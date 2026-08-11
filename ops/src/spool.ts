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
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  watch,
  type FSWatcher,
  type Stats,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

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

/** `lstat`, with "it is not there" as a value rather than an exception. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // ENOTDIR (an ancestor is a file), EACCES, ELOOP — all of them mean "this
    // path is not what we think it is", which is the caller's refusal case and
    // not something to paper over with a null.
    throw error;
  }
}

/** What is actually sitting at a path, for a log line a human can act on. */
function describeEntry(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'a symlink';
  if (stat.isFile()) return 'a regular file';
  if (stat.isDirectory()) return 'a directory';
  if (stat.isSocket()) return 'a socket';
  if (stat.isFIFO()) return 'a FIFO';
  return 'neither a directory nor a regular file';
}

/**
 * Make sure a spool exists and that the container's uid can write it.
 *
 * Returns whether the directory is safe to sweep. `false` means the executor
 * should not read, write, unlink or chown anything at that path.
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
 * ── Rewritten 2026-08-11: it created a root chown of any path on the host ──
 *
 * The first version of this function was four lines of `mkdirSync(recursive)`,
 * `statSync`, `chownSync` and it was a privilege escalation out of the sandbox,
 * in the change written to let agents file requests safely. Review of PR #8
 * found it; the mechanism is worth writing down in full, because every step of
 * it looked reasonable in isolation.
 *
 * The spool is `<stateDir>/run/ops`, and `<stateDir>/run` is bind-mounted
 * READ-WRITE into the container, owned by the uid the agent runs as. So the
 * agent owns the parent of the spool and may do anything it likes to the entry
 * called `ops`, including:
 *
 *     rm -rf run/ops && ln -s /root/.ssh run/ops
 *
 * On the next executor start — restarts are routine: a pull, a redeploy, a
 * reboot — the old code did this, as root:
 *
 *     mkdirSync(dir, {recursive:true})  // returns undefined on an existing
 *                                       // symlink-to-dir, no throw
 *     statSync(dir)                     // FOLLOWS the link: sees /root/.ssh
 *     chownSync(dir, 1000, 1000)        // FOLLOWS the link: chowns /root/.ssh
 *
 * That is an arbitrary-path root chown, chosen by the least trusted process on
 * the machine (CWE-59). `/etc`, `/root/.ssh`, the checkout root, or — most
 * pointedly — `/var/lib/clawcius-ops`, the executor's own state directory,
 * whose unreachability is the entire argument for why the circuit breaker
 * cannot be edited by the party it is quarantining.
 *
 * ── The decision: refuse and report; never repair what we did not create ──
 *
 * The obvious patch is `lstat` + `lchown`, and that is necessary but it is not
 * the whole answer, so it is not what this does. The question the review asked
 * is the right one: should a root process chown a path whose parent directory
 * is owned by the adversary, at all?
 *
 * It should not. Two rules, and they are deliberate:
 *
 *   1. **Only chown what this call just created.** A directory that already
 *      exists with the wrong owner is not a thing to fix silently — it is
 *      evidence. Either an operator made it by hand, or something else did,
 *      and both are worth a human reading a line. The old code's "repair"
 *      bought us the case where a previous root `mkdir` had left a bad owner;
 *      it cost us the case where the adversary chooses the target. That is a
 *      bad trade at any price. So the existing-and-wrongly-owned case is now a
 *      loud WARNING with the exact `chown` to run, and nothing else. That
 *      warning is also emitted by `OpsSpool.#ready()` on every sweep of an
 *      existing spool, which is the route the daemon actually takes — this
 *      function only sees a missing directory in production, so a promise kept
 *      only here would be a promise never kept at all.
 *
 *   2. **Never follow a symlink, and never trust a path after checking it.**
 *      Every level is `lstat`ed, refused if it is not a real directory, and
 *      the chown/chmod goes through a file descriptor opened `O_NOFOLLOW |
 *      O_DIRECTORY` whose `fstat` is compared with the `lstat` by device and
 *      inode. The window between "checked" and "used" is where these bugs
 *      live, and the fd is what closes it: whatever is chowned is the object
 *      we looked at, or nothing is.
 *
 * A symlink where the spool should be is therefore not repaired, not deleted
 * (deleting it as root is another primitive, and the agent owns the parent
 * anyway) and not swept. It is reported and left exactly where it is, and the
 * instance's requests stop arriving until someone looks — which is the correct
 * outcome, because the only party who can put a symlink there is the one whose
 * requests those would be.
 *
 * ── Also 2026-08-11: the fresh-host repair did not work ──────────────────
 *
 * The same review found the repair ineffective in the one case it was written
 * for. `mkdirSync(recursive)` as root created any missing ancestors root-owned
 * too, and only the leaf was ever chowned — so a host where `<stateDir>` did
 * not exist got `<stateDir>`, `run` and `run/ops` all owned by root, and
 * because `want` was read from the freshly-created `<stateDir>` the comparison
 * was vacuously satisfied and even the leaf chown was skipped. The container
 * could not write its own spool: the exact silent failure this whole change
 * exists to abolish, reintroduced by the code meant to prevent it.
 *
 * So: `want` is read from `ownerOf` BEFORE anything is created, each level is
 * created one at a time and chowned as it is created, and the mode is applied
 * with `fchmod` rather than left to `mkdir`'s mode argument — which is masked
 * by the process umask, and 0770 & ~022 is 0750, which uid 1000 cannot write.
 *
 * And if `ownerOf` itself does not exist, nothing is created at all. There is
 * no correct owner to discover, and a root-owned tree is worse than an absent
 * one: the absent one is fixed by the instance unit starting (it creates the
 * state directory as `npurcell`, and this function is retried on every sweep),
 * whereas the root-owned one silently swallows every request forever.
 *
 * Failures here are logged, never fatal. A spool that cannot be created is a
 * spool one agent cannot use; a daemon that refuses to boot over it is every
 * agent's rollback deadline unhonoured.
 */
