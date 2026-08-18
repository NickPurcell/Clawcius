/**
 * What this process can actually reach, as opposed to what it was configured
 * with.
 *
 * ── The difference, and why it is the whole point ───────────────────────────
 *
 * Until 2026-08-18 the boot banner said:
 *
 *     [status]   clawcius: /var/lib/clawcius/agent-home/projects
 *
 * That line is a statement about `status-config.yaml`. It is printed whether
 * the directory exists, whether it is a directory at all, and whether this
 * process — running as `npurcell`, under a unit with its own filesystem
 * settings — has any right to read it. It would have printed exactly the same
 * eight characters on a host where the path had been renamed.
 *
 * A verifier reading a journal needs the other statement: for each configured
 * path, is it there, can THIS process read it, and if not, why not. That is a
 * fact about the world, and it is the fact that turns "the page is empty" from
 * a mystery into a line with an errno in it.
 *
 * ── What this does NOT answer, and where that already lives ────────────────
 *
 * A board here is probed as a FILE: does it exist, is it a regular file, can
 * this process open it for reading. That is deliberately not the same question
 * as "can this service read the board", and the difference is #72: the boards
 * are SQLite in WAL mode, a read-only reader needs the `-shm` wal-index, and
 * under `ProtectSystem=strict` this service cannot create one — so while no
 * writer holds the board open, a perfectly readable file still cannot be
 * queried. That case is diagnosed by `describeBoardError` in registry.ts and
 * already reaches the API as `registryError`.
 *
 * It is not duplicated here on purpose. Two independent accounts of the same
 * fact can disagree, and the one that opens the database is the one that knows.
 * What this module adds is the layer underneath: a board that has been renamed,
 * deleted, or made unreadable to this uid never gets as far as a WAL problem,
 * and until now nothing said so at boot.
 *
 * ── Why the probes are re-run on every `/healthz`, not cached from boot ─────
 *
 * A boot-time snapshot served for the life of the process is a claim that
 * outlives the condition it was true of, which is the same defect as the stale
 * `dist/`: `/var/lib/clawcius/agent-home/projects` disappearing at 3am would go
 * on being reported as readable until somebody restarted the service. Every
 * result carries `checkedAt` so it cannot be read as anything other than a
 * statement about a moment.
 *
 * The cost is a handful of `stat`/`readdir` calls per request on a loopback-
 * only page. There is no cache and no rate limit, deliberately.
 *
 * ── Why `readdir` and not `access(R_OK)` ────────────────────────────────────
 *
 * `access(2)` answers with the REAL uid, and it answers about the permission
 * bits rather than about the operation. The operation this service performs on
 * a projects root is "list it", and the only reliable way to learn whether that
 * works is to do it. It also yields the entry count, which is the cheapest
 * available answer to "is this the right directory or an empty one somebody
 * created by mistake".
 */

import type { Stats } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';

export type ReachKind = 'directory' | 'file';

export type ReachTarget = {
  /** Which instance this belongs to — an agent id, or `oj`. */
  scope: string;
  /** What it is, in words a reader of a journal can act on. */
  what: string;
  path: string;
  kind: ReachKind;
};

export type ReachResult = ReachTarget & {
  ok: boolean;
  /** What was found. On failure, why — errno first. */
  detail: string;
  checkedAt: string;
};

/**
 * errno, in a sentence.
 *
 * The code is kept verbatim in the detail as well: it is the thing worth
 * grepping for, and the prose is for the person who has not met `ENOTDIR`.
 */
function explain(code: string | undefined): string {
  switch (code) {
    case 'ENOENT':
      return 'nothing exists at this path';
    case 'EACCES':
    case 'EPERM':
      return 'it exists and this process is not permitted to read it';
    case 'ENOTDIR':
      return 'a component of the path is not a directory';
    case 'ELOOP':
      return 'too many symbolic links — a link points at itself or at a cycle';
    case 'ENAMETOOLONG':
      return 'the path is too long for this filesystem';
    case 'EIO':
      return 'the filesystem returned an I/O error — suspect the disk or the mount';
    default:
      return 'see the errno';
  }
}

function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code ?? 'unknown';
}

function failure(error: unknown): string {
  const code = errnoOf(error);
  const message = error instanceof Error ? error.message : String(error);
  return `${code}: ${explain(code === 'unknown' ? undefined : code)} (${message})`;
}

