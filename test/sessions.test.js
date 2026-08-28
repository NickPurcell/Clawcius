import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AtCapacityError, SessionManager, TurnSettle, atCapacityNotice } from '../dist/agent.js';
import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { setConfig } from '../dist/config.js';

const CREW = 'hamachi';
const UUID = '0b3f4d1e-1111-4222-8333-444455556666';
const OTHER_UUID = '7c1a2b3d-2222-4333-8444-555566667777';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Only the keys the pool reads, and deliberately so. */
function installConfig({ maxConcurrent, idleTimeoutMinutes, workspaceRoot, modelByRole = {} }) {
  setConfig({
    discord: { token: 'unused-by-the-pool', guildId: 'unused-by-the-pool' },
    github: { token: '' },
    storage: { dbPath: 'unused-by-the-pool' },
    agent: {
      clawsky: { crew: CREW, wakeOnMail: true },
      model: 'model-for-everyone-else',
      modelByRole,
      sessions: { maxConcurrent, idleTimeoutMinutes, workspaceRoot },
    },
  });
}

/** A session that is a session in every way the pool cares about, and starts no container. */
class FakeSession {
  constructor(channelId, workspacePath, resumeSessionId, events, mcpServers, model) {
    this.channelId = channelId;
    this.workspacePath = workspacePath;
    /** What `acquire` resolved from the row's role — undefined means "use `model`". */
    this.model = model;
    this.sessionId = resumeSessionId ?? `pending-${channelId}`;
    this.busy = false;
    this.lastActiveAt = Date.now();
    this.closed = false;
    /** See `isBusy`: a handed-over turn that has not ended yet. */
    this.turnPending = false;
    this.onBusyChanged = () => {};
    /** Every `wake` this session was given, with the per-turn settle. */
    this.wakes = [];
  }

  wake(context, onSettled = null) {
    this.wakes.push({ context, onSettled });
  }

  async close() {
    this.closed = true;
  }
}

/** A manager wired to a real registry on a real (temporary) database. */
function pool(options = {}) {
  const {
    maxConcurrent = 4,
    idleTimeoutMinutes = 0,
    dbPath = join(tempDir('clawsky-sessions-'), 'clawcius.db'),
    workspaceRoot = tempDir('clawsky-workspaces-'),
  } = options;

  installConfig({ maxConcurrent, idleTimeoutMinutes, workspaceRoot });
  const registry = new AgentRegistry(dbPath, { crew: CREW });
  const built = [];
  const manager = new SessionManager(registry);
  manager.newSession = (...args) => {
    const session = new FakeSession(...args);
    built.push(session);
    return session;
  };
  return { manager, registry, dbPath, workspaceRoot, built };
}

const events = {
  onToolUse: () => {},
  onDone: () => {},
  onError: () => {},
  onCliFailure: () => {},
  onNeedsRespawn: () => {},
};

/** Delete a row behind the registry's back, as a stray DELETE would. */
function deleteRow(dbPath, id) {
  const db = new DatabaseSync(dbPath);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  db.close();
}

// ── identity: the row wins ───────────────────────────────────────────────────

function recordingRegistry(rows = {}) {
  return {
    calls: [],
    rows: new Map(Object.entries(rows)),
    get(id) {
      return this.rows.get(id);
    },
    ensure(id, identity) {
      this.calls.push({ method: 'ensure', id, identity });
      const existing = this.rows.get(id);
      if (existing) return existing;
      const created = { id, sessionId: '', status: 'live', spawnedAt: 0, lastActiveAt: 0, ...identity };
      this.rows.set(id, created);
      return created;
    },
    recordSession(id, sessionId, workspacePath, identity) {
      this.calls.push({ method: 'recordSession', id, sessionId, workspacePath, identity });
    },
    touch(id) {
      this.calls.push({ method: 'touch', id });
    },
  };
}