export function ensureSpoolDir(
  dir: string,
  ownerOf: string,
  log: (line: string) => void,
): boolean {
  // ── 1. What we would apply, discovered before anything is created ───────
  let want: { uid: number; gid: number };
  try {
    const reference = lstatOrNull(ownerOf);
    if (reference === null) {
      log(
        `${ownerOf} does not exist yet, so there is no owner to copy — NOT creating ${dir} ` +
          'as root. The instance unit creates the state directory as its User=, and this ' +
          'is retried on every sweep, so a first boot in the wrong order fixes itself. A ' +
          'root-owned spool would not: the container would get EACCES forever and the ' +
          'executor would see a quiet directory.',
      );
      return false;
    }
    if (!reference.isDirectory()) {
      log(`${ownerOf} is ${describeEntry(reference)}, not a directory — leaving ${dir} alone`);
      return false;
    }
    want = { uid: reference.uid, gid: reference.gid };
  } catch (error) {
    log(`cannot inspect ${ownerOf}: ${String(error)} — leaving ${dir} alone`);
    return false;
  }

  // ── 2. Only paths under `ownerOf` are ours to create ────────────────────
  //
  // An operator may point `opsSpoolDir` anywhere; creating arbitrary ancestors
  // as root outside the instance's own state directory is not this daemon's
  // business. If such a spool already exists as a real directory we will use
  // it; if it does not, we say so and stop.
  const rel = relative(ownerOf, dir);
  const inside = rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && rel !== '.';

  if (!inside) {
    const stat = (() => {
      try {
        return lstatOrNull(dir);
      } catch (error) {
        log(`cannot inspect ${dir}: ${String(error)}`);
        return undefined;
      }
    })();
    if (stat === undefined) return false;
    if (stat === null) {
      log(
        `${dir} is outside ${ownerOf} and does not exist. NOT creating it as root — a spool ` +
          'outside the instance\'s state directory is not one this daemon can reason about ' +
          `the ownership of. Create it on the host, owned ${want.uid}:${want.gid}, mode 0770.`,
      );
      return false;
    }
    if (!stat.isDirectory()) {
      log(`REFUSING to use ${dir}: it is ${describeEntry(stat)}, not a directory.`);
      return false;
    }
    return true;
  }

  // ── 3. Walk down from `ownerOf`, one level at a time ────────────────────
  const segments = rel.split(sep).filter((segment) => segment.length > 0);
  let cursor = ownerOf;

  for (let index = 0; index < segments.length; index += 1) {
    cursor = join(cursor, segments[index] as string);
    const leaf = index === segments.length - 1;

    let stat: Stats | null;
    try {
      stat = lstatOrNull(cursor);
    } catch (error) {
      log(`cannot inspect ${cursor}: ${String(error)} — ${dir} left alone`);
      return false;
    }

    if (stat === null) {
      if (!createOwned(cursor, want, log)) return false;
      continue;
    }

    if (!stat.isDirectory()) {
      // The whole point. A symlink here is not a directory that needs fixing,
      // it is a directory that has been replaced, and the only writer who can
      // do that inside the bind mount is the agent this spool belongs to.
      log(
        `REFUSING to use ${dir}: ${cursor} is ${describeEntry(stat)}, not a directory. ` +
          'Nothing here has been created, chowned, read or removed — following it would ' +
          `hand whatever it points at to uid ${want.uid}, as root. ${dir} lives inside a ` +
          'bind mount the container writes, so this is what tampering looks like. ' +
          `Investigate, then remove it by hand as the owner of ${ownerOf}.`,
      );
      return false;
    }

    if (leaf && (stat.uid !== want.uid || stat.gid !== want.gid)) {
      // Reported, NOT repaired. See the header: the executor does not chown
      // directories it did not just create, because their parent belongs to
      // the party this daemon is defending against.
      log(wrongOwnerLine(dir, ownerOf, want, stat));
    }
  }

  return true;
}