/** `0750`, the way it appears in every chmod anyone will type in response. */
function modeOf(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

/**
 * The identity the answers are about.
 *
 * Printed alongside the results because "not readable" is only actionable next
 * to "by whom" — the recurring fix on this host is a supplementary group, and
 * that conversation starts with a uid.
 */
export function processIdentity(): string {
  // Windows has neither; this service is Linux-only but the types are optional.
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const gid = typeof process.getgid === 'function' ? process.getgid() : -1;
  const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
  return `uid ${uid}, gid ${gid}, groups [${groups.join(', ')}]`;
}

export async function probe(target: ReachTarget): Promise<ReachResult> {
  const checkedAt = new Date().toISOString();
  const done = (ok: boolean, detail: string): ReachResult => ({ ...target, ok, detail, checkedAt });

  let info;
  try {
    // `stat`, not `lstat`: a symlinked root is a normal deployment and the
    // question is about the target, not about the link.
    info = await stat(target.path);
  } catch (error) {
    return done(false, failure(error));
  }

  if (target.kind === 'directory' && !info.isDirectory()) {
    return done(false, `not a directory — this path is ${describeType(info)}`);
  }
  if (target.kind === 'file' && !info.isFile()) {
    return done(false, `not a regular file — this path is ${describeType(info)}`);
  }

  const owner = `mode ${modeOf(info.mode)}, owned by uid ${info.uid}:gid ${info.gid}`;

  if (target.kind === 'directory') {
    try {
      const entries = await readdir(target.path);
      return done(
        true,
        `readable directory, ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ` +
          `${owner}, modified ${info.mtime.toISOString()}`,
      );
    } catch (error) {
      return done(false, `${failure(error)}; ${owner}`);
    }
  }

  try {
    // Opening for read is the operation; `access` would answer a slightly
    // different question with the real uid rather than the effective one.
    const handle = await open(target.path, 'r');
    await handle.close();
    return done(
      true,
      `readable file, ${info.size} bytes, ${owner}, modified ${info.mtime.toISOString()}`,
    );
  } catch (error) {
    return done(false, `${failure(error)}; ${owner}`);
  }
}

/**
 * What a path turned out to be, when it was not what the config implied.
 *
 * No symlink case: this uses `stat` rather than `lstat`, so a link is either
 * followed to its target or has already failed with ENOENT above.
 */
function describeType(info: Stats): string {
  if (info.isDirectory()) return 'a directory';
  if (info.isFile()) return 'a regular file';
  if (info.isSocket()) return 'a socket';
  if (info.isFIFO()) return 'a FIFO';
  if (info.isBlockDevice()) return 'a block device';
  if (info.isCharacterDevice()) return 'a character device';
  return 'something else';
}

/**
 * Every target, probed concurrently.
 *
 * Concurrent because they are independent and one of them being on a hung NFS
 * mount should not serialise the rest behind it. Order is preserved so the
 * banner reads the same every boot.
 */
export async function probeAll(targets: readonly ReachTarget[]): Promise<ReachResult[]> {
  return Promise.all(targets.map((target) => probe(target)));
}

/**
 * The paths this service's answers actually depend on.
 *
 * Sockets are deliberately absent: they are bound rather than read, and their
 * outcome is already reported per-socket on `/healthz` by `bindUnixSockets`.
 * Duplicating them here would produce two accounts of the same fact that could
 * disagree.
 */
export function targetsFor(config: {
  agents: readonly { id: string; projectsRoot: string; boardDb: string | null }[];
  oj: { workersRoot: string };
}): ReachTarget[] {
  const targets: ReachTarget[] = [];
  for (const agent of config.agents) {
    targets.push({
      scope: agent.id,
      what: 'projects root (sessions and transcripts)',
      path: agent.projectsRoot,
      kind: 'directory',
    });
    if (agent.boardDb !== null) {
      targets.push({
        scope: agent.id,
        // "file" rather than "board", because that is honestly all this
        // checks — whether it can be QUERIED is registry.ts's answer and is
        // reported separately as `registryError`. See the header.
        what: 'Clawsky board file (/api/clawsky)',
        path: agent.boardDb,
        kind: 'file',
      });
    }
  }
  targets.push({
    scope: 'oj',
    what: 'OJ workers root (/api/oj)',
    path: config.oj.workersRoot,
    kind: 'directory',
  });
  return targets;
}
