/**
 * Durable mapping of Discord threads to Agent SDK sessions.
 *
 * Uses Node's built-in SQLite (node:sqlite) so there is no native dependency
 * to compile — which matters on a small VM where node-gyp is both a build-time
 * and memory-time cost.
 *
 * The point of persisting this: when the bot restarts, an existing thread can
 * resume its prior agent session instead of starting cold.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ThreadSession = {
  threadId: string;
  sessionId: string;
  workspacePath: string;
  createdAt: number;
  lastActiveAt: number;
};

export class SessionStore {
  readonly #db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);

    // WAL keeps reads from blocking the writer, which matters because the
    // Discord gateway handler and the agent stream both touch this.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id      TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      )
    `);
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_thread_sessions_last_active
        ON thread_sessions (last_active_at)
    `);
  }

  /**
   * The underlying handle, so the scheduler can keep its tables in the same
   * file and inherit the same WAL settings rather than opening a second db.
   */
  get db(): DatabaseSync {
    return this.#db;
  }

  get(threadId: string): ThreadSession | undefined {
    const row = this.#db
      .prepare(
        `SELECT thread_id, session_id, workspace_path, created_at, last_active_at
           FROM thread_sessions WHERE thread_id = ?`,
      )
      .get(threadId) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return {
      threadId: row['thread_id'] as string,
      sessionId: row['session_id'] as string,
      workspacePath: row['workspace_path'] as string,
      createdAt: row['created_at'] as number,
      lastActiveAt: row['last_active_at'] as number,
    };
  }

  upsert(threadId: string, sessionId: string, workspacePath: string): void {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO thread_sessions
           (thread_id, session_id, workspace_path, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           session_id     = excluded.session_id,
           workspace_path = excluded.workspace_path,
           last_active_at = excluded.last_active_at`,
      )
      .run(threadId, sessionId, workspacePath, now, now);
  }

  touch(threadId: string): void {
    this.#db
      .prepare('UPDATE thread_sessions SET last_active_at = ? WHERE thread_id = ?')
      .run(Date.now(), threadId);
  }

  delete(threadId: string): void {
    this.#db.prepare('DELETE FROM thread_sessions WHERE thread_id = ?').run(threadId);
  }

  close(): void {
    this.#db.close();
  }
}