/**
 * The one place the "your spool is owned by the wrong uid" message is written.
 *
 * Shared, because it is emitted from two places that reach the same state by
 * different routes: `ensureSpoolDir` walking down to a leaf that already
 * exists, and `OpsSpool.#ready()` finding a spool that was there before the
 * daemon started. Before 2026-08-11 only the first existed, and the daemon
 * never took that route — see `#ready()` — so the promise was written down and
 * never kept.
 */
function wrongOwnerLine(
  dir: string,
  ownerOf: string,
  want: { uid: number; gid: number },
  have: { uid: number; gid: number },
): string {
  return (
    `WARNING: ${dir} is owned ${have.uid}:${have.gid} but ${ownerOf} is owned ` +
    `${want.uid}:${want.gid}, so the container probably cannot write its own spool ` +
    'and its requests will never arrive. NOT chowning it: this process is root and ' +
    'the directory above it is writable by the container, so repairing a path we ' +
    'did not create is how a symlink becomes an arbitrary root chown. Fix it on the ' +
    `host as ${want.uid}: chown ${want.uid}:${want.gid} ${dir} && chmod 0770 ${dir}`
  );
}

/**
 * Does an existing spool's ownership match the instance's state directory?
 *
 * Returns the warning to log, or `null` when there is nothing to say —
 * including when `ownerOf` is missing or is not a directory, because those
 * are `ensureSpoolDir`'s cases and have their own messages.
 *
 * `stat` is passed in rather than taken here: the caller has already `lstat`ed
 * the spool and refused it unless it is a real directory, and re-`lstat`ing by
 * name would be a second, different answer to the same question.
 */
function ownershipWarning(dir: string, ownerOf: string, stat: Stats): string | null {
  let reference: Stats | null;
  try {
    reference = lstatOrNull(ownerOf);
  } catch {
    // EACCES, ELOOP, ENOTDIR on the state directory is a different problem
    // with its own report; it is not evidence about the spool's owner.
    return null;
  }
  if (reference === null || !reference.isDirectory()) return null;
  if (stat.uid === reference.uid && stat.gid === reference.gid) return null;
  return wrongOwnerLine(dir, ownerOf, { uid: reference.uid, gid: reference.gid }, stat);
}

/**
 * `mkdir` one level, then chown and chmod it through an O_NOFOLLOW fd.
 *
 * The fd is the point. Between `mkdirSync` returning and anything else
 * touching the path, the owner of the parent directory — the agent — can
 * replace what we just made with a symlink. Opening `O_NOFOLLOW | O_DIRECTORY`
 * refuses a link outright, and comparing the fd's `fstat` with a fresh `lstat`
 * of the path refuses the swap-for-another-directory case: from there on we
 * are operating on the object we checked, not on the name we checked it by.
 *
 * `fchmod` rather than `mkdir`'s mode, because that argument is masked by the
 * umask: the daemon runs with 022, so 0770 arrives as 0750 and the container's
 * group loses write — which is the same invisible EACCES the ownership rules
 * above exist to prevent.
 */
