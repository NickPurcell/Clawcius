import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { MailWaker } from '../dist/mail-wake.js';
import { mailWakeEvents } from '../dist/daemon.js';
import { SUPERSEDED } from '../dist/types.js';

function board(lines = []) {
  const path = join(mkdtempSync(join(tmpdir(), 'clawsky-wake-')), 'clawcius.db');
  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);

  const add = (id, role, crew = 'hamachi') =>
    registry.ensure(id, { crew, role, workspacePath: `/w/${id}` });

  add('hamachi-coordinator', 'coordinator');
  add('hamachi-engineer1', 'engineer');
  add('hamachi-poster', 'poster');

  const busy = new Set();
  const started = [];
  const waker = new MailWaker({
    crew: 'hamachi',
    registry,
    mail,
    busy: (id) => busy.has(id),
    start: (agent, context, settle) => started.push({ id: agent.id, context, settle }),
    log: (line) => lines.push(line),
  });
  // What `main()` in daemon.ts wires: a delivery is the fast path into a sweep.
  mail.onDelivered = (message) => waker.onDelivered(message.recipient);

  return { registry, mail, waker, busy, started, add, lines };
}

const note = (author, recipient, body = 'hello') => ({
  author,
  recipient,
  subject: 's',
  body,
});

test('mail delivered to an idle agent starts a turn, and is read only once it RUNS', () => {
  const { mail, started } = board();
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'look at #31'));

  assert.equal(started.length, 1);
  assert.equal(started[0].id, 'hamachi-engineer1');
  assert.equal(started[0].context.kind, 'mail');
  assert.equal(started[0].context.count, 1);
  assert.match(started[0].context.mail, /look at #31/);
  assert.match(started[0].context.mail, /from hamachi-coordinator/);

  assert.equal(
    mail.unread('hamachi-engineer1').length,
    1,
    'handed over is not the same as read — nothing has run yet',
  );

  started[0].settle(true, 'turn completed');
  assert.equal(
    mail.unread('hamachi-engineer1').length,
    0,
    'once the turn has run, checkMail must not hand it over twice',
  );
});

test('a turn that dies before it runs leaves the mail for the next sweep', () => {
  const { mail, started, busy } = board();
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'the lost one'));
  assert.equal(started.length, 1);

  started[0].settle(false, 'session error: connection refused');

  assert.equal(
    mail.unread('hamachi-engineer1').length,
    1,
    'a turn that produced nothing must not consume the mail',
  );

  // And the next sweep re-offers it, which is the whole point.
  busy.clear();
  started.length = 0;
  mail.onDelivered('hamachi-engineer1');
  assert.equal(started.length, 1, 're-offered rather than lost');
  assert.match(started[0].context.mail, /the lost one/);
});

test('settle is once — onDone and onError can both fire for one turn', () => {
  const lines = [];
  const { mail, started } = board(lines);
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'x'));

  started[0].settle(true, 'turn completed');
  started[0].settle(false, 'session error afterwards');

  assert.equal(
    mail.unread('hamachi-engineer1').length,
    0,
    'a late failure must not un-read mail the turn already consumed',
  );
  assert.ok(
    !lines.some((l) => /turn died before it ran/.test(l)),
    'a turn that RAN must not also be reported as having died — one settle, one outcome',
  );
});

test('nothing interrupts a running turn — mail arriving mid-turn waits', () => {
  const { mail, busy, started } = board();
  busy.add('hamachi-engineer1');

  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'mid-turn'));

  assert.equal(started.length, 0, 'a turn was in flight; nothing may be pushed into it');
  assert.equal(
    mail.unread('hamachi-engineer1').length,
    1,
    'and the message is still unread, so it is not lost',
  );
});

test('the turn that follows a busy one picks up what arrived during it', () => {
  const { mail, waker, busy, started } = board();
  busy.add('hamachi-engineer1');
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'one'));
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'two'));
  assert.equal(started.length, 0);

  // The turn ends. `main()` sweeps on every busy-count change.
  busy.delete('hamachi-engineer1');
  waker.sweep();

  assert.equal(started.length, 1, 'one turn, not one per message');
  assert.equal(started[0].context.count, 2);
  assert.match(started[0].context.mail, /one/);
  assert.match(started[0].context.mail, /two/);
});

