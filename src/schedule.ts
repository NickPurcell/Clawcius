/**
 * Recurring schedules: when does "every Monday at 9am" next happen?
 *
 * Everything here is pure. Given a cron expression, an IANA timezone and a
 * moment, it says which moment comes next — no database, no clock, no mail. The
 * database half is `armed.ts` and the firing half is `armed-wake.ts`; this is
 * the arithmetic, alone, because the arithmetic is the part that is wrong twice
 * a year and the only way to know it is not is to test it against named days.
 *
 * ── The whole problem is that a schedule is not an instant ──────────────────
 *
 * "Every Monday at 9am" is a WALL CLOCK. `remindMe` stores an instant, which is
 * correct for a one-shot: you asked for a moment and it is that moment forever.
 * A repeat cannot work that way. Store "next Monday 9am" as a UTC instant, add
 * seven days to it each time it fires, and the schedule is right until the
 * clocks change and then it is an hour out for six months — 9am becomes 8am in
 * March and stays there. Nobody notices for a week, because being an hour early
 * looks like nothing at all.
 *
 * So the cron fields are matched against the wall clock IN THE SCHEDULE'S OWN
 * TIMEZONE, and the instant is derived from that every single time. The stored
 * state is the timezone and the expression; the instant in `due_at` is a cache
 * that is recomputed from them after every fire. Get this the wrong way round
 * and the code looks identical in June.
 *
 * The conversion is `Intl.DateTimeFormat` with a `timeZone`, which is the only
 * tz database Node has and the reason nothing is added to package.json. The
 * offsets come out of the same ICU data `date` on the host uses.
 *
 * ── Iterating wall-clock candidates is what makes DST come out right ────────
 *
 * `nextAfter` walks CALENDAR DAYS in the timezone, and inside a matching day it
 * walks the hour and minute values from the expression, in order. Each candidate
 * is a wall clock, converted to an instant exactly once. Two properties fall out
 * of that shape rather than out of special cases, which is why it is the shape:
 *
 *   SPRING FORWARD — 02:30 on 8 March 2026 in Los Angeles does not exist; the
 *   clocks go 01:59:59 → 03:00:00. `epochFromWall` detects it (see below) and
 *   returns null, the candidate is skipped, and the occurrence DOES NOT RUN
 *   THAT DAY. It is not moved to 03:00.
 *
 *   Skipping rather than shifting, argued: a schedule that silently moves is
 *   worse than one that visibly does not run. If it ran at 03:00 it would
 *   collide with whatever the agent has at 03:00, once a year, invisibly. The
 *   skip is not invisible — `scheduleRecurring` prints the next three fire
 *   times in the receipt and `listArmed` prints the next one, so an agent that
 *   asks for 02:30 daily can see the missing day before it happens. That
 *   visibility is what makes skipping the safe answer rather than the strict
 *   one. A schedule that must survive the gap should not sit inside it: 02:30
 *   is one minute of the year and 09:00 is not.
 *
 *   FALL BACK — 01:30 on 1 November 2026 happens twice, at 08:30Z (PDT) and
 *   again at 09:30Z (PST). There is ONE candidate for that wall clock, so it
 *   produces one instant and fires ONCE. `epochFromWall` resolves an ambiguous
 *   wall clock to the earlier of the two — IN EVERY ZONE, which took a second
 *   attempt to make true; see its own comment — so the fire is at 08:30Z and
 *   the repeated hour is passed over. An hourly schedule runs 24 times across
 *   that 25-hour day, not 25. A repeat that fires twice is worse than one that
 *   fires once at the earlier reading, because "twice" is indistinguishable
 *   from a duplicate row, which this codebase has already paid for once
 *   (Clawcius #50).
 *
 * ── Short months are skipped, for the same reason as the gap ────────────────
 *
 * `0 9 31 * *` runs on the 31st of August, October and December, and does not
 * run in September. The day iteration only ever produces days that exist, so
 * this is not a rule — it is the absence of one. Clamping to the last day of the
 * month was the alternative and it is worse: "the 31st" quietly becoming "the
 * 30th" is a schedule that moved without being asked, and the two readings are
 * indistinguishable afterwards. `0 9 28 * *` is what somebody who meant "every
 * month" should write, and the three-occurrence preview in the receipt is where
 * they find out they did not write it.
 *
 * ── Day-of-month and day-of-week are OR, which is standard and is a trap ────
 *
 * `0 9 1 * 1` means "the 1st of the month OR every Monday" in Vixie cron, not
 * "the 1st, if it is a Monday". That is genuinely the standard and it is
 * genuinely surprising, so it is implemented (this is not the place to invent a
 * dialect) and `scheduleRecurring` says so out loud in the receipt when both
 * fields are restricted. The preview underneath the warning is the proof.
 */

