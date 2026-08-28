import { DatabaseSync } from 'node:sqlite';
import { describeBoardError } from './registry.js';
import { redact } from './transcripts.js';

/** The recipient that means "the feed". Must match FEED in the waker's src/mail.ts. */
export const FEED = '*';

export type MailMessage = {
  id: number;
  /** The sending agent's id, from the `author` column. */
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
  /** Feed posts, newest first. Empty is the expected state. */
  feed: MailMessage[];
  /** DMs, newest first. */
  dms: MailMessage[];
  /** Rows in the table with recipient `*`, whether or not they were returned. */
  totalFeed: number;
  /** Rows in the table addressed to an agent, likewise. */
  totalDms: number;
  /** Messages sent per author, counted across the WHOLE table. */
  sentByAuthor: Map<string, number>;
  error: string | null;
};

const MESSAGE_LIMIT = 500;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Everything on one instance's board. */
export function readMail(
  dbPath: string | null,
  maxBodyChars: number,
  // Overridable so a test can drive the ceiling with a handful of rows instead
  // of a thousand. Nothing in the service passes it.
  limit: number = MESSAGE_LIMIT,
): MailSnapshot {
  const empty = { feed: [], dms: [], totalFeed: 0, totalDms: 0, sentByAuthor: new Map() };
  if (dbPath === null) return { configured: false, ...empty, error: null };

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const counts = db
      .prepare(
        `SELECT SUM(recipient =  ?) AS feed,
                SUM(recipient <> ?) AS dms
           FROM mail`,
      )
      .get(FEED, FEED) as Record<string, unknown>;

    const select = (predicate: string) =>
      db!
        .prepare(
          `SELECT id, author, recipient, subject, body, sent_at
             FROM mail
            WHERE recipient ${predicate} ?
            ORDER BY id DESC
            LIMIT ?`,
        )
        .all(FEED, limit) as Array<Record<string, unknown>>;

    const rows = [...select('='), ...select('<>')];

    // Sender counts over the whole table, not over the window above.
    const sentByAuthor = new Map<string, number>();
    for (const row of db
      .prepare('SELECT author, COUNT(*) AS n FROM mail GROUP BY author')
      .all() as Array<Record<string, unknown>>) {
      sentByAuthor.set(asString(row['author']), typeof row['n'] === 'number' ? row['n'] : 0);
    }

    const oldestReturned = rows.reduce<number>(
      (oldest, row) => (typeof row['id'] === 'number' && row['id'] < oldest ? row['id'] : oldest),
      Number.MAX_SAFE_INTEGER,
    );
    const readsByMail = new Map<number, string[]>();
    const reads =
      rows.length === 0
        ? []
        : (db
            .prepare(
              'SELECT mail_id, reader FROM mail_reads WHERE mail_id >= ? ORDER BY mail_id, reader',
            )
            .all(oldestReturned) as Array<Record<string, unknown>>);
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
      // Redacted here, on the way out, exactly as transcript text is — a body is prose an agent wrote, and agents paste credentials into prose.
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
      totalFeed: typeof counts['feed'] === 'number' ? counts['feed'] : feed.length,
      totalDms: typeof counts['dms'] === 'number' ? counts['dms'] : dms.length,
      sentByAuthor,
      error: null,
    };
  } catch (error) {
    return { configured: true, ...empty, error: describeBoardError(dbPath, error) };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
