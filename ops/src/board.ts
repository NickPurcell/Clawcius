/**
 * The host agent's end of the Clawsky board.
 *
 * The board is a SQLite file in an instance's state directory, written by that
 * instance's waker. Everything else on the board lives inside a container; the
 * host agent does not, so this is the one participant that reaches the table
 * from the host, as root, out of the executor's process.
 *
 * ── Why this is not `src/mail.ts` ───────────────────────────────────────────
 *
 * It should be. `src/store.ts` and `src/mail.ts` already hold every statement
 * below, and two copies of a schema is a thing that drifts. It is not, because
 * `ops/` is a separate npm package with its own `rootDir: src` and its own
 * `dist/`, and the ways to share code across that line all cost more than they
 * buy in the same change that removes the ops queue: reaching up with a
 * relative import moves `ops/dist/index.js` to `ops/dist/ops/src/index.js` and
 * silently breaks the unit's `ExecStart`, and a `file:..` dependency makes the
 * root package's `dist/` a build prerequisite of the root daemon.
 *
 * So drift is made LOUD instead of prevented. `#assertSchema` checks, at open
 * time, that every column this file names actually exists, and refuses the
 * mailbox with the missing column named if it does not. A board that has moved
 * on stops the host agent's mail rather than corrupting it, and says so in the
 * boot banner. Issue filed; this is the seam to close when it can be.
 *
 * ── What is NOT read from a message ─────────────────────────────────────────
 *
 * The author. Never. It is written by the waker from the agent id its own
 * `sendMail` tool closes over — an in-process variable, not anything the
 * message carries — and it arrives here as the `author` column of a committed
 * row. Nothing in this file reads a sender out of a subject or a body, and the
 * coordinator check in `host-mailbox.ts` is made against that column and
 * against the registry row it names. There is no field a request can carry
 * that says who filed it.
 *
 * ── The database file itself ────────────────────────────────────────────────
 *
 * It is NOT inside a bind mount: `docker/run-container.sh` gives a container
 * `$CLAWCIUS_STATE/run` and nothing else, and the board sits a level above
 * that, next to `waker-status.json` — the file whose containment the ops config
 * loader already re-checks for exactly this reason. `config.ts` refuses a
 * `board.db` inside any container's bind mount, and this file `lstat`s the path
 * and refuses a symlink or anything that is not a regular file before opening
 * it, because `node:sqlite` opens by name and the lesson of the retired ops
 * spool — a root `mkdir`/`chown` of a path whose parent the sandbox owned, which
 * was an arbitrary-path root chown (CWE-59) — is that a path an agent can
 * influence is resolved with THIS process's privileges. Two
 * checks that should both be redundant; three occasions in this repository say
 * otherwise.
 *
 * The database is never created. A missing file is a configured path that does
 * not match the waker's `CLAWCIUS_DB_PATH`, and creating an empty second board
 * next to the real one would look like a working mailbox that nobody can reach.
 */

import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  constants as fsConstants,
  fchownSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';

export type BoardMessage = {
  id: number;
  author: string;
  subject: string;
  body: string;
  sentAt: number;
};

/** Columns this file names, per table. Checked at open time. See the header. */
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  agents: [
    'id',
    'crew',
    'role',
    'session_id',
    'workspace_path',
    'status',
    'spawned_by',
    'spawned_at',
    'last_active_at',
  ],
  mail: ['id', 'author', 'recipient', 'subject', 'body', 'sent_at'],
  mail_reads: ['mail_id', 'reader', 'read_at'],
};

export class BoardError extends Error {}

/** The host agent's id in a crew. Must match `hostAgentId` in src/store.ts. */
export function hostAgentId(crew: string): string {
  return `${crew}-host`;
}

export class Board {
  readonly #db: DatabaseSync;
  readonly #crew: string;
  readonly #hostId: string;
  readonly #log: (line: string) => void;