/**
 * The zone every schedule gets unless it says otherwise.
 *
 * The operator's, and it is stored per row rather than read from here at fire
 * time. A default that is consulted when the schedule fires is a schedule that
 * changes meaning when the default changes; a default that is consulted when
 * the schedule is armed is a schedule that means what it meant when it was
 * written down. Only the second is auditable a year later.
 */
export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/** How far `nextAfter` will scan for a matching day before calling it never. */
const MAX_SCAN_DAYS = 3000;

/**
 * How many occurrences either walk will step through before it gives up.
 *
 * THIS IS A BUDGET FOR THE EVENT LOOP, not a policy about schedules. Every walk
 * here runs synchronously in the process that serves Discord, mail delivery,
 * the waker and every agent's tools, so its length is a length of time during
 * which nothing else in the system happens. One step costs about 0.05 ms on
 * this host, so twenty thousand is on the order of a second — which is a long
 * time for a restart to stall and an eternity for a tool call.
 *
 * It was 100,000, chosen when a step was thought to be free. OJ measured what
 * that bought: a single `scheduleRecurring` call with a back-dated anchor
 * froze the process for nineteen seconds. The step is ~140x cheaper now (see
 * `nextAfter`), and the budget came down rather than up, because the right
 * number is "how long may this block for" and that answer never depended on
 * how fast a step is.
 *
 * What it costs: a minutely schedule loses its every-N phase after a fortnight
 * of downtime, a five-minute schedule after ten weeks, an hourly one after two
 * years. All of them still FIRE — only the phase is abandoned, and only when
 * `everyN` is above 1, and it is reported rather than silently reset. See
 * `SchedulePlan.phaseReset`.
 */
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

/**
 * One field: a star, `a`, `a-b`, either of those with a `/n` step, or any of
 * them in a comma list. (Star-slash-n is not written out here because a block
 * comment cannot contain it.)
 *
 * Returns the error text rather than throwing, because every caller of this is
 * ultimately a tool result an agent reads, and "the day-of-week field: 9 is
 * above 7" is worth strictly more than a stack trace.
 */
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
      // `*/2` is a narrowing even though the range half is `*`. Getting this
      // wrong would make `0 9 */2 * 1` an OR against every Monday. Never
      // assigned false: this accumulates over the comma list, and one narrowed
      // part narrows the field however the others are written.
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

/**
 * Formatters are expensive to build and this builds one per timezone, once.
 *
 * `nextAfter` can call into here tens of thousands of times when it walks an
 * anchor that is a year in the past, and an `Intl.DateTimeFormat` constructed
 * inside that loop turns a millisecond into a minute.
 */
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

/**
 * A usable zone is `Area/Location`, or exactly UTC. An abbreviation is not one.
 *
 * ICU ACCEPTS `EST` AND IT IS A TRAP, which is the entire reason this is not
 * three lines around a try/catch. `EST` in the tz database is a fixed offset of
 * UTC-5 whose clocks NEVER CHANGE — a 9am schedule in `EST` runs at 9am in
 * January and at 8am local from March to November, every year, and looks
 * completely correct in the row. `MST` and `HST` are the same. `PST`, by pure
 * accident of the alias table, is not: it is a link to America/Los_Angeles and
 * does observe daylight saving. So the abbreviations are not even wrong
 * consistently, which is worse than being wrong.
 *
 * Requiring a slash refuses all of them, in the turn the agent asked, with a
 * message naming the zone it should have written. It also refuses `NZ`, `GB`
 * and the other legacy single-word aliases, which are real zones and are simply
 * spelled the modern way instead. That is a small cost against a silent hour.
 */
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