/** A manager over a stubbed registry — no database, no config beyond the pool's. */
function stubbedPool(rows, options = {}) {
  const { maxConcurrent = 4, idleTimeoutMinutes = 0, modelByRole = {} } = options;
  installConfig({
    maxConcurrent,
    idleTimeoutMinutes,
    workspaceRoot: tempDir('clawsky-ws-'),
    modelByRole,
  });
  const registry = recordingRegistry(rows);
  const built = [];
  const manager = new SessionManager(registry);
  manager.newSession = (...args) => {
    const session = new FakeSession(...args);
    built.push(session);
    return session;
  };
  return { manager, registry, built };
}

test('the identity written back for an engineer is the engineer, not a coordinator', async () => {
  const { manager, registry, built } = stubbedPool({
    'hamachi-engineer1': {
      id: 'hamachi-engineer1',
      crew: CREW,
      role: 'engineer',
      sessionId: '',
      workspacePath: '/tmp/engineer1',
      spawnedBy: 'hamachi-coordinator',
    },
  });

  manager.acquire('hamachi-engineer1', events);
  built[0].sessionId = UUID;
  manager.persist('hamachi-engineer1');

  const written = registry.calls.find((call) => call.method === 'recordSession');
  assert.equal(written.identity.role, 'engineer');
  assert.equal(written.identity.crew, CREW);
  assert.equal(written.identity.spawnedBy, 'hamachi-coordinator');
  assert.equal(written.sessionId, UUID);
  await manager.shutdown();
});

test('an engineer stays an engineer in the database too', async () => {
  const { manager, registry } = pool();
  registry.ensure('hamachi-engineer1', {
    crew: CREW,
    role: 'engineer',
    workspacePath: '/tmp/engineer1',
    spawnedBy: 'hamachi-coordinator',
  });

  const session = manager.acquire('hamachi-engineer1', events);
  session.sessionId = UUID;
  manager.persist('hamachi-engineer1');

  // The second defence, over a real database: even handed the wrong identity,
  // `recordSession`'s conflict clause updates the session and nothing else. Both
  // of these have to hold — see the note on `recordingRegistry`.
  const row = registry.get('hamachi-engineer1');
  assert.equal(row.role, 'engineer');
  assert.equal(row.spawnedBy, 'hamachi-coordinator');
  assert.equal(row.sessionId, UUID);
  await manager.shutdown();
});

test('acquire hands ensure the identity the row says, not a default', async () => {
  // The role the pool acts on is the row's, not the one `#identityFor` guessed:
  // `acquire` reads it back out of `ensure`. CLAWSKY.md — "Spawn and kill: held
  // by the coordinator alone".
  const { manager, registry } = stubbedPool({
    'hamachi-engineer1': {
      id: 'hamachi-engineer1',
      crew: CREW,
      role: 'engineer',
      sessionId: '',
      workspacePath: '/tmp/engineer1',
      spawnedBy: 'hamachi-coordinator',
    },
  });
  manager.acquire('hamachi-engineer1', events);
  const ensured = registry.calls.find((call) => call.method === 'ensure');
  assert.equal(ensured.identity.role, 'engineer');
  await manager.shutdown();
});

test('a turn ending for an agent with no row never calls recordSession', async () => {
  const { manager, registry, built } = stubbedPool({});
  manager.acquire('hamachi-engineer1', events);
  built[0].sessionId = UUID;
  // The row was created by `ensure` on the way in. Take it away again.
  registry.rows.delete('hamachi-engineer1');
  registry.calls.length = 0;

  manager.persist('hamachi-engineer1');
  assert.deepEqual(registry.calls, [], 'persist must not touch the registry with no row');
  await manager.shutdown();
});

