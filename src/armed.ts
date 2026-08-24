/**
 * Armed conditions: a thing that will produce mail when it comes true.
 *
 * `remindMe`, `scheduleRecurring` and `watchPr` look like three features and
 * are one mechanism. Each is a row in this table saying *whose* condition it
 * is, *what* would satisfy it, and *when to look next*; the waker looks, and
 * when the condition is met it delivers mail from the owner to the owner.
 * Nothing else is needed, because mail already wakes an idle agent (CLAWSKY.md
 * phase 3) — so a reminder that fires and a colleague's DM take the same route
 * into the same inbox.
 *
 * ── The row is on disk, and that is the whole point ─────────────────────────
 *
 * A `setTimeout` would have been four lines. It would also have evaporated on
 * every deploy, and this service is restarted often enough that a reminder held
 * in a Node process is a reminder that will usually not arrive. CLAWSKY.md is
 * explicit: wakes are on disk and survive a reboot. So the table lives in the
 * same SQLite file as the registry and the mail — one file to back up, one WAL,
 * and a condition can be read back by a process that has never heard of the one
 * that armed it.
 *
 * A FIRE MISSED WHILE THE SERVICE WAS DOWN STILL FIRES. `due` asks for
 * everything at or before *now*, with no lower bound, so a reminder that came
 * due during a three-hour outage is returned on the next tick and delivered
 * late. The mail says how late. Late is better than never for a reminder, and
 * silence is the worst way for one to fail.
 *
 * ── `owner` is not an argument, here or anywhere ────────────────────────────
 *
 * The column is written from the arming tool's closure — the same variable
 * `sendMail` stamps an author with — and it is the only agent the waker will
 * ever mail about this row. There is deliberately no way to arm a condition for
 * somebody else: not a parameter that is validated and rejected, but no
 * parameter at all, because a validated parameter is a thing somebody later
 * relaxes. See CLAWSKY.md, *Scheduling*: an agent may only schedule itself.
 *
 * That property has to survive a restart too, which is why `owner` is stored
 * rather than derived. The process that fires a condition is not the process
 * that armed it and has no session to ask.
 *
 * ── A reminder is one-shot, and a schedule is the other thing ───────────────
 *
 * `remindMe` fires once and disarms. It has no `every` argument and no cron
 * expression, and it never will:
 *
 *   - the agent receiving a reminder is, by definition, running, and it holds
 *     `remindMe`. "Remind me again tomorrow" is a tool call it can make in the
 *     turn the reminder arrives, with the note rewritten for what it now knows;
 *   - a repeating reminder outlives its purpose silently. The daily 9am wake
 *     for a job that finished in March keeps firing, and nobody notices,
 *     because nothing about it looks wrong. A one-shot cannot rot: it is either
 *     pending or spent.
 *
 * The second argument is the one a `schedule` row has to answer, because a
 * recurring job is exactly the thing that can rot. It is a separate kind rather
 * than a flag on a reminder — one tool with a mode is two tools an agent has to
 * read twice to tell apart, and the one-shot is wanted unchanged. What makes
 * the repeat auditable instead of rotting is that it is VISIBLE and it is
 * STOPPABLE: `listFor` returns it, `listArmed` prints when it last fired and
 * when it fires next, `disarm` withdraws it, and every mail it sends carries
 * the id that would stop it. A repeat nobody can see is the thing that was
 * refused; a repeat in the listing with a last-fired stamp is not that thing.
 *
 * A PR watch is not one-shot either — it is armed until the pull request merges
 * or closes, which is a condition rather than a schedule, and it disarms itself
 * when that condition is met. So the table now holds one of each: something
 * that ends by the clock, something that ends by a stranger, and something that
 * ends only when it is told to.
 *
 * ── Self-terminating is not the same as harmless ────────────────────────────
 *
 * A reminder and a PR watch both end by themselves, which was the argument for
 * shipping without a way to read the table back or cancel a row — a schedule
 * does not, which is what `A reminder is one-shot, and a schedule is the other
 * thing` argues above. It held for one condition and not for two: duplicates
 * last as long as the thing they watch and multiply the mail for the whole of
 * it. That is Clawcius #50, and it happened — two watches on one pull request,
 * armed by two agents that each had no way to see the other's, delivering every
 * event twice with no way to stop it.
 *
 * So `listFor` and `spentFor` are read by a tool now, `disarmFor` withdraws a
 * row on an agent's say-so, and `findPrWatch` lets the arming tool refuse the
 * second watch instead of writing it. The last of those is the one that
 * matters: the other two describe and repair a mistake that has already cost
 * something, and it prevents it.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AgentRegistry } from './store.js';

/** What kind of condition a row holds. Persisted, so these strings are schema. */
export type ArmedKind = 'reminder' | 'pr-watch' | 'schedule';

