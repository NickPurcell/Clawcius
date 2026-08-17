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
 *   While SOME writer holds the board open the `-shm` exists and reads
 *   succeed. When the last one has exited CLEANLY, SQLite deletes `-wal` and
 *   `-shm` on that close, and the next read here fails with "attempt to write
 *   a readonly database". Measured, not inferred: reproduced on 2026-08-16
 *   with node 22's `node:sqlite` against a WAL database in a directory with
 *   mode 555 — writer live, read succeeds; writer cleanly gone, `SELECT`
 *   fails; writer SIGKILLed so the sidecars survive, read succeeds.
 *
 *   "Some writer" and not "the waker": `ops/src/host-mailbox.ts` holds a Board
 *   open for the ops daemon's lifetime wherever a `board:` block is
 *   configured, which is both instances. Only the two waker processes hold the
 *   boards today, so the behaviour above is what this host does — but the page
 *   reports the observation rather than concluding which daemon is missing.
 *
 * That is the one state where this page most wants to be useful, so the
 * failure is reported in words on the page instead of rendering an empty
 * roster that looks like a host with no agents. See `describeBoardError`.
 * Clawcius #72; the fix is the operator's to choose, because every candidate
 * (a `ReadWritePaths=` line, a dedicated read-only account, taking the board
 * out of WAL) changes something outside this service.
 *
 * ── Opened per read, not held ───────────────────────────────────────────────
 *
 * A registry is a handful of rows and opening SQLite is a couple of syscalls,
 * so there is no cache and no long-lived handle. That buys two things worth
 * more than the microseconds: every read re-reports the current truth,
 * including "nothing holds this open any more and it is no longer readable",
 * and a writer restart — which deletes and recreates the `-shm` underneath us
 * — cannot leave this process holding a mapping of a file that is gone.
 *
 * Unlike `ops/src/board.ts` there is no `lstat` guard on the path here. That
 * one runs as root and refuses to follow a symlink for that reason; this runs
 * as npurcell, the board sits in the instance's state directory a level above
 * anything `docker/run-container.sh` bind-mounts, and nothing in a container
 * has a path to it.
 */

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
 * and no collision avoidance below 200 characters: `/a/b` and `/a-b` slugify
 * identically. That is upstream's rule and this has to match it exactly, not
 * improve on it.
 *
 * Above 200 characters upstream truncates and appends a hash, and this does
 * too. Ported from `@anthropic-ai/claude-agent-sdk`, which is the dependency
 * that writes these directories:
 *
 *     var dc = 200;
 *     function lE(e){let t=0;for(let r=0;r<e.length;r++)t=(t<<5)-t+e.charCodeAt(r)|0;return t}
 *     function lEe(e){return Math.abs(lE(e)).toString(36)}
 *     function us(e){let t=e.replace(/[^a-zA-Z0-9]/g,"-");
 *                    if(t.length<=dc)return t;
 *                    return `${t.slice(0,dc)}-${lEe(e)}`}
 *
 * Three details that are easy to get wrong and are load-bearing: the hash is
 * of the ORIGINAL path, not of the dashed string; it is a signed 32-bit
 * accumulator (`|0`) rendered in base 36 through `Math.abs`; and it runs over
 * UTF-16 code units, so `charCodeAt` in a loop is the faithful port rather
 * than iterating code points. The output was compared against the bundled
 * implementation over ordinary, boundary, over-length and non-ASCII paths on
 * 2026-08-16 and agreed on all of them.
 *
 * Nothing on this host is near 200 characters —
 * `/var/lib/clawcius/workspaces/<channelId>` is about 47 — so the branch is
 * latent here. It is ported anyway because the alternative is a function that
 * silently returns a directory name that does not exist, and the symptom of
 * that is an agent whose sessions all appear under "other".
 *
 * NOTE that no test in this repository can detect upstream CHANGING this rule:
 * both sides of the comparison live here, and `status/` does not depend on the
 * SDK. The tests pin the reimplementation against known-good constants and
 * nothing more. Clawcius #78, with the options and what each costs.
 */
const SLUG_MAX_LENGTH = 200;

function slugHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

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

/**
 * SQLite primary result codes, the ones this file distinguishes.
 *
 * `node:sqlite` puts the EXTENDED code on `error.errcode` — the WAL failure in
 * the header arrives as 1544, `SQLITE_READONLY_DIRECTORY` — so the low byte is
 * what identifies the family. Reading a number is the point: the message text
 * is prose, and the first version of this function branched on the presence of
 * a `-shm` file alone and therefore told an operator that the waker was down
 * when the real answer was "that file is not a database".
 */
const SQLITE_READONLY = 8;

/** Whatever is wrong with the path itself, or null if nothing is. */
function describePathTrouble(dbPath: string): string | null {
  try {
    if (!statSync(dbPath).isFile()) {
      return `${dbPath} is not a regular file, so it is not a board. Nothing was opened.`;
    }
    // `statSync` alone does not answer this: stat succeeds on a mode-000 file,
    // because what it needs is search permission on the directory. Readability
    // has to be asked for directly or an unreadable board falls through to
    // SQLite's "unable to open database file", which is the same message a
    // missing one produces.
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

/**
 * Turn a failed read into something a person can act on.
 *
 * Exported because the board holds more than the registry: `mail.ts` opens the
 * same file with the same discipline and fails in exactly the same ways, and
 * two copies of this triage would drift into disagreeing about what a missing
 * `-shm` means.
 *
 * The waker is only named when the failure is actually consistent with the
 * waker being down: SQLite said READONLY, which on a database this service can
 * read means it could not get at the WAL index. Everything else keeps its own
 * diagnosis — "file is not a database" and "no such table: agents" are
 * different problems with different fixes, and collapsing them into "the waker
 * is down" sends someone to restart a service that is fine.
 */
export function describeBoardError(dbPath: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const extended = (error as { errcode?: unknown }).errcode;
  const primary = typeof extended === 'number' ? extended & 0xff : null;

  // Asked first whatever SQLite said, because a path that is missing,
  // unreadable or not a file explains every error code better than the code
  // does — SQLITE_CANTOPEN above all, which is one message for all three.
  const trouble = describePathTrouble(dbPath);
  if (trouble !== null) return trouble;

  if (primary === SQLITE_READONLY) {
    const shm = existsSync(`${dbPath}-shm`);
    // Reports the observation and names the candidates; it does not conclude
    // which process is missing. "The -shm is gone, therefore the waker is
    // down" holds only while the waker is the sole writer, and this repository
    // already contains a second one — ops/src/host-mailbox.ts holds a Board
    // open for the ops daemon's lifetime wherever a `board:` block is
    // configured, which is both instances. Naming a specific service here
    // would send someone to restart the wrong one the day that ships.
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

/**
 * A read of one instance's board.
 *
 * Never throws. Every failure becomes `error` on the snapshot, because one
 * instance whose board cannot be read must not blank the page for the one
 * whose can — the same rule the transcript roots already follow.
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
    return { configured: true, agents: [], error: describeBoardError(dbPath, error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a handle that never opened is not a failure worth reporting */
    }
  }
}
