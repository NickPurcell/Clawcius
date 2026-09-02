import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { MailWaker } from '../dist/mail-wake.js';
import { buildSpawnTools } from '../dist/spawn-tool.js';

/** Stands in for `prompt.buildSpawnCharter`. */
const spawnCharter = (vars) =>
  `You are ${vars.id}, a ${vars.role} of crew ${vars.crew}, spawned by ` +
  `${vars.spawnedBy}.\n\n${vars.instructions}`;

/** A crew with a coordinator and a poster, and no waker listening. */
const spawnBoard = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'clawsky-spawn-')), 'clawcius.db');
  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);

  registry.ensure('hamachi-coordinator', {
    crew: 'hamachi',
    role: 'coordinator',
    workspacePath: '/w/coordinator',
  });
  registry.ensure('hamachi-poster', { crew: 'hamachi', role: 'poster', workspacePath: '/w/poster' });

  const workspaceRoot = mkdtempSync(join(tmpdir(), 'clawsky-workspaces-'));
  const logged = [];
  const released = [];
  const disarmed = [];
  const toolsOf = (agentId, wakesOnMail = true) =>
    buildSpawnTools(agentId, {
      registry,
      mail,
      workspaceRoot,
      charter: spawnCharter,
      wakesOnMail,
      capacity: () => ({ live: 1, max: 4, idleTimeoutMinutes: 30 }),
      log: (line) => logged.push(line),
      disarm: (owner) => {
        disarmed.push(owner);
        return 2;
      },
      release: async (id) => {
        released.push(id);
      },
    });
  const spawnOf = (agentId, wakesOnMail = true) => toolsOf(agentId, wakesOnMail)[0];
  const retireOf = (agentId) => toolsOf(agentId)[1];

  return { registry, mail, spawnOf, retireOf, workspaceRoot, logged, released, disarmed };
};

/** The same crew with a waker wired the way daemon.ts wires it, and `start` recorded instead of run. */
const wakingBoard = (start) => {
  const board = spawnBoard();
  const started = [];
  const waker = new MailWaker({
    crew: 'hamachi',
    registry: board.registry,
    mail: board.mail,
    busy: () => false,
    start: start ?? ((agent, context, settle) => started.push({ id: agent.id, context, settle })),
    log: () => {},
  });
  board.mail.onDelivered = (message) => waker.onDelivered(message.recipient);
  return { ...board, waker, started };
};

test('spawn mints the id, the workspace and the row, and delivers turn one as mail', async () => {
  const { registry, mail, spawnOf, workspaceRoot, logged } = spawnBoard();

  const result = await spawnOf('hamachi-coordinator').handler(
    { role: 'engineer', instructions: 'Own the ops dry-run work.' },
    {},
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content.map((p) => p.text).join('\n'), /hamachi-engineer1/);

  const row = registry.get('hamachi-engineer1');
  assert.equal(row.role, 'engineer');
  assert.equal(row.crew, 'hamachi');
  assert.equal(row.status, 'live');
  assert.equal(row.spawnedBy, 'hamachi-coordinator');
  assert.equal(row.workspacePath, join(workspaceRoot, 'hamachi-engineer1'));
  assert.equal(existsSync(row.workspacePath), true);

  const inbox = mail.unread('hamachi-engineer1');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'hamachi-coordinator');
  assert.match(inbox[0].body, /You are hamachi-engineer1, a engineer of crew hamachi/);
  assert.match(inbox[0].body, /Own the ops dry-run work/);

  assert.ok(logged.some((line) => line.includes('hamachi-engineer1')), 'the spawn is journaled');
  registry.close();
});

test('the ordinal is the first free one, and an id is never reused', async () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  await spawn.handler({ role: 'engineer', instructions: 'one' }, {});
  await spawn.handler({ role: 'engineer', instructions: 'two' }, {});
  await spawn.handler({ role: 'researcher', instructions: 'three' }, {});

  assert.ok(registry.get('hamachi-engineer1'));
  assert.ok(registry.get('hamachi-engineer2'));
  assert.ok(registry.get('hamachi-researcher1'));
  assert.equal(registry.get('hamachi-engineer2').spawnedBy, 'hamachi-coordinator');

  // A row seeded by hand is a name that is taken; the mint steps over it.
  registry.ensure('hamachi-engineer3', {
    crew: 'hamachi',
    role: 'engineer',
    workspacePath: '/w/seeded',
  });
  await spawn.handler({ role: 'engineer', instructions: 'four' }, {});
  assert.equal(registry.get('hamachi-engineer4').spawnedBy, 'hamachi-coordinator');
  assert.equal(registry.get('hamachi-engineer3').spawnedBy, null);
  registry.close();
});

