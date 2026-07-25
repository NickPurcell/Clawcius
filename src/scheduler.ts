/**
 * Self-scheduling for the agent.
 *
 * The Agent SDK ships no `ScheduleWakeup`/`CronCreate` equivalent — those are
 * harness capabilities, not model capabilities. This module is that harness
 * piece: the agent calls an in-process MCP tool, and the *waker* owns the
 * timer, the persistence, and the limits.
 *
 * Keeping the timer here rather than letting the agent write crontabs matters
 * for three reasons: it survives the sandbox (no setgid `crontab`, no
 * namespace), it wakes the existing warm session instead of spawning a cold
 * one, and the loop guards live in the same process that already enforces
 * concurrency.
 *
 * Firing is poll-based rather than one `setTimeout` per schedule. Timers do not
 * survive a restart, and delays beyond ~24.8 days overflow `setTimeout`'s
 * 32-bit millisecond argument and fire immediately — a poll over SQLite has
 * neither problem.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Schedule } from './types.js';

const POLL_INTERVAL_MS = 15_000;
const DAILY_AT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type SchedulerLimits = {
  enabled: boolean;
  /** Floor on any delay. Stops the agent building a tight self-wake loop. */
  minDelaySeconds: number;
  /** Cap on pending schedules per channel. */
  maxPending: number;
  /** Cap on fires per channel per rolling 24h. */
  maxWakesPerDay: number;
};

/** Thrown for limit violations — the message goes back to the agent verbatim. */
export class ScheduleRejected extends Error {}

export type WakeHandler = (schedule: Schedule) => void;

/**
 * Next occurrence of HH:MM in the *process's* local timezone.
 * Set `Environment=TZ=...` in the unit file to control it.
 */
export function nextDailyAt(hhmm: string, from: number = Date.now()): number {
  const match = DAILY_AT_PATTERN.exec(hhmm);
  if (!match) {
    throw new ScheduleRejected(`daily_at must be HH:MM in 24-hour form, got "${hhmm}"`);
  }
  const next = new Date(from);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= from) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

