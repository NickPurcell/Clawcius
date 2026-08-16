/**
 * Recurring schedules: `scheduleRecurring`, the cron arithmetic under it, and
 * the loop that fires it.
 *
 * EVERY FIXTURE HERE SITS ON A DAY WHERE SOMETHING HAPPENS. That is the point
 * of the file and it is the reason it is worth its maintenance: a schedule test
 * anchored to an ordinary Tuesday in June passes against an implementation that
 * stores a UTC instant and adds seven days, which is the implementation this
 * code exists not to be. The days are named because they are load-bearing:
 *
 *   8 MARCH 2026 — Los Angeles has no 02:30 that day. The clocks go 01:59:59 to
 *   03:00:00. An occurrence inside the gap must not run, and must not be
 *   quietly moved to 03:00.
 *
 *   1 NOVEMBER 2026 — Los Angeles has 01:30 twice, at 08:30Z and again at
 *   09:30Z. It must fire ONCE. An hourly schedule runs 24 times across that
 *   25-hour day.
 *
 *   AND ACROSS BOTH — "every day at 9am" must stay 9am. This is the test that
 *   fails for a UTC instant plus a fixed interval, and it fails twice a year,
 *   by an hour, in a direction nobody notices for a week.
 *
 *   17 AUGUST 2026 is a Monday, and the every-other-week fixtures are anchored
 *   to it. The assertion that matters is the one about 24 August: a fortnightly
 *   schedule that fires on the wrong Mondays is right half the time, which is
 *   how it survives a test that only checks the interval.
 *
 * The clock is the one thing not tested here: nothing verifies that a schedule
 * armed in real life fires at the real 9am, because that takes a day to observe
 * and a fake timer would only be testing the fake. What is tested is that the
 * instant computed for a named wall clock is the right instant, which is the
 * half that can be wrong silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { ArmedStore } from '../dist/armed.js';
import { ArmedWaker } from '../dist/armed-wake.js';
import { buildArmedTools, renderArmed } from '../dist/armed-tool.js';
import {
  advance,
  epochFromWall,
  firstFire,
  nextAfter,
  parseCron,
  planNextFire,
  preview,
  zonedStamp,
} from '../dist/schedule.js';

const LA = 'America/Los_Angeles';

function board() {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'clawsky-schedule-')), 'clawcius.db');
  const registry = new AgentRegistry(dbPath, { crew: 'hamachi' });
  const mail = new MailStore(registry);
  const store = new ArmedStore(registry);

  const add = (id, role) => registry.ensure(id, { crew: 'hamachi', role, workspacePath: `/w/${id}` });
  add('hamachi-coordinator', 'coordinator');
  add('hamachi-engineer1', 'engineer');
  add('hamachi-engineer2', 'engineer');

  return { dbPath, registry, mail, store };
}

const said = (result) => result.content.map((part) => part.text).join('\n');

const toolsFor = (agentId, store) =>
  Object.fromEntries(
    buildArmedTools(agentId, {
      store,
      github: null,
      defaultRepo: 'NickPurcell/Clawcius',
      pollSeconds: 120,
    }).map((t) => [t.name, t]),
  );

const waker = (registry, mail, store) =>
  new ArmedWaker({ store, registry, mail, github: null, tickMs: 1000, log: () => {} });

/** The parsed fields, or a failure that names the expression rather than a line. */
function cron(expression) {
  const parsed = parseCron(expression);
  assert.ok(parsed.ok, `"${expression}" should parse: ${parsed.error ?? ''}`);
  return parsed.fields;
}

/** The next `count` fires after `after`, as ISO instants. */
function fires(expression, after, count, timeZone = LA, everyN = 1) {
  const fields = cron(expression);
  const out = [];
  let at = after;
  while (out.length < count) {
    at = advance(fields, timeZone, at, everyN);
    if (at === null) break;
    out.push(new Date(at).toISOString());
  }
  return out;
}