test('only a coordinator may spawn, and it is read from the row', async () => {
  const { registry, spawnOf } = spawnBoard();

  const refused = await spawnOf('hamachi-poster').handler(
    { role: 'engineer', instructions: 'do a thing' },
    {},
  );
  assert.equal(refused.isError, true);
  assert.equal(registry.get('hamachi-engineer1'), undefined, 'nothing was written');

  const noRow = await spawnOf('hamachi-nobody').handler({ role: 'engineer', instructions: 'x' }, {});
  assert.equal(noRow.isError, true);
  assert.equal(registry.listByCrew('hamachi').length, 2);
  registry.close();
});

test('a coordinator, a role that is not a role, and an empty brief are refused', async () => {
  const { registry, mail, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  for (const args of [
    { role: 'coordinator', instructions: 'help me' },
    { role: 'devops', instructions: 'x' },
    { role: 'engineer', instructions: '   ' },
    { role: 'engineer', instructions: 'x'.repeat(16_001) },
  ]) {
    const refused = await spawn.handler(args, {});
    assert.equal(refused.isError, true, JSON.stringify(args).slice(0, 60));
  }

  assert.deepEqual(
    registry.listByCrew('hamachi').map((row) => row.id).sort(),
    ['hamachi-coordinator', 'hamachi-poster'],
  );
  assert.equal(mail.unread('hamachi-coordinator2').length, 0);
  registry.close();
});

test('every spawnable role spawns, with the role case-folded', async () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  for (const role of ['engineer', 'Researcher', 'poster', 'UPDATER']) {
    const result = await spawn.handler({ role, instructions: `be a ${role}` }, {});
    assert.notEqual(result.isError, true, role);
  }
  assert.equal(registry.get('hamachi-updater1').role, 'updater');
  assert.equal(registry.get('hamachi-researcher1').role, 'researcher');
  assert.equal(registry.get('hamachi-poster1').role, 'poster');
  registry.close();
});

test('spawn refuses when mail would never wake what it created', async () => {
  const { registry, mail, spawnOf } = spawnBoard();

  const refused = await spawnOf('hamachi-coordinator', false).handler(
    { role: 'engineer', instructions: 'take it' },
    {},
  );
  assert.equal(refused.isError, true);
  assert.equal(registry.get('hamachi-engineer1'), undefined, 'no row was written');
  assert.equal(mail.unread('hamachi-engineer1').length, 0);
  registry.close();
});

test('an agent that has never run is woken by the mail its spawn delivered', async () => {
  const { registry, mail, waker, started, spawnOf } = wakingBoard();

  await spawnOf('hamachi-coordinator').handler(
    { role: 'researcher', instructions: 'Find out what changed.' },
    {},
  );

  // Delivered inside the tool call, so the turn starts before spawn returns.
  const woken = started.filter((s) => s.id === 'hamachi-researcher1');
  assert.equal(woken.length, 1);
  assert.equal(woken[0].context.kind, 'mail');
  assert.match(woken[0].context.mail, /You are hamachi-researcher1, a researcher/);
  assert.match(woken[0].context.mail, /Find out what changed/);

  assert.equal(registry.get('hamachi-researcher1').sessionId, '', 'nothing to resume — it is new');

  assert.equal(mail.unread('hamachi-researcher1').length, 1, 'handed over, not yet run');
  woken[0].settle(true, 'turn completed');
  assert.equal(mail.unread('hamachi-researcher1').length, 0, 'the turn ran, so it is consumed');

  waker.sweep();
  assert.equal(started.filter((s) => s.id === 'hamachi-researcher1').length, 1);
  registry.close();
});

