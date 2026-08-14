/**
 * The agent registry: who exists, and which session each of them resumes.
 *
 * This began as a Discord-thread → session-id map, and the shape survives
 * because Clawsky's identity model is that table with the key generalised: an
 * agent is a row, not a process. The id is the identity and the session id is
 * a field on it. That ordering is load-bearing — a session id does not exist
 * until the session starts, so it cannot be what mints the name, and an agent
 * resurrected under a new session id must still be the same agent or its mail
 * history detaches from it.
 *
 * `status` is declared, never observed. With agents resumed rather than
 * resident there is no process to look at: a kill writes `dead`, and an agent
 * that dies mid-turn from a crash writes nothing at all. `lastActiveAt` is
 * what makes that survivable — `live` with a fortnight-old `lastActiveAt`
 * reads differently from `dead` without inventing a third state, and it is
 * honest about the case where nobody actually knows.
 *
 * MIGRATION. The live deployment has real rows in `thread_sessions`, one per
 * Discord channel, and losing them means every conversation restarts cold with
 * no warning that it did. So they are COPIED into `agents` exactly once
 * (guarded by `PRAGMA user_version`) and the old table is left precisely where
 * it is. A rollback to the previous `dist/` then finds its data intact, which
 * matters more than tidiness on a deployment where a stale `dist/` is the most
 * common way this system breaks. The copy is one-way and one-time: rows added
 * to `thread_sessions` afterwards are not picked up, because after this ships
 * nothing writes there.
 *
 * A migrated row keeps its Discord channel id as its agent id. That id is what
 * the Discord layer looks sessions up by, so renaming it here would detach
 * every live session from its channel — the exact failure the registry exists
 * to prevent.
 *
 * Uses Node's built-in SQLite (node:sqlite) so there is no native dependency
 * to compile, which matters on a small VM where node-gyp costs both build time
 * and memory.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The four crew roles, and `host`.
 *
 * `coordinator` is the default for anything that predates the registry, because
 * the only agents that existed before it were the ones Discord wakes, and
 * Discord stays with the coordinator.
 *
 * `host` is not a crew member. It is the account on the VPS that runs commands,
 * given a registry row and a mailbox so that reaching it is a DM rather than a
 * queue. It is a role rather than a naming convention because two rules key off
 * it and neither should be a string comparison against an id: only a
 * coordinator may DM it (mail.ts), and nothing inside a container may run it —
 * the ops executor owns that mailbox, from the host (src/mail-wake.ts).
 */
export type AgentRole = 'coordinator' | 'engineer' | 'researcher' | 'poster' | 'host';

export const AGENT_ROLES: readonly AgentRole[] = [
  'coordinator',
  'engineer',
  'researcher',
  'poster',
  'host',
];

/**
 * The host agent's id in a given crew.
 *
 * Derived rather than configured, so the executor on the host and the waker in
 * the container arrive at the same name without a shared config file — they
 * have no other way to agree on one. The role on the row is what carries the
 * meaning; this is only how the row is found.
 */
export function hostAgentId(crew: string): string {
  return `${crew}-host`;
}

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

export type AgentStatus = 'live' | 'dead';

export type AgentRecord = {
  /** `hamachi-engineer1`, or a Discord channel id for a migrated row. */
  id: string;
  crew: string;
  role: AgentRole;
  /** Empty until the agent's first run, and rewritten on resurrection. */
  sessionId: string;
  workspacePath: string;
  status: AgentStatus;
  /** The agent that spawned this one, or null for operator-created rows. */
  spawnedBy: string | null;
  spawnedAt: number;
  lastActiveAt: number;
};

export type AgentIdentity = {
  crew: string;
  role: AgentRole;
  workspacePath: string;
  spawnedBy?: string | null;
};

const COLUMNS = `id, crew, role, session_id, workspace_path, status,
                 spawned_by, spawned_at, last_active_at`;

function toRecord(row: Record<string, unknown>): AgentRecord {
  return {
    id: row['id'] as string,
    crew: row['crew'] as string,
    role: row['role'] as AgentRole,
    sessionId: row['session_id'] as string,
    workspacePath: row['workspace_path'] as string,
    status: row['status'] as AgentStatus,
    spawnedBy: (row['spawned_by'] as string | null) ?? null,
    spawnedAt: row['spawned_at'] as number,
    lastActiveAt: row['last_active_at'] as number,
  };
}

export class AgentRegistry {
  readonly #db: DatabaseSync;
  /** Crew and role given to rows migrated from `thread_sessions`. */
  readonly #migrationCrew: string;