// ── Daylight saving: the whole reason this is not a `setInterval` ───────────

test('9am stays 9am across spring forward — the UTC instant moves, the wall clock does not', () => {
  const fields = cron('0 9 * * *');
  const from = Date.parse('2026-03-06T00:00:00Z');

  const first = nextAfter(fields, LA, from);
  const second = nextAfter(fields, LA, first);
  const third = nextAfter(fields, LA, second);
  const fourth = nextAfter(fields, LA, third);

  // 8 March 2026 is the day the clocks go forward in Los Angeles.
  assert.equal(zonedStamp(first, LA), '2026-03-06 09:00 PST');
  assert.equal(zonedStamp(second, LA), '2026-03-07 09:00 PST');
  assert.equal(zonedStamp(third, LA), '2026-03-08 09:00 PDT');
  assert.equal(zonedStamp(fourth, LA), '2026-03-09 09:00 PDT');

  // The same wall clock is a DIFFERENT instant either side of the boundary,
  // and the gap between two consecutive 9ams is 23 hours, not 24. A schedule
  // stored as a UTC instant plus a fixed interval gets this wrong, and gets it
  // wrong by exactly one hour for the following eight months.
  assert.equal(new Date(second).toISOString(), '2026-03-07T17:00:00.000Z');
  assert.equal(new Date(third).toISOString(), '2026-03-08T16:00:00.000Z');
  assert.equal(third - second, 23 * 3_600_000, 'the short day is 23 hours long');

  // And the other boundary, in the other direction: 1 November 2026.
  const autumn = nextAfter(fields, LA, Date.parse('2026-10-31T00:00:00Z'));
  const afterwards = nextAfter(fields, LA, autumn);
  assert.equal(zonedStamp(autumn, LA), '2026-10-31 09:00 PDT');
  assert.equal(zonedStamp(afterwards, LA), '2026-11-01 09:00 PST');
  assert.equal(afterwards - autumn, 25 * 3_600_000, 'and the long day is 25');
});

test('an hour spring forward removes does not run that day, and is not moved to a nearby one', () => {
  // 02:30 on 8 March 2026 does not exist in Los Angeles.
  assert.equal(epochFromWall(2026, 3, 8, 2, 30, LA), null, 'that clock reading never happens');

  const upcoming = fires('30 2 * * *', Date.parse('2026-03-06T00:00:00Z'), 4);
  assert.deepEqual(upcoming, [
    '2026-03-06T10:30:00.000Z',
    '2026-03-07T10:30:00.000Z',
    // 8 March is absent. It is NOT 03:30, and it is NOT 01:30.
    '2026-03-09T09:30:00.000Z',
    '2026-03-10T09:30:00.000Z',
  ]);

  const skipped = upcoming.map((at) => zonedStamp(Date.parse(at), LA));
  assert.ok(
    !skipped.some((s) => s.startsWith('2026-03-08')),
    'nothing at all runs on the day whose 02:30 does not exist',
  );
});

test('an hour fall back repeats fires once, at the earlier reading, not twice', () => {
  // 01:30 on 1 November 2026 happens at 08:30Z (PDT) and again at 09:30Z (PST).
  const upcoming = fires('30 1 * * *', Date.parse('2026-10-31T00:00:00Z'), 3);
  assert.deepEqual(upcoming, [
    '2026-10-31T08:30:00.000Z',
    // Once. The 09:30Z repeat of the same wall clock is not a second fire.
    '2026-11-01T08:30:00.000Z',
    '2026-11-02T09:30:00.000Z',
  ]);

  // The same property said the way it is actually load-bearing: an hourly
  // schedule sees 24 fires across a 25-hour day.
  const start = epochFromWall(2026, 10, 31, 23, 59, LA);
  const end = epochFromWall(2026, 11, 2, 0, 0, LA);
  const fields = cron('30 * * * *');
  const onTheDay = [];
  for (let at = nextAfter(fields, LA, start); at < end; at = nextAfter(fields, LA, at)) {
    onTheDay.push(new Date(at).toISOString());
  }
  assert.equal(onTheDay.length, 24, '24 fires, not 25');
  assert.ok(onTheDay.includes('2026-11-01T08:30:00.000Z'), 'the first 01:30 fires');
  assert.ok(!onTheDay.includes('2026-11-01T09:30:00.000Z'), 'the second 01:30 does not');
});

