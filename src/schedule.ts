/** The zone every agent's clock is set to, and the one a bare time is read in. */
export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/** How far `nextAfter` will scan for a matching day before calling it never. */
const MAX_SCAN_DAYS = 3000;

const MAX_CATCHUP = 20_000;

/** Sorted, deduplicated field values, plus whether the field was narrowed. */
export type CronFields = {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** `*` in day-of-month? The OR rule below turns on when both are false. */
  domRestricted: boolean;
  dowRestricted: boolean;
  /** The expression as written, normalised to single spaces. */
  text: string;
};

export type CronParse = { ok: true; fields: CronFields } | { ok: false; error: string };

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** `@daily` and friends are cron, but they are not this cron. Say the equivalent. */
const NICKNAMES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

type FieldSpec = { name: string; min: number; max: number; names?: string[] };

/** One cron field: `*`, `a`, `a-b`, any of those with a `/n` step, or a comma list of them. Returns the error text rather than throwing. */
function parseField(raw: string, spec: FieldSpec): { values: number[]; restricted: boolean } | string {
  const text = raw.trim().toLowerCase();
  if (text === '') return `the ${spec.name} field is empty`;

  const named = (token: string): string => {
    if (!spec.names) return token;
    const index = spec.names.indexOf(token);
    return index === -1 ? token : String(index + spec.min);
  };

  const values = new Set<number>();
  let restricted = false;

  for (const part of text.split(',')) {
    const halves = part.split('/');
    if (halves.length > 2) return `the ${spec.name} field: "${part}" has two step markers`;
    const rangeText = halves[0] ?? '';
    const stepText = halves[1];

    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        return `the ${spec.name} field: "${stepText}" is not a step (expected a whole number above 0)`;
      }
      // `*/2` is a narrowing even though the range half is `*`.
      if (rangeText !== '*' || step !== 1) restricted = true;
    }

    let from: number;
    let to: number;
    if (rangeText === '*') {
      from = spec.min;
      to = spec.max;
    } else {
      const bounds = rangeText.split('-').map(named);
      if (bounds.length > 2) return `the ${spec.name} field: "${rangeText}" is not a range`;
      from = Number(bounds[0]);
      to = bounds.length === 2 ? Number(bounds[1]) : from;
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return `the ${spec.name} field: "${rangeText}" is not a number or a range of numbers`;
      }
      if (from < spec.min || from > spec.max || to < spec.min || to > spec.max) {
        return `the ${spec.name} field: "${rangeText}" is outside ${spec.min}-${spec.max}`;
      }
      if (to < from) return `the ${spec.name} field: "${rangeText}" runs backwards`;
      restricted = true;
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  return { values: [...values].sort((a, b) => a - b), restricted };
}

export function parseCron(expression: string): CronParse {
  const raw = String(expression ?? '').trim();
  if (raw === '') return { ok: false, error: 'the expression is empty' };

  const nickname = NICKNAMES[raw.toLowerCase()];
  if (nickname) {
    return {
      ok: false,
      error: `"${raw}" is a cron nickname and this takes the five fields — write "${nickname}"`,
    };
  }

  const parts = raw.split(/\s+/);
  if (parts.length === 6) {
    return {
      ok: false,
      error:
        `"${raw}" has six fields. This is five-field cron with no seconds column — a schedule ` +
        'that can fire every second is not something this delivers as mail. Drop the first field',
    };
  }
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `"${raw}" has ${parts.length} field(s); expected five: minute hour day-of-month month day-of-week`,
    };
  }

  const specs: FieldSpec[] = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day-of-month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
    { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES },
  ];

  const parsed = parts.map((part, index) => parseField(part, specs[index]!));
  for (const result of parsed) {
    if (typeof result === 'string') return { ok: false, error: result };
  }
  const [minute, hour, dom, month, dow] = parsed as Array<{ values: number[]; restricted: boolean }>;

  // Both 0 and 7 are Sunday in every cron there has ever been.
  const daysOfWeek = [...new Set(dow!.values.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);

  return {
    ok: true,
    fields: {
      minutes: minute!.values,
      hours: hour!.values,
      daysOfMonth: dom!.values,
      months: month!.values,
      daysOfWeek,
      domRestricted: dom!.restricted,
      dowRestricted: dow!.restricted,
      text: parts.join(' '),
    },
  };
}

