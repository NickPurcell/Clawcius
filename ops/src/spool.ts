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
 * ── One spool per instance, since 2026-08-10 ────────────────────────────
 *
 * There used to be a single directory for the whole executor. That was two
 * bugs in one line, and only one of them was visible.
 *
 * The visible one: `docker/run-container.sh` bind-mounts `$CLAWCIUS_STATE/run`
 * and nothing else, and `CLAWCIUS_STATE` is per instance — `/var/lib/clawcius`
 * for Clawcius, `/var/lib/hamachi` for Hamachi. A shared spool at
 * `/var/lib/clawcius/run/ops` is therefore reachable from exactly one of the
 * two containers. From inside Hamachi's, that path does not exist. It had no
 * way to file a request at all, and the failure was silent on both sides.
 *
 * The invisible one, which turned out to matter more: a shared directory
 * carries no evidence of who wrote a file. `redeploy hamachi` filed by Hamachi
 * and `redeploy hamachi` filed by Clawcius are the same eight bytes. The
 * executor logged both identically because it could not tell them apart — and
 * "which agent asked for this" is the first question anybody has about a
 * privileged action. One spool per instance answers it structurally: the
 * container can only write into its own bind mount, so the directory a file
 * was found in is a fact about the writer that the writer cannot forge.
 *
 * The `.json` suffix requirement is load-bearing for a boring reason: an agent
 * writing a request with `>` produces a zero-length file the instant the shell
 * opens it, and a sweep landing in that window would read an empty file and
 * report malformed JSON. Writing to `<name>.tmp` and renaming to `<name>.json`
 * is the documented way to file a request, and the suffix check is what makes
 * that work.
 */

import {
  chownSync,
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
  /**
   * Which instance filed this. Provenance, and it comes from the DIRECTORY.
   *
   * Added 2026-08-10 with per-instance spools. Before that there was one
   * shared spool and this question had no answer at all: the executor could
   * see that somebody had asked to redeploy Hamachi, and could not see whether
   * the somebody was Hamachi or Clawcius. Those are different events. One is
   * an agent maintaining itself; the other is an agent reaching across the
   * boundary at its neighbour, and the journal recorded them identically.
   *
   * It is set by the spool from its own configuration and NEVER read out of
   * the request body. That is the entire security property: the file is
   * hostile input, the directory it was found in is not — a container can only
   * write into the one spool bind-mounted into it. A `requester` field written
   * inside the JSON is treated as an unknown field, logged as ignored, and has
   * no path to this value. See the note in request.ts.
   */
  requester: string;
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

/**
 * Make sure a spool exists and that the container's uid can write it.
 *
 * ── The ownership problem, and why it is solved by stat ──────────────────
 *
 * The executor is root. `mkdir` from root produces a root-owned directory, and
 * the whole point of a spool is that an unprivileged process in a gVisor
 * container writes into it. A root-owned 0770 spool is not a spool: the
 * agent's `mv` gets EACCES, the executor sees an empty directory — which is
 * indistinguishable from a quiet night — and nobody finds out until someone
 * asks why a request was never actioned. That is the same silent shape as the
 * mount asymmetry this whole change is about, so it is not left to chance.
 *
 * `docker/run-container.sh` solves it by construction for the wake spool: it
 * runs as `npurcell` (the instance units set `User=npurcell`), so `mkdir -p
 * "$WAKE_DIR"` produces a directory owned by the uid the container runs as —
 * the Dockerfile builds the agent user with `AGENT_UID=1000` precisely so the
 * two match. That script now creates the ops spool the same way, in the same
 * place, for the same reason.
 *
 * This function is the belt to that braces, for the case where the executor
 * boots before any container has ever been started. It takes the ownership it
 * should apply from `ownerOf` — the instance's state directory, which systemd
 * created with the instance unit's `User=` — rather than from a uid in config.
 * Same rule as `build.ts`: the owner is discovered by `stat`, never hardcoded,
 * because this daemon is not entitled to an opinion about who owns a directory
 * it was pointed at.
 *
 * Failures here are logged, never fatal. A spool that cannot be chowned is a
 * spool one agent cannot use; a daemon that refuses to boot over it is every
 * agent's rollback deadline unhonoured.
 */
export function ensureSpoolDir(
  dir: string,
  ownerOf: string,
  log: (line: string) => void,
): void {
  let created = false;
  try {
    // 0770 rather than 0750: the container writes here. Group ownership is
    // what makes that work without the directory being world-writable.
    created = mkdirSync(dir, { recursive: true, mode: 0o770 }) !== undefined;
  } catch (error) {
    log(`cannot create ${dir}: ${String(error)} — requests filed there will never arrive`);
    return;
  }

  let want: { uid: number; gid: number };
  let have: { uid: number; gid: number };
  try {
    const reference = statSync(ownerOf);
    want = { uid: reference.uid, gid: reference.gid };
    const current = statSync(dir);
    have = { uid: current.uid, gid: current.gid };
  } catch (error) {
    log(`cannot compare ${dir} against ${ownerOf}: ${String(error)} — leaving it alone`);
    return;
  }

  if (want.uid === have.uid && want.gid === have.gid) {
    if (created) log(`created ${dir}, already owned ${have.uid}:${have.gid}`);
    return;
  }

  try {
    chownSync(dir, want.uid, want.gid);
    log(
      `chowned ${dir} to ${want.uid}:${want.gid} to match ${ownerOf} — it was ` +
        `${have.uid}:${have.gid}, which the container's uid cannot write`,
    );
  } catch (error) {
    // Loud, and with the command in it, because the alternative symptom is an
    // agent whose requests vanish.
    log(
      `WARNING: ${dir} is owned ${have.uid}:${have.gid} but ${ownerOf} is owned ` +
        `${want.uid}:${want.gid}, and chown failed (${String(error)}). The container ` +
        `probably cannot write its own spool. Fix on the host with: ` +
        `chown ${want.uid}:${want.gid} ${dir} && chmod 0770 ${dir}`,
    );
  }
}

export class OpsSpool {
  #dir: string;
  #instance: string;
  #ownerOf: string;
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
    /**
     * The instance that owns this directory. Stamped onto every request that
     * comes out of it, and the only source of provenance in the system.
     */
    instance: string;
    /**
     * A path whose ownership the spool should match — the instance's state
     * directory. See `ensureSpoolDir`. Empty means "do not touch ownership",
     * which is what the self-test uses.
     */
    ownerOf?: string;
    maxBytes: number;
    maxPerSweep: number;
    maxFiles: number;
    pollSeconds: number;
    log: (line: string) => void;
    onRequest: SpoolHandler;
  }) {
    this.#dir = options.dir;
    this.#instance = options.instance;
    this.#ownerOf = options.ownerOf ?? '';
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

  /** Whose spool this is. */
  get instance(): string {
    return this.#instance;
  }

  start(): void {
    if (this.#ownerOf) {
      ensureSpoolDir(this.#dir, this.#ownerOf, this.#log);
    } else {
      mkdirSync(this.#dir, { recursive: true, mode: 0o770 });
    }

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
          // `requester` is stamped here, from this spool's configuration, and
          // is the one field in the whole pipeline that the file's author
          // cannot influence.
          this.#onRequest({ name, body, requester: this.#instance });
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