test('the timezone is a property of the schedule, not of the host', () => {
  const fields = cron('0 9 * * *');
  // June, so that all three zones are genuinely distinct: London is on GMT
  // until the last Sunday in March, which is a fact worth having tripped over
  // once — an equality here in the wrong month proves nothing either way.
  const from = Date.parse('2026-06-20T00:00:00Z');
  const la = nextAfter(fields, LA, from);
  const london = nextAfter(fields, 'Europe/London', from);
  const utc = nextAfter(fields, 'UTC', from);

  assert.equal(new Date(utc).toISOString(), '2026-06-20T09:00:00.000Z');
  assert.equal(new Date(london).toISOString(), '2026-06-20T08:00:00.000Z', 'BST');
  assert.equal(new Date(la).toISOString(), '2026-06-20T16:00:00.000Z', 'PDT');
  assert.equal(la - london, 8 * 3_600_000);
});

test('an abbreviation is refused even where the system would accept it', () => {
  const { registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  // ICU takes all four of these. `EST` and `MST` are FIXED offsets whose clocks
  // never change, so 9am in them is 8am local for eight months of the year;
  // `PST` is an alias that does change; `PST8PDT` is a legacy spelling. An
  // agent cannot be expected to know which is which, so none are accepted.
  return Promise.all(
    ['EST', 'MST', 'PST', 'PST8PDT'].map(async (zone) => {
      assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: zone }));
      const result = await scheduleRecurring.handler(
        { note: 'n', cron: '0 9 * * 1', timezone: zone },
        {},
      );
      assert.equal(result.isError, true, `${zone} should be refused`);
      assert.match(said(result), /Area\/Location/);
    }),
  ).then(() => {
    assert.equal(store.listFor('hamachi-engineer1').length, 0);
    registry.close();
  });
});

// ── Every N occurrences, counted from an anchor ─────────────────────────────

test('every other week fires on the anchor\'s Mondays, and not on the ones between', () => {
  const fields = cron('0 9 * * 1');
  // 17 August 2026 is a Monday.
  const anchor = epochFromWall(2026, 8, 17, 0, 0, LA);
  const now = Date.parse('2026-08-16T12:00:00Z');

  const first = firstFire(fields, LA, 2, anchor, now);
  assert.ok(first.ok, first.error);

  const upcoming = preview(fields, LA, 2, first.at, 4).map((at) => zonedStamp(at, LA));
  assert.deepEqual(upcoming, [
    '2026-08-17 09:00 PDT',
    '2026-08-31 09:00 PDT',
    '2026-09-14 09:00 PDT',
    '2026-09-28 09:00 PDT',
  ]);
  assert.ok(
    !upcoming.some((s) => s.startsWith('2026-08-24')),
    'the Monday between is the whole point: an interval test alone would pass on it',
  );

  // Every occurrence, for contrast — the same expression at everyN 1.
  const weekly = preview(fields, LA, 1, first.at, 3).map((at) => zonedStamp(at, LA));
  assert.deepEqual(weekly, ['2026-08-17 09:00 PDT', '2026-08-24 09:00 PDT', '2026-08-31 09:00 PDT']);
});

