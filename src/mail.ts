import type { DatabaseSync } from 'node:sqlite';
import type { AgentRegistry } from './store.js';

/** The recipient that means "the feed". Not a legal agent id. */
export const FEED = '*';

/** Refused above this. A message is prose, not a payload. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SUBJECT_CHARS = 200;

export type OutgoingMail = {
  /** The sending session's own id, from the tool's closure. Never from the body. */
  author: string;
  /** An agent id, or `*` for the feed. */
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

  /** Fired once per accepted message, after it is committed. Synchronous inside `deliver`, so the subscriber must not throw. */
  onDelivered: (message: MailMessage) => void = () => {};

  constructor(registry: AgentRegistry) {
    this.#registry = registry;
    this.#db = registry.db;

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
      // Coordinators may DM each other across crews (how a sandboxed crew reaches the operator's).
      const bothCoordinators = author.role === 'coordinator' && recipient.role === 'coordinator';
      if (recipient.crew !== author.crew && !bothCoordinators) {
        return {
          accepted: false,
          detail:
            `${author.id} (${author.crew}) may not DM ${recipient.id} (${recipient.crew}) — ` +
            'crews talk on the feed',
        };
      }
    }

    const subject = mail.subject.slice(0, MAX_SUBJECT_CHARS);
    const sentAt = Date.now();
    const inserted = this.#db
      .prepare('INSERT INTO mail (author, recipient, subject, body, sent_at) VALUES (?, ?, ?, ?, ?)')
      .run(author.id, mail.recipient, subject, mail.body, sentAt);

    // After the insert, never before: a subscriber that reads the inbox must
    // find the message it is being told about.
    this.onDelivered({
      id: Number(inserted.lastInsertRowid),
      author: author.id,
      recipient: mail.recipient,
      subject,
      body: mail.body,
      sentAt,
    });

    return {
      accepted: true,
      detail: mail.recipient === FEED ? 'posted to the feed' : `delivered to ${mail.recipient}`,
    };
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