test('a channel the registry has never heard of is a coordinator, in the configured crew', async () => {
  const { manager, registry, workspaceRoot } = pool();
  manager.acquire('1234567890', events);

  const row = registry.get('1234567890');
  assert.equal(row.role, 'coordinator');
  assert.equal(row.crew, CREW);
  // The id is the channel id and the workspace is under the configured root:
  // minting a prettier name would detach a live session from its channel.
  assert.equal(row.workspacePath, join(workspaceRoot, '1234567890'));
  assert.equal(row.spawnedBy, null);
  await manager.shutdown();
});

test('a turn ending for an agent with no row writes nothing at all', async () => {
  const { manager, registry, dbPath } = pool();
  registry.ensure('hamachi-engineer1', {
    crew: CREW,
    role: 'engineer',
    workspacePath: '/tmp/engineer1',
    spawnedBy: 'hamachi-coordinator',
  });

  const session = manager.acquire('hamachi-engineer1', events);
  session.sessionId = UUID;

  // Something deleted the row mid-turn. Nothing in this tree does that today —
  // `!reset` clears the session id, not the row — which is why the guard needs
  // a test rather than a reproduction.
  deleteRow(dbPath, 'hamachi-engineer1');
  assert.equal(registry.get('hamachi-engineer1'), undefined);

  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return realWrite(chunk, ...rest);
  };
  try {
    manager.persist('hamachi-engineer1');
  } finally {
    process.stderr.write = realWrite;
  }

  // An agent is a row; a turn is not a thing that may create one.
  assert.equal(registry.get('hamachi-engineer1'), undefined);
  // And it is loud, because a silent no-op would hide the delete that made it
  // reachable.
  assert.match(written.join(''), /finished a turn with no registry row — not creating one/);
  await manager.shutdown();
});

test('persist writes nothing while the session id is still the placeholder', async () => {
  const { manager, registry } = pool();
  manager.acquire('1234567890', events);

  // `pending-<channelId>` must never reach SQLite: it is not a UUID, so every
  // later wake for this channel would try to resume from it and the CLI exits 1.
  manager.persist('1234567890');
  assert.equal(registry.get('1234567890').sessionId, '');
  await manager.shutdown();
});

test('persist on a channel with no live session is a no-op', async () => {
  const { manager, registry } = pool();
  registry.ensure('1234567890', {
    crew: CREW,
    role: 'coordinator',
    workspacePath: '/tmp/x',
    spawnedBy: null,
  });
  manager.persist('1234567890');
  assert.equal(registry.get('1234567890').sessionId, '');
  await manager.shutdown();
});

// ── capacity ─────────────────────────────────────────────────────────────────

test('capacity reports the live count, the cap and whether anything empties it', async () => {
  const { manager } = pool({ maxConcurrent: 3, idleTimeoutMinutes: 0 });
  assert.deepEqual(manager.capacity, { live: 0, max: 3, idleTimeoutMinutes: 0 });

  manager.acquire('a', events);
  manager.acquire('b', events);
  // The timeout travels with the two numbers deliberately: a full pool with
  // eviction on is a wait, and a full pool with eviction off does not clear on
  // its own. `spawn` cannot tell those apart from `live` and `max` alone.
  assert.deepEqual(manager.capacity, { live: 2, max: 3, idleTimeoutMinutes: 0 });
  await manager.shutdown();
});

test('acquire throws AtCapacityError at the cap, carrying the numbers', async () => {
  const { manager } = pool({ maxConcurrent: 2 });
  manager.acquire('a', events);
  manager.acquire('b', events);

  let error;
  assert.throws(
    () => manager.acquire('c', events),
    (thrown) => {
      error = thrown;
      return true;
    },
  );
  assert.equal(error.live, 2);
  assert.equal(error.max, 2);
  assert.equal(error.name, 'AtCapacityError');
  // The catch site tells this apart from a spawn failure or a dead transport
  // by class, not by matching on a message.
  assert.equal(error instanceof AtCapacityError, true);
  // And nothing was half-created on the way out.
  assert.equal(manager.has('c'), false);
  assert.equal(manager.capacity.live, 2);
  await manager.shutdown();
});

