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
  /** Rows in the table with recipient `*`, whether or not they were returned. */
  totalFeed: number;
  /** Rows in the table addressed to an agent, likewise. */
  totalDms: number;
  /**
   * Messages sent per author, counted across the WHOLE table.
   *
   * Not derived from the two lists above, and that is the point: a count taken
   * from a capped window undercounts the moment the cap bites, and it would do
   * so silently, on a number the page prints beside an agent's name.
   *
   * A `Map`, not an object literal: agent ids come from the board, and `{}`
   * inherits from `Object.prototype`, so an id of `constructor` would answer a
   * function to `?? 0`. No id looks like that today; a `Map` costs nothing and
   * removes the question.
   */
  sentByAuthor: Map<string, number>;
  error: string | null;
};

/**
 * How many messages to return, PER LIST.
 *
 * Per list, not overall, and that distinction is the whole of this constant's
 * history. The first version took the newest 500 rows of `mail` and then
 * partitioned them on recipient — so once the board passed 500 rows, a burst of
 * DMs could push every post out of the window and the feed would render empty.
 * The page's copy for an empty feed is a positive claim ("posts are possible —
 * none has been written"), so the ceiling would not have degraded the view, it
 * would have made it say something false.
 *
 * Two queries instead, each with its own limit and its own total, both served
 * by `idx_mail_recipient (recipient, id)` which `src/mail.ts` already creates.
 *
 * A ceiling rather than pagination because a paginated conversation view is
 * more machinery than 110 rows justify. It is not a silent truncation either:
 * each list carries its own `COUNT(*)` and the page says "showing N of M" when
 * they differ.
 *
 * Note that per-list means the worst case is 500 + 500 messages, so the ceiling
 * on one instance's response is twice what one limit suggests: 1000 bodies at
 * `maxBlockChars` is ~20 MB. Hamachi's whole board is 110 rows and 308 KB, so
 * this is a direction-of-travel number rather than a live one — but it is the
 * honest one.
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

    // Sender counts over the whole table, not over the window above. One
    // GROUP BY rather than tallying the rows we happened to return, so the
    // number beside an agent's name is its real one.
    const sentByAuthor = new Map<string, number>();
    for (const row of db
      .prepare('SELECT author, COUNT(*) AS n FROM mail GROUP BY author')
      .all() as Array<Record<string, unknown>>) {
      sentByAuthor.set(asString(row['author']), typeof row['n'] === 'number' ? row['n'] : 0);
    }

    // One query for the read receipts rather than one per message. The table is
    // (mail_id, reader) and a feed post has as many rows as there are agents,
    // so the per-message version would be N+1 queries against a database
    // another process is writing to.
    //
    // Bounded by the oldest id we actually returned: `mail` is capped and this
    // table is not, so an unbounded scan here reads the whole receipt history
    // to use at most two windows of it.
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
      /* closing a handle that never opened is not a failure worth reporting */
    }
  }
}