// ── Timezone arithmetic ────────────────────────────────────────────────────

/** Formatters are expensive to build and this builds one per timezone, once. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** A usable zone is `Area/Location`, or exactly UTC. Abbreviations such as `EST` are fixed offsets that never observe DST, so they are refused. */
export function isTimezone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  const name = timeZone.trim();
  if (name.toUpperCase() !== 'UTC' && !name.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

type Wall = { y: number; m: number; d: number; h: number; mi: number; s: number };

/** What clock a given instant shows in a given zone. */
function wallOf(at: number, timeZone: string): Wall {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
function offsetAt(at: number, timeZone: string): number {
  const w = wallOf(at, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(at / 1000) * 1000;
}

/** The instant at which a zone's clock reads the given wall time, or null when that reading does not occur (a spring-forward gap). */
export function epochFromWall(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): number | null {
  const asUtc = Date.UTC(y, m - 1, d, h, mi);

  // A Set, because away from a transition these are the same number and the
  // ordinary case should cost one verification rather than three.
  const offsets = new Set([
    offsetAt(asUtc - 86_400_000, timeZone),
    offsetAt(asUtc, timeZone),
    offsetAt(asUtc + 86_400_000, timeZone),
  ]);

  let earliest: number | null = null;
  for (const offset of offsets) {
    const at = asUtc - offset;
    const check = wallOf(at, timeZone);
    if (check.y !== y || check.m !== m || check.d !== d || check.h !== h || check.mi !== mi) {
      continue;
    }
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/** `YYYY-MM-DD HH:MM PST`, or the time alone with `style: 'time'`. */
export function zonedStamp(at: number, timeZone: string, style: 'full' | 'time' = 'full'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(new Date(at));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const clock = `${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
  if (style === 'time') return clock;
  return `${get('year')}-${get('month')}-${get('day')} ${clock}`;
}

// ── Walking occurrences ────────────────────────────────────────────────────

type Civil = { y: number; m: number; d: number };

function nextCivilDay({ y, m, d }: Civil): Civil {
  const at = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

function civilDayOfWeek({ y, m, d }: Civil): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Does the expression select this calendar day? */
function matchesDay(fields: CronFields, civil: Civil): boolean {
  if (!fields.months.includes(civil.m)) return false;
  const dom = fields.daysOfMonth.includes(civil.d);
  const dow = fields.daysOfWeek.includes(civilDayOfWeek(civil));
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  if (fields.domRestricted) return dom;
  if (fields.dowRestricted) return dow;
  return true;
}

/** The first instant strictly after `after` at which the expression matches. */
export function nextAfter(fields: CronFields, timeZone: string, after: number): number | null {
  const start = wallOf(after, timeZone);
  let civil: Civil = start;

  for (let scanned = 0; scanned <= MAX_SCAN_DAYS; scanned += 1) {
    if (matchesDay(fields, civil)) {
      for (const hour of fields.hours) {
        // ── SEEK, DO NOT RESCAN ────────────────────────────────────────────
        if (scanned === 0 && hour < start.h) continue;
        for (const minute of fields.minutes) {
          if (scanned === 0 && hour === start.h && minute <= start.mi) continue;
          const at = epochFromWall(civil.y, civil.m, civil.d, hour, minute, timeZone);
          // null is the spring-forward gap: that clock reading does not happen
          // today, so the occurrence does not happen today.
          if (at !== null && at > after) return at;
        }
      }
    }
    civil = nextCivilDay(civil);
  }
  return null;
}

/** The `steps`th occurrence strictly after `after`. `steps` is at least 1. */
export function advance(
  fields: CronFields,
  timeZone: string,
  after: number,
  steps: number,
): number | null {
  let at: number | null = after;
  for (let taken = 0; taken < steps; taken += 1) {
    at = nextAfter(fields, timeZone, at as number);
    if (at === null) return null;
  }
  return at;
}

export type SchedulePlan = {
  /** Null when the expression has no further occurrence at all. */
  nextAt: number | null;
  /** Occurrences that came and went with nothing running. Never delivered. */
  skipped: number;
  /** Whether `skipped` is the true count or a floor. */
  skippedExact: boolean;
  /** Set when so many occurrences were missed that the every-N phase was abandoned and now counts from this firing. */
  phaseReset: boolean;
};

/** Where the schedule goes next, stepped from the occurrence being fired now rather than from `now`, which is what keeps the every-N phase across an outage. */
export function planNextFire(
  fields: CronFields,
  timeZone: string,
  everyN: number,
  from: number,
  now: number,
): SchedulePlan {
  let next = advance(fields, timeZone, from, everyN);
  let skipped = 0;
  // THE BUDGET IS IN OCCURRENCES WALKED, NOT IN OCCURRENCES SKIPPED.
  let walked = 0;

  while (next !== null && next <= now) {
    if (walked >= MAX_CATCHUP) {
      // `skipped` is now a floor rather than a count: the loop stopped, the
      // occurrences did not. Saying so is the difference between a number and
      // a number that can be trusted.
      return {
        nextAt: nextAfter(fields, timeZone, now),
        skipped,
        skippedExact: false,
        phaseReset: everyN > 1,
      };
    }
    skipped += 1;
    walked += everyN;
    next = advance(fields, timeZone, next, everyN);
  }

  return { nextAt: next, skipped, skippedExact: true, phaseReset: false };
}

export type FirstFire =
  | { ok: true; at: number }
  | { ok: false; error: string };

/** An O(1) upper bound on how many occurrences lie between two moments. */
function occurrenceCeiling(fields: CronFields, from: number, to: number): number {
  const days = Math.max(0, Math.ceil((to - from) / 86_400_000)) + 1;
  return fields.hours.length * fields.minutes.length * days;
}

/** The first occurrence at or after `now`, in phase with `anchorAt`. */
export function firstFire(
  fields: CronFields,
  timeZone: string,
  everyN: number,
  anchorAt: number,
  now: number,
): FirstFire {
  if (everyN === 1 && anchorAt <= now) {
    const at = nextAfter(fields, timeZone, now);
    if (at === null) {
      return {
        ok: false,
        error:
          'that expression has no occurrence at all — check the day-of-month against the month',
      };
    }
    return { ok: true, at };
  }

  if (anchorAt < now) {
    const ceiling = occurrenceCeiling(fields, anchorAt, now);
    if (ceiling > MAX_CATCHUP) {
      const perDay = fields.hours.length * fields.minutes.length;
      const days = Math.ceil((now - anchorAt) / 86_400_000);
      return {
        ok: false,
        error:
          `the anchor is too far back for this expression to count from — it matches up to ` +
          `${perDay} time(s) a day and the anchor is ${days} day(s) ago, which is up to ` +
          `${ceiling} occurrences to step through before reaching today. Move the anchor ` +
          `forward; any anchor picks the same phase as one ${everyN} occurrences later`,
      };
    }
  }

  // `anchorAt - 1` so an anchor that lands exactly on an occurrence selects
  // that occurrence as number zero rather than the one after it.
  let at = nextAfter(fields, timeZone, anchorAt - 1);
  if (at === null) {
    return {
      ok: false,
      error: 'that expression has no occurrence at all — check the day-of-month against the month',
    };
  }

  // Occurrences walked, not selections made — see the note in `planNextFire`.
  // The ceiling above should already have refused anything that reaches this,
  // which is why it is a backstop rather than the bound anybody reads about.
  for (let walked = 0; at !== null && at <= now; walked += everyN) {
    if (walked >= MAX_CATCHUP) {
      return {
        ok: false,
        error:
          `the anchor is too far in the past for this expression — over ${MAX_CATCHUP} ` +
          'occurrences lie between it and now. Move the anchor forward',
      };
    }
    at = advance(fields, timeZone, at, everyN);
  }
  if (at === null) {
    return { ok: false, error: 'that expression has no occurrence left inside the scan horizon' };
  }

  return { ok: true, at };
}

/** The next few fires, which is the only readable proof of what an expression means. */
export function preview(
  fields: CronFields,
  timeZone: string,
  everyN: number,
  first: number,
  count: number,
): number[] {
  const fires = [first];
  let at: number | null = first;
  while (fires.length < count) {
    at = advance(fields, timeZone, at as number, everyN);
    if (at === null) break;
    fires.push(at);
  }
  return fires;
}
