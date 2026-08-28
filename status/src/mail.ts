import { DatabaseSync } from 'node:sqlite';
import { describeBoardError } from './registry.js';
import { redact } from './transcripts.js';

/** The recipient that means "the feed". Matches FEED in the waker's src/mail.ts. */
export const FEED = '*';

export type MailRow = {
  id: number;
  author: string;
  /** An agent id, or `*` for the feed. */
  recipient: string;
  subject: string;
  body: string;
  bodyTruncated: boolean;
  /** Milliseconds since epoch. */
  sentAt: number;
};

export type MailWindow = {
  rows: MailRow[];
  error: string | null;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Mail an agent sent or received with `after < sent_at <= until`, oldest first.
 * `until` null means no upper bound. Feed posts count only for their author.
 */
export function readMailFor(
  dbPath: string | null,
  agentId: string,
  after: number,
  until: number | null,
  maxBodyChars: number,
): MailWindow {
  if (dbPath === null) return { rows: [], error: null };

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT id, author, recipient, subject, body, sent_at
           FROM mail
          WHERE (author = ? OR recipient = ?)
            AND sent_at > ?
            AND sent_at <= ?
          ORDER BY sent_at, id`,
      )
      .all(agentId, agentId, after, until ?? Number.MAX_SAFE_INTEGER) as Array<Record<string, unknown>>;

    return {
      error: null,
      rows: rows.map((row) => {
        // Redacted on the way out, as transcript text is: a body is prose an agent wrote.
        const full = redact(asString(row['body']));
        return {
          id: typeof row['id'] === 'number' ? row['id'] : -1,
          author: asString(row['author']),
          recipient: asString(row['recipient']),
          subject: redact(asString(row['subject'])),
          body: full.length > maxBodyChars ? full.slice(0, maxBodyChars) : full,
          bodyTruncated: full.length > maxBodyChars,
          sentAt: typeof row['sent_at'] === 'number' ? row['sent_at'] : 0,
        };
      }),
    };
  } catch (error) {
    return { rows: [], error: describeBoardError(dbPath, error) };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