test('a channel that already holds a slot is served at capacity', async () => {
  const { manager } = pool({ maxConcurrent: 1 });
  const first = manager.acquire('a', events);
  // The cap is on distinct sessions, not on turns. A conversation that has a
  // slot keeps it, or the pool would deadlock the moment it filled.
  assert.equal(manager.acquire('a', events), first);
  assert.throws(() => manager.acquire('b', events), AtCapacityError);
  await manager.shutdown();
});

test('releasing a slot makes it available again', async () => {
  const { manager, built } = pool({ maxConcurrent: 1 });
  manager.acquire('a', events);
  assert.throws(() => manager.acquire('b', events), AtCapacityError);

  await manager.release('a');
  assert.equal(built[0].closed, true);
  assert.equal(manager.capacity.live, 0);
  assert.doesNotThrow(() => manager.acquire('b', events));
  await manager.shutdown();
});

test('onCountsChanged fires when the pool moves', async () => {
  const { manager } = pool({ maxConcurrent: 2 });
  let moves = 0;
  manager.onCountsChanged = () => {
    moves += 1;
  };
  manager.acquire('a', events);
  assert.equal(moves, 1);
  await manager.release('a');
  assert.equal(moves, 2);
  // A refusal is not a move.
  manager.acquire('b', events);
  manager.acquire('c', events);
  assert.throws(() => manager.acquire('d', events), AtCapacityError);
  assert.equal(moves, 4);
  await manager.shutdown();
});

// ── eviction ─────────────────────────────────────────────────────────────────

test('the sweeper is inert at idleTimeoutMinutes: 0, however idle a session is', async (t) => {
  // Enabled before the manager is constructed: the sweeper interval is armed in
  // the constructor.
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => t.mock.timers.reset());

  const { manager, built } = pool({ maxConcurrent: 4, idleTimeoutMinutes: 0 });
  manager.acquire('a', events);
  manager.acquire('b', events);
  // Idle since well before this deployment existed.
  for (const session of built) session.lastActiveAt = 0;

  t.mock.timers.tick(60_000);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(manager.capacity.live, 2);
  assert.equal(built.every((session) => session.closed === false), true);
  await manager.shutdown();
});

test('with a timeout set, the sweeper evicts the idle and leaves the busy', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => t.mock.timers.reset());

  const { manager, built } = pool({ maxConcurrent: 4, idleTimeoutMinutes: 30 });
  manager.acquire('idle', events);
  manager.acquire('busy', events);
  manager.acquire('recent', events);
  const [idle, busy, recent] = built;

  idle.lastActiveAt = Date.now() - 31 * 60_000;
  busy.lastActiveAt = Date.now() - 31 * 60_000;
  busy.busy = true;
  recent.lastActiveAt = Date.now() - 29 * 60_000;

  t.mock.timers.tick(60_000);
  // #evictIdle awaits release() per session; give the microtasks room.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();

  assert.equal(manager.has('idle'), false, 'an idle session past the cutoff should be evicted');
  // Nothing interrupts a running turn — CLAWSKY.md § Lifecycle.
  assert.equal(manager.has('busy'), true, 'a busy session must never be evicted');
  assert.equal(manager.has('recent'), true, 'a session inside the window must not be evicted');
  await manager.shutdown();
});

test('shutdown closes everything and empties the pool', async () => {
  const { manager, built } = pool({ maxConcurrent: 4 });
  manager.acquire('a', events);
  manager.acquire('b', events);
  await manager.shutdown();
  assert.equal(manager.capacity.live, 0);
  assert.equal(built.every((session) => session.closed), true);
});

// ── per-role models ─────────────────────────────────────────────────────────

