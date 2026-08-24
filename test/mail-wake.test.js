/**
 * Mail wakes an idle agent, and does not touch a busy one.
 *
 * The two properties worth a test are the ones that would be invisible if they
 * broke: a turn that gets interrupted looks like an agent behaving oddly rather
 * than like a bug here, and a message that is marked read without a turn ever
 * starting is simply gone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { MailWaker } from '../dist/mail-wake.js';

function board() {
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
    log: () => {},
  });
  // What `main()` in daemon.ts wires: a delivery is the fast path into a sweep.
  mail.onDelivered = (message) => waker.onDelivered(message.recipient);

  return { registry, mail, waker, busy, started, add };
}

const note = (author, recipient, body = 'hello') => ({
  author,
  recipient,
  subject: 's',
  body,
});

test('mail delivered to an idle agent starts a turn, and is read only once it RUNS', () => {
  // The title used to say "with the mail already read", which was the contract
  // until #239: marked read at handoff, before the turn had produced anything.
  // Five messages were lost that way in one second on 2026-08-24.
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

test('a turn that dies before it runs leaves the mail for the next sweep (#239)', () => {
  // THE FIVE-MESSAGE LOSS, as a test. `start` only hands the turn to a session
  // and returns; every way a turn actually dies is asynchronous and lands after
  // that. The worst was `onError` — a dead transport, usually the gVisor sentry
  // OOM-killed inside the container's memcg, which kills every agent in the same
  // second and has done so seven times in four days.
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
  const { mail, started } = board();
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'x'));

  started[0].settle(true, 'turn completed');
  started[0].settle(false, 'session error afterwards');
  assert.equal(
    mail.unread('hamachi-engineer1').length,
    0,
    'a late failure must not un-read mail the turn already consumed',
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
  // TWO unread now, not one: since #239 the first is not consumed until its turn
  // has actually run. `busy` is what stops it being re-offered meanwhile, which
  // is why deferring the mark is safe.
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

test('the waker never runs the host agent — that mailbox belongs to the executor', () => {
  const { mail, waker, add, started } = board();
  add('hamachi-host', 'host');
  mail.deliver(note('hamachi-coordinator', 'hamachi-host', 'restart the proxy'));

  assert.equal(started.length, 0);
  assert.equal(
    mail.unread('hamachi-host').length,
    1,
    'left for the ops executor to read from the host, outside the sandbox',
  );

  waker.sweep();
  assert.equal(started.length, 0, 'and the sweep does not pick it up either');
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
