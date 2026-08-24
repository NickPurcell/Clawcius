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
 * ── And the zones are not all Californian, which cost a round to learn ──────
 *
 * The first version of this file was 31 tests that all sat in
 * `America/Los_Angeles`. They passed, and they were passing over a real defect:
 * a doubled wall clock resolved to the EARLIER instant west of UTC and the
 * LATER one east of it, because the offset probe landed on opposite sides of
 * the answer depending on the sign. OJ found it by sweeping 23 zones against a
 * brute-force reference — 406 cases, every one of them east of Greenwich — and
 * its closing line is the lesson: `Europe/London` in this file would have
 * caught it, and `America/Los_Angeles` alone never could.
 *
 * So the DST fixtures now run east of UTC as well: 25 OCTOBER and 29 MARCH 2026
 * in London and Berlin, 5 APRIL and 27 SEPTEMBER 2026 in Auckland, and
 * `Australia/Lord_Howe`, whose DST shift is THIRTY MINUTES rather than an hour
 * and which therefore breaks anything that assumes the size of the step.
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
import { ArmedWaker, composeScheduleMail } from '../dist/armed-wake.js';
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

// ── The same two boundaries, east of Greenwich ─────────────────────────────

test('a doubled wall clock resolves to the EARLIER instant east of UTC too, not the later', () => {
  // This is the assertion that was false and passing. Every one of these zones
  // has a positive offset on the day in question, which is the whole point:
  // the defect was invisible from California and unmissable from anywhere else.
  const cases = [
    // zone,                  y  m  d  h  mi, earlier instant,          later
    ['Europe/London', 2026, 10, 25, 1, 30, '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'],
    ['Europe/Berlin', 2026, 10, 25, 2, 30, '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'],
    ['Pacific/Auckland', 2026, 4, 5, 2, 30, '2026-04-04T13:30:00.000Z', '2026-04-04T14:30:00.000Z'],
    // 30-minute DST: nothing here may assume the step is an hour.
    ['Australia/Lord_Howe', 2026, 4, 5, 1, 45, '2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z'],
    // And the western case, unchanged, so the rule is one rule.
    [LA, 2026, 11, 1, 1, 30, '2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z'],
  ];

  for (const [zone, y, m, d, h, mi, earlier, later] of cases) {
    const at = epochFromWall(y, m, d, h, mi, zone);
    // Both instants really do show this clock — that is what makes it doubled.
    assert.equal(zonedStamp(Date.parse(earlier), zone).slice(0, 16), zonedStamp(at, zone).slice(0, 16));
    assert.equal(
      new Date(at).toISOString(),
      earlier,
      `${zone} ${y}-${m}-${d} ${h}:${mi} must resolve to the earlier reading, not ${later}`,
    );
    assert.notEqual(new Date(at).toISOString(), later);
  }
});

test('a spring-forward gap is a gap east of UTC as well, including a half-hour one', () => {
  assert.equal(epochFromWall(2026, 3, 29, 1, 30, 'Europe/London'), null, 'London 29 Mar 01:30');
  assert.equal(epochFromWall(2026, 3, 29, 2, 30, 'Europe/Berlin'), null, 'Berlin 29 Mar 02:30');
  assert.equal(epochFromWall(2026, 9, 27, 2, 30, 'Pacific/Auckland'), null, 'Auckland 27 Sep 02:30');
  // Lord Howe skips only 02:00-02:30, so 02:15 is a gap and 02:45 is not.
  assert.equal(epochFromWall(2026, 10, 4, 2, 15, 'Australia/Lord_Howe'), null);
  assert.notEqual(epochFromWall(2026, 10, 4, 2, 45, 'Australia/Lord_Howe'), null);
  // And the minute either side of a gap is not a gap.
  assert.notEqual(epochFromWall(2026, 3, 29, 0, 59, 'Europe/London'), null);
  assert.notEqual(epochFromWall(2026, 3, 29, 2, 0, 'Europe/London'), null);
});

