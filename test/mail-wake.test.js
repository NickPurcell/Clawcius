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
import { buildSpawnTools } from '../dist/spawn-tool.js';

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
    start: (agent, context) => started.push({ id: agent.id, context }),
    log: () => {},
  });
  // What index.ts wires: a delivery is the fast path into a sweep.
  mail.onDelivered = (message) => waker.onDelivered(message.recipient);

  return { registry, mail, waker, busy, started, add };
}

const note = (author, recipient, body = 'hello') => ({
  author,
  recipient,
  subject: 's',
  body,
});

test('mail delivered to an idle agent starts a turn with the mail already read', () => {
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
    0,
    'the turn opened with it read, so checkMail must not hand it over twice',
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

  // The turn ends. index.ts sweeps on every busy-count change.
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
  assert.equal(mail.unread('hamachi-engineer1').length, 1);

  busy.delete('hamachi-engineer1');
  waker.sweep();
  assert.equal(started.length, 2);
  assert.match(started[1].context.mail, /second/);
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

// ── spawn: the waker is what makes a new row an agent ───────────────────────
//
// The property these are for is the one the whole of `src/spawn-tool.ts` rests
// on: a row that has never run is not a special case. `SessionManager.acquire`
// resumes a session id when there is one and starts a fresh session when there
// is not, and the waker does not look at the difference — so spawning is "write
// the row, then send it mail", and the machinery that was already here does the
// rest. If that stops being true, spawn silently becomes a way of creating
// agents that nobody can reach.
//
// Belongs in `test/spawn-tool.test.js`; here because a new file under `test/`
// has twice blocked a deploy on the host's copy (Clawcius #104, #116).

const spawnCharter = (vars) =>
  `You are ${vars.id}, a ${vars.role} of crew ${vars.crew}, spawned by ` +
  `${vars.spawnedBy}.\n\n${vars.instructions}`;

function spawnInto({ registry, mail }, coordinatorId, workspaceRoot, log = () => {}) {
  const [spawn] = buildSpawnTools(coordinatorId, {
    registry,
    mail,
    workspaceRoot,
    charter: spawnCharter,
    wakesOnMail: true,
    log,
  });
  return spawn;
}

test('an agent that has never run is woken by the mail its spawn delivered', async () => {
  const { registry, mail, waker, started } = board();
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'clawsky-spawn-wake-'));
  const spawn = spawnInto({ registry, mail }, 'hamachi-coordinator', workspaceRoot);

  await spawn.handler(
    { role: 'researcher', instructions: 'Find out what changed in #117.' },
    {},
  );

  // Delivered inside the tool call, so the fast path has already run: the turn
  // starts before spawn returns rather than on the next sweep.
  const woken = started.filter((s) => s.id === 'hamachi-researcher1');
  assert.equal(woken.length, 1);
  assert.equal(woken[0].context.kind, 'mail');
  assert.match(woken[0].context.mail, /You are hamachi-researcher1, a researcher/);
  assert.match(woken[0].context.mail, /Find out what changed in #117/);
  assert.match(woken[0].context.mail, /from hamachi-coordinator/);

  assert.equal(registry.get('hamachi-researcher1').sessionId, '', 'nothing to resume — it is new');
  assert.equal(mail.unread('hamachi-researcher1').length, 0, 'the turn opened with it read');

  waker.sweep();
  assert.equal(
    started.filter((s) => s.id === 'hamachi-researcher1').length,
    1,
    'and a later sweep does not hand it the same first turn twice',
  );
  registry.close();
});

test('a spawn whose first turn could not start is queued, not lost', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'clawsky-spawn-cap-')), 'clawcius.db');
  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);
  registry.ensure('hamachi-coordinator', {
    crew: 'hamachi',
    role: 'coordinator',
    workspacePath: '/w/coordinator',
  });

  let atCapacity = true;
  const started = [];
  const waker = new MailWaker({
    crew: 'hamachi',
    registry,
    mail,
    busy: () => false,
    start: (agent, context) => {
      if (atCapacity) throw new Error('at capacity (4 concurrent sessions)');
      started.push({ id: agent.id, context });
    },
    log: () => {},
  });
  mail.onDelivered = (message) => waker.onDelivered(message.recipient);

  const workspaceRoot = mkdtempSync(join(tmpdir(), 'clawsky-spawn-cap-ws-'));
  const result = await spawnInto(
    { registry, mail },
    'hamachi-coordinator',
    workspaceRoot,
  ).handler({ role: 'engineer', instructions: 'take #121' }, {});

  // The row is real and the caller is told the truth about it rather than a
  // cheerful guess: the agent exists, its turn has not started yet.
  assert.ok(registry.get('hamachi-engineer1'));
  assert.match(result.content.map((p) => p.text).join('\n'), /queued/);
  assert.equal(mail.unread('hamachi-engineer1').length, 1);

  atCapacity = false;
  waker.sweep();
  assert.equal(started.length, 1);
  assert.equal(started[0].id, 'hamachi-engineer1');
  assert.match(started[0].context.mail, /take #121/);
  registry.close();
});

test('a spawned agent survives the process that spawned it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawsky-spawn-restart-'));
  const path = join(dir, 'clawcius.db');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'clawsky-spawn-restart-ws-'));

  // ── first process ──
  {
    const registry = new AgentRegistry(path, { crew: 'hamachi' });
    const mail = new MailStore(registry);
    registry.ensure('hamachi-coordinator', {
      crew: 'hamachi',
      role: 'coordinator',
      workspacePath: '/w/coordinator',
    });
    // No waker at all: nothing is listening, so the first turn is never taken.
    // That is the same situation as a restart landing between the delivery and
    // the wake, and it is the one where a spawn would be lost if the first turn
    // were a call rather than a row.
    await spawnInto({ registry, mail }, 'hamachi-coordinator', workspaceRoot).handler(
      { role: 'engineer', instructions: 'own the snapshot verifier' },
      {},
    );
    registry.close();
  }

  // ── second process, same file ──
  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);

  const row = registry.get('hamachi-engineer1');
  assert.equal(row.role, 'engineer', 'the identity is on disk, not in the process that minted it');
  assert.equal(row.spawnedBy, 'hamachi-coordinator');
  assert.equal(row.status, 'live');

  const started = [];
  const waker = new MailWaker({
    crew: 'hamachi',
    registry,
    mail,
    busy: () => false,
    start: (agent, context) => started.push({ id: agent.id, context }),
    log: () => {},
  });
  // `start()` sweeps immediately — mail that arrived while this process was
  // down is still mail — so the first turn is handed over late rather than
  // never.
  waker.start();
  waker.stop();

  assert.equal(started.length, 1);
  assert.equal(started[0].id, 'hamachi-engineer1');
  assert.match(started[0].context.mail, /own the snapshot verifier/);

  // And it is reachable afterwards, which is the difference between this and an
  // ephemeral subagent.
  mail.onDelivered = (message) => waker.onDelivered(message.recipient);
  mail.deliver({
    author: 'hamachi-coordinator',
    recipient: 'hamachi-engineer1',
    subject: '',
    body: 'second task',
  });
  assert.equal(started.length, 2);
  assert.match(started[1].context.mail, /second task/);
  registry.close();
});