/** Which happenings on a pull request produce mail. Chosen per `watchPr` call. */
export type WatchEvent = 'review' | 'comment' | 'merge';

export const WATCH_EVENTS: readonly WatchEvent[] = ['review', 'comment', 'merge'];

export function isWatchEvent(value: string): value is WatchEvent {
  return (WATCH_EVENTS as readonly string[]).includes(value);
}

export type ReminderSpec = {
  /** The agent's own words to its future self. Not external content. */
  note: string;
};

export type PrWatchSpec = {
  /** `owner/name`, validated before it is stored — see github.ts. */
  repo: string;
  pr: number;
  on: WatchEvent[];
  pollSeconds: number;
};

/**
 * A recurring schedule, stored as what it means rather than as when it is next.
 *
 * `cron` and `timezone` together ARE the schedule; `due_at` is a cache of them
 * recomputed after every fire. Storing the timezone in the row rather than
 * reading a default at fire time is the difference between a schedule that
 * still means 9am in Los Angeles next March and one that quietly means 8am —
 * see the header of schedule.ts, which is where the whole argument lives.
 *
 * `everyN` and `anchorAt` are the one thing five-field cron cannot say: every
 * other week. The anchor fixes which week, and it is kept after arming even
 * though nothing reads it again, because it is the only record of what the
 * phase was chosen to be. A row that says "every 2nd Monday" without saying
 * from when cannot be checked by anybody who did not arm it.
 */
export type ScheduleSpec = {
  /** The agent's own words to its future self. Same payload as a reminder. */
  note: string;
  cron: string;
  timezone: string;
  /** Fire on every Nth matching occurrence. 1 is every one. */
  everyN: number;
  /** Occurrence zero is the first match at or after this. */
  anchorAt: number;
};

/**
 * What a schedule has done, which is the half that makes it auditable.
 *
 * Kept in the `seen` column beside a PR watch's watermarks, because it is the
 * same question in both cases — what does this row already know — and a second
 * column would have been a migration for four numbers.
 */
export type ScheduleSeen = {
  /** Null until it has fired once. */
  lastFiredAt: number | null;
  fires: number;
  /** Occurrences that passed with nothing running, over the schedule's life. */
  missed: number;
  /**
   * Whether `missed` is a total or a floor — see `SchedulePlan.skippedExact`.
   *
   * Once a single catch-up walk has stopped on its budget the running total can
   * never be exact again, so this latches false and stays there. Optional
   * because rows written before it existed have no opinion, and absent is read
   * as exact: those rows were written under a budget nothing reached.
   */
  missedExact?: boolean;
};

/**
 * Watermarks, so a poll reports what is new rather than everything.
 *
 * Ids rather than timestamps: GitHub's ids are monotonic per resource and an
 * edited comment does not get a new one, which is the behaviour wanted here —
 * an agent should be told about a comment once, not again every time somebody
 * fixes a typo in it. `state` is the last state seen, so a merge is a change
 * rather than a fact re-observed every two minutes.
 */
export type PrWatchSeen = {
  reviewId: number;
  issueCommentId: number;
  reviewCommentId: number;
  state: string;
};

export type ArmedSpec = ReminderSpec | PrWatchSpec | ScheduleSpec;
export type ArmedSeen = PrWatchSeen | ScheduleSeen;