test('a role with an override gets that model; every other role gets undefined', () => {
  const { manager, built } = stubbedPool(
    {
      'hamachi-updater1': { id: 'hamachi-updater1', role: 'updater', sessionId: '' },
      'hamachi-engineer1': { id: 'hamachi-engineer1', role: 'engineer', sessionId: '' },
    },
    { modelByRole: { updater: 'claude-haiku-4-5' } },
  );

  manager.acquire('hamachi-updater1', events);
  manager.acquire('hamachi-engineer1', events);

  // Resolved from the ROW's role. The updater runs cheap; nothing else moves.
  assert.equal(built[0].model, 'claude-haiku-4-5');
  // undefined rather than the top-level model: the fallback lives in `#buildOptions`.
  assert.equal(built[1].model, undefined);
});

test('no overrides configured leaves every role on the default model', () => {
  const { manager, built } = stubbedPool({
    'hamachi-updater1': { id: 'hamachi-updater1', role: 'updater', sessionId: '' },
  });

  manager.acquire('hamachi-updater1', events);

  // The shipped default before an operator writes `modelByRole` at all.
  assert.equal(built[0].model, undefined);
});

test('the override follows the row, not the id', () => {
  // An id that looks like an engineer on a row that says updater. The row wins,
  // for the same reason `#identityFor` prefers it: ids are a naming convention
  // and the row is the identity.
  const { manager, built } = stubbedPool(
    { 'hamachi-engineer7': { id: 'hamachi-engineer7', role: 'updater', sessionId: '' } },
    { modelByRole: { updater: 'claude-haiku-4-5' } },
  );

  manager.acquire('hamachi-engineer7', events);
  assert.equal(built[0].model, 'claude-haiku-4-5');
});

// ── what the user is told ────────────────────────────────────────────────────

test('the notice carries the numbers from the error it was given', () => {
  // `live` and `max` exist on the error because the catch site has no other way
  // to get them — the pool has moved on by then.
  assert.match(atCapacityNotice(new AtCapacityError(1, 7), 0), /1 of 7 are in use/);
});

// ── the resumable-id rule these all lean on ──────────────────────────────────

test('a stored UUID is resumed and a placeholder is not', async () => {
  const { manager, registry, built } = pool();
  registry.ensure('a', { crew: CREW, role: 'coordinator', workspacePath: '/tmp/a', spawnedBy: null });
  registry.recordSession('a', OTHER_UUID, '/tmp/a', {
    crew: CREW,
    role: 'coordinator',
    workspacePath: '/tmp/a',
  });

  manager.acquire('a', events);
  assert.equal(built[0].sessionId, OTHER_UUID);
  // And the stored workspace wins over the derived one, so a row written by
  // spawn keeps the workspace spawn chose.
  assert.equal(built[0].workspacePath, '/tmp/a');

  registry.ensure('b', { crew: CREW, role: 'coordinator', workspacePath: '/tmp/b', spawnedBy: null });
  assert.equal(registry.get('b').sessionId, '');
  manager.acquire('b', events);
  assert.equal(built[1].sessionId, 'pending-b');
  await manager.shutdown();
});

// ── which in-process tools a session is given ───────────────────────────────

/** The tool names on the MCP server `acquire` built for a session. */
function toolNames(mcpServers) {
  assert.ok(mcpServers, 'acquire built no MCP servers for this session at all');
  const server = mcpServers.clawsky;
  assert.ok(server, `no \`clawsky\` server, only: ${Object.keys(mcpServers).join(', ')}`);
  const registered = server.instance?._registeredTools;
  assert.ok(
    registered && typeof registered === 'object',
    'could not read the tools off the SDK MCP server — `instance._registeredTools` is how ' +
      'this test reads them and the agent SDK has changed shape. Fix the reader; the rule it ' +
      'checks (CLAWSKY.md: "Spawn and kill: held by the coordinator alone") has not changed.',
  );
  const names = Object.keys(registered).sort();
  assert.ok(
    names.includes('checkMail') && names.includes('sendMail'),
    `a session with a mail store must always be offered the mail tools; got: ${names.join(', ')}`,
  );
  return names;
}

