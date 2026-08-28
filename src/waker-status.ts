/** A one-line status file the waker publishes so the ops executor can tell whether this instance is mid-turn. */

import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUILD_INFO, type BuildInfo } from './build-info.js';

export type WakerStatus = {
  build: BuildInfo;
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
  /** What the waker believes its own publishing interval is. */
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

  /** Call whenever a session is acquired or released. */
  noteChange(): void {
    if (!this.enabled) return;
    if (this.#options.liveCount() === this.#lastCount) return;
    this.publish();
  }

  /** Remove the file on a clean shutdown. */
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
      build: BUILD_INFO,
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
      // Never throw out of here.
      process.stderr.write(`[waker-status] could not publish: ${String(error)}\n`);
      try {
        unlinkSync(temp);
      } catch {
        /* the temp file is already gone, or was never created */
      }
    }
  }
}
