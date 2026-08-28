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
          // Reattach anything that was not watchable before.
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

/** Four integers that change when anything this page renders changes, or null when the board cannot be read. */
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
    }
  }
}
