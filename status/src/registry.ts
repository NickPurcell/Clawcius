/**
 * The agent registry, read out of each instance's board database.
 *
 * Until this file existed the page enumerated the filesystem: every directory
 * under a `projectsRoot` became a row, which is why Clawcius showed 49
 * "sessions" and why three of Hamachi's five "agents" were `/tmp` scratch
 * directories left behind by permission probes. A directory is not an agent.
 * The registry is where the agents actually are — `src/store.ts`, table
 * `agents`, one row per identity — so that is what the page now lists.
 *
 * ── The join, and why it needs no schema change ─────────────────────────────
 *
 * Claude Code names a project directory by slugifying the cwd: every character
 * that is not `[A-Za-z0-9]` becomes `-`. The registry stores `workspace_path`
 * for every agent, and the waker spawns that agent with exactly that path as
 * its cwd (`src/agent.ts`, `cwd: this.workspacePath`). So
 *
 *     slug('/var/lib/hamachi/workspaces/1467070145343258628')
 *       === '-var-lib-hamachi-workspaces-1467070145343258628'
 *
 * names that agent's transcript directory, and every `.jsonl` in it is one of
 * that agent's sessions — the one it is resuming, and every one it has had
 * before. Two strings, one substitution apart. Verified against this host on
 * 2026-08-16: the five directories under Hamachi's root are the two workspaces
 * the waker has ever used plus `-tmp-ojperm`, `-tmp-ojprobe` and
 * `-tmp-permtest`, and only the workspace ones appear in `workspace_path`.
 *
 * ── Read-only, and what that costs on this host ─────────────────────────────
 *
 * The waker holds this database open and writes to it live. So it is opened
 * `readOnly`, which SQLite enforces — a second writer, or a lock that stalled
 * the waker mid-turn, would be far worse than a page that cannot render.
 *
 * There is a real hazard in that, on this deployment specifically, and it is
 * documented here rather than worked around because working around it would
 * mean giving this service a writable path:
 *
 *   The board is in WAL mode. A reader of a WAL database needs the `-shm`
 *   wal-index. If one already exists it can be mapped read-only; if it does
 *   NOT exist, SQLite must create it, and creating it requires WRITE access to
 *   the directory. `clawcius-status.service` runs `ProtectSystem=strict`, so
 *   its whole filesystem is read-only and it can create nothing.
 *
 *   While the waker is running the `-shm` exists and reads succeed. When the
 *   waker has exited CLEANLY, SQLite deletes `-wal` and `-shm` on the last
 *   close, and the next read here fails with "attempt to write a readonly
 *   database". Measured, not inferred: reproduced on 2026-08-16 with node 22's
 *   `node:sqlite` against a WAL database in a directory with mode 555 —
 *   writer live, read succeeds; writer cleanly gone, `SELECT` fails; writer
 *   SIGKILLed so the sidecars survive, read succeeds.
 *
 * That is the one state where this page most wants to be useful, so the
 * failure is reported in words on the page — naming the waker — instead of
 * rendering an empty roster that looks like a host with no agents. See the
 * `-shm` check in `describeRegistryError`. Clawcius issue filed alongside this
 * change; the fix is the operator's to choose, because every candidate
 * (a `ReadWritePaths=` line, a dedicated read-only account, taking the board
 * out of WAL) changes something outside this service.
 *
 * ── Opened per read, not held ───────────────────────────────────────────────
 *
 * A registry is a handful of rows and opening SQLite is a couple of syscalls,
 * so there is no cache and no long-lived handle. That buys two things worth
 * more than the microseconds: every read re-reports the current truth,
 * including "the waker is down and this is no longer readable", and a waker
 * restart — which deletes and recreates the `-shm` underneath us — cannot
 * leave this process holding a mapping of a file that no longer exists.
 *
 * Unlike `ops/src/board.ts` there is no `lstat` guard on the path here. That
 * one runs as root and refuses to follow a symlink for that reason; this runs
 * as npurcell, the board sits in the instance's state directory a level above
 * anything `docker/run-container.sh` bind-mounts, and nothing in a container
 * has a path to it.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

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
  /**
   * `status` verbatim from the row.
   *
   * Named `declaredStatus` and not `status` on purpose. It is written, never
   * observed: a kill writes `dead` and a crash writes nothing, so the word
   * alone is not evidence that anything is running. It is always shown beside
   * `lastActiveAt`, which is.
   */
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

/**
 * Claude Code's project-directory naming, reimplemented.
 *
 * Every character outside `[A-Za-z0-9]` becomes `-`, including the leading
 * slash — which is why every real slug on this host starts with a dash, and
 * why `isValidProjectSlug` in transcripts.ts allows one. There is no escaping
 * and no collision avoidance in it: `/a/b` and `/a-b` slugify identically.
 * That is upstream's rule and this has to match it exactly, not improve on it.
 */
export function slugifyWorkspace(workspacePath: string): string {
  return workspacePath.replace(/[^A-Za-z0-9]/g, '-');
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Turn a failed read into something a person can act on.
 *
 * The `-shm` check is what distinguishes the deployment hazard in the header
 * from an ordinary permissions problem, and it is a file test rather than a
 * match on SQLite's message text — "attempt to write a readonly database" is
 * prose and is not the only wording that reaches here.
 */
function describeRegistryError(dbPath: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (!existsSync(dbPath)) {
    return (
      `${dbPath} does not exist. It must be the same file as that instance's ` +
      'CLAWCIUS_DB_PATH — the board is never created here, because an empty second ' +
      'database would render as a crew with no agents.'
    );
  }

  if (!existsSync(`${dbPath}-shm`)) {
    return (
      `${dbPath} could not be read (${message}). Its -shm wal-index is absent, which ` +
      'means no process currently holds the board open — the waker for this instance is ' +
      'down. This service runs under ProtectSystem=strict and cannot create the -shm ' +
      'itself, so the registry is unreadable until the waker is back. Transcripts below ' +
      'are unaffected; they are read straight off disk.'
    );
  }

  return `${dbPath} could not be read: ${message}`;
}

/**
 * A read of one instance's board.
 *
 * Never throws. Every failure becomes `error` on the snapshot, because one
 * instance whose waker is down must not blank the page for the one that is
 * running — the same rule the transcript roots already follow.
 */
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
    return { configured: true, agents: [], error: describeRegistryError(dbPath, error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a handle that never opened is not a failure worth reporting */
    }
  }
}
