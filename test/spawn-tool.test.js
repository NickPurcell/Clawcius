/**
 * `spawn` — a coordinator getting a colleague. CLAWSKY.md phase 5.
 *
 * Two halves, and the split is the design rather than a filing convention.
 *
 * THE TOOL. Identity is minted by this process and cannot be passed in. That is
 * the same property `sendMail` has when it refuses to take a `from`, reached
 * the same way — a variable in a closure rather than a field a model fills in —
 * and it is asserted the same way, by naming the complete argument list rather
 * than a denylist. A `spawn` that accepted an id would let a coordinator mint
 * `hamachi-host`, or a second row for a name another agent already answers to.
 *
 * THE WAKE. The whole of `src/spawn-tool.ts` rests on a row that has never run
 * not being a special case: `SessionManager.acquire` resumes a session id when
 * there is one and starts a fresh session when there is not, and `MailWaker`
 * does not look at the difference. That is what makes spawning "write the row,
 * then send it mail" rather than new session plumbing. If it stops being true,
 * spawn quietly becomes a way of creating agents nobody can reach — which is
 * why the last test here spawns into one process, reopens the database in
 * another, and checks the first turn is handed over late rather than never.
 *
 * Run against `dist/`, not `src/`: Node's type stripping does not resolve a
 * `.js` specifier to a `.ts` file, and testing the built output is also what
 * catches the stale-dist failure this repo keeps hitting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { MailWaker } from '../dist/mail-wake.js';
import { buildSpawnTools } from '../dist/spawn-tool.js';

/** What the model reads back out of a tool result. */
const said = (result) => result.content.map((part) => part.text).join('\n');

/**
 * Stands in for `prompt.buildSpawnCharter`, which reads the template out of
 * agent-config.yaml. What matters here is which values reach it.
 */
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
  // The pool the waker would be drawing on. Mutable so a test can fill it.
  const capacity = { live: 1, max: 4, idleTimeoutMinutes: 0 };
  const spawnOf = (agentId) =>
    buildSpawnTools(agentId, {
      registry,
      mail,
      workspaceRoot,
      charter: spawnCharter,
      wakesOnMail: true,
      capacity: () => capacity,
      log: (line) => logged.push(line),
    })[0];

  return { registry, mail, spawnOf, workspaceRoot, logged, capacity };
};

/**
 * The same crew with the waker wired as `main()` in daemon.ts wires it — a delivery is the
 * fast path into a sweep — and `start` recorded instead of run.
 */
const wakingBoard = () => {
  const board = spawnBoard();
  const started = [];
  const waker = new MailWaker({
    crew: 'hamachi',
    registry: board.registry,
    mail: board.mail,
    busy: () => false,
    start: (agent, context) => started.push({ id: agent.id, context }),
    log: () => {},
  });
  board.mail.onDelivered = (message) => waker.onDelivered(message.recipient);
  return { ...board, waker, started };
};

function spawnInto({ registry, mail }, coordinatorId, workspaceRoot, log = () => {}) {
  const [spawn] = buildSpawnTools(coordinatorId, {
    registry,
    mail,
    workspaceRoot,
    charter: spawnCharter,
    wakesOnMail: true,
    capacity: () => ({ live: 1, max: 4, idleTimeoutMinutes: 0 }),
    log,
  });
  return spawn;
}

// ── The tool: identity, roles, refusals ─────────────────────────────────────

test('spawn has no argument that names the agent it creates', () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  // Exhaustive, for the same reason `sendMail` has no `from`: an `id` added
  // here later would let a coordinator mint `hamachi-host`, or a second row for
  // a name another agent already answers to.
  assert.deepEqual(Object.keys(spawn.inputSchema).sort(), ['instructions', 'role']);
  assert.equal(spawn.name, 'spawn');
  registry.close();
});

