/**
 * Noticing that something changed.
 *
 * The page is meant to be left open on a second monitor, so it has to update
 * itself. What it must never do is *lie* about being up to date — a stream that
 * has silently died looks exactly like a host where nothing is happening, and
 * on a page whose whole job is telling you whether agents are alive, that is
 * the worst bug available. Hence the heartbeat in `index.ts`, and hence the
 * belt-and-braces below.
 *
 * ── Why fs.watch is not trusted on its own ────────────────────────────────
 *
 * `fs.watch(dir, { recursive: true })` is the obvious answer and it is not
 * sufficient. The specific reason on this host comes first, because it is the
 * one that is not hypothetical:
 *
 *   - The agents write their transcripts from INSIDE a gVisor container, into
 *     a bind mount whose host side is what we watch. SETUP.md § 6b records
 *     that the waker hit exactly this and found "gVisor's gofer does not
 *     reliably deliver inotify for writes made inside the sandbox", which is
 *     why it runs a 5s sweep alongside its own fs.watch. Nothing about this
 *     service's position in that topology is different.
 *
 * And the generic reasons, which would apply on any host:
 *
 *   - Recursive watching is emulated on some platforms and was only added for
 *     Linux in Node 20. It works here (Node 22), but it is one runtime bump
 *     away from being a different implementation.
 *
 *   - inotify watches are a finite per-user kernel resource
 *     (`fs.inotify.max_user_watches`, commonly 8192 or 65536, and a recursive
 *     watch consumes one per directory). Exhausting it does not raise anything
 *     useful — events simply stop arriving.
 *
 *   - A directory created after the watch was established may or may not be
 *     covered, depending on implementation. Every new session creates one, so
 *     this is not a hypothetical.
 *
 *   - A root that does not exist yet cannot be watched at all, and a brand-new
 *     agent instance legitimately has no projects directory until its first
 *     turn.
 *
 * So: watch when we can, and additionally rescan on a slow timer that cannot
 * miss anything. The timer is cheap because subscribers only ever receive
 * "something under this root changed" — the expensive work of deciding what
 * changed happens when a client actually asks.
 */

import { watch, type FSWatcher } from 'node:fs';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type ChangeEvent = {
  /** Configured agent id whose root changed, or `oj`. */
  scope: string;
  /** Best-effort path, relative to the watched root. Empty when unknown. */
  path: string;
  /** Milliseconds since epoch when the batch was flushed. */
  at: number;
  /** True when this came from the fallback rescan rather than an fs event. */
  fromRescan: boolean;
};

export type WatchTarget = {
  scope: string;
  root: string;
};

type Listener = (event: ChangeEvent) => void;

export class RootWatcher {
  #targets: WatchTarget[];
  #debounceMs: number;
  #rescanSeconds: number;
  #listeners = new Set<Listener>();
  #watchers = new Map<string, FSWatcher>();
  #timers = new Map<string, NodeJS.Timeout>();
  #pendingPath = new Map<string, string>();
  #rescanTimer: NodeJS.Timeout | null = null;
  /** Roots we could not watch, surfaced on /healthz rather than swallowed. */
  #unwatched = new Map<string, string>();

  constructor(targets: WatchTarget[], debounceMs: number, rescanSeconds: number) {
    this.#targets = targets;
    this.#debounceMs = debounceMs;
    this.#rescanSeconds = rescanSeconds;
  }