/** A pool with a real board behind it, and the built `mcpServers` captured. */
function boardPool(options = {}) {
  const { maxConcurrent = 4, spawnLog = () => {}, mail: withMail = true } = options;
  const workspaceRoot = tempDir('clawsky-workspaces-');
  installConfig({ maxConcurrent, idleTimeoutMinutes: 0, workspaceRoot });

  const registry = new AgentRegistry(join(tempDir('clawsky-tools-'), 'clawcius.db'), { crew: CREW });
  const mail = withMail ? new MailStore(registry) : null;
  const manager = new SessionManager(registry, mail, null, spawnLog);

  const built = [];
  manager.newSession = (channelId, workspacePath, resumeSessionId, _events, mcpServers) => {
    const session = new FakeSession(channelId, workspacePath, resumeSessionId);
    session.mcpServers = mcpServers;
    built.push(session);
    return session;
  };
  return { manager, registry, mail, built };
}

test("a coordinator's session is offered the spawn tool", async () => {
  const { manager, registry, built } = boardPool();
  registry.ensure('hamachi-coordinator', {
    crew: CREW,
    role: 'coordinator',
    workspacePath: '/w/coordinator',
  });

  manager.acquire('hamachi-coordinator', events);
  assert.deepEqual(toolNames(built[0].mcpServers), ['checkMail', 'sendMail', 'spawn']);
  await manager.shutdown();
});

test("an engineer's session is not, and that is the whole of CLAWSKY.md's rule", async () => {
  const { manager, registry, built } = boardPool();
  registry.ensure('hamachi-engineer1', {
    crew: CREW,
    role: 'engineer',
    workspacePath: '/w/engineer1',
    spawnedBy: 'hamachi-coordinator',
  });

  manager.acquire('hamachi-engineer1', events);
  assert.deepEqual(toolNames(built[0].mcpServers), ['checkMail', 'sendMail']);
  await manager.shutdown();
});

test('a poster gets mail and nothing else either', async () => {
  const { manager, registry, built } = boardPool();
  registry.ensure('hamachi-poster', { crew: CREW, role: 'poster', workspacePath: '/w/poster' });
  manager.acquire('hamachi-poster', events);
  // Not just "not an engineer": every role that is not `coordinator`.
  assert.deepEqual(toolNames(built[0].mcpServers), ['checkMail', 'sendMail']);
  await manager.shutdown();
});

test('with no spawn log wired, not even a coordinator is offered spawn', async () => {
  // `spawnLog` is null when the board is off; `main()` in daemon.ts decides that.
  const { manager, registry, built } = boardPool({ spawnLog: null });
  registry.ensure('hamachi-coordinator', {
    crew: CREW,
    role: 'coordinator',
    workspacePath: '/w/coordinator',
  });

  manager.acquire('hamachi-coordinator', events);
  assert.deepEqual(toolNames(built[0].mcpServers), ['checkMail', 'sendMail']);
  await manager.shutdown();
});

test('with no mail store there are no in-process tools at all', async () => {
  const { manager, registry, built } = boardPool({ mail: false });
  registry.ensure('hamachi-coordinator', {
    crew: CREW,
    role: 'coordinator',
    workspacePath: '/w/coordinator',
  });

  manager.acquire('hamachi-coordinator', events);
  // `clawsky.enabled: false` is a supported state: no checkMail, no sendMail,
  // and the waker behaves as it did before any of this existed.
  assert.equal(built[0].mcpServers, null);
  await manager.shutdown();
});

test('a Discord channel the registry has never heard of DOES get spawn', async () => {
  // Stated because it is surprising and it is a privilege.
  const { manager, built } = boardPool();
  manager.acquire('9876543210', events);
  assert.deepEqual(toolNames(built[0].mcpServers), ['checkMail', 'sendMail', 'spawn']);
  await manager.shutdown();
});

