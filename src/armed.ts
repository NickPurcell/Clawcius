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

/** A recurring schedule, stored as what it means rather than as when it is next. */
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

/** What a schedule has done, which is the half that makes it auditable. */
export type ScheduleSeen = {
  /** Null before the first fire. */
  lastFiredAt: number | null;
  fires: number;
  /** Occurrences that passed with nothing running, over the schedule's life. */
  missed: number;
  /** Whether `missed` is a total or a floor — see `SchedulePlan.skippedExact`. */
  missedExact?: boolean;
};

/** Watermarks, so a poll reports what is new rather than everything. */
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

/** What `disarmFor` did, as a value rather than a thrown error or a log line. */
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

/** Rebuild a condition from its row. */
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

  /** Arm a condition. */
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

  /** Everything armed and at or past its moment. */
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

  findPrWatch(owner: string, repo: string, pr: number): ArmedCondition | null {
    for (const condition of this.listFor(owner)) {
      if (condition.kind !== 'pr-watch') continue;
      const spec = condition.spec as PrWatchSpec;
      if (spec.pr === pr && sameRepo(spec.repo, repo)) return condition;
    }
    return null;
  }

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

  disarm(id: number): void {
    this.#db
      .prepare('UPDATE armed_conditions SET active = 0, fired_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

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