test('a second message delivered while the first turn is starting is not lost', () => {
  const { mail, waker, busy, started } = board();

  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'first'));
  assert.equal(started.length, 1);
  // The real SessionManager flips busy synchronously inside `start`; the stub
  // does not, so this is what that moment looks like.
  busy.add('hamachi-engineer1');

  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'second'));
  assert.equal(started.length, 1, 'the running turn is not interrupted');
  assert.equal(mail.unread('hamachi-engineer1').length, 2);

  // The first turn runs and consumes only what it was handed.
  started[0].settle(true, 'turn completed');
  assert.equal(mail.unread('hamachi-engineer1').length, 1, 'only the second is left');

  busy.delete('hamachi-engineer1');
  waker.sweep();
  assert.equal(started.length, 2);
  assert.match(started[1].context.mail, /second/);
  assert.doesNotMatch(started[1].context.mail, /first/, 'the settled one is not re-offered');
});

test('a feed post wakes every reader and not its author', () => {
  const { mail, started } = board();
  mail.deliver(note('hamachi-poster', '*', 'board news'));

  const woken = started.map((entry) => entry.id).sort();
  assert.deepEqual(woken, ['hamachi-coordinator', 'hamachi-engineer1']);
});

test('mail does not resurrect a dead agent', () => {
  const { registry, mail, started } = board();
  registry.setStatus('hamachi-engineer1', 'dead');

  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'come back'));

  assert.equal(started.length, 0, 'kill must actually kill');
  assert.equal(
    mail.unread('hamachi-engineer1').length,
    1,
    'and the mail keeps, so a resurrection hands it over as the first turn',
  );
});

test('a turn that could not be started leaves the mail unread', () => {
  const { registry, mail } = board();
  const started = [];
  const waker = new MailWaker({
    crew: 'hamachi',
    registry,
    mail,
    busy: () => false,
    start: () => {
      throw new Error('at capacity (4 concurrent sessions)');
    },
    log: () => {},
  });
  mail.onDelivered = (message) => waker.onDelivered(message.recipient);

  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'please'));

  assert.equal(started.length, 0);
  assert.equal(
    mail.unread('hamachi-engineer1').length,
    1,
    'collect would have marked it read on the way past; unread + markRead does not',
  );
});

test('settle called synchronously, from inside start(), leaves the mail unread', () => {
  const registry = new AgentRegistry(join(mkdtempSync(join(tmpdir(), 'sync-settle-')), 'c.db'), {
    crew: 'hamachi',
  });
  registry.ensure('hamachi-coordinator', {
    crew: 'hamachi',
    role: 'coordinator',
    workspacePath: '/tmp/c',
    spawnedBy: null,
  });
  registry.ensure('hamachi-engineer1', {
    crew: 'hamachi',
    role: 'engineer',
    workspacePath: '/tmp/e',
    spawnedBy: null,
  });
  const mail = new MailStore(registry);

  const lines = [];
  let settleCalls = 0;
  const waker = new MailWaker({
    crew: 'hamachi',
    registry,
    mail,
    busy: () => false,
    // The synchronous failure: settle runs before start returns.
    start: (_agent, _context, settle) => {
      settleCalls += 1;
      settle(false, 'session error: child transport is dead');
    },
    log: (line) => lines.push(line),
  });
  mail.onDelivered = (message) => waker.onDelivered(message.recipient);

  mail.deliver({
    author: 'hamachi-coordinator',
    recipient: 'hamachi-engineer1',
    subject: 's',
    body: 'must survive',
  });

  assert.equal(
    mail.unread('hamachi-engineer1').length,
    1,
    'a turn that died inside start() must not consume the mail',
  );
  assert.equal(settleCalls, 1);

  // And the log must not claim a wake that did not happen.
  assert.ok(lines.some((l) => /turn died before it ran/.test(l)));
  assert.ok(
    !lines.some((l) => /^woke hamachi-engineer1/.test(l)),
    'no wake happened, so none may be announced',
  );
  registry.close();
});

// ── the ceiling on re-offers ────────────────────────────────────────────────

