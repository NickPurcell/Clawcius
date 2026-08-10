/**
 * A one-line status file the waker publishes so the ops executor can tell
 * whether this instance is mid-turn.
 *
 * The executor is a separate root process that recreates containers. Recreating
 * one while a session is running kills a live `docker exec` — from Discord that
 * is a person mid-conversation with an agent that stops replying and never
 * explains why. There is no IPC between the two processes and deliberately so
 * (the executor holds docker and systemctl; the waker is the thing being
 * restarted), so the handshake is a file: the waker says how many sessions are
 * live and when it last said it, and the executor decides.
 *
 * Two properties this has to have, and both are about the failure mode rather
 * than the happy path:
 *
 *   It is written on CHANGE, not only on a timer. A turn that starts one second
 *   after a periodic write would otherwise be invisible for a whole interval,
 *   which is exactly the window a `redeploy` would drive through.
 *
 *   It is ALSO written periodically, unchanged, because the timestamp is the
 *   liveness signal. A waker that has crashed leaves its last file on disk
 *   saying `liveCount: 0` forever, and a stale zero reads as "safe to destroy
 *   the container" — the most dangerous possible lie. The executor treats
 *   anything older than its own staleness threshold as busy, so the periodic
 *   write is what earns the file the right to be believed.
 *
 * Written by rename, never in place: the reader is a different process on a
 * different schedule, and a partial read of a half-written file parses as
 * malformed JSON. Malformed is treated as busy too, so a torn read is safe
 * rather than wrong — but it would still be noise in the executor's log every
 * time, and an atomic rename costs nothing.
 */

import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type WakerStatus = {
  /** Instance name, matching the `instances:` key in ops-config.yaml. */
  instance: string;
  /** Sessions currently holding a `claude` child process. 0 means idle. */
  liveCount: number;
  /** Concurrency ceiling, for context in logs and on the status page. */
  maxConcurrent: number;
  pid: number;
  /** Epoch ms of this write. The staleness check is against this. */
  at: number;
  /** Same instant, readable, because this file gets `cat`ed by people. */
  atIso: string;
  /**
   * What the waker believes its own publishing interval is. The executor does
   * not have to trust it — its own `idleStaleSeconds` is the authority — but
   * having it in the file means a mismatch is diagnosable from the file alone.
   */
  publishIntervalSeconds: number;
};

export type WakerStatusOptions = {
  /** Absolute path to write. Empty disables publishing entirely. */
  path: string;
  intervalSeconds: number;
  instance: string;
  maxConcurrent: number;
  /** Asked for the current live session count on every publish. */
  liveCount: () => number;
};

export class WakerStatusPublisher {
  #options: WakerStatusOptions;
  #timer: NodeJS.Timeout | null = null;
  #lastCount = -1;

  constructor(options: WakerStatusOptions) {
    this.#options = options;
  }

  get enabled(): boolean {
    return this.#options.path.length > 0;
  }

  get path(): string {
    return this.#options.path;
  }

  start(): void {
    if (!this.enabled) return;

    this.publish();
    this.#timer = setInterval(() => this.publish(), this.#options.intervalSeconds * 1000);
    this.#timer.unref();
    process.stdout.write(
      `[waker-status] publishing to ${this.#options.path} ` +
        `every ${this.#options.intervalSeconds}s\n`,
    );
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Call whenever a session is acquired or released.
   *
   * Cheap enough to call unconditionally — a write only happens when the count
   * actually moved, so the hot path of "several messages into a live session"
   * costs one integer comparison.
   */
  noteChange(): void {
    if (!this.enabled) return;
    if (this.#options.liveCount() === this.#lastCount) return;
    this.publish();
  }

  /**
   * Remove the file on a clean shutdown.
   *
   * Absent is the honest state for a stopped waker, and the executor reads
   * absent as busy — which is right, because a waker that is not running cannot
   * tell you whether the container is in use. Leaving a final `liveCount: 0`
   * behind would be a stale zero that happens to be true at the moment of
   * writing and false forever after.
   */
  removeOnShutdown(): void {
    if (!this.enabled) return;
    try {
      unlinkSync(this.#options.path);
    } catch {
      // Best effort. A status file we failed to delete goes stale on its own
      // within `idleStaleSeconds`, which lands on the safe side anyway.
    }
  }

  publish(): void {
    if (!this.enabled) return;

    const now = Date.now();
    const liveCount = this.#options.liveCount();
    const status: WakerStatus = {
      instance: this.#options.instance,
      liveCount,
      maxConcurrent: this.#options.maxConcurrent,
      pid: process.pid,
      at: now,
      atIso: new Date(now).toISOString(),
      publishIntervalSeconds: this.#options.intervalSeconds,
    };

    const temp = join(dirname(this.#options.path), `.waker-status.${process.pid}.tmp`);
    try {
      mkdirSync(dirname(this.#options.path), { recursive: true });
      writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o644 });
      renameSync(temp, this.#options.path);
      this.#lastCount = liveCount;
    } catch (error) {
      // Never throw out of here. This is telemetry for another process; the
      // waker failing to write it must not take a Discord bot down. The cost of
      // silence is that the executor sees a stale file and refuses to do
      // anything destructive, which is the direction we want to fail in.
      process.stderr.write(`[waker-status] could not publish: ${String(error)}\n`);
      try {
        unlinkSync(temp);
      } catch {
        /* the temp file is already gone, or was never created */
      }
    }
  }
}