test('a spawn whose first turn could not start is queued, not lost', async () => {
  let atCapacity = true;
  const started = [];
  const { registry, mail, waker, spawnOf } = wakingBoard((agent, context) => {
    if (atCapacity) throw new Error('at capacity');
    started.push({ id: agent.id, context });
  });

  const result = await spawnOf('hamachi-coordinator').handler(
    { role: 'engineer', instructions: 'take the snapshot work' },
    {},
  );

  assert.equal(result.isError, undefined);
  assert.ok(registry.get('hamachi-engineer1'));
  assert.equal(mail.unread('hamachi-engineer1').length, 1);

  atCapacity = false;
  waker.sweep();
  assert.equal(started.length, 1);
  assert.equal(started[0].id, 'hamachi-engineer1');
  assert.match(started[0].context.mail, /take the snapshot work/);
  registry.close();
});

test('a spawned agent survives the process that spawned it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawsky-spawn-restart-'));
  const path = join(dir, 'clawcius.db');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'clawsky-spawn-restart-ws-'));
  const spawnInto = (registry, mail) =>
    buildSpawnTools('hamachi-coordinator', {
      registry,
      mail,
      workspaceRoot,
      charter: spawnCharter,
      wakesOnMail: true,
      capacity: () => ({ live: 1, max: 4, idleTimeoutMinutes: 30 }),
      log: () => {},
    })[0];

  {
    const registry = new AgentRegistry(path, { crew: 'hamachi' });
    const mail = new MailStore(registry);
    registry.ensure('hamachi-coordinator', {
      crew: 'hamachi',
      role: 'coordinator',
      workspacePath: '/w/coordinator',
    });
    // No waker at all: nothing is listening, so the first turn is never taken.
    await spawnInto(registry, mail).handler(
      { role: 'engineer', instructions: 'own the snapshot verifier' },
      {},
    );
    registry.close();
  }

  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);

  const row = registry.get('hamachi-engineer1');
  assert.equal(row.role, 'engineer');
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
  waker.start();
  waker.stop();

  assert.equal(started.length, 1);
  assert.equal(started[0].id, 'hamachi-engineer1');
  assert.match(started[0].context.mail, /own the snapshot verifier/);

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

test('a coordinator retires a crewmate: session released, wakes disarmed, mail no longer wakes it', async () => {
  const board = wakingBoard();
  await board.spawnOf('hamachi-coordinator').handler({ role: 'researcher', instructions: 'Look.' });
  board.started.length = 0;

  const result = await board.retireOf('hamachi-coordinator').handler({ id: 'hamachi-researcher1' });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(board.registry.get('hamachi-researcher1').status, 'dead');
  assert.deepEqual(board.released, ['hamachi-researcher1']);
  assert.deepEqual(board.disarmed, ['hamachi-researcher1']);

  board.mail.deliver({ author: 'hamachi-coordinator', recipient: 'hamachi-researcher1', subject: 'more', body: 'x' });
  assert.deepEqual(board.started, [], 'mail must not resurrect a retired agent');

  const again = await board.retireOf('hamachi-coordinator').handler({ id: 'hamachi-researcher1' });
  assert.equal(again.isError, undefined, 'a second retire is not an error');
  assert.equal(board.released.length, 1, 'and releases nothing again');
  assert.equal(board.disarmed.length, 1);
});

test('retire is refused to non-coordinators, for coordinators, and for unknown ids', async () => {
  const board = spawnBoard();
  await board.spawnOf('hamachi-coordinator').handler({ role: 'engineer', instructions: 'Build.' });

  const byPoster = await board.retireOf('hamachi-poster').handler({ id: 'hamachi-engineer1' });
  assert.equal(byPoster.isError, true);
  const self = await board.retireOf('hamachi-coordinator').handler({ id: 'hamachi-coordinator' });
  assert.equal(self.isError, true);
  const unknown = await board.retireOf('hamachi-coordinator').handler({ id: 'hamachi-engineer9' });
  assert.equal(unknown.isError, true);
  board.registry.ensure('clawcius-engineer1', { crew: 'clawcius', role: 'engineer', workspacePath: '/w/other' });
  const otherCrew = await board.retireOf('hamachi-coordinator').handler({ id: 'clawcius-engineer1' });
  assert.equal(otherCrew.isError, true);
  assert.equal(board.registry.get('clawcius-engineer1').status, 'live');
  assert.equal(board.registry.get('hamachi-engineer1').status, 'live');
  assert.deepEqual(board.released, []);
});