test('a message that never settles stops being offered, and the line says so', () => {
  const { mail, waker, started, lines } = board();
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'look at #31'));

  // Every turn dies without settling — the standing-refusal case.
  for (let i = 0; i < 10; i += 1) {
    for (const s of started.splice(0)) s.settle(false, 'API refused: billing_error');
    waker.sweep();
  }

  assert.equal(started.length, 0, 'the ceiling must stop the loop');
  const capped = lines.filter((l) => /pausing for/.test(l));
  assert.equal(capped.length, 1, 'and say so ONCE, not every sweep');
  assert.match(capped[0], /offered 3 times/);
  assert.match(capped[0], /stay UNREAD/i);
  assert.doesNotMatch(
    capped[0],
    /any other wake still delivers/i,
    'a discord or scheduled wake does not deliver paused mail; it only allows a poll',
  );
  assert.match(capped[0], /a NEW message to this agent releases the batch/);

  assert.equal(mail.unread('hamachi-engineer1').length, 1);
});

test('a superseded turn does NOT spend one of a message s re-offers', () => {
  // Three Discord messages interleaved with a pending mail turn is ordinary traffic in a coordinator's channel.
  const { mail, waker, started, lines } = board();
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'look at #31'));

  for (let i = 0; i < 6; i += 1) {
    for (const s of started.splice(0)) s.settle(false, SUPERSEDED);
    waker.sweep();
  }

  assert.equal(started.length, 1, 'ordinary Discord traffic must not park the mail');
  assert.deepEqual(
    lines.filter((l) => /pausing for/.test(l)),
    [],
    'and must not blame a refusal that never happened',
  );
});

test('the ceiling is three offers PER WINDOW, not three ever', () => {
  const { mail, waker, started, lines } = board();
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'look at #31'));

  for (let i = 0; i < 5; i += 1) {
    for (const s of started.splice(0)) s.settle(false, 'API refused: server_error');
    waker.sweep();
  }
  assert.equal(started.length, 0, 'the hot loop is bounded');
  assert.equal(lines.filter((l) => /pausing for/.test(l)).length, 1);

  // The window passes and the blip is over.
  const realNow = Date.now;
  try {
    const later = realNow() + 61_000;
    Date.now = () => later;
    waker.sweep();
  } finally {
    Date.now = realNow;
  }

  assert.equal(started.length, 1, 'a paused batch must be offered again once the window passes');
  assert.equal(mail.unread('hamachi-engineer1').length, 1, 'and was never lost while paused');
});

/** Drive `count` sweeps, settling every offer with `why`, and return how many offers were made. */
function grind(board_, why, count, stepMs = 61_000) {
  const { waker, started } = board_;
  const realNow = Date.now;
  let offers = 0;
  try {
    let clock = realNow();
    Date.now = () => clock;
    for (let i = 0; i < count; i += 1) {
      for (const s of started.splice(0)) {
        offers += 1;
        s.settle(false, why);
      }
      // Past the re-offer window, so the soft ceiling is back to zero every time.
      clock += stepMs;
      waker.sweep();
    }
  } finally {
    Date.now = realNow;
  }
  offers += started.splice(0).length;
  return offers;
}

test('one message cannot be offered without bound, however its turns end', () => {
  // #382: a one-shot reminder was re-offered ~230 times across one evening. Each
  // offer is a model call with the whole session attached, so an unbounded count
  // is the whole cost of the bug.
  for (const why of [SUPERSEDED, 'API refused: billing_error', 'the turn died: ECONNRESET']) {
    const b = board();
    b.mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'the one that would not die'));

    const offers = grind(b, why, 100);

    assert.ok(
      offers <= 20,
      `settling every turn with "${why}" produced ${offers} offers of one message — unbounded`,
    );
    assert.equal(
      b.mail.unread('hamachi-engineer1').length,
      1,
      'giving up must park the message, never consume it — nothing is lost',
    );
  }
});

