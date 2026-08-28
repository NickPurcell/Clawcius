import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The roles a row may hold. Persisted, so these strings are schema. */
export type AgentRole =
  | 'coordinator'
  | 'engineer'
  | 'researcher'
  | 'poster'
  | 'updater';

export const AGENT_ROLES: readonly AgentRole[] = [
  'coordinator',
  'engineer',
  'researcher',
  'poster',
  'updater',
];


export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

export type AgentStatus = 'live' | 'dead';

export type AgentRecord = {
  /** `hamachi-engineer1`, or a Discord channel id for a migrated row. */
  id: string;
  crew: string;
  role: AgentRole;
  /** Empty before the agent's first run; rewritten on resurrection. */
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

  /** Make sure a row exists, without touching one that already does. */
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

  /** Create a row for an agent that must not already exist. */
  create(id: string, identity: AgentIdentity): AgentRecord {
    const existing = this.get(id);
    if (existing) {
      throw new Error(
        `agent "${id}" already exists (${existing.role} of crew ${existing.crew}) — ` +
          'an id is an identity and is never reused',
      );
    }

    const now = Date.now();
    // Plain INSERT, not INSERT OR IGNORE: a PRIMARY KEY conflict here is the
    // race the check above cannot see, and it must surface rather than vanish.
    this.#db
      .prepare(
        `INSERT INTO agents
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

  /** Record the session the agent now runs under. An upsert whose conflict clause updates the session only: role, crew and spawned_by are identity. */
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

  clearSession(id: string): void {
    this.#db.prepare(`UPDATE agents SET session_id = '' WHERE id = ?`).run(id);
  }

  close(): void {
    this.#db.close();
  }
}