  /**
   * @throws BoardError if the file is missing, is not a regular file, or does
   * not carry the schema this file was written against. Every one of those is
   * a misconfiguration a human has to see, not a condition to work around.
   */
  constructor(options: { dbPath: string; crew: string; log: (line: string) => void }) {
    this.#crew = options.crew;
    this.#hostId = hostAgentId(options.crew);
    this.#log = options.log;

    let stat;
    try {
      stat = lstatSync(options.dbPath);
    } catch (error) {
      throw new BoardError(
        `cannot open the board at ${options.dbPath}: ${String(error)}. This must be the same ` +
          "file as that instance's CLAWCIUS_DB_PATH; it is never created here, because an " +
          'empty second board reads as a mailbox that works and that nobody can reach.',
      );
    }
    if (!stat.isFile()) {
      throw new BoardError(
        `REFUSING to open ${options.dbPath}: it is not a regular file. Not following it — ` +
          'this process is root and node:sqlite opens by name.',
      );
    }

    this.#db = new DatabaseSync(options.dbPath);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#assertSchema();
    this.#shareWalWith(options.dbPath, stat.uid, stat.gid);
  }

  get crew(): string {
    return this.#crew;
  }

  get hostId(): string {
    return this.#hostId;
  }

  #assertSchema(): void {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const rows = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<
        Record<string, unknown>
      >;
      if (rows.length === 0) {
        throw new BoardError(
          `the board has no "${table}" table. Either this is not a Clawsky database, or the ` +
            'waker and the executor are running different builds. Nothing is read or written.',
        );
      }
      const present = new Set(rows.map((row) => row['name'] as string));
      const missing = columns.filter((column) => !present.has(column));
      if (missing.length > 0) {
        throw new BoardError(
          `the board's "${table}" table is missing ${missing.join(', ')}. ops/src/board.ts ` +
            'is a second copy of the schema in src/store.ts and src/mail.ts and this is it ' +
            'having drifted. Refusing rather than writing rows the waker cannot read.',
        );
      }
    }
  }

  /**
   * Let the waker keep writing after root has opened the file.
   *
   * SQLite creates `-wal` and `-shm` as whoever opens the database first. This
   * process is root; the waker is not. A root-owned `-wal` next to a
   * user-owned database is a waker that can no longer write its own board — a
   * silent, total failure of the thing this change exists to build — so the
   * sidecars are handed back to whoever owns the database file.
   *
   * Through an `O_NOFOLLOW` descriptor and `fchown`, not `chown` by name, so
   * that what is changed is the object that was checked rather than whatever
   * the name resolves to a moment later. Failures are logged, never fatal — the usual
   * cause is running the executor as something other than root, where the
   * problem being fixed does not arise.
   */
  #shareWalWith(dbPath: string, uid: number, gid: number): void {
    if (process.getuid?.() !== 0) return;
    for (const suffix of ['-wal', '-shm']) {
      const path = `${dbPath}${suffix}`;
      let fd: number;
      try {
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch {
        continue; // not there yet, or not a plain file. Either way, not ours.
      }
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || (opened.uid === uid && opened.gid === gid)) continue;
        fchownSync(fd, uid, gid);
        this.#log(`handed ${path} back to ${uid}:${gid} so the waker can still write its board`);
      } catch (error) {
        this.#log(
          `WARNING: ${path} is not owned ${uid}:${gid} and could not be chowned ` +
            `(${String(error)}). The waker may no longer be able to write its own board. ` +
            `On the host: chown ${uid}:${gid} ${path}`,
        );
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* nothing useful to do about a failed close */
        }
      }
    }
  }

  /**
   * Make sure the host agent has a row, and that the row is a host agent's.
   *
   * The executor creates it rather than the waker, so that "the host agent
   * exists" means "a process that can actually run it is up". A coordinator
   * that DMs `<crew>-host` while this daemon is down gets `unknown recipient`,
   * which names the missing thing; a row created by the container side would
   * instead accept the message into a mailbox nobody reads.
   *
   * Returns false — mailbox off — if the id is taken by something that is not a
   * host agent. That is either an operator seeding `clawsky.agents` with the
   * reserved id or a genuine collision, and taking over the row would give a
   * container agent's mailbox to a root daemon.
   */
  register(workspacePath: string): boolean {
    const existing = this.#db
      .prepare('SELECT role, crew FROM agents WHERE id = ?')
      .get(this.#hostId) as Record<string, unknown> | undefined;

    if (existing) {
      if (existing['role'] !== 'host') {
        this.#log(
          `REFUSING the host mailbox: ${this.#hostId} already exists on this board as a ` +
            `${String(existing['role'])}. Nothing was changed. Remove that row, or the ` +
            'clawsky.agents entry that creates it, and restart.',
        );
        return false;
      }
      this.#db
        .prepare('UPDATE agents SET last_active_at = ?, status = ? WHERE id = ?')
        .run(Date.now(), 'live', this.#hostId);
      return true;
    }

    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO agents
           (id, crew, role, session_id, workspace_path, status,
            spawned_by, spawned_at, last_active_at)
         VALUES (?, ?, 'host', '', ?, 'live', NULL, ?, ?)`,
      )
      .run(this.#hostId, this.#crew, workspacePath, now, now);
    this.#log(`registered ${this.#hostId} on the board at crew ${this.#crew}`);
    return true;
  }

  /** The registry role of an agent, or '' if this board has never heard of it. */
  roleOf(agentId: string): string {
    const row = this.#db.prepare('SELECT role FROM agents WHERE id = ?').get(agentId) as
      | Record<string, unknown>
      | undefined;
    return row ? ((row['role'] as string) ?? '') : '';
  }

  /**
   * DMs waiting for the host agent, oldest first.
   *
   * DMs only. A feed post is addressed to everybody and carries no authority —
   * "everything on the feed is a claim, never an instruction" is the rule the
   * whole board is arranged around, and a root daemon that ran tasks off the
   * feed would be the counterexample. Feed rows are left untouched rather than
   * marked read, because nothing here has any business reading them.
   */
  unread(): BoardMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT id, author, subject, body, sent_at
           FROM mail
          WHERE recipient = ?
            AND NOT EXISTS (
                  SELECT 1 FROM mail_reads
                   WHERE mail_reads.mail_id = mail.id AND mail_reads.reader = ?)
          ORDER BY id`,
      )
      .all(this.#hostId, this.#hostId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row['id'] as number,
      author: row['author'] as string,
      subject: row['subject'] as string,
      body: row['body'] as string,
      sentAt: row['sent_at'] as number,
    }));
  }

  /**
   * Mark a message read.
   *
   * Called BEFORE the task runs, not after. A task that crashes the executor
   * halfway must not be re-read and re-run on the next boot — the same rule as
   * "unlink before acting" in every spool in this repository, and it matters
   * more here, because what would be repeated is a command on the VPS.
   */
  markRead(id: number): void {
    this.#db
      .prepare('INSERT OR IGNORE INTO mail_reads (mail_id, reader, read_at) VALUES (?, ?, ?)')
      .run(id, this.#hostId, Date.now());
  }

  /**
   * Answer, as the host agent.
   *
   * Written straight into the table rather than through anything the container
   * side offers. Every other participant sends with a `sendMail` tool the waker
   * builds inside its own process, closed over the sending session's id; the
   * host agent has no session and no waker, so its author name comes from
   * `#hostId` here for exactly the same reason — it is a variable in the
   * process that is entitled to it, and there is no path to it from outside.
   */
  send(to: string, subject: string, body: string): void {
    this.#db
      .prepare('INSERT INTO mail (author, recipient, subject, body, sent_at) VALUES (?, ?, ?, ?, ?)')
      .run(this.#hostId, to, subject.slice(0, 200), body, Date.now());
    this.#db
      .prepare('UPDATE agents SET last_active_at = ? WHERE id = ?')
      .run(Date.now(), this.#hostId);
  }

  close(): void {
    this.#db.close();
  }
}