test('new mail does not resurrect a message the waker has given up on', () => {
  // The pause releases when `overdue.length === pending.length` stops holding, so
  // before #382 any later message handed the parked one back to the sweep. An
  // agent on a watchPr poll gets mail every few minutes forever.
  const b = board();
  b.mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'the stuck one'));
  grind(b, SUPERSEDED, 100);
  b.started.length = 0;

  b.mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'a fresh one'));

  assert.equal(b.started.length, 1, 'the new message is still delivered');
  assert.equal(b.started[0].context.count, 1, 'and it arrives ALONE — the parked one is not back');
  assert.match(b.started[0].context.mail, /a fresh one/);
  assert.doesNotMatch(b.started[0].context.mail, /the stuck one/);
});

// ── mailWakeEvents ──────────────────────────────────────────────────────────

const summary = (over = {}) => ({
  isError: false,
  costUsd: 0.01,
  numTurns: 1,
  durationMs: 10,
  subtype: 'success',
  sentMessage: false,
  apiError: null,
  apiErrorKind: null,
  retryScheduled: false,
  retryAttempt: 0,
  ...over,
});

function wired() {
  const out = { log: [], err: [], persisted: 0, released: 0 };
  const events = mailWakeEvents({
    persist: () => (out.persisted += 1),
    release: () => (out.released += 1),
    err: (line) => out.err.push(line),
    log: (line) => out.log.push(line),
    agentId: 'hamachi-engineer1',
  });
  return { events, out };
}

test('a finished mail wake logs its SUBTYPE, not just that it finished', () => {
  const { events, out } = wired();
  events.onDone(summary());
  assert.equal(out.log.length, 1);
  assert.match(out.log[0], /mail wake turn success/);

  const bad = wired();
  bad.events.onDone(summary({ subtype: 'error_max_turns', isError: true }));
  assert.match(bad.out.log[0], /mail wake turn error_max_turns/);
  assert.match(bad.out.log[0], /isError/);
});

test('a refusal logs the REFUSED block and NO completion line', () => {
  // A refused turn did not finish. Logging both would be the handoff-line
  // problem again: two lines that cannot be told apart by grep.
  const { events, out } = wired();
  events.onDone(summary({ apiError: 'API Error: billing_error', apiErrorKind: 'billing_error' }));
  assert.deepEqual(out.log, [], 'a refusal has not finished a turn');
  assert.equal(out.err.length, 1);
  assert.match(out.err[0], /mail wake REFUSED \(billing_error\)/);
  assert.match(out.err[0], /not retrying — mail left unread for the next sweep/);
});

test('a refusal WITH a retry queued says so, and still logs no completion', () => {
  const { events, out } = wired();
  events.onDone(summary({
    apiError: 'API Error: server_error',
    apiErrorKind: 'server_error',
    retryScheduled: true,
    retryAttempt: 1,
  }));
  assert.deepEqual(out.log, []);
  assert.match(out.err[0], /retry 1 queued/);
  assert.doesNotMatch(out.err[0], /left unread for the next sweep/, 'the retry re-runs it');
});

test('the refusal block does not end in a blank line', () => {
  const { events, out } = wired();
  events.onDone(summary({ apiError: 'x', apiErrorKind: 'billing_error' }));
  assert.doesNotMatch(out.err[0], /\n$/);
});

test('every turn persists the session id, refused or not', () => {
  // The id is how an evicted or dropped session resumes the same transcript.
  const a = wired();
  a.events.onDone(summary());
  assert.equal(a.out.persisted, 1);

  const b = wired();
  b.events.onDone(summary({ apiError: 'x', apiErrorKind: 'billing_error' }));
  assert.equal(b.out.persisted, 1, 'a refused turn still has an id worth keeping');
});

test('a stale token releases the session and says so', () => {
  const { events, out } = wired();
  events.onNeedsRespawn();
  assert.equal(out.released, 1);
  assert.match(out.err.join('\n'), /stale token/);
});

test('an async death RELEASES the session, or the agent goes deaf for good', () => {
  const { events, out } = wired();
  events.onError(new Error('connecting to control server: connection refused'));

  assert.equal(out.released, 1, 'a dead session must leave the pool, or nothing wakes this agent again');
  assert.match(out.err.join('\n'), /connection refused/, 'and the journal must name what killed it');
  assert.deepEqual(out.log, [], 'a turn that died did not finish');
});
