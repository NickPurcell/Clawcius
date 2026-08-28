import { DatabaseSync } from 'node:sqlite';
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';

/** One row of the `agents` table, as the page needs it. */
export type RegistryAgent = {
  /** `hamachi-engineer1`, or a Discord channel id for a migrated row. */
  id: string;
  crew: string;
  role: string;
  /** The session it resumes. Empty before its first run. */
  sessionId: string;
  workspacePath: string;
  /** `slug(workspacePath)` — the transcript directory this agent writes into. */
  projectSlug: string;
  /** `status` verbatim from the row. */
  declaredStatus: string;
  spawnedBy: string | null;
  spawnedAt: string | null;
  lastActiveAt: string | null;
};

export type RegistrySnapshot = {
  /** False when this instance has no `boardDb` in status-config.yaml. */
  configured: boolean;
  agents: RegistryAgent[];
  /** A sentence when the board could not be read. Rendered, never swallowed. */
  error: string | null;
};

const SLUG_MAX_LENGTH = 200;

function slugHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/**
 * Claude Code's project-directory slug, ported exactly from
 * `@anthropic-ai/claude-agent-sdk`: every character outside `[A-Za-z0-9]`
 * becomes `-` (so real slugs start with a dash), and above 200 characters it
 * truncates and appends a base-36 hash. `slug(workspace_path)` names the
 * agent's transcript directory, so this must match upstream, not improve on it.
 */
export function slugifyWorkspace(workspacePath: string): string {
  const dashed = workspacePath.replace(/[^A-Za-z0-9]/g, '-');
  if (dashed.length <= SLUG_MAX_LENGTH) return dashed;
  return `${dashed.slice(0, SLUG_MAX_LENGTH)}-${Math.abs(slugHash(workspacePath)).toString(36)}`;
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const SQLITE_READONLY = 8;

/** Whatever is wrong with the path itself, or null if nothing is. */
function describePathTrouble(dbPath: string): string | null {
  try {
    if (!statSync(dbPath).isFile()) {
      return `${dbPath} is not a regular file, so it is not a board. Nothing was opened.`;
    }
    accessSync(dbPath, fsConstants.R_OK);
    return null;
  } catch (error) {
    // `existsSync` is not enough to tell these apart: it answers false for a
    // file that is there and unreadable, which would send someone off to fix a
    // path that was correct all along.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return (
        `${dbPath} does not exist. It must be the same file as that instance's ` +
        'CLAWCIUS_DB_PATH — the board is never created here, because an empty second ' +
        'database would render as a crew with no agents.'
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return (
        `${dbPath} exists and is not readable by this service (${code}). The board is ` +
        "owned by the instance's waker account; this service runs as the same user on " +
        'this deployment, so this means the ownership or the mode has changed.'
      );
    }
    return `${dbPath} could not be examined: ${error instanceof Error ? error.message : error}`;
  }
}

export function describeBoardError(dbPath: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const extended = (error as { errcode?: unknown }).errcode;
  const primary = typeof extended === 'number' ? extended & 0xff : null;

  const trouble = describePathTrouble(dbPath);
  if (trouble !== null) return trouble;

  if (primary === SQLITE_READONLY) {
    const shm = existsSync(`${dbPath}-shm`);
    // Reports the observation and names the candidates; it does not conclude which process is missing.
    return (
      `${dbPath} could not be read (${message}). ` +
      (shm
        ? 'Its -shm wal-index exists but could not be used, so no live writer holds this ' +
          'board open and recovering the index would need a write. '
        : 'Its -shm wal-index is absent, so no process currently holds this board open. ') +
      'This service runs under ProtectSystem=strict and cannot create or repair the -shm ' +
      'itself, so the board stays unreadable until something that can write beside it ' +
      "opens it — normally that instance's waker, and the ops daemon too where one is " +
      'configured. Transcripts are unaffected; they are read straight off disk.'
    );
  }

  return `${dbPath} could not be read: ${message}`;
}

export function readRegistry(dbPath: string | null): RegistrySnapshot {
  if (dbPath === null) {
    return {
      configured: false,
      agents: [],
      error: null,
    };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT id, crew, role, session_id, workspace_path, status,
                spawned_by, spawned_at, last_active_at
           FROM agents
          ORDER BY crew, role, id`,
      )
      .all() as Array<Record<string, unknown>>;

    return {
      configured: true,
      error: null,
      agents: rows.map((row) => {
        const workspacePath = asString(row['workspace_path']);
        return {
          id: asString(row['id']),
          crew: asString(row['crew']),
          role: asString(row['role']),
          sessionId: asString(row['session_id']),
          workspacePath,
          projectSlug: slugifyWorkspace(workspacePath),
          declaredStatus: asString(row['status']),
          spawnedBy: typeof row['spawned_by'] === 'string' ? row['spawned_by'] : null,
          spawnedAt: toIso(row['spawned_at']),
          lastActiveAt: toIso(row['last_active_at']),
        };
      }),
    };
  } catch (error) {
    return { configured: true, agents: [], error: describeBoardError(dbPath, error) };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
