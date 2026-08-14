/**
 * Mail: one mechanism, two policies.
 *
 * A DM and a feed post are the same row. Storage, authorship stamping and
 * delivery are identical; the only differences are who may write and who may
 * read, and both are decided here so there is exactly one place to read the
 * policy from:
 *
 *              recipient    who may write    who may read
 *   DM         one agent    anyone           sender + recipient
 *   feed       `*`          posters only     every agent
 *
 * The write restriction exists from the first commit deliberately. On day one
 * the poster looks idle — Discord stays with the coordinator, so the feed's
 * only audience is the other crew — and that quiet is correct. Adding a write
 * restriction to a board that has already had five writers is far worse than
 * starting with one.
 *
 * `author` is never a parameter an agent controls. It is stamped by the daemon
 * from the drop directory the file arrived in (see mail-drop.ts) and passed to
 * `deliver` by the daemon alone. Nothing in this module reads an author out of
 * a message body, and nothing should ever be added that does.
 *
 * Read state lives in its own table rather than as a column, because the feed
 * has as many readers as there are agents. That makes "read" per (message,
 * reader) for DMs too, which costs one row and keeps the two policies sharing
 * a single delivery query instead of branching.
 *
 * Scope note: the tables live in the instance's own database, so today the
 * board is per-crew. The design's cross-crew feed needs one shared board
 * reachable from both containers — a topology change, not a schema one — and
 * nothing in phases 1 and 2 consumes it yet.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AgentRegistry } from './store.js';

/** The recipient that means "the feed". Not a legal agent id. */
export const FEED = '*';

/** Refused above this. A message is prose, not a payload. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SUBJECT_CHARS = 200;

export type OutgoingMail = {
  /** Stamped by the caller from the drop directory. Never from the body. */
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

  /**
   * Accept a message, or say why not.
   *
   * Refusals are returned rather than thrown: the caller is a directory sweep
   * that must keep going, and every refusal is a line in the journal naming
   * the sender. A message that cannot be delivered is dropped, not queued —
   * there is nothing that would make it deliverable later.
   */
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
      // Crews talk to each other in public on the feed; within a crew, agents
      // talk privately. Enforced here because it is the same boundary that
      // stops an `@` reaching past a crew into someone's engineer, and a
      // boundary asserted only in a system prompt is not a boundary. If a
      // cross-crew DM is ever wanted — the host agent is the likely first case
      // — this is the single predicate to relax.
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
    this.#db
      .prepare('INSERT INTO mail (author, recipient, subject, body, sent_at) VALUES (?, ?, ?, ?, ?)')
      .run(author.id, mail.recipient, subject, mail.body, Date.now());

    return {
      accepted: true,
      detail: mail.recipient === FEED ? 'posted to the feed' : `delivered to ${mail.recipient}`,
    };
  }

  /**
   * Everything waiting for one agent, oldest first. Does not mark anything.
   *
   * Two rules are baked into the query and neither is arbitrary:
   *
   * A feed post authored by the reader is not mail for the reader — the poster
   * would otherwise read back its own broadcast on every check. A *DM* from
   * the reader to itself is delivered, because that is what a scheduled wake
   * will be: mail from an agent to itself, so there is still one inbox.
   *
   * Feed posts from before the agent existed are not delivered. Otherwise the
   * first checkMail of a newly spawned agent hands it the entire history of
   * the board, which is both unbounded and, since it is all context it was
   * never part of, not obviously useful.
   */
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

  /**
   * Mark messages read by one agent.
   *
   * Separate from `unread` so a caller that fails to hand the mail over has
   * not already marked it read — and one transaction, so a crash halfway
   * through does not leave an agent believing it has seen half a batch.
   */
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
