/**
 * Armed conditions: a thing that will produce mail when it comes true.
 *
 * `remindMe` and `watchPr` look like two features and are one mechanism. Both
 * are a row in this table saying *whose* condition it is, *what* would satisfy
 * it, and *when to look next*; the waker looks, and when the condition is met
 * it delivers mail from the owner to the owner. Nothing else is needed, because
 * mail already wakes an idle agent (CLAWSKY.md phase 3) — so a reminder that
 * fires and a colleague's DM take the same route into the same inbox.
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
 * ── One-shot, deliberately ──────────────────────────────────────────────────
 *
 * A reminder fires once and disarms. There is no `every` argument and no cron
 * expression. Two reasons, and the second is the real one:
 *
 *   - the agent receiving a reminder is, by definition, running, and it holds
 *     `remindMe`. "Remind me again tomorrow" is a tool call it can make in the
 *     turn the reminder arrives, with the note rewritten for what it now knows;
 *   - a repeating reminder outlives its purpose silently. The daily 9am wake
 *     for a job that finished in March keeps firing, and nobody notices,
 *     because nothing about it looks wrong. A one-shot cannot rot: it is either
 *     pending or spent.
 *
 * A PR watch is not one-shot — it is armed until the pull request merges or
 * closes, which is a condition rather than a schedule, and it disarms itself
 * when that condition is met. That asymmetry is intentional: the watch has a
 * defined end and the reminder does not.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AgentRegistry } from './store.js';

/** What kind of condition a row holds. Persisted, so these strings are schema. */
export type ArmedKind = 'reminder' | 'pr-watch';

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

export type ArmedCondition = {
  id: number;
  /** The agent that armed it, and the only agent it can ever mail. */
  owner: string;
  kind: ArmedKind;
  armedAt: number;
  /** The next moment the waker should look at this row. */
  dueAt: number;
  active: boolean;
  spec: ReminderSpec | PrWatchSpec;
  seen: PrWatchSeen | null;
};

export type ReminderCondition = ArmedCondition & { kind: 'reminder'; spec: ReminderSpec };
export type PrWatchCondition = ArmedCondition & {
  kind: 'pr-watch';
  spec: PrWatchSpec;
  seen: PrWatchSeen;
};

const COLUMNS = 'id, owner, kind, armed_at, due_at, active, spec, seen';

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
  if (kind !== 'reminder' && kind !== 'pr-watch') return null;

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
    spec: spec as ReminderSpec | PrWatchSpec,
    seen: (seen as PrWatchSeen | null) ?? null,
  };
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
    spec: ReminderSpec | PrWatchSpec,
    seen: PrWatchSeen | null = null,
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

  get(id: number): ArmedCondition | null {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM armed_conditions WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? toCondition(row) : null;
  }

  /** Push a still-armed condition's next look further out. */
  reschedule(id: number, dueAt: number, seen: PrWatchSeen | null = null): void {
    if (seen === null) {
      this.#db.prepare('UPDATE armed_conditions SET due_at = ? WHERE id = ?').run(dueAt, id);
      return;
    }
    this.#db
      .prepare('UPDATE armed_conditions SET due_at = ?, seen = ? WHERE id = ?')
      .run(dueAt, JSON.stringify(seen), id);
  }

  /** Spend a condition. It is kept, not deleted — the history is the record. */
  disarm(id: number): void {
    this.#db
      .prepare('UPDATE armed_conditions SET active = 0, fired_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }
}