export type ArmedCondition = {
  id: number;
  /** The agent that armed it, and the only agent it can ever mail. */
  owner: string;
  kind: ArmedKind;
  armedAt: number;
  /** The next moment the waker should look at this row. */
  dueAt: number;
  active: boolean;
  /** When it stopped being armed — fired, ended, or was withdrawn. Null while active. */
  firedAt: number | null;
  spec: ArmedSpec;
  seen: ArmedSeen | null;
};

/**
 * What `disarmFor` did, as a value rather than a thrown error or a log line.
 *
 * The four cases are different sentences to whoever asked — "there is no such
 * condition" and "that one is another agent's" call for different next moves —
 * and only the tool layer knows how to say them. See `mail.ts`: a refusal the
 * caller cannot read is a refusal that did not happen.
 */
export type DisarmOutcome =
  | { disarmed: true; condition: ArmedCondition }
  | { disarmed: false; reason: 'missing' }
  | { disarmed: false; reason: 'not-yours'; owner: string }
  | { disarmed: false; reason: 'already-inactive'; condition: ArmedCondition };

export type ReminderCondition = ArmedCondition & { kind: 'reminder'; spec: ReminderSpec };
export type PrWatchCondition = ArmedCondition & {
  kind: 'pr-watch';
  spec: PrWatchSpec;
  seen: PrWatchSeen;
};

const COLUMNS = 'id, owner, kind, armed_at, due_at, active, spec, seen, fired_at';

/**
 * Rebuild a condition from its row.
 *
 * `spec` and `seen` are JSON columns and this is where they stop being text, so
 * it is also where a row written by an older build is either understood or
 * rejected. A row that cannot be parsed is dropped rather than thrown on: the
 * caller is a loop over every armed condition in the crew, and one unreadable
 * row must not stop the other agents' reminders from firing.
 */
function toCondition(row: Record<string, unknown>): ArmedCondition | null {
  const kind = row['kind'] as string;
  if (kind !== 'reminder' && kind !== 'pr-watch' && kind !== 'schedule') return null;

  let spec: unknown;
  let seen: unknown;
  try {
    spec = JSON.parse(row['spec'] as string);
    seen = JSON.parse((row['seen'] as string) || 'null');
  } catch {
    return null;
  }
  if (typeof spec !== 'object' || spec === null) return null;

  return {
    id: row['id'] as number,
    owner: row['owner'] as string,
    kind,
    armedAt: row['armed_at'] as number,
    dueAt: row['due_at'] as number,
    active: (row['active'] as number) === 1,
    firedAt: (row['fired_at'] as number | null) ?? null,
    spec: spec as ArmedSpec,
    seen: (seen as ArmedSeen | null) ?? null,
  };
}