test('the role acted on is the row, not the identity the fallback would have picked', async () => {
  const { manager, registry, built } = boardPool();
  registry.ensure('hamachi-engineer2', {
    crew: CREW,
    role: 'engineer',
    workspacePath: '/w/engineer2',
    spawnedBy: 'hamachi-coordinator',
  });

  manager.acquire('hamachi-engineer2', events);
  assert.equal(toolNames(built[0].mcpServers).includes('spawn'), false);
  await manager.shutdown();
});

// ── The settle travels with the TURN, not with the session ──────────────────

test('every wake carries its own settle, not just the one that built the session (#241)', () => {
  const { manager, registry, built } = pool();
  registry.ensure('hamachi-engineer1', {
    crew: CREW,
    role: 'engineer',
    workspacePath: '/tmp/engineer1',
    spawnedBy: 'hamachi-coordinator',
  });

  const settles = [];
  for (const which of ['first', 'second', 'third']) {
    const settle = (ran, why) => settles.push({ which, ran, why });
    manager
      .acquire('hamachi-engineer1', events)
      .wake({ kind: 'mail', channelId: 'hamachi-engineer1', count: 1 }, settle);
  }

  assert.equal(built.length, 1, 'all three wakes went to one session — that is the premise');
  const [session] = built;
  assert.equal(session.wakes.length, 3);

  for (const [i, w] of session.wakes.entries()) {
    assert.equal(typeof w.onSettled, 'function', `wake ${i + 1} arrived with no settle`);
  }
  const distinct = new Set(session.wakes.map((w) => w.onSettled));
  assert.equal(distinct.size, 3, 'each turn must settle its OWN mail, not an earlier turn s');

  // And they are wired to the right turns, which set-size alone does not show.
  session.wakes[1].onSettled(true, '');
  assert.deepEqual(settles, [{ which: 'second', ran: true, why: '' }]);
});

// ── TurnSettle ──────────────────────────────────────────────────────────────

test('a settle fires exactly once, however many times the turn ends', () => {
  // Belt and braces with mail-wake's own once-guard, deliberately: the two
  // layers fail independently, and a double `markRead` is a message confirmed
  // read twice, which is how a real one gets consumed by a turn that never saw it.
  const calls = [];
  const settle = new TurnSettle();
  settle.adopt((ran, why) => calls.push({ ran, why }), 'first');

  settle.done(true, 'turn completed');
  settle.done(false, 'and again');
  settle.done(true, 'and again');

  assert.deepEqual(calls, [{ ran: true, why: 'turn completed' }]);
});

test('adopting a new turn ends the previous one FALSE (#241)', () => {
  // A wake arriving while a turn is pending means that turn never completed —
  // nothing else would have left it pending. Its mail was never confirmed read,
  // so it must be offered again rather than vanishing with the callback.
  const calls = [];
  const settle = new TurnSettle();
  settle.adopt((ran, why) => calls.push({ turn: 'first', ran, why }), 'first');
  settle.adopt((ran, why) => calls.push({ turn: 'second', ran, why }), 'superseded');

  assert.deepEqual(calls, [{ turn: 'first', ran: false, why: 'superseded' }]);

  settle.done(true, 'done');
  assert.deepEqual(calls[1], { turn: 'second', ran: true, why: 'done' });
});

test('adopting when nothing is in flight settles nothing', () => {
  // The common case — one wake, one turn. `adopt` must not invent a settle for
  // a turn that never existed.
  let fired = 0;
  const settle = new TurnSettle();
  settle.adopt(() => fired++, 'nothing was in flight');
  assert.equal(fired, 0);
  assert.equal(settle.pending, true);
});

test('a turn left pending stays pending — a queued retry has not ended (#241)', () => {
  // `onDone` deliberately leaves an API refusal WITH a retry queued unsettled:
  // the retry re-runs the turn and its own completion decides. Settling either
  // way here would be a guess, and a guess of TRUE loses the mail.
  const settle = new TurnSettle();
  settle.adopt(() => assert.fail('a queued retry must not settle its turn'), 'first');
  assert.equal(settle.pending, true);
});

