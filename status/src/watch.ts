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