export class Scheduler {
  readonly #db: DatabaseSync;
  readonly #limits: SchedulerLimits;
  #onWake: WakeHandler | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(db: DatabaseSync, limits: SchedulerLimits) {
    this.#db = db;
    this.#limits = limits;

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id               TEXT PRIMARY KEY,
        channel_id       TEXT NOT NULL,
        prompt           TEXT NOT NULL,
        next_run_at      INTEGER NOT NULL,
        interval_seconds INTEGER,
        daily_at         TEXT,
        created_at       INTEGER NOT NULL,
        last_run_at      INTEGER
      )
    `);
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (next_run_at)');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS wake_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        fired_at   INTEGER NOT NULL
      )
    `);
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_wake_log ON wake_log (channel_id, fired_at)');
  }

  start(onWake: WakeHandler): void {
    if (!this.#limits.enabled) return;
    this.#onWake = onWake;
    this.#timer = setInterval(() => this.#tick(), POLL_INTERVAL_MS);
    this.#timer.unref();
    // Catch anything that came due while the bot was down.
    this.#tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // -- creation ------------------------------------------------------------

  createOneShot(channelId: string, delaySeconds: number, prompt: string): Schedule {
    this.#assertCanSchedule(channelId, delaySeconds);
    return this.#insert({
      channelId,
      prompt,
      nextRunAt: Date.now() + delaySeconds * 1000,
      intervalSeconds: null,
      dailyAt: null,
    });
  }

  createInterval(channelId: string, intervalSeconds: number, prompt: string): Schedule {
    this.#assertCanSchedule(channelId, intervalSeconds);
    return this.#insert({
      channelId,
      prompt,
      nextRunAt: Date.now() + intervalSeconds * 1000,
      intervalSeconds,
      dailyAt: null,
    });
  }

  createDaily(channelId: string, dailyAt: string, prompt: string): Schedule {
    const nextRunAt = nextDailyAt(dailyAt);
    // Daily cadence is inherently above the floor, so only the count limits
    // apply — a delay check here would reject a legitimate 09:00 set at 08:59.
    this.#assertWithinCounts(channelId);
    return this.#insert({ channelId, prompt, nextRunAt, intervalSeconds: null, dailyAt });
  }

  list(channelId: string): Schedule[] {
    const rows = this.#db
      .prepare('SELECT * FROM schedules WHERE channel_id = ? ORDER BY next_run_at')
      .all(channelId) as Record<string, unknown>[];
    return rows.map(toSchedule);
  }

  cancel(channelId: string, id: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM schedules WHERE id = ? AND channel_id = ?')
      .run(id, channelId);
    return Number(result.changes) > 0;
  }

  // -- guards --------------------------------------------------------------

  #assertCanSchedule(channelId: string, delaySeconds: number): void {
    if (!Number.isFinite(delaySeconds)) {
      throw new ScheduleRejected('delay must be a number of seconds');
    }
    if (delaySeconds < this.#limits.minDelaySeconds) {
      throw new ScheduleRejected(
        `minimum is ${this.#limits.minDelaySeconds}s; ${delaySeconds}s was requested. ` +
          'Short self-wake intervals turn into runaway loops.',
      );
    }
    this.#assertWithinCounts(channelId);
  }

  #assertWithinCounts(channelId: string): void {
    const pending = this.#db
      .prepare('SELECT COUNT(*) AS n FROM schedules WHERE channel_id = ?')
      .get(channelId) as { n: number };
    if (pending.n >= this.#limits.maxPending) {
      throw new ScheduleRejected(
        `this channel already has ${pending.n} schedules (limit ${this.#limits.maxPending}). ` +
          'Cancel one before adding another.',
      );
    }

    if (this.#firesLastDay(channelId) >= this.#limits.maxWakesPerDay) {
      throw new ScheduleRejected(
        `this channel has already used its ${this.#limits.maxWakesPerDay} scheduled wakes ` +
          'in the last 24 hours. Wait, or ask a human to raise the limit.',
      );
    }
  }

  #firesLastDay(channelId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM wake_log WHERE channel_id = ? AND fired_at > ?')
      .get(channelId, Date.now() - 86_400_000) as { n: number };
    return row.n;
  }

  // -- firing --------------------------------------------------------------

  #tick(): void {
    if (!this.#onWake) return;

    const due = this.#db
      .prepare('SELECT * FROM schedules WHERE next_run_at <= ? ORDER BY next_run_at LIMIT 25')
      .all(Date.now()) as Record<string, unknown>[];

    for (const row of due) {
      const schedule = toSchedule(row);

      // Re-check the daily cap at fire time, not only at creation: a schedule
      // created yesterday should not be able to outrun today's budget.
      if (this.#firesLastDay(schedule.channelId) >= this.#limits.maxWakesPerDay) {
        this.#deferByADay(schedule);
        process.stderr.write(
          `[scheduler] ${schedule.channelId} at daily wake cap; deferring ${schedule.id}\n`,
        );
        continue;
      }

      this.#advance(schedule);
      this.#db
        .prepare('INSERT INTO wake_log (channel_id, fired_at) VALUES (?, ?)')
        .run(schedule.channelId, Date.now());

      try {
        this.#onWake(schedule);
      } catch (error) {
        process.stderr.write(`[scheduler] wake handler failed: ${String(error)}\n`);
      }
    }

    // Keep the rate-limit log from growing without bound.
    this.#db.prepare('DELETE FROM wake_log WHERE fired_at < ?').run(Date.now() - 172_800_000);
  }

  /** Move a repeating schedule forward, or delete a one-shot that has fired. */
  #advance(schedule: Schedule): void {
    const now = Date.now();

    if (schedule.intervalSeconds !== null) {
      // Step forward from now rather than from the missed slot, so a long
      // outage does not produce a burst of catch-up fires.
      this.#db
        .prepare('UPDATE schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?')
        .run(now + schedule.intervalSeconds * 1000, now, schedule.id);
      return;
    }

    if (schedule.dailyAt !== null) {
      this.#db
        .prepare('UPDATE schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?')
        .run(nextDailyAt(schedule.dailyAt, now), now, schedule.id);
      return;
    }

    this.#db.prepare('DELETE FROM schedules WHERE id = ?').run(schedule.id);
  }

  #deferByADay(schedule: Schedule): void {
    this.#db
      .prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
      .run(Date.now() + 3_600_000, schedule.id);
  }

  #insert(input: Omit<Schedule, 'id' | 'createdAt' | 'lastRunAt'>): Schedule {
    const schedule: Schedule = {
      ...input,
      id: randomUUID().slice(0, 8),
      createdAt: Date.now(),
      lastRunAt: null,
    };
    this.#db
      .prepare(
        `INSERT INTO schedules
           (id, channel_id, prompt, next_run_at, interval_seconds, daily_at, created_at, last_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.channelId,
        schedule.prompt,
        schedule.nextRunAt,
        schedule.intervalSeconds,
        schedule.dailyAt,
        schedule.createdAt,
        schedule.lastRunAt,
      );
    return schedule;
  }
}

function toSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: row['id'] as string,
    channelId: row['channel_id'] as string,
    prompt: row['prompt'] as string,
    nextRunAt: row['next_run_at'] as number,
    intervalSeconds: (row['interval_seconds'] as number | null) ?? null,
    dailyAt: (row['daily_at'] as string | null) ?? null,
    createdAt: row['created_at'] as number,
    lastRunAt: (row['last_run_at'] as number | null) ?? null,
  };
}

/** Human-readable cadence, for `list_schedules` output and log lines. */
export function describeCadence(schedule: Schedule): string {
  if (schedule.intervalSeconds !== null) return `every ${schedule.intervalSeconds}s`;
  if (schedule.dailyAt !== null) return `daily at ${schedule.dailyAt}`;
  return 'once';
}