/** Repositories are not case-sensitive to GitHub, so they must not be here. */
function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export class ArmedStore {
  readonly #db: DatabaseSync;

  constructor(registry: AgentRegistry) {
    this.#db = registry.db;

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS armed_conditions (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        owner    TEXT    NOT NULL,
        kind     TEXT    NOT NULL,
        armed_at INTEGER NOT NULL,
        due_at   INTEGER NOT NULL,
        active   INTEGER NOT NULL DEFAULT 1,
        spec     TEXT    NOT NULL,
        seen     TEXT    NOT NULL DEFAULT 'null',
        fired_at INTEGER
      )
    `);
    // The waker's only query is "what is active and due", on every tick.
    this.#db.exec(
      'CREATE INDEX IF NOT EXISTS idx_armed_due ON armed_conditions (active, due_at)',
    );
  }

  /**
   * Arm a condition.
   *
   * `owner` is a required first argument rather than a field of an options
   * object so that a caller cannot forget it and get a row belonging to
   * nobody. Every caller passes a closure variable; nothing passes user input.
   */
  arm(
    owner: string,
    kind: ArmedKind,
    dueAt: number,
    spec: ArmedSpec,
    seen: ArmedSeen | null = null,
  ): ArmedCondition {
    const armedAt = Date.now();
    const inserted = this.#db
      .prepare(
        `INSERT INTO armed_conditions (owner, kind, armed_at, due_at, active, spec, seen)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(owner, kind, armedAt, dueAt, JSON.stringify(spec), JSON.stringify(seen));

    return {
      id: Number(inserted.lastInsertRowid),
      owner,
      kind,
      armedAt,
      dueAt,
      active: true,
      firedAt: null,
      spec,
      seen,
    };
  }

  /**
   * Everything armed and at or past its moment.
   *
   * No lower bound on purpose. A condition whose `due_at` is three hours in the
   * past is exactly the case this exists for — the process was down when it
   * came due — and a query that quietly skipped it would turn a late reminder
   * into no reminder.
   */
  due(now: number = Date.now()): ArmedCondition[] {
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM armed_conditions
          WHERE active = 1 AND due_at <= ?
          ORDER BY due_at, id`,
      )
      .all(now) as Array<Record<string, unknown>>;
    return rows.map(toCondition).filter((c): c is ArmedCondition => c !== null);
  }

  /** Everything still armed for one agent, soonest first. */
  listFor(owner: string): ArmedCondition[] {
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM armed_conditions
          WHERE active = 1 AND owner = ?
          ORDER BY due_at, id`,
      )
      .all(owner) as Array<Record<string, unknown>>;
    return rows.map(toCondition).filter((c): c is ArmedCondition => c !== null);
  }

  /**
   * Conditions of one agent that have stopped, most recently first.
   *
   * `disarm` keeps the row, so this history has always existed and nothing has
   * ever read it back. It matters because an empty `listArmed` has two
   * meanings — you never armed one, or you armed one and it ended — and an
   * agent that reads the first when the second is true arms a duplicate, which
   * is the whole of Clawcius #50 happening again one step later.
   *
   * Bounded by `since` and reported with the number of rows older than it, so
   * the bound is something the caller can see rather than a silent truncation.
   */
  spentFor(owner: string, since: number): { recent: ArmedCondition[]; older: number } {
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM armed_conditions
          WHERE active = 0 AND owner = ? AND COALESCE(fired_at, armed_at) >= ?
          ORDER BY fired_at DESC, id DESC`,
      )
      .all(owner, since) as Array<Record<string, unknown>>;
    const older = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM armed_conditions
          WHERE active = 0 AND owner = ? AND COALESCE(fired_at, armed_at) < ?`,
      )
      .get(owner, since) as { n: number };

    return {
      recent: rows.map(toCondition).filter((c): c is ArmedCondition => c !== null),
      older: Number(older.n),
    };
  }

  /**
   * The agent's own live watch on a pull request, if it has one.
   *
   * Owner-scoped, and it has to be: two agents watching one PR is two agents
   * each wanting their own mail, which is correct. One agent watching it twice
   * is a mistake, and this is what lets `watchPr` say so at arm time instead of
   * the operator working it out from duplicate mail (Clawcius #50).
   */
  findPrWatch(owner: string, repo: string, pr: number): ArmedCondition | null {
    for (const condition of this.listFor(owner)) {
      if (condition.kind !== 'pr-watch') continue;
      const spec = condition.spec as PrWatchSpec;
      if (spec.pr === pr && sameRepo(spec.repo, repo)) return condition;
    }
    return null;
  }

  /**
   * The agent's own live schedule with exactly these terms, if it has one.
   *
   * The same defence as `findPrWatch`, and it matters more here. A duplicate
   * watch doubles the mail until the pull request closes, which is days; a
   * duplicate schedule doubles it until somebody works out that there are two
   * rows, which is never, because a repeat arriving twice a week looks exactly
   * like a repeat arriving twice a week. That is Clawcius #50 with no end date.
   *
   * The note is part of the comparison, deliberately. Two schedules on the same
   * cron with different notes are two jobs that happen to run at the same time
   * — "9am Monday: check the deploys" and "9am Monday: review open PRs" — and
   * refusing the second would be refusing something correct. The same note at
   * the same time in the same zone is not two jobs.
   *
   * ── The phase is compared as the NEXT FIRE, not as the anchor ──────────────
   *
   * Two fortnightly schedules on alternating weeks are a coherent thing to want
   * — together they are the weekly job you get by arming the halves separately —
   * and the first version of this refused the second of them, because it
   * compared everything except the one field that made them different.
   *
   * Comparing `anchorAt` instead would have been worse, and this is the trap
   * worth writing down: `anchor` DEFAULTS TO NOW, so two genuinely identical
   * schedules armed a second apart carry different anchors, and a comparison
   * that included the anchor would never match anything. It would look like a
   * duplicate check and be a no-op.
   *
   * So the comparison is on the computed first fire, which is what the anchor
   * exists to determine and is the only thing about it an agent can observe.
   * Same terms and the same next occurrence is one schedule twice; same terms
   * on opposite weeks is two schedules. `due_at` on a live row is always its
   * next fire, so this stays true after either row has fired any number of
   * times.
   *
   * It is exact rather than approximate, with one seam: a row that has come due
   * and not yet been swept by the waker still holds the fire it is about to
   * make, so an identical schedule armed inside that window — at most one tick
   * — is not recognised. Refusing a duplicate is a courtesy, `disarm` is the
   * remedy, and closing a fifteen-second seam is not worth reaching into the
   * waker's business from here.
   */
  findSchedule(owner: string, spec: ScheduleSpec, dueAt: number): ArmedCondition | null {
    for (const condition of this.listFor(owner)) {
      if (condition.kind !== 'schedule') continue;
      const existing = condition.spec as ScheduleSpec;
      if (
        existing.note === spec.note &&
        existing.cron === spec.cron &&
        existing.timezone === spec.timezone &&
        existing.everyN === spec.everyN &&
        condition.dueAt === dueAt
      ) {
        return condition;
      }
    }
    return null;
  }

  get(id: number): ArmedCondition | null {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM armed_conditions WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? toCondition(row) : null;
  }

  /** Push a still-armed condition's next look further out. */
  reschedule(id: number, dueAt: number, seen: ArmedSeen | null = null): void {
    if (seen === null) {
      this.#db.prepare('UPDATE armed_conditions SET due_at = ? WHERE id = ?').run(dueAt, id);
      return;
    }
    this.#db
      .prepare('UPDATE armed_conditions SET due_at = ?, seen = ? WHERE id = ?')
      .run(dueAt, JSON.stringify(seen), id);
  }

  /**
   * Spend a condition. It is kept, not deleted — the history is the record.
   *
   * No owner, because the caller is the waker: a condition that has fired, or
   * whose pull request has closed, is spent regardless of whose it was. Every
   * path that acts on an *agent's* instruction goes through `disarmFor`.
   */
  disarm(id: number): void {
    this.#db
      .prepare('UPDATE armed_conditions SET active = 0, fired_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  /**
   * Withdraw one agent's condition, and only that agent's.
   *
   * THE `owner = ?` IN THE UPDATE IS THE AUTHORISATION. Not the read above it,
   * which exists only to choose which sentence the caller is told: a crew
   * shares a container and a uid, so between two crewmates the owner column is
   * the entire boundary, and it has to be enforced by the statement that does
   * the writing rather than by a branch preceding it. Delete the read and this
   * method is still safe; delete the `AND owner = ?` and it is not.
   *
   * Nothing here throws. A refusal is a return value the model reads, exactly
   * as `MailStore.deliver` refuses a recipient — see mail-tool.ts, and Clawcius
   * #30 for what happens when a refusal is only a line in the journal.
   */
  disarmFor(owner: string, id: number): DisarmOutcome {
    const existing = this.get(id);
    if (!existing) return { disarmed: false, reason: 'missing' };
    if (existing.owner !== owner) {
      return { disarmed: false, reason: 'not-yours', owner: existing.owner };
    }
    if (!existing.active) return { disarmed: false, reason: 'already-inactive', condition: existing };

    const firedAt = Date.now();
    const result = this.#db
      .prepare(
        'UPDATE armed_conditions SET active = 0, fired_at = ? WHERE id = ? AND owner = ? AND active = 1',
      )
      .run(firedAt, id, owner);
    if (Number(result.changes) === 0) return { disarmed: false, reason: 'missing' };

    return { disarmed: true, condition: { ...existing, active: false, firedAt } };
  }
}
