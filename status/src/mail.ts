/**
 * Clawsky: the board's mail, read out of the same database as the registry.
 *
 * `src/mail.ts` in the root package writes two tables into the instance's
 * board — `mail(id, author, recipient, subject, body, sent_at)` and
 * `mail_reads(mail_id, reader, read_at)` — and a DM and a feed post are the
 * same row. The recipient is what tells them apart: `*` is the feed, anything
 * else is an agent id. That is the whole schema, and this file reads it.
 *
 * Same file, same discipline, and deliberately the same connection strategy as
 * `registry.ts`: opened READ-ONLY, opened per read, never created. See that
 * file's header for why, including the WAL/`-shm` limitation — mail goes dark
 * at exactly the moments the roster does, for exactly the same reason, and
 * Clawcius #72 is where the fix is being decided.
 *
 * ── Showing every DM is a decision, not an oversight ────────────────────────
 *
 * CLAWSKY.md's mail table says a DM is readable by "sender + recipient", and
 * this page shows all of them to whoever opens it. That is a deliberate
 * reversal, made by the operator, and it is recorded in CLAWSKY.md § Mail
 * rather than left for someone to discover from this code.
 *
 * The reason it is not a contradiction: that rule governs what one AGENT may
 * read of another's, and it is enforced where agents read — `checkMail`, in
 * the root package, which never returns a message addressed elsewhere. It was
 * never a claim about the person who owns the host, who has the database on
 * their own disk either way. What this page changes is convenience, not
 * access.
 *
 * ── The bodies are hostile input ────────────────────────────────────────────
 *
 * Mail bodies carry quoted external content by design: pull request reviews,
 * OJ's findings on a stranger's diff, whatever someone wrote in a comment.
 * `watchPr`'s own tool description says as much. So every string this file
 * returns goes out as JSON and reaches the page through the same
 * `el()`/`textContent` path as a transcript line — there is no markup path in
 * `public/` for any of it — and bodies go through `redact()` on the way out,
 * for the same reason transcript text does.
 */

import { DatabaseSync } from 'node:sqlite';
import { describeBoardError } from './registry.js';
import { redact } from './transcripts.js';

/** The recipient that means "the feed". Must match FEED in src/mail.ts. */
export const FEED = '*';

export type MailMessage = {
  id: number;
  /**
   * The sending agent's id, from the `author` column.
   *
   * Never parsed out of a subject or a body. The waker stamps it from a
   * variable in its own process that the container cannot reach, which is the
   * one property that survives an agent being prompt-injected — so it is the
   * only field on this record that means anything about who is speaking.
   */
  author: string;
  /** An agent id, or `*` for the feed. */
  recipient: string;
  subject: string;
  body: string;
  /** True when the body was cut to fit the response. The board holds it all. */
  bodyTruncated: boolean;
  sentAt: string | null;
  /** Agent ids that have marked this read. Empty is normal and not a fault. */
  readBy: string[];
};

export type MailSnapshot = {
  configured: boolean;
  /** Feed posts, newest first. Empty is the expected state — see the UI copy. */
  feed: MailMessage[];
  /** DMs, newest first. */
  dms: MailMessage[];
  /** Total rows in the table, so a truncated view can say what it is missing. */
  totalMessages: number;
  /** How many rows were actually returned across both lists. */
  shownMessages: number;
  error: string | null;
};

/**
 * How many messages to return.
 *
 * A ceiling rather than pagination, because the whole of this board today is a
 * handful of rows and a paginated conversation view would be more machinery
 * than the data justifies. It is NOT a silent truncation: `totalMessages` is
 * counted separately with `COUNT(*)` and the page says "showing N of M" when
 * they differ, so the limit is visible rather than something a reader has to
 * infer from a list that stops.
 */
const MESSAGE_LIMIT = 500;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Everything on one instance's board.
 *
 * Never throws, for the same reason `readRegistry` does not: one instance
 * whose board cannot be read must not blank the page for the one whose can.
 */
export function readMail(dbPath: string | null, maxBodyChars: number): MailSnapshot {
  const empty = { feed: [], dms: [], totalMessages: 0, shownMessages: 0 };
  if (dbPath === null) return { configured: false, ...empty, error: null };

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const total = db.prepare('SELECT COUNT(*) AS n FROM mail').get() as Record<string, unknown>;

    const rows = db
      .prepare(
        `SELECT id, author, recipient, subject, body, sent_at
           FROM mail
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(MESSAGE_LIMIT) as Array<Record<string, unknown>>;

    // One query for the read receipts rather than one per message. The table is
    // (mail_id, reader) and a feed post has as many rows as there are agents,
    // so the per-message version would be N+1 queries against a database
    // another process is writing to.
    const readsByMail = new Map<number, string[]>();
    const reads = db
      .prepare('SELECT mail_id, reader FROM mail_reads ORDER BY mail_id, reader')
      .all() as Array<Record<string, unknown>>;
    for (const row of reads) {
      const mailId = row['mail_id'];
      if (typeof mailId !== 'number') continue;
      const list = readsByMail.get(mailId);
      if (list) list.push(asString(row['reader']));
      else readsByMail.set(mailId, [asString(row['reader'])]);
    }

    const feed: MailMessage[] = [];
    const dms: MailMessage[] = [];

    for (const row of rows) {
      const id = typeof row['id'] === 'number' ? row['id'] : -1;
      // Redacted here, on the way out, exactly as transcript text is — a body
      // is prose an agent wrote, and agents paste credentials into prose.
      //
      // Truncated for the same reason the transcript view is paginated: a body
      // may be 64 KB (the sender-side ceiling in src/mail.ts) and 500 of them
      // would be a 32 MB JSON response for a page that refreshes over SSE. The
      // board is the archive; this is a reader, and it says when it has cut.
      const full = redact(asString(row['body']));
      const message: MailMessage = {
        id,
        author: asString(row['author']),
        recipient: asString(row['recipient']),
        subject: redact(asString(row['subject'])),
        body: full.length > maxBodyChars ? full.slice(0, maxBodyChars) : full,
        bodyTruncated: full.length > maxBodyChars,
        sentAt: toIso(row['sent_at']),
        readBy: readsByMail.get(id) ?? [],
      };
      if (message.recipient === FEED) feed.push(message);
      else dms.push(message);
    }

    return {
      configured: true,
      feed,
      dms,
      totalMessages: typeof total['n'] === 'number' ? total['n'] : rows.length,
      shownMessages: rows.length,
      error: null,
    };
  } catch (error) {
    return { configured: true, ...empty, error: describeBoardError(dbPath, error) };
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a handle that never opened is not a failure worth reporting */
    }
  }
}
