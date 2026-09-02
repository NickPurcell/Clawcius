import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { AgentRecord, AgentRegistry } from './store.js';

/** The recipient that means "the feed". Not a legal agent id. */
export const FEED = '*';

/** `<crew>-coordinator`: that crew's live coordinators, whichever crew it is. */
const COORDINATOR_ALIAS = /^([a-z][a-z0-9-]*)-coordinator$/;

/** Each crew owns `<root>/<crew>` (mode 1733): any user may drop a file, only the crew reads it. */
const SPOOL_ROOT = '/var/spool/clawcius';

/** Refused above this. A message is prose, not a payload. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SUBJECT_CHARS = 200;

export type OutgoingMail = {
  /** The sending session's own id, from the tool's closure. Never from the body. */
  author: string;
  /** An agent id, `<crew>-coordinator`, or `*` for the feed. */
  recipient: string;
  subject: string;
  body: string;
};

export type MailMessage = {
  id: number;
  author: string;
  recipient: string;
  subject: string;
  body: string;
  sentAt: number;
};

export type DeliveryResult = { accepted: boolean; detail: string };

export class MailStore {
  readonly #db: DatabaseSync;
  readonly #registry: AgentRegistry;
  readonly #spoolRoot: string;

  /** Fired once per accepted message, after it is committed. Synchronous inside `deliver`, so the subscriber must not throw. */
  onDelivered: (message: MailMessage) => void = () => {};