function createOwned(
  path: string,
  want: { uid: number; gid: number },
  log: (line: string) => void,
): boolean {
  try {
    mkdirSync(path, { mode: 0o770 });
  } catch (error) {
    log(`cannot create ${path}: ${String(error)} — requests filed there will never arrive`);
    return false;
  }

  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    log(
      `created ${path} but could not open it without following symlinks (${String(error)}). ` +
        'Something replaced it between the mkdir and the open, which is not something that ' +
        'happens by accident. Nothing was chowned.',
    );
    return false;
  }

  try {
    const opened = fstatSync(fd);
    const onDisk = lstatSync(path);
    if (opened.dev !== onDisk.dev || opened.ino !== onDisk.ino || !opened.isDirectory()) {
      log(
        `created ${path} but the directory now at that path is not the one that was ` +
          'created. Refusing to chown it; nothing was changed.',
      );
      return false;
    }
    fchmodSync(fd, 0o770);
    fchownSync(fd, want.uid, want.gid);
    log(`created ${path}, owned ${want.uid}:${want.gid}, mode 0770`);
    return true;
  } catch (error) {
    // Not fatal, and loud: the usual cause is running the executor as
    // something other than root, where chown of a directory to another uid is
    // simply not permitted. Say what to run rather than what failed.
    log(
      `created ${path} but could not set it to ${want.uid}:${want.gid} mode 0770 ` +
        `(${String(error)}). The container may not be able to write its spool. On the ` +
        `host: chown ${want.uid}:${want.gid} ${path} && chmod 0770 ${path}`,
    );
    return true;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* nothing useful to do about a failed close */
    }
  }
}

/**
 * NOT the spool path. This one creates a directory on the HOST, for the host
 * agent's working directory, and it is `mkdir -p` + `chown` by name because
 * nothing in the sandbox owns any part of that path. The spool's parent IS
 * owned by the sandbox, which is why `ensureSpoolDir` above refuses to repair
 * anything and does its chown through an O_NOFOLLOW descriptor. Do not point
 * this at anything an agent can write.
 *
 * Added 2026-08-11 for the host agent's working directory, whose owner is no
 * longer discoverable by `stat`ing anything. It used to be chowned to match the
 * checkout, because the session ran as the checkout's owner; the session now
 * runs as a named service account that owns nothing on this host to point at,
 * so the uid comes from `resolveAgentUser` instead.
 *
 * That is a real reversal of the rule written all over this file — "the owner
 * is discovered, never configured, because this daemon is not entitled to an
 * opinion about who owns a directory it was pointed at" — and the reversal is
 * the point of the whole rework. For a SPOOL the rule still holds: the right
 * owner there is whatever uid the container runs as, which is a fact about the
 * host that config can only get wrong. For the session's IDENTITY it was
 * exactly backwards: discovering it from the filesystem is how the session
 * ended up running as the operator, who is in the docker group.
 */