test('spawn mints the id, the workspace and the row, and delivers turn one', async () => {
  const { registry, mail, spawnOf, workspaceRoot, logged } = spawnBoard();

  const result = await spawnOf('hamachi-coordinator').handler(
    { role: 'engineer', instructions: 'Own the ops dry-run work. Start with #121.' },
    {},
  );

  assert.equal(result.isError, undefined);
  assert.match(said(result), /hamachi-engineer1/);

  const row = registry.get('hamachi-engineer1');
  assert.equal(row.role, 'engineer');
  assert.equal(row.crew, 'hamachi');
  assert.equal(row.status, 'live');
  assert.equal(row.spawnedBy, 'hamachi-coordinator');
  assert.equal(row.workspacePath, join(workspaceRoot, 'hamachi-engineer1'));
  assert.equal(
    existsSync(row.workspacePath),
    true,
    'a row pointing at a directory that is not there fails at every wake',
  );

  // Turn one is ordinary mail, authored by the coordinator that spawned it.
  const inbox = mail.unread('hamachi-engineer1');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'hamachi-coordinator');
  assert.match(inbox[0].body, /You are hamachi-engineer1, a engineer of crew hamachi/);
  assert.match(inbox[0].body, /Own the ops dry-run work/);

  // Visible from outside the turn that did it — there is no cap on spawning,
  // so the journal is where the cost shows up.
  assert.match(logged.join('\n'), /hamachi-coordinator spawned hamachi-engineer1 \(engineer/);
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

  // A row an operator seeded by hand is a name that is taken, and the mint
  // steps over it rather than colliding with it.
  registry.ensure('hamachi-engineer3', {
    crew: 'hamachi',
    role: 'engineer',
    workspacePath: '/w/seeded',
  });
  await spawn.handler({ role: 'engineer', instructions: 'four' }, {});
  assert.equal(registry.get('hamachi-engineer4').spawnedBy, 'hamachi-coordinator');
  assert.equal(registry.get('hamachi-engineer3').spawnedBy, null, 'the seeded row is untouched');
  registry.close();
});

test('only a coordinator may spawn, and it is read from the row', async () => {
  const { registry, spawnOf } = spawnBoard();

  // The poster holds the tool — the check that matters is against the row at
  // the moment of the call, not against which tools a session happened to be
  // built with.
  const refused = await spawnOf('hamachi-poster').handler(
    { role: 'engineer', instructions: 'do a thing' },
    {},
  );
  assert.equal(refused.isError, true);
  assert.match(said(refused), /only a coordinator may spawn; hamachi-poster is a poster/);
  assert.equal(registry.get('hamachi-engineer1'), undefined, 'and nothing was written');
  registry.close();
});

test('the two roles that carry privilege cannot be spawned', async () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  for (const role of ['coordinator', 'host']) {
    const refused = await spawn.handler({ role, instructions: 'help me' }, {});
    assert.equal(refused.isError, true);
    assert.match(said(refused), /cannot be spawned/);
    assert.match(said(refused), /runs commands on the VPS/);
  }

  assert.deepEqual(
    registry.listByCrew('hamachi').map((row) => row.id).sort(),
    ['hamachi-coordinator', 'hamachi-poster'],
  );
  registry.close();
});

test('a role that is not a role, and a brief that is not a brief, are refused', async () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  const badRole = await spawn.handler({ role: 'devops', instructions: 'x' }, {});
  assert.equal(badRole.isError, true);
  assert.match(said(badRole), /"devops" is not a role/);

  const empty = await spawn.handler({ role: 'engineer', instructions: '   ' }, {});
  assert.equal(empty.isError, true);
  assert.match(said(empty), /nothing to be/);

  assert.equal(registry.listByCrew('hamachi').length, 2);
  registry.close();
});

test('the description tells a coordinator what spawn costs and what it cannot undo', () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  // The description is the only documentation an agent is guaranteed to see.
  assert.match(spawn.description, /hamachi-coordinator/);
  assert.match(spawn.description, /There is no id\s+argument and there never will be one/);
  assert.match(spawn.description, /LONG-LIVED/);
  assert.match(spawn.description, /THERE IS NO KILL VERB YET/);
  assert.match(spawn.description, /ONLY A COORDINATOR MAY SPAWN/);
  registry.close();
});