test('a wake carrying no settle still ends the turn before it', () => {
  // Discord wakes pass no callback. They must not silently strand the settle of
  // a mail turn that was still in flight — that is mail loss by another route.
  const calls = [];
  const settle = new TurnSettle();
  settle.adopt((ran, why) => calls.push({ ran, why }), 'mail turn');
  settle.adopt(null, 'a discord wake arrived');

  assert.deepEqual(calls, [{ ran: false, why: 'a discord wake arrived' }]);
  assert.equal(settle.pending, false, 'a null adopt leaves nothing in flight');
  settle.done(true, 'no-op');
  assert.equal(calls.length, 1);
});

test('a pending turn counts as busy, so the sweep cannot pre-empt a retry backoff (#241)', () => {
  // An API refusal WITH a retry queued leaves the turn deliberately unsettled — the retry re-runs it and its own completion decides.
  const { manager, registry, built } = pool();
  registry.ensure('hamachi-engineer1', {
    crew: CREW,
    role: 'engineer',
    workspacePath: '/tmp/engineer1',
    spawnedBy: 'hamachi-coordinator',
  });
  manager.acquire('hamachi-engineer1', events);
  const [session] = built;

  session.busy = false;
  session.turnPending = true;
  assert.equal(manager.isBusy('hamachi-engineer1'), true, 'idle-but-unsettled is not idle');

  session.turnPending = false;
  assert.equal(manager.isBusy('hamachi-engineer1'), false, 'a settled idle session is free again');
});

test('busyCount reads the same predicate as isBusy (#241 round 3)', () => {
  const { manager, registry, built } = pool();
  registry.ensure('hamachi-engineer1', {
    crew: CREW,
    role: 'engineer',
    workspacePath: '/tmp/engineer1',
    spawnedBy: 'hamachi-coordinator',
  });
  manager.acquire('hamachi-engineer1', events);
  const [session] = built;

  session.busy = false;
  session.turnPending = true;
  assert.equal(manager.isBusy('hamachi-engineer1'), true);
  assert.equal(manager.busyCount, 1, 'the status file must not publish a mid-backoff agent as idle');

  session.turnPending = false;
  assert.equal(manager.busyCount, 0);
});

test('eviction announces itself — it was the only silent release while running (#249)', async () => {
  // Every other path that drops a session says so in the journal.
  const lines = [];
  const dbPath = join(tempDir('clawsky-evict-'), 'clawcius.db');
  installConfig({
    maxConcurrent: 4,
    idleTimeoutMinutes: 30,
    workspaceRoot: tempDir('clawsky-evict-ws-'),
  });
  const registry = new AgentRegistry(dbPath, { crew: CREW });
  const manager = new SessionManager(registry, null, null, null, (line) => lines.push(line));
  const built = [];
  manager.newSession = (...args) => {
    const session = new FakeSession(...args);
    built.push(session);
    return session;
  };
  registry.ensure('hamachi-engineer1', {
    crew: CREW,
    role: 'engineer',
    workspacePath: '/tmp/engineer1',
    spawnedBy: 'hamachi-coordinator',
  });
  manager.acquire('hamachi-engineer1', events);

  // Idle well past the timeout, and not busy.
  built[0].lastActiveAt = Date.now() - 45 * 60_000;
  await manager.evictIdle();

  const evicted = lines.filter((l) => /evicting hamachi-engineer1/.test(l));
  assert.equal(evicted.length, 1, 'an eviction must leave a record');
  assert.match(evicted[0], /idle 45 minute\(s\)/, 'and say how long it had been idle');

  // Releases the interval and the SQLite handle.
  await manager.shutdown();
});

test('the at-capacity notice carries the numbers', () => {
  const notice = atCapacityNotice(new AtCapacityError(4, 4));
  assert.match(notice, /4 of 4 are in use/);
  assert.match(notice, /not queued/);
});