  start(): void {
    for (const target of this.#targets) this.#attach(target);

    if (this.#rescanSeconds > 0) {
      this.#rescanTimer = setInterval(() => {
        for (const target of this.#targets) {
          // Reattach anything that was not watchable before. This is how a
          // brand-new agent instance starts streaming without a restart of
          // this service: its projects directory appears, and the next rescan
          // picks it up.
          if (!this.#watchers.has(target.scope)) this.#attach(target);
          this.#emit({ scope: target.scope, path: '', at: Date.now(), fromRescan: true });
        }
      }, this.#rescanSeconds * 1000);
      // Unref'd so the timer never holds the process open on its own — a
      // shutdown should not have to wait out a 60-second poll.
      this.#rescanTimer.unref();
    }
  }

  stop(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    if (this.#rescanTimer) clearInterval(this.#rescanTimer);
    this.#rescanTimer = null;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Roots that could not be watched, and why. For /healthz. */
  get unwatched(): ReadonlyMap<string, string> {
    return this.#unwatched;
  }

  get watchedCount(): number {
    return this.#watchers.size;
  }

  #attach(target: WatchTarget): void {
    if (!existsSync(target.root)) {
      this.#unwatched.set(target.scope, `${target.root} does not exist yet`);
      return;
    }

    try {
      const watcher = watch(target.root, { recursive: true, persistent: false }, (_type, name) => {
        this.#schedule(target.scope, typeof name === 'string' ? name : '');
      });

      // A watcher that errors after being established — the directory was
      // removed, or inotify gave up — is dropped rather than left in place
      // pretending to work. The rescan loop will try again.
      watcher.on('error', (error) => {
        this.#unwatched.set(target.scope, `watch failed: ${error.message}`);
        this.#watchers.delete(target.scope);
        try {
          watcher.close();
        } catch {
          // Already closed; nothing to do and nothing to report.
        }
      });

      this.#watchers.set(target.scope, watcher);
      this.#unwatched.delete(target.scope);
    } catch (error) {
      // Not fatal. `rescanSeconds` is the reason this can be a warning: the
      // page keeps updating, just at poll resolution instead of instantly.
      this.#unwatched.set(
        target.scope,
        `watch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Coalesce a burst into one event.
   *
   * One agent turn appends several lines and rewrites a sidecar; naively
   * forwarding each would send a dozen SSE frames for a single message and
   * make the client re-fetch a dozen times. The debounce restarts on each
   * event, which is right here in a way it would not be for the waker's
   * message bundler: there is no ceiling, because unlike a user waiting for a
   * reply, nobody is harmed by a busy agent's update landing after it stops
   * being busy — and a continuously-writing agent still shows as running from
   * its mtime.
   */
  #schedule(scope: string, path: string): void {
    this.#pendingPath.set(scope, path);
    const existing = this.#timers.get(scope);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.#timers.delete(scope);
      this.#emit({
        scope,
        path: this.#pendingPath.get(scope) ?? '',
        at: Date.now(),
        fromRescan: false,
      });
      this.#pendingPath.delete(scope);
    }, this.#debounceMs);
    timer.unref();
    this.#timers.set(scope, timer);
  }

  #emit(event: ChangeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // One subscriber throwing — a client socket that died between the
        // write and the flush — must not stop the others being told.
      }
    }
  }
}

// ── The board ───────────────────────────────────────────────────────────────

/**
 * Noticing that the BOARD changed, which is a different problem.
 *
 * `RootWatcher` above watches directories, and the board is a single SQLite
 * file in neither of them — so until this existed `/api/clawsky` refreshed only
 * when some unrelated transcript happened to change. Mail delivery usually
 * causes one, because it wakes an agent, but the host agent is documented as
 * having no transcripts under any projects root at all: a DM to or from
 * `<crew>-host` could leave the page stale under a header correctly reporting
 * "live". A page whose data source is not watched is a stale page that looks
 * current, which is Clawcius #14's complaint wearing different clothes.
 *
 * ── Polled, not watched, and the reason is not inotify ──────────────────────
 *
 * `fs.watch` would work here — unlike the transcript roots, the board is
 * written by a host process rather than from inside gVisor, so events would
 * actually arrive. It is still the wrong instrument. The board is in WAL mode,
 * so every touch of `last_active_at` writes the `-wal` file, and the waker
 * touches it on every turn: watching the directory means an event per write,
 * where what the page needs to know is whether the TABLES changed. Those are
 * not the same question, and one is a proxy for the other only by luck.
 *
 * So this asks the database instead. Four integers — the newest mail id, the
 * mail row count, the agent row count and the newest `last_active_at` — which
 * is exact rather than indicative, cheap enough to run on a timer, and covers
 * the cases a file watch would miss for the same reason it covers the ones it
 * would over-report: a row deleted and another inserted changes the count pair,
 * and a `-wal` write that changed nothing this page shows changes none of them.
 *
 * Read-only and open-per-poll, exactly as `registry.ts` and `mail.ts` are, and
 * failing the same way: an unreadable board yields no fingerprint and simply
 * does not fire. The page is already able to say it could not read the board.
 */
export class BoardWatcher {
  #boards: Array<{ scope: string; dbPath: string }>;
  #seconds: number;
  #timer: NodeJS.Timeout | null = null;
  #last = new Map<string, string>();
  #subscribers: Array<(event: ChangeEvent) => void> = [];

  constructor(boards: Array<{ scope: string; dbPath: string }>, seconds: number) {
    this.#boards = boards;
    this.#seconds = seconds;
  }

  subscribe(handler: (event: ChangeEvent) => void): void {
    this.#subscribers.push(handler);
  }

  start(): void {
    if (this.#seconds <= 0 || this.#boards.length === 0) return;
    // Fingerprint everything once without publishing, so the first poll after
    // startup reports what changed since startup rather than announcing every
    // board as changed to whoever is already watching.
    for (const board of this.#boards) {
      const seen = fingerprint(board.dbPath);
      if (seen !== null) this.#last.set(board.scope, seen);
    }
    this.#timer = setInterval(() => this.#poll(), this.#seconds * 1000);
    this.#timer.unref();
  }

  #poll(): void {
    for (const board of this.#boards) {
      const seen = fingerprint(board.dbPath);
      if (seen === null) continue;
      if (this.#last.get(board.scope) === seen) continue;
      this.#last.set(board.scope, seen);
      const event: ChangeEvent = {
        scope: board.scope,
        path: 'board',
        at: Date.now(),
        fromRescan: true,
      };
      for (const handler of this.#subscribers) handler(event);
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/**
 * Four integers that change when anything this page renders changes, or null
 * when the board cannot be read.
 *
 * Counts as well as maxima on purpose: a maximum alone cannot see a deletion,
 * and `MAX(id)` alone cannot see a row deleted and reinserted.
 */
function fingerprint(dbPath: string): string | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT (SELECT COUNT(*)             FROM mail)   AS mailRows,
                (SELECT IFNULL(MAX(id), 0)   FROM mail)   AS mailMax,
                (SELECT COUNT(*)             FROM agents) AS agentRows,
                (SELECT IFNULL(MAX(last_active_at), 0) FROM agents) AS agentSeen`,
      )
      .get() as Record<string, unknown>;
    return [row['mailRows'], row['mailMax'], row['agentRows'], row['agentSeen']].join(':');
  } catch {
    // Unreadable, missing, or a board without these tables. Not this class's
    // job to explain — the page already does, from its own read.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing useful to do about a failed close */
    }
  }
}