export function ensureDirOwnedBy(
  dir: string,
  want: { uid: number; gid: number },
  log: (line: string) => void,
  mode: number,
  why = '',
): void {
  let created = false;
  try {
    // 0770 rather than 0750 for spools: the container writes there. Group
    // ownership is what makes that work without the directory being
    // world-writable.
    created = mkdirSync(dir, { recursive: true, mode }) !== undefined;
  } catch (error) {
    log(`cannot create ${dir}: ${String(error)} — requests filed there will never arrive`);
    return;
  }

  let have: { uid: number; gid: number };
  try {
    const current = statSync(dir);
    have = { uid: current.uid, gid: current.gid };
  } catch (error) {
    log(`cannot stat ${dir}: ${String(error)} — leaving it alone`);
    return;
  }

  if (want.uid === have.uid && want.gid === have.gid) {
    if (created) log(`created ${dir}, already owned ${have.uid}:${have.gid}`);
    return;
  }

  try {
    chownSync(dir, want.uid, want.gid);
    log(
      `chowned ${dir} to ${want.uid}:${want.gid} ${why} — it was ` +
        `${have.uid}:${have.gid}, which the process that has to write it cannot`,
    );
  } catch (error) {
    // Loud, and with the command in it, because the alternative symptom is an
    // agent whose requests vanish, or a session that cannot start.
    log(
      `WARNING: ${dir} is owned ${have.uid}:${have.gid} but should be ` +
        `${want.uid}:${want.gid} ${why}, and chown failed (${String(error)}). Fix on the ` +
        `host with: chown ${want.uid}:${want.gid} ${dir} && chmod ` +
        `${(mode & 0o7777).toString(8).padStart(4, '0')} ${dir}`,
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
  #running = false;
  /**
   * The last complaint logged about the directory itself.
   *
   * The safety check below runs on every sweep — every five seconds, forever —
   * and a spool that has been replaced with a symlink stays replaced until a
   * human deals with it. Logging that once per sweep would bury the incident
   * in its own alarm. Repeats of the identical line are suppressed, and the
   * next state change (including a return to normal) always prints.
   */
  #complaint = '';

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
    this.#running = true;
    // The watcher is attached by #ready() once the directory is known to be a
    // real one, and re-attached if it is ever replaced. Watching first would
    // mean an fs.watch on whatever a symlink points at.
    this.#ready();

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
    this.#running = false;
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  /**
   * Is the spool a real directory that this process may sweep?
   *
   * Checked on EVERY sweep rather than once at start, and that is the fix for
   * the second half of the 2026-08-11 finding. `ensureSpoolDir` runs at start;
   * the agent owns `<stateDir>/run` for the whole life of the process and can
   * swap `ops` for a symlink at any moment after it. A check that only ran at
   * boot would leave `drain()` — which `readdir`s and, critically, `unlink`s as
   * root — pointed wherever the link went, deleting files anywhere on the host
   * that happened to end in `.json`.
   *
   * A missing directory is not a refusal: it is retried through
   * `ensureSpoolDir`, which is what makes the first-boot ordering
   * (`clawcius-ops.service` is deliberately not ordered after the instance
   * units) recover by itself once the state directory appears.
   *
   * What this is NOT is atomic, and that is worth stating rather than
   * implying. Node has no `unlinkat`, so the sweep below re-resolves the
   * directory by name for every file it removes; an attacker swapping the
   * directory for a symlink in the window between this check and one of those
   * `unlink`s could still get a file removed elsewhere. Closing that properly
   * needs a directory descriptor and `*at()` syscalls this runtime does not
   * expose. What the check does buy is that the ordinary, persistent case —
   * plant a link, wait for a restart — is refused outright and reported,
   * rather than being followed with root's privileges and no log line. The
   * residual race is in ops/README.md under "what this does not protect
   * against", where it belongs.
   */
  #ready(): boolean {
    let stat: Stats | null;
    try {
      stat = lstatOrNull(this.#dir);
    } catch (error) {
      this.#complain(`cannot inspect ${this.#dir}: ${String(error)}`);
      return false;
    }

    if (stat !== null && !stat.isDirectory()) {
      this.#complain(
        `REFUSING to sweep ${this.#dir}: it is ${describeEntry(stat)}, not a directory. ` +
          'Not following it, not reading through it and not deleting anything behind it — ' +
          'this path is inside a bind mount the container writes, and a root sweep of a ' +
          'symlink would readdir and unlink wherever it pointed. No requests from ' +
          `${this.#instance} will be seen until a human removes it.`,
      );
      return false;
    }

    if (stat === null) {
      // Gone, or never there. Recreate it the careful way, then re-check.
      const created = this.#ownerOf
        ? ensureSpoolDir(this.#dir, this.#ownerOf, (line) => this.#complain(line))
        : this.#createUnowned();
      if (!created) return false;
      try {
        stat = lstatOrNull(this.#dir);
      } catch {
        return false;
      }
      if (stat === null || !stat.isDirectory()) return false;
      // A newly created directory is a different inode, so any watcher we hold
      // is watching something that no longer exists.
      this.#attachWatch();
    }

    // ── The spool is a real directory. Can the container write it? ──────────
    //
    // Added 2026-08-11, second review of PR #8. `ensureSpoolDir` documented —
    // and implemented — a loud warning for an existing, wrongly-owned spool,
    // and the daemon could not reach it: this method only called that function
    // when the directory was MISSING, and an existing one fell straight
    // through to `return true`. So the realistic state — `run-container.sh`'s
    // `mkdir -p "$OPS_DIR"` running as root because the executor invoked
    // `--recreate`, or an in-place upgrade from the build whose repair did not
    // work, or a manual root `mkdir` — produced a root-owned spool that was
    // swept happily forever while the container (uid 1000) got EACCES on every
    // `mv`, its requests vanished, and NOTHING was logged. That is the exact
    // silent-failure shape this whole change exists to abolish.
    //
    // Still not repaired, for the reason in the header: the parent belongs to
    // the party we are defending against. Reported, once, with the command to
    // run — and swept anyway, because sweeping a real directory is safe and
    // the operator may have fixed the mode without the owner.
    const warning = this.#ownerOf === '' ? null : ownershipWarning(this.#dir, this.#ownerOf, stat);
    if (warning === null) {
      this.#complaint = '';
    } else {
      // Through #complain, so a spool that stays wrong does not print the same
      // line every five seconds until somebody deals with it.
      this.#complain(warning);
    }

    if (this.#running && this.#watcher === null) this.#attachWatch();
    return true;
  }

  /** The no-`ownerOf` path, used by the self-test and by nothing on the host. */
  #createUnowned(): boolean {
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o770 });
      return true;
    } catch (error) {
      this.#complain(`cannot create ${this.#dir}: ${String(error)}`);
      return false;
    }
  }

  #attachWatch(): void {
    if (!this.#running) return;
    this.#watcher?.close();
    this.#watcher = null;
    try {
      this.#watcher = watch(this.#dir, () => this.drain());
    } catch (error) {
      this.#log(`cannot watch ${this.#dir}: ${String(error)} — polling only`);
    }
  }

  #complain(line: string): void {
    if (line === this.#complaint) return;
    this.#complaint = line;
    this.#log(line);
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
      // Before anything is read, and before anything is unlinked. See #ready.
      if (!this.#ready()) return;

      let names: string[];
      try {
        names = readdirSync(this.#dir);
      } catch (error) {
        this.#complain(`cannot read ${this.#dir}: ${String(error)}`);
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
        // Opened O_NOFOLLOW, and every decision made against the FD rather
        // than the name, since 2026-08-11.
        //
        // These files are written by the container. `req.json` can be a
        // symlink to anything root can read — `/root/.ssh/id_rsa`, whose
        // contents would then go through the parser and into the journal as a
        // "malformed request" — or a FIFO, which would block the sweep, and
        // with it the daemon that holds every rollback deadline, forever.
        // O_NONBLOCK is what makes the FIFO case an error instead of a hang.
        //
        // And the size check is made with `fstat` on the open descriptor, not
        // `stat` on the path, because the two are not the same check: between
        // a `stat` that says 40 bytes and an `open` a moment later, the writer
        // owns the directory and can put something else there. What is read is
        // now the object that was measured, or nothing is.
        let fd: number;
        try {
          fd = openSync(
            path,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
          );
        } catch (error) {
          this.#log(`${name}: could not open it as a plain file (${String(error)}), discarded`);
          this.#discard(path);
          processed += 1;
          continue;
        }

        try {
          const stat = fstatSync(fd);
          if (!stat.isFile()) {
            this.#log(`${name}: not a regular file, discarded unread`);
            this.#discard(path);
            processed += 1;
            continue;
          }
          if (stat.size > this.#maxBytes) {
            // Never read. The point of checking size first is that the
            // oversized case costs a stat, not a read.
            this.#log(
              `${name}: ${stat.size} bytes exceeds the ${this.#maxBytes}-byte cap, ` +
                'discarded unread',
            );
            this.#discard(path);
            processed += 1;
            continue;
          }
          body = readFileSync(fd, 'utf8');
        } catch (error) {
          this.#log(`${name}: could not read (${String(error)})`);
          this.#discard(path);
          processed += 1;
          continue;
        } finally {
          try {
            closeSync(fd);
          } catch {
            /* nothing useful to do about a failed close */
          }
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