/**
 * The instant at which a zone's clock reads exactly this — or null if it never
 * does. When it reads that way twice, THE EARLIER INSTANT, in every zone.
 *
 * The offset that applies is a function of the answer, so the answer cannot be
 * computed directly. What is done instead is to CANDIDATE-AND-CHECK: take the
 * offsets in force around the target, subtract each from the wall numbers read
 * as UTC, convert each result back, and keep the ones that really do read the
 * way they were asked to. That check is the whole spring-forward story — 02:30
 * on 8 March in Los Angeles converts back to 01:30 under every candidate
 * offset, so nothing survives and the answer is null rather than a plausible
 * instant an hour out.
 *
 * ── Why three probes and an explicit minimum, rather than two passes ────────
 *
 * The obvious implementation guesses with the offset at the wall numbers read
 * as UTC, then corrects with the offset at that guess. It is right about which
 * instants EXIST, and it was wrong about which one it returned for a doubled
 * wall clock — and wrong in a way that could not be seen from this side of the
 * Atlantic. The first probe lands *before* the true instant for a negative
 * offset and *after* it for a positive one, so the tie broke earlier west of
 * UTC and later east of it. `America/Los_Angeles` fired at the first 01:30 and
 * `Europe/London` at the second, an hour apart, while this comment claimed a
 * single rule for both. OJ found it by sweeping 23 zones against a brute-force
 * reference: 406 cases, all east of Greenwich. The tests could not have found
 * it, because every fixture in them was in California.
 *
 * The invariant was never actually broken — one wall clock still produced one
 * instant and one fire, everywhere — so what was wrong was the DOCUMENTED
 * GUARANTEE rather than any schedule. That is worth fixing properly rather than
 * by weakening the sentence to match the code: most of this file's value to
 * whoever reads it next is that its prose can be trusted, and "the earlier one,
 * except east of UTC, where the later one" is a rule nobody can hold in their
 * head while reasoning about anything else.
 *
 * So: probe a day either side of the target as well as at it. Any transition
 * near enough to matter lies inside that bracket, so both offsets in play are
 * sampled and both readings of a doubled clock are produced. Take the smallest
 * that verifies. Away from a transition all three probes agree, the set has one
 * member, and this costs one extra `Intl` call over the two-pass version.
 */
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