test('the anchor decides which fortnight, and arming later does not shift it', () => {
  const fields = cron('0 9 * * 1');
  const now = Date.parse('2026-08-20T12:00:00Z'); // a Thursday, after the anchor

  const fromSeventeenth = firstFire(fields, LA, 2, epochFromWall(2026, 8, 17, 0, 0, LA), now);
  const fromTwentyFourth = firstFire(fields, LA, 2, epochFromWall(2026, 8, 24, 0, 0, LA), now);
  assert.ok(fromSeventeenth.ok && fromTwentyFourth.ok);

  // Same expression, same moment of arming, different anchor: opposite weeks.
  assert.equal(zonedStamp(fromSeventeenth.at, LA), '2026-08-31 09:00 PDT');
  assert.equal(zonedStamp(fromTwentyFourth.at, LA), '2026-08-24 09:00 PDT');
});

test('an every-other-week schedule keeps its phase across an outage', () => {
  const fields = cron('0 9 * * 1');
  // It fired on the 17th. Then nothing ran for a fortnight.
  const fired = epochFromWall(2026, 8, 17, 9, 0, LA);
  const backUp = Date.parse('2026-09-01T18:00:00Z');

  const plan = planNextFire(fields, LA, 2, fired, backUp);
  assert.equal(plan.skipped, 1, 'the 31st came and went');
  assert.equal(plan.phaseReset, false);
  // 14 September, not 7 September. Recomputing from `now` would give the 7th
  // and the schedule would run on the wrong Mondays from then on, forever.
  assert.equal(zonedStamp(plan.nextAt, LA), '2026-09-14 09:00 PDT');
});

test('a missed daily schedule fires once and counts the rest — never a burst', () => {
  const fields = cron('0 9 * * *');
  const due = epochFromWall(2026, 6, 1, 9, 0, LA);
  const backUp = epochFromWall(2026, 6, 4, 9, 30, LA);

  const plan = planNextFire(fields, LA, 1, due, backUp);
  // The 2nd, the 3rd and the 4th all passed unheard. One mail is delivered for
  // the 1st, late, and it carries the number three.
  assert.equal(plan.skipped, 3);
  assert.equal(zonedStamp(plan.nextAt, LA), '2026-06-05 09:00 PDT');
});

// ── Days of the month, days of the year ────────────────────────────────────

test('the 1st and the 15th', () => {
  assert.deepEqual(
    fires('0 9 1,15 * *', Date.parse('2026-08-16T12:00:00Z'), 4).map((at) =>
      zonedStamp(Date.parse(at), LA),
    ),
    ['2026-09-01 09:00 PDT', '2026-09-15 09:00 PDT', '2026-10-01 09:00 PDT', '2026-10-15 09:00 PDT'],
  );
});

test('the 31st does not run in a 30-day month, and is not clamped to the 30th', () => {
  const upcoming = fires('0 9 31 * *', Date.parse('2026-08-16T12:00:00Z'), 4).map((at) =>
    zonedStamp(Date.parse(at), LA),
  );
  assert.deepEqual(upcoming, [
    '2026-08-31 09:00 PDT',
    // September has 30 days. It is skipped, not moved to the 30th.
    '2026-10-31 09:00 PDT',
    '2026-12-31 09:00 PST',
    '2027-01-31 09:00 PST',
  ]);
  assert.ok(
    !upcoming.some((s) => s.includes('-09-30') || s.includes('-11-30')),
    'clamping would put it on a day nobody asked for, indistinguishably',
  );
});

test('a day of the year', () => {
  assert.deepEqual(
    fires('0 9 25 12 *', Date.parse('2026-08-16T12:00:00Z'), 3).map((at) =>
      zonedStamp(Date.parse(at), LA),
    ),
    ['2026-12-25 09:00 PST', '2027-12-25 09:00 PST', '2028-12-25 09:00 PST'],
  );
});

test('an expression that can never match is refused rather than armed', () => {
  const never = firstFire(cron('0 0 30 2 *'), LA, 1, Date.now(), Date.now());
  assert.equal(never.ok, false);
  assert.match(never.error, /no occurrence/);
});

