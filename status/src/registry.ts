import { DatabaseSync } from 'node:sqlite';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';

/** One row of the `agents` table, as the page needs it. */
export type RegistryAgent = {
  /** `hamachi-engineer1`, or a Discord channel id for a coordinator. */
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
  lastActiveAt: number | null;
};

export type RegistrySnapshot = {
  agents: RegistryAgent[];
  /** One sentence when the board could not be read. */
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
 * Claude Code's project-directory slug, ported exactly from the agent SDK:
 * every character outside `[A-Za-z0-9]` becomes `-`, and above 200 characters
 * it truncates and appends a base-36 hash of the original path.
 */
export function slugifyWorkspace(workspacePath: string): string {
  const dashed = workspacePath.replace(/[^A-Za-z0-9]/g, '-');
  if (dashed.length <= SLUG_MAX_LENGTH) return dashed;
  return `${dashed.slice(0, SLUG_MAX_LENGTH)}-${Math.abs(slugHash(workspacePath)).toString(36)}`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const SQLITE_READONLY = 8;

/** One sentence: what is wrong with the board and what would fix it. */
export function describeBoardError(dbPath: string, error: unknown): string {
  try {
    if (!statSync(dbPath).isFile()) return `${dbPath} is not a regular file; point boardDb at the crew's CLAWCIUS_DB_PATH.`;
    accessSync(dbPath, fsConstants.R_OK);
  } catch (trouble) {
    const code = (trouble as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return `${dbPath} does not exist; point boardDb at the crew's CLAWCIUS_DB_PATH.`;
    if (code === 'EACCES' || code === 'EPERM') return `${dbPath} is not readable by this service (${code}); fix its owner or mode.`;
  }

  const message = error instanceof Error ? error.message : String(error);
  const extended = (error as { errcode?: unknown }).errcode;
  if (typeof extended === 'number' && (extended & 0xff) === SQLITE_READONLY) {
    return `${dbPath} has no writer holding it open, so its WAL index cannot be read; start the crew's waker.`;
  }
  return `${dbPath} could not be read: ${message}`;
}

export function readRegistry(dbPath: string | null): RegistrySnapshot {
  if (dbPath === null) return { agents: [], error: null };

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT id, crew, role, session_id, workspace_path, status, spawned_by, last_active_at
           FROM agents
          ORDER BY crew, role, id`,
      )
      .all() as Array<Record<string, unknown>>;

    return {
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
          lastActiveAt: asMs(row['last_active_at']),
        };
      }),
    };
  } catch (error) {
    return { agents: [], error: describeBoardError(dbPath, error) };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