test('spawn refuses when nothing would ever wake what it created', async () => {
  const { registry, mail, workspaceRoot } = spawnBoard();
  const [spawn] = buildSpawnTools('hamachi-coordinator', {
    registry,
    mail,
    workspaceRoot,
    charter: () => 'unused',
    // The phase-2 deployment: agents send and read mail, and nothing turns a
    // delivery into a turn. A spawned agent has no Discord channel, so this is
    // the one configuration where the row could never run at all.
    wakesOnMail: false,
    capacity: () => ({ live: 1, max: 4, idleTimeoutMinutes: 0 }),
    log: () => {},
  });

  const refused = await spawn.handler({ role: 'engineer', instructions: 'take #121' }, {});
  assert.equal(refused.isError, true);
  assert.match(said(refused), /wakeOnMail/);
  assert.equal(registry.get('hamachi-engineer1'), undefined, 'and no row was written');
  assert.equal(mail.unread('hamachi-engineer1').length, 0);
  registry.close();
});

// ── The wake: a row that has never run is not a special case ────────────────

test('an agent that has never run is woken by the mail its spawn delivered', async () => {
  const { registry, mail, waker, started } = wakingBoard();
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

// ── Capacity: a row that could never take a turn is not written ─────────────

test('spawn refuses when the session pool is full and nothing ever empties it', async () => {
  const { registry, mail, spawnOf, capacity, logged } = spawnBoard();

  // `agent-config.hamachi.yaml`: maxConcurrent 1, idleTimeoutMinutes 0. `spawn`
  // runs inside the calling coordinator's turn, so the coordinator is always
  // holding that one slot — the pool is full by construction at every spawn,
  // not just at a busy moment.
  capacity.live = 1;
  capacity.max = 1;
  capacity.idleTimeoutMinutes = 0;

  const refused = await spawnOf('hamachi-coordinator').handler(
    { role: 'engineer', instructions: 'take #121' },
    {},
  );

  assert.equal(refused.isError, true);
  assert.match(said(refused), /sessions\.maxConcurrent/);
  assert.match(said(refused), /sessions\.idleTimeoutMinutes/);

  // The whole point of refusing rather than queueing. There is no kill verb,
  // `create` refuses a taken id and ids are never reused, so a row written here
  // would be permanently unrunnable and removable only with sqlite3 on the VPS.
  assert.equal(registry.get('hamachi-engineer1'), undefined);
  assert.equal(mail.unread('hamachi-engineer1').length, 0);
  assert.equal(logged.length, 0, 'nothing happened, so nothing is claimed in the journal');
  registry.close();
});

test('a full pool with eviction on is a wait, not a refusal', async () => {
  const { registry, spawnOf, capacity } = spawnBoard();

  // Same full pool, but idle sessions are evicted, so a slot genuinely frees
  // itself and the ten-second sweep picks the agent up. Refusing here would
  // block a spawn that would have worked.
  capacity.live = 3;
  capacity.max = 3;
  capacity.idleTimeoutMinutes = 30;

  const result = await spawnOf('hamachi-coordinator').handler(
    { role: 'engineer', instructions: 'take #121' },
    {},
  );

  assert.equal(result.isError, undefined);
  assert.ok(registry.get('hamachi-engineer1'));
  // And the caller is told which wait it is in. "retries within ~10s" would be
  // the wrong sentence: the retry is real but what it is waiting on is a slot.
  assert.match(said(result), /waiting for a session slot/);
  assert.match(said(result), /frees after 30m idle/);
  registry.close();
});

test('a free slot spawns normally and says the turn started', async () => {
  const { registry, spawnOf, capacity } = spawnBoard();
  capacity.live = 1;
  capacity.max = 4;

  const result = await spawnOf('hamachi-coordinator').handler(
    { role: 'engineer', instructions: 'take #121' },
    {},
  );

  // No waker is wired in this board, so the mail is still unread and the tool
  // reports the ordinary sweep retry rather than a capacity wait.
  assert.equal(result.isError, undefined);
  assert.match(said(result), /sweep retries every ~10s/);
  assert.doesNotMatch(said(result), /waiting for a session slot/);
  registry.close();
});

test('the description separates the policy limit from the machine limit', () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  // "There is no limit on how many you may spawn and nothing will stop you"
  // was true of the policy and false of the machine — the session cap will.
  assert.match(spawn.description, /No POLICY limits how many you may spawn/);
  assert.match(spawn.description, /THE MACHINE LIMITS YOU EVEN SO/);
  assert.doesNotMatch(spawn.description, /nothing will stop you/);
  registry.close();
});