  constructor(dbPath: string, options: { crew: string }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#migrationCrew = options.crew;

    // WAL keeps reads from blocking the writer, which matters because the
    // Discord gateway handler, the mail drop and the agent stream all touch
    // this.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id             TEXT PRIMARY KEY,
        crew           TEXT NOT NULL,
        role           TEXT NOT NULL,
        session_id     TEXT NOT NULL DEFAULT '',
        workspace_path TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'live',
        spawned_by     TEXT,
        spawned_at     INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      )
    `);
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_agents_crew ON agents (crew)');
    this.#migrate();
  }

  /**
   * Copy the pre-Clawsky Discord sessions in, once.
   *
   * `user_version` rather than a marker table: it is a single integer SQLite
   * already carries, it survives a rollback (the old code never reads it), and
   * it cannot be half-written. `INSERT OR IGNORE` on top of it means running
   * this twice is harmless even if the version is somehow reset.
   */
  #migrate(): void {
    const version = (
      this.#db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
    )?.['user_version'] as number | undefined;
    if ((version ?? 0) >= 1) return;

    const legacy = this.#db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_sessions'`)
      .get();

    if (legacy) {
      const copied = this.#db
        .prepare(
          `INSERT OR IGNORE INTO agents
             (id, crew, role, session_id, workspace_path, status,
              spawned_by, spawned_at, last_active_at)
           SELECT thread_id, ?, 'coordinator', session_id, workspace_path, 'live',
                  NULL, created_at, last_active_at
             FROM thread_sessions`,
        )
        .run(this.#migrationCrew);
      process.stdout.write(
        `[registry] migrated ${copied.changes} Discord session(s) into the agent registry ` +
          `as crew "${this.#migrationCrew}" — thread_sessions left in place\n`,
      );
    }

    this.#db.exec('PRAGMA user_version = 1');
  }

  /**
   * The underlying handle, so mail keeps its tables in the same file and
   * inherits the same WAL settings rather than opening a second database.
   * Sharing the file is also what lets mail policy join against the registry
   * in one statement instead of two round trips.
   */
  get db(): DatabaseSync {
    return this.#db;
  }

  get(id: string): AgentRecord | undefined {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM agents WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : undefined;
  }

  listByCrew(crew: string): AgentRecord[] {
    const rows = this.#db
      .prepare(`SELECT ${COLUMNS} FROM agents WHERE crew = ? ORDER BY id`)
      .all(crew) as Array<Record<string, unknown>>;
    return rows.map(toRecord);
  }

  /**
   * Make sure a row exists, without touching one that already does.
   *
   * Called on every session acquire, so a channel that has never run a turn
   * still has an identity — and therefore a mailbox and a drop directory —
   * before its first turn rather than after it. Existing rows are left alone
   * on purpose: role and crew are identity, and a later spawn or an operator
   * edit must not be silently reverted by a wake.
   */
  ensure(id: string, identity: AgentIdentity): AgentRecord {
    const existing = this.get(id);
    if (existing) return existing;

    const now = Date.now();
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO agents
           (id, crew, role, session_id, workspace_path, status,
            spawned_by, spawned_at, last_active_at)
         VALUES (?, ?, ?, '', ?, 'live', ?, ?, ?)`,
      )
      .run(
        id,
        identity.crew,
        identity.role,
        identity.workspacePath,
        identity.spawnedBy ?? null,
        now,
        now,
      );
    return this.get(id) as AgentRecord;
  }

  /**
   * Record the session the agent is now running under.
   *
   * Upserts rather than updates because the Discord path used to create rows
   * here and must keep working if `ensure` was somehow skipped; a wake that
   * silently failed to persist its session id is a conversation that goes cold
   * at the next restart.
   */
  recordSession(id: string, sessionId: string, workspacePath: string, identity: AgentIdentity): void {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO agents
           (id, crew, role, session_id, workspace_path, status,
            spawned_by, spawned_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id     = excluded.session_id,
           workspace_path = excluded.workspace_path,
           last_active_at = excluded.last_active_at`,
      )
      .run(
        id,
        identity.crew,
        identity.role,
        sessionId,
        workspacePath,
        identity.spawnedBy ?? null,
        now,
        now,
      );
  }

  touch(id: string): void {
    this.#db.prepare('UPDATE agents SET last_active_at = ? WHERE id = ?').run(Date.now(), id);
  }

  setStatus(id: string, status: AgentStatus): void {
    this.#db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
  }

  /**
   * Forget the session without forgetting the agent.
   *
   * `!reset` used to delete the row outright, which under the old schema meant
   * only "start cold next time". It means considerably more now: the row is
   * the identity mail is addressed to, so deleting it would drop the mailbox
   * along with the transcript. Clearing the session id is the faithful
   * translation — the next wake starts fresh, the agent is still the same
   * agent.
   */
  clearSession(id: string): void {
    this.#db.prepare(`UPDATE agents SET session_id = '' WHERE id = ?`).run(id);
  }

  close(): void {
    this.#db.close();
  }
}