/** "2026-08-17 09:00 PDT" — the only rendering in which a schedule is legible. */
export function zonedStamp(at: number, timeZone: string): string {
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
  return (
    `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ` +
    `${get('timeZoneName')}`
  );
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

/**
 * Does the expression select this calendar day?
 *
 * The day-of-month/day-of-week OR is here, in three lines, and it is the
 * standard's rule rather than a preference: when both fields are narrowed a day
 * matching EITHER is selected. `scheduleRecurring` warns when it applies.
 */
function matchesDay(fields: CronFields, civil: Civil): boolean {
  if (!fields.months.includes(civil.m)) return false;
  const dom = fields.daysOfMonth.includes(civil.d);
  const dow = fields.daysOfWeek.includes(civilDayOfWeek(civil));
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  if (fields.domRestricted) return dom;
  if (fields.dowRestricted) return dow;
  return true;
}

/**
 * The first instant strictly after `after` at which the expression matches.
 *
 * Null means it never does inside the scan horizon, which for a well-formed
 * expression means never at all — `0 0 30 2 *` is the 30th of February. That is
 * refused at arm time rather than becoming a row that waits forever.
 */
export function nextAfter(fields: CronFields, timeZone: string, after: number): number | null {
  const start = wallOf(after, timeZone);
  let civil: Civil = start;

  for (let scanned = 0; scanned <= MAX_SCAN_DAYS; scanned += 1) {
    if (matchesDay(fields, civil)) {
      for (const hour of fields.hours) {
        // ── SEEK, DO NOT RESCAN ────────────────────────────────────────────
        //
        // On the first day only, skip the slots that have already gone by in
        // local time instead of converting each one and discarding it. Both
        // arrays are sorted, so this is a handful of integer comparisons in
        // place of a handful of hundred `Intl` conversions.
        //
        // This is not a micro-optimisation. Without it a call costs O(slots
        // elapsed in the local day), and both `advance` and `planNextFire`
        // repeat the call once per occurrence — synchronously, on the event
        // loop that serves Discord, mail and every other agent's tools. OJ
        // measured the shape it produces: one `* * * * *` walk from a
        // day-old anchor blocked the process for 18,971 ms, and an ordinary
        // five-minute schedule with a week's outage cost ~6 seconds per row
        // on restart. Nothing was wrong with the answers; the process simply
        // stopped for the duration.
        //
        // The `at > after` test below is kept and remains the correctness
        // gate. This only declines to convert candidates that cannot pass it.
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
  /**
   * Whether `skipped` is the true count or a floor.
   *
   * False when the walk stopped on its budget, which means the real number is
   * larger and unknown — 20,000 counted against 43,200 that happened, for a
   * minutely schedule thirty days late. The count exists so that an agent is
   * told about firings it never received, and a count presented as exact when
   * it is not undercuts the one job that sentence has. So the fact that
   * counting stopped travels with the number, and the mail says "at least".
   *
   * THIS BECAME REACHABLE WHEN THE BUDGET CAME DOWN. At 100,000 occurrences
   * nothing realistic hit it; at 20,000 a five-minute schedule with a year's
   * outage does, and so does a minutely one with a fortnight. Lowering the
   * budget was right — it bounds how long the process stops — and this is the
   * consequence of it, handled rather than inherited.
   */
  skippedExact: boolean;
  /**
   * Set when so many occurrences were missed that the every-N phase was
   * abandoned and now counts from this firing. Reported in the mail, not hidden.
   * Meaningless — and always false — when `everyN` is 1, where every occurrence
   * is selected and there is no phase to lose.
   */
  phaseReset: boolean;
};

/**
 * Where the schedule goes next, given where it last was and what time it is.
 *
 * `from` is the occurrence being fired now, NOT the current time, and that is
 * the whole of how the phase survives an outage. Every step is `everyN`
 * occurrences forward from a selected one, so a schedule anchored to the 17th
 * of August and down for a fortnight resumes on the 14th of September — the
 * same day it would have reached had nothing gone wrong — rather than on the
 * 7th, which is what recomputing from `now` would give.
 *
 * The loop counts what it steps over, because the count is the thing the
 * operator asked to be told: fire once, late, and say how many were missed.
 * Never a burst.
 */
export function planNextFire(
  fields: CronFields,
  timeZone: string,
  everyN: number,
  from: number,
  now: number,
): SchedulePlan {
  let next = advance(fields, timeZone, from, everyN);
  let skipped = 0;
  // THE BUDGET IS IN OCCURRENCES WALKED, NOT IN OCCURRENCES SKIPPED. One
  // skipped firing costs `everyN` steps, so counting skips would let a
  // schedule with `everyN: 100` do a hundred times the work of one with
  // `everyN: 1` under a bound that looks identical. Measured, that is the
  // difference between a second and a minute and a half of stopped process.
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

/**
 * An O(1) upper bound on how many occurrences lie between two moments.
 *
 * `hours × minutes` is exactly how many times the expression can match in a
 * day; the day fields can only ever remove days, never add them. So this
 * over-counts — `0 9 * * 1` is scored as one a day rather than one a week —
 * and over-counting is the safe direction for something whose only job is to
 * refuse a walk before taking it.
 */
function occurrenceCeiling(fields: CronFields, from: number, to: number): number {
  const days = Math.max(0, Math.ceil((to - from) / 86_400_000)) + 1;
  return fields.hours.length * fields.minutes.length * days;
}

/**
 * The first fire of a newly armed schedule, and where the anchor comes in.
 *
 * Occurrence zero is the first match at or after the anchor; every selected
 * occurrence is `everyN` steps from it. Arming walks from the anchor to the
 * present so that "every other Monday from the 17th" means the same thing
 * whether it is armed on the 16th or in November. Nothing is stored per step:
 * the phase lives in `due_at` always being a selected occurrence, so this walk
 * happens once, at arm time, and never again.
 *
 * ── Two ways of not taking a walk that would freeze the process ─────────────
 *
 * This runs inside a tool call, which runs on the shared event loop, so the
 * length of the walk is a length of time during which the whole system is
 * stopped. `anchor` is caller-supplied and a back-dated one is cheap to write
 * and expensive to honour.
 *
 * FIRST: WHEN `everyN` IS 1 THERE IS NOTHING TO WALK. Every occurrence is
 * selected, so which one is "number zero" cannot change which one comes next —
 * the answer is just the next occurrence after now, whatever the anchor says.
 * That is not an optimisation with a rounding error in it; it is the same
 * value by definition, and it removes the entire pathological class, because
 * the dense expressions people write (`* * * * *`) are exactly the ones nobody
 * writes an `everyN` for. A future anchor still walks, and walks zero steps.
 *
 * SECOND: COUNT BEFORE WALKING. `occurrenceCeiling` bounds the work in
 * arithmetic, so an anchor that would cost a minute of frozen event loop is
 * refused in the turn that asked, immediately, with the numbers that made it
 * unreasonable. Refusing in O(1) beats refusing in O(MAX_CATCHUP) — the old
 * code did the latter, and OJ timed it at nineteen seconds.
 */
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