test('day-of-month and day-of-week are OR, as in every other cron', () => {
  // "the 1st, OR any Monday" — surprising, standard, and warned about at arm
  // time. If this ever becomes AND it is a change to what an expression means.
  const upcoming = fires('0 9 1 * 1', Date.parse('2026-08-16T12:00:00Z'), 4).map((at) =>
    zonedStamp(Date.parse(at), LA),
  );
  assert.deepEqual(upcoming, [
    '2026-08-17 09:00 PDT',
    '2026-08-24 09:00 PDT',
    '2026-08-31 09:00 PDT',
    '2026-09-01 09:00 PDT',
  ]);
});

test('the fields parse the way cron parses them, and refuse the way this needs them to', () => {
  assert.deepEqual(cron('30 8 * * 1-5').daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(cron('0 9 * * MON,FRI').daysOfWeek, [1, 5]);
  assert.deepEqual(cron('0 9 25 DEC *').months, [12]);
  assert.deepEqual(cron('0 9 * * 7').daysOfWeek, [0], 'both 0 and 7 are Sunday');
  assert.deepEqual(cron('0 */6 * * *').hours, [0, 6, 12, 18]);

  // A star with a step is a narrowing, so `*/2` in day-of-month plus a weekday
  // is the OR case rather than a plain weekly.
  assert.equal(cron('0 9 */2 * 1').domRestricted, true);
  assert.equal(cron('0 9 * * 1').domRestricted, false);

  for (const [expression, expected] of [
    ['0 9 * *', /five/],
    ['0 0 9 * * 1', /six fields/],
    ['@daily', /nickname/],
    ['0 9 * * 9', /day-of-week/],
    ['61 9 * * *', /minute/],
    ['0 9 15-1 * *', /backwards/],
    ['', /empty/],
  ]) {
    const parsed = parseCron(expression);
    assert.equal(parsed.ok, false, `"${expression}" should not parse`);
    assert.match(parsed.error, expected);
  }
});

// ── The tool ───────────────────────────────────────────────────────────────

test('scheduleRecurring has no argument that names an agent', () => {
  const { registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  assert.deepEqual(
    Object.keys(scheduleRecurring.inputSchema).sort(),
    ['anchor', 'cron', 'everyN', 'note', 'timezone'],
    'a `for` added later fails here rather than in a review',
  );
  registry.close();
});

test('an owner passed to scheduleRecurring is ignored — the target is the closure', async () => {
  const { registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  await scheduleRecurring.handler(
    { note: 'mine', cron: '0 9 * * 1', owner: 'hamachi-coordinator', for: 'hamachi-coordinator' },
    {},
  );

  assert.equal(store.listFor('hamachi-coordinator').length, 0, 'not the coordinator\'s');
  assert.equal(store.listFor('hamachi-engineer1').length, 1);
  assert.equal(store.listFor('hamachi-engineer1')[0].owner, 'hamachi-engineer1');
  registry.close();
});

test('the receipt prints the next three fires, which is the only readable proof', async () => {
  const { registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  const result = await scheduleRecurring.handler({ note: 'the 31st', cron: '0 9 31 * *' }, {});
  assert.equal(result.isError, false);
  const text = said(result);
  assert.match(text, /next 3 fires/);
  // Three moments, each in the schedule's own zone and not only in UTC — that
  // is what makes a skipped September visible before it is a missing wake.
  assert.ok((text.match(/P[SD]T/g) ?? []).length >= 3, text);
  assert.match(text, /CHECK THOSE TIMES/);
  registry.close();
});

test('a schedule stores its timezone and its expression, not the instant it computed', async () => {
  const { dbPath, registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  await scheduleRecurring.handler(
    { note: 'weekly', cron: '0 9 * * 1', timezone: 'Europe/London', everyN: 2 },
    {},
  );
  registry.close();

  // The process ends; a new one reads the row.
  const revived = new AgentRegistry(dbPath, { crew: 'hamachi' });
  const [rebuilt] = new ArmedStore(revived).listFor('hamachi-engineer1');
  assert.equal(rebuilt.kind, 'schedule');
  assert.equal(rebuilt.spec.cron, '0 9 * * 1');
  assert.equal(rebuilt.spec.timezone, 'Europe/London');
  assert.equal(rebuilt.spec.everyN, 2);
  assert.equal(typeof rebuilt.spec.anchorAt, 'number');
  // And the cached instant still reads 9am in the zone it was armed for, which
  // is the only thing that makes the cache safe to keep at all.
  assert.match(zonedStamp(rebuilt.dueAt, 'Europe/London'), /09:00/);
  revived.close();
});

test('the default zone is the operator\'s, and a bad one is refused rather than guessed', async () => {
  const { registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  await scheduleRecurring.handler({ note: 'default', cron: '0 9 * * 1' }, {});
  assert.equal(store.listFor('hamachi-engineer1')[0].spec.timezone, 'America/Los_Angeles');

  const bad = await scheduleRecurring.handler({ note: 'n', cron: '0 9 * * 1', timezone: 'PST' }, {});
  assert.equal(bad.isError, true);
  assert.match(said(bad), /not an IANA timezone/);
  assert.equal(store.listFor('hamachi-engineer1').length, 1, 'and nothing was written');
  registry.close();
});

test('a bad expression is a refusal that says which field, not a row that never fires', async () => {
  const { registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  for (const [args, expected] of [
    [{ note: 'n', cron: 'every monday' }, /not a cron expression/],
    [{ note: 'n', cron: '0 0 30 2 *' }, /no occurrence/],
    [{ note: '', cron: '0 9 * * 1' }, /no note/],
    [{ note: 'n', cron: '0 9 * * 1', everyN: 0 }, /whole number of 1 or more/],
    [{ note: 'n', cron: '0 9 * * 1', everyN: 500 }, /another field/],
    [{ note: 'n', cron: '0 9 * * 1', anchor: 'next monday' }, /neither a date/],
  ]) {
    const result = await scheduleRecurring.handler(args, {});
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(said(result), expected);
  }
  assert.equal(store.listFor('hamachi-engineer1').length, 0, 'nothing was armed by any of them');
  registry.close();
});

test('the same schedule armed twice is refused — a duplicate repeat has no end date', async () => {
  const { registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  const first = await scheduleRecurring.handler({ note: 'check deploys', cron: '0 9 * * 1' }, {});
  assert.notEqual(first.isError, true);
  const [armed] = store.listFor('hamachi-engineer1');

  const second = await scheduleRecurring.handler({ note: 'check deploys', cron: '0 9 * * 1' }, {});
  assert.equal(second.isError, true);
  assert.match(said(second), new RegExp(`#${armed.id}`), 'the refusal carries the id');
  assert.equal(store.listFor('hamachi-engineer1').length, 1, 'and no second row');

  // A different note at the same time is a different job and is allowed.
  const other = await scheduleRecurring.handler({ note: 'review open PRs', cron: '0 9 * * 1' }, {});
  assert.notEqual(other.isError, true);
  assert.equal(store.listFor('hamachi-engineer1').length, 2);

  // As is the same note in another agent's session — that is not a duplicate.
  const { scheduleRecurring: theirs } = toolsFor('hamachi-engineer2', store);
  const theirCopy = await theirs.handler({ note: 'check deploys', cron: '0 9 * * 1' }, {});
  assert.notEqual(theirCopy.isError, true);
  registry.close();
});

// ── Firing, and being seen to have fired ───────────────────────────────────

test('a schedule fires, books the next occurrence, and stays armed', () => {
  const { registry, mail, store } = board();
  const due = Date.now() - 60_000;
  store.arm(
    'hamachi-engineer1',
    'schedule',
    due,
    {
      note: 'the Monday sweep',
      cron: '0 9 * * 1',
      timezone: LA,
      everyN: 1,
      anchorAt: due,
    },
    { lastFiredAt: null, fires: 0, missed: 0 },
  );

  const loop = waker(registry, mail, store);
  loop.tick();
  loop.tick();
  loop.tick();

  const delivered = mail.unread('hamachi-engineer1');
  assert.equal(delivered.length, 1, 'once per occurrence, not once per tick');
  assert.match(delivered[0].body, /the Monday sweep/);

  const [still] = store.listFor('hamachi-engineer1');
  assert.ok(still, 'a schedule does not disarm itself');
  assert.ok(still.dueAt > Date.now(), 'and its next occurrence is in the future');
  assert.equal(still.seen.fires, 1);
  assert.equal(typeof still.seen.lastFiredAt, 'number');
  registry.close();
});

test('a schedule missed while the service was down fires once, late, and says how many it skipped', () => {
  const { registry, mail, store } = board();
  // Daily at 9am, and the last thing that happened was four days ago.
  const due = Date.now() - 4 * 24 * 3_600_000;
  store.arm(
    'hamachi-engineer1',
    'schedule',
    due,
    { note: 'water the plants', cron: '0 9 * * *', timezone: LA, everyN: 1, anchorAt: due },
    { lastFiredAt: null, fires: 0, missed: 0 },
  );

  waker(registry, mail, store).tick();

  const delivered = mail.unread('hamachi-engineer1');
  assert.equal(delivered.length, 1, 'one mail, not four — a burst is not the work done later');
  assert.match(delivered[0].body, /LATE/);
  assert.match(delivered[0].body, /occurrences came and went/);
  assert.match(delivered[0].body, /NOT delivered/);
  assert.match(delivered[0].body, /water the plants/);

  const [still] = store.listFor('hamachi-engineer1');
  assert.ok(still.seen.missed >= 3, 'and the count is kept on the row, not only in the mail');
  registry.close();
});

test('every mail a schedule sends carries the id that would stop it', () => {
  const { registry, mail, store } = board();
  const due = Date.now() - 1000;
  const armed = store.arm(
    'hamachi-engineer1',
    'schedule',
    due,
    { note: 'n', cron: '0 9 * * 1', timezone: LA, everyN: 1, anchorAt: due },
    { lastFiredAt: null, fires: 0, missed: 0 },
  );

  waker(registry, mail, store).tick();

  const [delivered] = mail.unread('hamachi-engineer1');
  assert.match(delivered.body, new RegExp(`disarm\\(${armed.id}\\)`));
  // And it says what it is not: a schedule posts nothing outward by itself.
  assert.match(delivered.body, /Nothing was posted anywhere on your behalf/);
  assert.match(delivered.body, /Next: /);
  registry.close();
});

test('listArmed shows a schedule with when it last fired and when it fires next', async () => {
  const { registry, mail, store } = board();
  const { scheduleRecurring, listArmed } = toolsFor('hamachi-engineer1', store);
  await scheduleRecurring.handler({ note: 'the Monday sweep', cron: '0 9 * * 1' }, {});

  const before = said(await listArmed.handler({}, {}));
  assert.match(before, /schedule/);
  assert.match(before, /`0 9 \* \* 1`/);
  assert.match(before, /America\/Los_Angeles/);
  assert.match(before, /has not fired yet/, 'never-fired and fired-recently must not look alike');

  // Bring it due and let it fire once.
  const [armed] = store.listFor('hamachi-engineer1');
  store.reschedule(armed.id, Date.now() - 1000, armed.seen);
  waker(registry, mail, store).tick();

  const after = said(await listArmed.handler({}, {}));
  assert.match(after, /last fired \d{4}-\d{2}-\d{2}/);
  assert.match(after, /1 time/);
  assert.match(after, /fires \d{4}-\d{2}-\d{2}/, 'and when it next does');
  registry.close();
});

test('disarm stops a schedule, which is the only thing that ever does', async () => {
  const { registry, mail, store } = board();
  const { scheduleRecurring, disarm } = toolsFor('hamachi-engineer1', store);
  await scheduleRecurring.handler({ note: 'no longer needed', cron: '0 9 * * *' }, {});
  const [armed] = store.listFor('hamachi-engineer1');

  const result = await disarm.handler({ id: armed.id }, {});
  assert.notEqual(result.isError, true);
  assert.match(said(result), /schedule/);

  // Due in the past and disarmed: the loop must not fire it anyway.
  store.reschedule(armed.id, Date.now() - 1000);
  waker(registry, mail, store).tick();
  assert.equal(mail.unread('hamachi-engineer1').length, 0);
  assert.equal(store.listFor('hamachi-engineer1').length, 0);
  registry.close();
});

test('a schedule belongs to one agent, and a crewmate can neither see nor stop it', async () => {
  const { registry, store } = board();
  const mine = toolsFor('hamachi-engineer1', store);
  const theirs = toolsFor('hamachi-engineer2', store);

  await mine.scheduleRecurring.handler({ note: 'mine alone', cron: '0 9 * * 1' }, {});
  const [armed] = store.listFor('hamachi-engineer1');

  assert.doesNotMatch(said(await theirs.listArmed.handler({}, {})), /mine alone/);
  const refused = await theirs.disarm.handler({ id: armed.id }, {});
  assert.equal(refused.isError, true);
  assert.match(said(refused), /belongs to hamachi-engineer1/);
  assert.equal(store.listFor('hamachi-engineer1').length, 1, 'and it is still armed afterwards');
  registry.close();
});

test('a schedule whose expression this build cannot read is disarmed and says so', () => {
  const { registry, mail, store } = board();
  // The shape a schema change would leave behind: a row written by a build
  // whose parser accepted something this one does not.
  const due = Date.now() - 1000;
  store.arm(
    'hamachi-engineer1',
    'schedule',
    due,
    { note: 'from the future', cron: '0 9 * * * L', timezone: LA, everyN: 1, anchorAt: due },
    { lastFiredAt: null, fires: 0, missed: 0 },
  );

  waker(registry, mail, store).tick();

  const [delivered] = mail.unread('hamachi-engineer1');
  assert.match(delivered.subject, /DISARMED/);
  assert.match(delivered.body, /from the future/);
  assert.equal(store.listFor('hamachi-engineer1').length, 0, 'rather than throwing every tick');
  registry.close();
});

test('a schedule with an unreadable spec is listed as unreadable, not thrown over', () => {
  const rendered = renderArmed(
    'hamachi-engineer1',
    [
      {
        id: 7,
        owner: 'hamachi-engineer1',
        kind: 'schedule',
        armedAt: 0,
        dueAt: 1_000,
        active: true,
        firedAt: null,
        spec: {},
        seen: null,
      },
    ],
    { recent: [], older: 0 },
    2_000,
  );
  assert.match(rendered, /#7/);
  assert.match(rendered, /unreadable/);
});

test('the tool descriptions state what a schedule is and is not', () => {
  const { registry, store } = board();
  const { scheduleRecurring, remindMe } = toolsFor('hamachi-engineer1', store);

  // The repeat's own terms.
  assert.match(scheduleRecurring.description, /REPEATS UNTIL YOU STOP IT/);
  assert.match(scheduleRecurring.description, /ONCE, late/);
  assert.match(scheduleRecurring.description, /posts nothing to Discord or anywhere outside/);
  assert.match(scheduleRecurring.description, /America\/Los_Angeles/);
  assert.match(scheduleRecurring.description, /hamachi-engineer1/);

  // And `remindMe` no longer claims a repeat is impossible, which it was until
  // this tool existed. A retracted sentence left in place is worse than either.
  assert.doesNotMatch(remindMe.description, /There is no repeat option/);
  assert.match(remindMe.description, /ONE-SHOT/);
  assert.match(remindMe.description, /scheduleRecurring/);
  registry.close();
});
