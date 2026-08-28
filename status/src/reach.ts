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
  detail: string;
  checkedAt: string;
};

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

function describeType(info: Stats): string {
  if (info.isDirectory()) return 'a directory';
  if (info.isFile()) return 'a regular file';
  if (info.isSocket()) return 'a socket';
  if (info.isFIFO()) return 'a FIFO';
  if (info.isBlockDevice()) return 'a block device';
  if (info.isCharacterDevice()) return 'a character device';
  return 'something else';
}

export async function probeAll(targets: readonly ReachTarget[]): Promise<ReachResult[]> {
  return Promise.all(targets.map((target) => probe(target)));
}

/** The paths this service's answers actually depend on. */
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