test('London keeps 9am at 9am, and fires once in its repeated hour', () => {
  const daily = cron('0 9 * * *');
  let at = nextAfter(daily, 'Europe/London', Date.parse('2026-03-27T00:00:00Z'));
  const stamps = [];
  for (let i = 0; i < 3; i += 1) {
    stamps.push([new Date(at).toISOString(), zonedStamp(at, 'Europe/London')]);
    at = nextAfter(daily, 'Europe/London', at);
  }
  // 29 March is when the UK clocks go forward. 9am stays 9am; the instant moves.
  assert.deepEqual(stamps, [
    ['2026-03-27T09:00:00.000Z', '2026-03-27 09:00 GMT'],
    ['2026-03-28T09:00:00.000Z', '2026-03-28 09:00 GMT'],
    ['2026-03-29T08:00:00.000Z', '2026-03-29 09:00 GMT+1'],
  ]);

  // 01:30 daily across 25 October fires once, at the BST reading.
  const nightly = fires('30 1 * * *', Date.parse('2026-10-23T00:00:00Z'), 4, 'Europe/London');
  assert.deepEqual(nightly, [
    '2026-10-23T00:30:00.000Z',
    '2026-10-24T00:30:00.000Z',
    '2026-10-25T00:30:00.000Z', // BST, the earlier of the two 01:30s
    '2026-10-26T01:30:00.000Z',
  ]);

  // And 24 fires across the 25-hour day, the same as Los Angeles.
  const hourly = cron('30 * * * *');
  const start = epochFromWall(2026, 10, 24, 23, 59, 'Europe/London');
  const end = epochFromWall(2026, 10, 26, 0, 0, 'Europe/London');
  let count = 0;
  for (let t = nextAfter(hourly, 'Europe/London', start); t < end; t = nextAfter(hourly, 'Europe/London', t)) {
    count += 1;
  }
  assert.equal(count, 24);
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

// ── Walks that must not stop the process ───────────────────────────────────

test('a back-dated anchor does not walk when everyN is 1, because it cannot matter', () => {
  const fields = cron('* * * * *');
  const now = Date.parse('2026-08-16T12:00:00Z');

  // Six years of minutes lie between this anchor and now — three million
  // occurrences. With everyN 1 every one of them is selected, so which is
  // "number zero" cannot change the answer, and walking to find that out was
  // 19 seconds of blocked event loop.
  const started = Date.now();
  const result = firstFire(fields, LA, 1, Date.parse('2020-01-01T00:00:00Z'), now);
  const elapsed = Date.now() - started;

  assert.ok(result.ok, result.error);
  // The answer is the same one the anchor-free question has.
  assert.equal(result.at, nextAfter(fields, LA, now));
  assert.equal(new Date(result.at).toISOString(), '2026-08-16T12:01:00.000Z');
  // Deliberately loose: this is a regression guard against an O(occurrences)
  // walk reappearing, not a benchmark. The measured figure is under a
  // millisecond and the value it replaced was 18,971.
  assert.ok(elapsed < 1000, `took ${elapsed}ms — the anchor short-circuit is gone`);
});

test('a FUTURE anchor starts the schedule later, at every everyN — a past one only picks phase', () => {
  const daily = cron('0 9 * * *');
  const now = Date.parse('2026-08-16T12:00:00Z');

  // The short-circuit that makes a back-dated anchor free is guarded on the
  // anchor being in the past, so this case still walks — and must, because
  // "start this daily schedule in December" is a sensible thing to ask for and
  // is the reason the tool description may not say the anchor does nothing.
  const december = firstFire(daily, LA, 1, Date.parse('2026-12-01T08:00:00Z'), now);
  assert.ok(december.ok, december.error);
  assert.equal(zonedStamp(december.at, LA), '2026-12-01 09:00 PST');

  // Whereas a past anchor at everyN 1 genuinely changes nothing.
  const backdated = firstFire(daily, LA, 1, now - 30 * 86_400_000, now);
  const none = firstFire(daily, LA, 1, now, now);
  assert.ok(backdated.ok && none.ok);
  assert.equal(backdated.at, none.at);
  assert.equal(zonedStamp(backdated.at, LA), '2026-08-16 09:00 PDT');
});

test('an anchor whose walk would be unreasonable is refused by arithmetic, not by walking it', () => {
  const now = Date.parse('2026-08-16T12:00:00Z');

  // everyN above 1, so the anchor genuinely does select a phase and the walk
  // cannot be skipped. It can still be declined before it is taken.
  const started = Date.now();
  const dense = firstFire(cron('* * * * *'), LA, 2, now - 300 * 86_400_000, now);
  const elapsed = Date.now() - started;

  assert.equal(dense.ok, false);
  assert.match(dense.error, /1440 time\(s\) a day/);
  assert.match(dense.error, /Move the anchor forward/);
  assert.ok(elapsed < 1000, `took ${elapsed}ms — the refusal walked instead of counting`);

  // A sparse expression over the same span is fine and is not refused: the
  // bound is on the work implied, not on how old the anchor is.
  const sparse = firstFire(cron('0 9 * * 1'), LA, 2, now - 300 * 86_400_000, now);
  assert.ok(sparse.ok, sparse.error);
});

test('the catch-up budget is spent in occurrences walked, not in firings skipped', () => {
  const fields = cron('* * * * *');
  const now = Date.parse('2026-08-16T12:00:00Z');

  // One skipped firing costs `everyN` steps. Budgeting by skips would let this
  // do a hundred times the work of the everyN-1 case under a bound that reads
  // the same — a second against a minute and a half of stopped process.
  const started = Date.now();
  const plan = planNextFire(fields, LA, 100, now - 400 * 86_400_000, now);
  const elapsed = Date.now() - started;

  assert.equal(plan.phaseReset, true, 'the phase was abandoned rather than walked to');
  assert.ok(plan.nextAt !== null && plan.nextAt > now, 'and it still has a next fire');
  assert.ok(elapsed < 5000, `took ${elapsed}ms`);

  // Below the budget nothing is abandoned and the phase is exact.
  const modest = planNextFire(cron('0 9 * * 1'), LA, 2, epochFromWall(2026, 8, 17, 9, 0, LA), now);
  assert.equal(modest.phaseReset, false);
});

test('a count that stopped on the budget is reported as a floor, not as a total', () => {
  const now = Date.parse('2026-08-16T12:00:00Z');

  // Ordinary case: the count is the count.
  const exact = planNextFire(cron('0 9 * * *'), LA, 1, now - 4 * 86_400_000, now);
  assert.equal(exact.skipped, 4);
  assert.equal(exact.skippedExact, true);

  // A minutely schedule thirty days late really missed 43,200 occurrences.
  // The walk stops at the budget, so the number it can report is 20,000 — and
  // the point is that it must not be handed over as though it were 43,200.
  const stopped = planNextFire(cron('* * * * *'), LA, 1, now - 30 * 86_400_000, now);
  assert.equal(stopped.skippedExact, false);
  assert.ok(stopped.skipped < 30 * 1440, 'the walk stopped short, by construction');
  assert.equal(stopped.phaseReset, false, 'everyN is 1, so there was no phase to lose');
});

test('the mail hedges the missed count when it is a floor, and does not when it is not', () => {
  const condition = {
    id: 4,
    owner: 'hamachi-engineer1',
    kind: 'schedule',
    armedAt: 0,
    dueAt: 1_000,
    active: true,
    firedAt: null,
    spec: { note: 'n', cron: '* * * * *', timezone: LA, everyN: 1, anchorAt: 0 },
    seen: { lastFiredAt: null, fires: 0, missed: 0 },
  };

  const floor = composeScheduleMail(condition, 2_000, {
    nextAt: 9_000,
    skipped: 20_000,
    skippedExact: false,
    phaseReset: false,
  });
  assert.match(floor.body, /AT LEAST 20000 further occurrences/);
  assert.match(floor.body, /FLOOR AND NOT A TOTAL/);
  assert.match(floor.body, /More were missed than that/);

  const total = composeScheduleMail(condition, 2_000, {
    nextAt: 9_000,
    skipped: 3,
    skippedExact: true,
    phaseReset: false,
  });
  assert.match(total.body, /^3 further occurrences came and went/m);
  assert.doesNotMatch(total.body, /AT LEAST/);
  assert.doesNotMatch(total.body, /FLOOR AND NOT A TOTAL/);
});

test('the hedge follows the number into listArmed, and latches once it is set', () => {
  const { registry, mail, store } = board();
  const spec = { note: 'dense', cron: '* * * * *', timezone: LA, everyN: 1, anchorAt: 0 };
  // Thirty days late on a minutely schedule: the walk cannot count them all.
  const armed = store.arm(
    'hamachi-engineer1',
    'schedule',
    Date.now() - 30 * 86_400_000,
    spec,
    { lastFiredAt: null, fires: 0, missed: 0 },
  );

  const loop = waker(registry, mail, store);
  loop.tick();

  const afterFirst = store.get(armed.id);
  assert.equal(afterFirst.seen.missedExact, false, 'the row remembers that counting stopped');

  const { listArmed } = toolsFor('hamachi-engineer1', store);
  return listArmed.handler({}, {}).then(async (listed) => {
    assert.match(said(listed), /at least \d+ occurrence\(s\) missed/);

    // Fire it again, on time. This walk counts nothing and is exact, but the
    // running total is a floor forever — one short walk cannot be undone.
    store.reschedule(armed.id, Date.now() - 1000, afterFirst.seen);
    loop.tick();
    assert.equal(store.get(armed.id).seen.missedExact, false, 'it latches');
    assert.match(said(await listArmed.handler({}, {})), /at least/);
    registry.close();
  });
});

test('a phase reset is reported to the agent rather than quietly applied', () => {
  const { registry, mail, store } = board();
  const due = Date.parse('2025-06-01T16:00:00Z');
  store.arm(
    'hamachi-engineer1',
    'schedule',
    due,
    { note: 'dense', cron: '* * * * *', timezone: LA, everyN: 3, anchorAt: due },
    { lastFiredAt: null, fires: 0, missed: 0 },
  );

  waker(registry, mail, store).tick();

  const [delivered] = mail.unread('hamachi-engineer1');
  assert.match(delivered.body, /could not be walked forward/);
  assert.match(delivered.body, /counts from this firing/);
  registry.close();
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

test('two fortnightly schedules on opposite weeks are two schedules, not a duplicate', async () => {
  const { registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  // Anchors derived from the clock rather than written down, because the tool
  // refuses an anchor over a year old and a fixture date would quietly become
  // a failing test twelve months after it was written. The pure-arithmetic
  // tests above pin real dates by name; these cannot.
  const monday = cron('0 9 * * 1');
  const first = nextAfter(monday, LA, Date.now());
  const next = nextAfter(monday, LA, first);
  const asDate = (at) => zonedStamp(at, LA).slice(0, 10);

  // Together these are the weekly job you get by arming the halves separately,
  // which is a coherent thing to want. Everything about them matches except
  // the one field that makes them different.
  const odd = await scheduleRecurring.handler(
    { note: 'standup', cron: '0 9 * * 1', everyN: 2, anchor: asDate(first) },
    {},
  );
  const even = await scheduleRecurring.handler(
    { note: 'standup', cron: '0 9 * * 1', everyN: 2, anchor: asDate(next) },
    {},
  );
  assert.notEqual(odd.isError, true, said(odd));
  assert.notEqual(even.isError, true, said(even));

  const armed = store.listFor('hamachi-engineer1');
  assert.equal(armed.length, 2);
  assert.notEqual(armed[0].dueAt, armed[1].dueAt, 'they fire on different Mondays');

  // But the same schedule spelled with a different anchor is still one
  // schedule twice: an anchor five days before that first Monday selects the
  // very same Monday as occurrence zero, so it is the same first fire and the
  // same schedule.
  //
  // This is also why the comparison is on the computed fire and not on
  // `anchorAt`: the anchor DEFAULTS TO NOW, so two genuinely identical
  // schedules armed a second apart carry different anchors, and a check that
  // included the anchor would look like a duplicate check and match nothing.
  const spelledDifferently = await scheduleRecurring.handler(
    { note: 'standup', cron: '0 9 * * 1', everyN: 2, anchor: asDate(first - 5 * 86_400_000) },
    {},
  );
  assert.equal(spelledDifferently.isError, true, said(spelledDifferently));
  assert.match(said(spelledDifferently), /same next occurrence/);
  assert.equal(store.listFor('hamachi-engineer1').length, 2, 'and no third row');
  registry.close();
});

test('an anchor more than a year out is refused as the typo it almost always is', async () => {
  const { registry, store } = board();
  const { scheduleRecurring } = toolsFor('hamachi-engineer1', store);

  for (const anchor of ['2020-01-01', '2040-01-01']) {
    const result = await scheduleRecurring.handler(
      { note: 'n', cron: '0 9 * * 1', everyN: 2, anchor },
      {},
    );
    assert.equal(result.isError, true, anchor);
    assert.match(said(result), /more than a year/);
  }
  assert.equal(store.listFor('hamachi-engineer1').length, 0);
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

test('a schedule this build cannot read is disarmed and says so — expression OR timezone', () => {
  // Both halves of the spec, because only one of them was guarded to begin
  // with. An unresolvable timezone made `Intl.DateTimeFormat` throw inside the
  // tick, which the per-condition catch logged and swallowed, leaving the row
  // armed and due in the past — so it threw again every 15 seconds, forever,
  // and the owner was never told. The realistic cause is an ICU downgrade,
  // which would do it to every schedule on the board at once.
  for (const [label, spec] of [
    ['expression', { cron: '0 9 * * * L', timezone: LA }],
    ['timezone', { cron: '0 9 * * 1', timezone: 'Mars/Olympus_Mons' }],
  ]) {
    const { registry, mail, store } = board();
    const due = Date.now() - 1000;
    store.arm(
      'hamachi-engineer1',
      'schedule',
      due,
      { note: 'from the future', ...spec, everyN: 1, anchorAt: due },
      { lastFiredAt: null, fires: 0, missed: 0 },
    );

    const loop = waker(registry, mail, store);
    loop.tick();
    loop.tick();
    loop.tick();

    const delivered = mail.unread('hamachi-engineer1');
    assert.equal(delivered.length, 1, `${label}: told once, not once per tick`);
    assert.match(delivered[0].subject, /DISARMED/, label);
    assert.match(delivered[0].body, /from the future/, `${label}: the note comes back with it`);
    assert.equal(
      store.listFor('hamachi-engineer1').length,
      0,
      `${label}: disarmed rather than left throwing every tick`,
    );
    registry.close();
  }
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

  // And it does not overstate the anchor. It said the anchor does NOTHING at
  // everyN 1, which is false for a future one — the description is what an
  // agent reads while deciding how to call the tool, so an absolute that is
  // wrong in one direction is worse here than anywhere else in the change.
  assert.doesNotMatch(scheduleRecurring.description, /does\s+NOTHING/);
  assert.match(scheduleRecurring.description, /A FUTURE anchor delays the first fire/);
  assert.match(scheduleRecurring.description, /A PAST anchor only chooses/);

  // And `remindMe` no longer claims a repeat is impossible, which it was until
  // this tool existed. A retracted sentence left in place is worse than either.
  assert.doesNotMatch(remindMe.description, /There is no repeat option/);
  assert.match(remindMe.description, /ONE-SHOT/);
  assert.match(remindMe.description, /scheduleRecurring/);
  registry.close();
});

// ── everything an agent is shown is PT, and says so ─────────────────────────
//
// THESE EPOCHS ARE CHOSEN, NOT ARBITRARY. The waker runs on the host, which is
// Europe/Berlin; agent containers are America/Los_Angeles. A test that only
// asserts "a zone label is present" passes in both, so it would not have caught
// the defect — the old code produced a correct-looking number in a container and
// a wrong one on the host.
//
// So each epoch below renders in a DIFFERENT HOUR in the two zones, and the
// assertions pin the hour and the literal abbreviation. Weakening either one
// makes these pass on the host, which is the thing they exist to stop.

test('a rendered time is PT, in the hour PT would use — not the host process zone', async () => {
  const { zonedStamp, DEFAULT_TIMEZONE } = await import('../dist/schedule.js');

  // 02:30Z: 19:30 the previous day in PT, 04:30 the same day in Berlin.
  // Different hour AND different date, so nothing accidental can align them.
  const at = Date.parse('2026-08-24T02:30:00Z');

  assert.equal(zonedStamp(at, DEFAULT_TIMEZONE, 'time'), '19:30 PDT');
  assert.equal(zonedStamp(at, DEFAULT_TIMEZONE), '2026-08-23 19:30 PDT');

  // The rendering the host would have produced, kept in the file so the contrast
  // is here rather than in a commit message. Asserted as a DIFFERENCE rather
  // than as a literal: the first draft asserted 'CEST' from memory and this ICU
  // renders Europe/Berlin as 'GMT+2'. What matters is that the host's hour is
  // not PT's, which is the whole defect; the abbreviation it happens to print is
  // not this test's business.
  const asHost = zonedStamp(at, 'Europe/Berlin', 'time');
  assert.notEqual(asHost.slice(0, 5), '19:30', 'host and PT must not agree here');
  assert.equal(asHost.slice(0, 5), '04:30');
});

test('the abbreviation follows the changeover rather than being hardcoded', async () => {
  const { zonedStamp, DEFAULT_TIMEZONE } = await import('../dist/schedule.js');
  // Same wall-clock intent, six months apart. A hardcoded "PDT" passes the test
  // above and fails this one.
  assert.match(zonedStamp(Date.parse('2026-08-24T02:30:00Z'), DEFAULT_TIMEZONE, 'time'), /PDT$/);
  assert.match(zonedStamp(Date.parse('2026-01-15T02:30:00Z'), DEFAULT_TIMEZONE, 'time'), /PST$/);
});

test('DEFAULT_TIMEZONE is the agents\' zone, not the process\'s', async () => {
  const { DEFAULT_TIMEZONE } = await import('../dist/schedule.js');
  assert.equal(DEFAULT_TIMEZONE, 'America/Los_Angeles');
});

test('DEFAULT_TIMEZONE and the container\'s AGENT_TZ are the same zone', async () => {
  // The system prompt tells every agent that `date` in its container agrees with
  // what the waker renders. That is true only while these two independent
  // constants match — one in TypeScript, one in a shell script — and nothing
  // derived either from the other. A sentence asserting a stricter mechanism
  // than the one that shipped is the defect this whole change is about, so the
  // honest comment beside each is now a guarantee instead.
  const { DEFAULT_TIMEZONE } = await import('../dist/schedule.js');
  const { readFileSync } = await import('node:fs');
  const sh = readFileSync('docker/run-container.sh', 'utf8');
  const m = sh.match(/AGENT_TZ="\$\{AGENT_TZ:-([^}"]+)\}"/);
  assert.ok(m, 'AGENT_TZ default not found in run-container.sh — has it moved?');
  assert.equal(
    m[1],
    DEFAULT_TIMEZONE,
    'run-container.sh and schedule.ts disagree about the agent timezone; the ' +
      'system prompt claims they agree',
  );
});

test('a schedule in the reader\'s own zone is rendered once, not twice', async () => {
  // THIS TEST'S FIRST DRAFT TESTED A COPY OF THE FUNCTION. It pasted `alsoIn`'s
  // three lines into the test body and asserted on those, so deleting the whole
  // fix from `armed-tool.ts` left the suite green at 388/388. It was written to
  // close a finding about a duplication nothing asserted on, and it had the
  // identical defect: it asserted on something that was not the shipped code.
  //
  // So it drives the real tool now, and reads the string an agent would read.
  const { registry, store } = board();
  const { scheduleRecurring, listArmed } = toolsFor('hamachi-engineer1', store);

  // BOTH surfaces, because they use different code and I checked: undoing
  // `alsoIn` leaves `listArmed` green, and undoing the `local` suppression
  // leaves the receipt green. One assertion would have caught one defect.
  const receipt = said(
    await scheduleRecurring.handler(
      { note: 'stand-up', cron: '0 9 * * *', timezone: 'America/Los_Angeles' },
      {},
    ),
  );
  assert.doesNotMatch(receipt, /P[DS]T\)/, 'the preview echoed each fire in the same zone');

  const mine = said(await listArmed.handler({}, {}));

  // The reader's own zone: one rendering. No ` (…)` echo, and no second line
  // repeating the first and calling it `local`.
  assert.match(mine, /fires \d{4}-\d{2}-\d{2} \d{2}:\d{2} P[DS]T/);
  assert.doesNotMatch(mine, /P[DS]T\)/, 'the parenthetical repeated the line it annotates');
  assert.doesNotMatch(mine, /P[DS]T local/, 'the `local` line repeated the line above it');

  registry.close();
});

test('a schedule in another zone still shows both, because they are two facts', async () => {
  const { registry, store } = board();
  const { scheduleRecurring, listArmed } = toolsFor('hamachi-engineer1', store);

  const receipt = said(
    await scheduleRecurring.handler(
      { note: 'london stand-up', cron: '0 9 * * *', timezone: 'Europe/London' },
      {},
    ),
  );
  // The preview must still carry both: the schedule's zone and the reader's.
  assert.match(receipt, /GMT\+1.*\(.*P[DS]T\)/, 'the preview dropped the Pacific instant');

  const mine = said(await listArmed.handler({}, {}));

  // Suppression must not have eaten the case it exists to preserve: the
  // schedule's own zone and the reader's are different numbers here.
  assert.match(mine, /local/, 'the schedule-zone line was suppressed when it carried a fact');
  assert.match(mine, /P[DS]T/, 'the reader\'s own zone is missing');
  registry.close();
});
