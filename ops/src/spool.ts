/**
 * The ops spool: the same directory-as-a-queue idea as `src/wake-spool.ts`,
 * generalised from one verb to a closed list of them.
 *
 * The shape is inherited deliberately rather than reinvented. A bind-mounted
 * directory works where a unix socket does not — gVisor blocks connections to
 * host unix sockets, correctly, since one would be a hole straight through the
 * sandbox boundary — and writing a file is something the agent can do from
 * cron, from a script, from anywhere, without a client library.
 *
 * What is NOT inherited is the trust level. The wake spool feeds a process
 * that starts an agent turn; the worst a bad request does there is waste a
 * turn, which is why that file can afford to be twenty lines of parsing. This
 * spool feeds a root process holding docker and systemctl. So:
 *
 *   - a size cap per file, enforced by `stat` before the file is opened, so an
 *     enormous file is never read into memory at all;
 *   - a cap on files consumed per sweep, so a burst cannot monopolise the
 *     daemon;
 *   - a cap on files *present*, past which the spool is treated as flooded and
 *     drained without being read — a container writing thousands of request
 *     files is not a scheduling accident;
 *   - unlink before parse, so a request that somehow crashes the parser is not
 *     retried forever on every sweep;
 *   - and a rate limit above all of it, in the executor.
 *
 * The `.json` suffix requirement is load-bearing for a boring reason: an agent
 * writing a request with `>` produces a zero-length file the instant the shell
 * opens it, and a sweep landing in that window would read an empty file and
 * report malformed JSON. Writing to `<name>.tmp` and renaming to `<name>.json`
 * is the documented way to file a request, and the suffix check is what makes
 * that work.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';

export type RawRequest = {
  /** Spool file name. Logged; never used to build a path beyond `join`. */
  name: string;
  /** File contents, already size-capped. */
  body: string;
};

export type SpoolHandler = (raw: RawRequest) => void;

/**
 * File names we will even look at.
 *
 * `readdir` returns basenames, so a name cannot contain a separator — but the
 * check is here anyway, because that is a property of the API rather than of
 * anything this code enforces, and it is one refactor away from being false.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

export class OpsSpool {
  #dir: string;
  #onRequest: SpoolHandler;
  #maxBytes: number;
  #maxPerSweep: number;
  #maxFiles: number;
  #pollMs: number;
  #log: (line: string) => void;
  #watcher: FSWatcher | null = null;
  #sweeper: NodeJS.Timeout | null = null;
  #draining = false;

  constructor(options: {
    dir: string;
    maxBytes: number;
    maxPerSweep: number;
    maxFiles: number;
    pollSeconds: number;
    log: (line: string) => void;
    onRequest: SpoolHandler;
  }) {
    this.#dir = options.dir;
    this.#maxBytes = options.maxBytes;
    this.#maxPerSweep = options.maxPerSweep;
    this.#maxFiles = options.maxFiles;
    this.#pollMs = options.pollSeconds * 1000;
    this.#log = options.log;
    this.#onRequest = options.onRequest;
  }

  get dir(): string {
    return this.#dir;
  }

  start(): void {
    // 0770 rather than 0750: the container writes here. Group ownership is what
    // makes that work without the directory being world-writable, and it is
    // set on the host at install time — see ops/README.md.
    mkdirSync(this.#dir, { recursive: true, mode: 0o770 });

    try {
      this.#watcher = watch(this.#dir, () => this.drain());
    } catch (error) {
      this.#log(`cannot watch ${this.#dir}: ${String(error)} — polling only`);
    }

    // The sweep is not a fallback here, it is the primary mechanism. gVisor's
    // gofer does not reliably deliver inotify for writes made inside the
    // sandbox, which is the same finding that put a 5s sweep next to the
    // waker's fs.watch and set the status page's rescan interval. fs.watch is
    // the fast path when it happens to fire.
    this.#sweeper = setInterval(() => this.drain(), this.#pollMs);
    this.#sweeper.unref();

    this.drain();
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  /**
   * Consume up to `maxPerSweep` requests.
   *
   * Reentrancy-guarded: fs.watch fires several times for one write and the
   * sweep runs on its own timer, so this is called far more often than there
   * is work. The guard is not about correctness of the handler — the executor
   * has its own lock — it is about not walking the directory four times for
   * one file.
   */
  drain(): void {
    if (this.#draining) return;
    this.#draining = true;

    try {
      let names: string[];
      try {
        names = readdirSync(this.#dir);
      } catch (error) {
        this.#log(`cannot read ${this.#dir}: ${String(error)}`);
        return;
      }

      const candidates = names.filter((name) => name.endsWith('.json'));

      // A flood is not a queue. Past the ceiling, everything goes — including
      // any legitimate request caught up in it, which is the right trade: an
      // agent that has filled the spool has already lost the ability to make a
      // request the executor can reason about, and processing the first eight
      // of ten thousand would just mean doing it again in five seconds forever.
      if (candidates.length > this.#maxFiles) {
        this.#log(
          `SPOOL FLOODED: ${candidates.length} request files in ${this.#dir} ` +
            `(ceiling ${this.#maxFiles}). Discarding all of them unread. This is not what ` +
            'a scheduling mistake looks like.',
        );
        for (const name of candidates) {
          try {
            unlinkSync(join(this.#dir, name));
          } catch {
            /* it is going or gone; the next sweep will say so */
          }
        }
        return;
      }

      // Oldest first, by name. `docker/…` conventions and the wake spool both
      // use an epoch-second filename, so lexical order is chronological order
      // for anything following the documented pattern — and for anything not
      // following it, order is arbitrary but at least deterministic.
      candidates.sort();

      let processed = 0;
      for (const name of candidates) {
        if (processed >= this.#maxPerSweep) {
          this.#log(
            `sweep cap reached (${this.#maxPerSweep}); ${candidates.length - processed} ` +
              'request(s) left for the next sweep',
          );
          break;
        }

        const path = join(this.#dir, name);

        if (!NAME_PATTERN.test(name)) {
          this.#log(`${name}: implausible file name, discarded unread`);
          this.#discard(path);
          processed += 1;
          continue;
        }

        let body: string;
        try {
          const stat = statSync(path);
          if (!stat.isFile()) {
            this.#log(`${name}: not a regular file, discarded unread`);
            this.#discard(path);
            processed += 1;
            continue;
          }
          if (stat.size > this.#maxBytes) {
            // Never opened. The point of checking size first is that the
            // oversized case costs a stat, not a read.
            this.#log(
              `${name}: ${stat.size} bytes exceeds the ${this.#maxBytes}-byte cap, ` +
                'discarded unread',
            );
            this.#discard(path);
            processed += 1;
            continue;
          }
          body = readFileSync(path, 'utf8');
        } catch (error) {
          this.#log(`${name}: could not read (${String(error)})`);
          this.#discard(path);
          processed += 1;
          continue;
        }

        // Removed before it is acted on. A request that throws must not come
        // back on the next sweep — least of all a destructive one.
        this.#discard(path);
        processed += 1;

        try {
          this.#onRequest({ name, body });
        } catch (error) {
          this.#log(`${name}: handler threw (${String(error)})`);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  #discard(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.#log(`could not remove ${path}: ${String(error)}`);
    }
  }
}