  constructor(registry: AgentRegistry, options: { spoolRoot?: string } = {}) {
    this.#registry = registry;
    this.#db = registry.db;
    this.#spoolRoot = options.spoolRoot ?? SPOOL_ROOT;

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS mail (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        author    TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject   TEXT NOT NULL DEFAULT '',
        body      TEXT NOT NULL,
        sent_at   INTEGER NOT NULL
      )
    `);
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_mail_recipient ON mail (recipient, id)');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS mail_reads (
        mail_id INTEGER NOT NULL,
        reader  TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (mail_id, reader)
      )
    `);
  }

  /** Accept a message, or say why not. */
  deliver(mail: OutgoingMail): DeliveryResult {
    const author = this.#registry.get(mail.author);
    if (!author) {
      return { accepted: false, detail: `unknown sender "${mail.author}"` };
    }
    if (!mail.body.trim()) {
      return { accepted: false, detail: 'empty body' };
    }
    if (Buffer.byteLength(mail.body, 'utf8') > MAX_BODY_BYTES) {
      return { accepted: false, detail: `body over ${MAX_BODY_BYTES} bytes` };
    }

    // A row with that exact id is an agent; the alias is for when there is none.
    const alias = COORDINATOR_ALIAS.exec(mail.recipient);
    if (alias && !this.#registry.get(mail.recipient)) return this.#deliverToCoordinators(author, alias[1]!, mail);

    if (mail.recipient === FEED) {
      // The one restriction that makes the trust rule enforceable at a single
      // point per crew rather than in five system prompts at once.
      if (author.role !== 'poster') {
        return {
          accepted: false,
          detail: `only a poster may write to the feed; ${author.id} is a ${author.role}`,
        };
      }
    } else {
      const recipient = this.#registry.get(mail.recipient);
      if (!recipient) {
        return { accepted: false, detail: `unknown recipient "${mail.recipient}"` };
      }
      // Crews talk to each other in public on the feed; within a crew, agents talk privately.
      if (recipient.crew !== author.crew) {
        return {
          accepted: false,
          detail:
            `${author.id} (${author.crew}) may not DM ${recipient.id} (${recipient.crew}) — ` +
            'crews talk on the feed',
        };
      }
    }

    const subject = mail.subject.slice(0, MAX_SUBJECT_CHARS);
    this.#insert(author.id, mail.recipient, subject, mail.body, Date.now());

    return {
      accepted: true,
      detail: mail.recipient === FEED ? 'posted to the feed' : `delivered to ${mail.recipient}`,
    };
  }

  #liveCoordinators(): AgentRecord[] {
    return this.#registry
      .listByCrew(this.#registry.crew)
      .filter((a) => a.role === 'coordinator' && a.status === 'live');
  }

  /** `onDelivered` fires after the insert, never before: a subscriber that reads the inbox must find the message. */
  #insert(author: string, recipient: string, subject: string, body: string, sentAt: number): void {
    const inserted = this.#db
      .prepare('INSERT INTO mail (author, recipient, subject, body, sent_at) VALUES (?, ?, ?, ?, ?)')
      .run(author, recipient, subject, body, sentAt);
    this.onDelivered({ id: Number(inserted.lastInsertRowid), author, recipient, subject, body, sentAt });
  }

  /** Own crew: one copy per live coordinator. Another crew: a file in its spool, from `<ourcrew>-coordinator`. */
  #deliverToCoordinators(author: AgentRecord, crew: string, mail: OutgoingMail): DeliveryResult {
    const subject = mail.subject.slice(0, MAX_SUBJECT_CHARS);
    const sentAt = Date.now();
    if (crew === this.#registry.crew) {
      const coordinators = this.#liveCoordinators();
      if (coordinators.length === 0) {
        return { accepted: false, detail: `crew ${crew} has no live coordinator` };
      }
      for (const c of coordinators) this.#insert(author.id, c.id, subject, mail.body, sentAt);
      return { accepted: true, detail: `delivered to ${coordinators.map((c) => c.id).join(', ')}` };
    }
    if (author.role !== 'coordinator') {
      return {
        accepted: false,
        detail: `only a coordinator may write to another crew's coordinator; ${author.id} is a ${author.role}`,
      };
    }
    const dir = join(this.#spoolRoot, crew);
    const name = `${sentAt}-${randomUUID()}.json`;
    const record = JSON.stringify({ author: `${author.crew}-coordinator`, subject, body: mail.body, sentAt });
    try {
      writeFileSync(join(dir, `.${name}`), record);
      renameSync(join(dir, `.${name}`), join(dir, name));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? String(error);
      return { accepted: false, detail: `crew ${crew} has no spool on this box (${code})` };
    }
    return { accepted: true, detail: `handed to crew ${crew}'s coordinators` };
  }

  /** Move what other crews dropped in this crew's spool into the mail table; returns one line per file. */
  importSpool(): string[] {
    const dir = join(this.#spoolRoot, this.#registry.crew);
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      return [];
    }
    const lines: string[] = [];
    const coordinators = this.#liveCoordinators();
    for (const name of names.sort()) {
      const path = join(dir, name);
      let record: { author?: unknown; subject?: unknown; body?: unknown; sentAt?: unknown };
      try {
        record = JSON.parse(readFileSync(path, 'utf8')) as typeof record;
      } catch {
        record = {};
      }
      const { author, subject, body } = record;
      const valid =
        typeof author === 'string' && COORDINATOR_ALIAS.test(author) &&
        typeof subject === 'string' && typeof body === 'string' &&
        body.trim() !== '' && Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES;
      if (!valid) {
        unlinkSync(path);
        lines.push(`spool: dropped ${name} — not a message`);
        continue;
      }
      if (coordinators.length === 0) continue;
      const sentAt = typeof record.sentAt === 'number' ? record.sentAt : Date.now();
      unlinkSync(path);
      for (const c of coordinators) this.#insert(author, c.id, subject.slice(0, MAX_SUBJECT_CHARS), body, sentAt);
      lines.push(`spool: ${author} → ${coordinators.map((c) => c.id).join(', ')} — ${subject.slice(0, 60)}`);
    }
    return lines;
  }

  unread(agentId: string): MailMessage[] {
    const agent = this.#registry.get(agentId);
    if (!agent) return [];

    const rows = this.#db
      .prepare(
        `SELECT id, author, recipient, subject, body, sent_at
           FROM mail
          WHERE (recipient = ?
                 OR (recipient = ? AND author <> ? AND sent_at >= ?))
            AND NOT EXISTS (
                  SELECT 1 FROM mail_reads
                   WHERE mail_reads.mail_id = mail.id AND mail_reads.reader = ?)
          ORDER BY id`,
      )
      .all(agentId, FEED, agentId, agent.spawnedAt, agentId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row['id'] as number,
      author: row['author'] as string,
      recipient: row['recipient'] as string,
      subject: row['subject'] as string,
      body: row['body'] as string,
      sentAt: row['sent_at'] as number,
    }));
  }

  /** Mark messages read by one agent. */
  markRead(agentId: string, ids: readonly number[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const insert = this.#db.prepare(
      'INSERT OR IGNORE INTO mail_reads (mail_id, reader, read_at) VALUES (?, ?, ?)',
    );
    this.#db.exec('BEGIN');
    try {
      for (const id of ids) insert.run(id, agentId, now);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Everything waiting, marked read in one go. What checkMail calls. */
  collect(agentId: string): MailMessage[] {
    const messages = this.unread(agentId);
    this.markRead(
      agentId,
      messages.map((message) => message.id),
    );
    return messages;
  }
}
