/**
 * The registry, and above all the migration.
 *
 * There is live data in `thread_sessions` on both deployments — one row per
 * Discord channel, each holding the session id that keeps a conversation warm
 * across restarts. Losing one is invisible until someone speaks and the agent
 * has forgotten the entire conversation, so the copy is worth a test even
 * though it runs exactly once per database.
 *
 * Run against `dist/`, not `src/`: Node's type stripping does not resolve a
 * `.js` specifier to a `.ts` file, and testing the built output is also what
 * catches the stale-dist failure this repo keeps hitting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AgentRegistry } from '../dist/store.js';

function tempDb(name = 'clawcius.db') {
  return join(mkdtempSync(join(tmpdir(), 'clawsky-registry-')), name);
}

/** A database exactly as the pre-Clawsky waker left it. */
function seedLegacy(path, rows) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE thread_sessions (
      thread_id      TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    )
  `);
  const insert = db.prepare(
    'INSERT INTO thread_sessions VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.threadId, row.sessionId, row.workspacePath, row.createdAt, row.lastActiveAt);
  }
  db.close();
}

test('migrates existing Discord sessions and leaves the old table alone', () => {
  const path = tempDb();
  seedLegacy(path, [
    {
      threadId: '1234567890',
      sessionId: '0b3f4d1e-1111-4222-8333-444455556666',
      workspacePath: '/var/lib/clawcius/workspaces/1234567890',
      createdAt: 1_700_000_000_000,
      lastActiveAt: 1_700_000_500_000,
    },
  ]);

  const registry = new AgentRegistry(path, { crew: 'clawcius' });
  const agent = registry.get('1234567890');

  // The channel id stays the agent id: it is what the Discord layer looks
  // sessions up by, so a prettier name here would detach live sessions.
  assert.equal(agent.id, '1234567890');
  assert.equal(agent.sessionId, '0b3f4d1e-1111-4222-8333-444455556666');
  assert.equal(agent.workspacePath, '/var/lib/clawcius/workspaces/1234567890');
  assert.equal(agent.crew, 'clawcius');
  assert.equal(agent.role, 'coordinator');
  assert.equal(agent.status, 'live');
  assert.equal(agent.spawnedBy, null);
  assert.equal(agent.spawnedAt, 1_700_000_000_000);
  assert.equal(agent.lastActiveAt, 1_700_000_500_000);

  // Rollback safety: the previous dist must still find its data.
  const legacy = registry.db.prepare('SELECT COUNT(*) AS n FROM thread_sessions').get();
  assert.equal(legacy.n, 1);
  registry.close();
});

test('migration runs once and does not overwrite what happened since', () => {
  const path = tempDb();
  seedLegacy(path, [
    {
      threadId: '99',
      sessionId: 'aaaaaaaa-1111-4222-8333-444455556666',
      workspacePath: '/w/99',
      createdAt: 1,
      lastActiveAt: 2,
    },
  ]);

  const first = new AgentRegistry(path, { crew: 'clawcius' });
  first.recordSession('99', 'bbbbbbbb-1111-4222-8333-444455556666', '/w/99', {
    crew: 'clawcius',
    role: 'coordinator',
    workspacePath: '/w/99',
  });
  first.close();

  const second = new AgentRegistry(path, { crew: 'clawcius' });
  assert.equal(second.get('99').sessionId, 'bbbbbbbb-1111-4222-8333-444455556666');
  assert.equal(
    second.db.prepare('PRAGMA user_version').get().user_version,
    1,
    'the migration marker must survive so the copy is not repeated',
  );
  second.close();
});

test('a fresh database needs no legacy table', () => {
  const registry = new AgentRegistry(tempDb(), { crew: 'hamachi' });
  assert.equal(registry.listByCrew('hamachi').length, 0);
  registry.close();
});

test('ensure creates once and never overwrites identity', () => {
  const registry = new AgentRegistry(tempDb(), { crew: 'hamachi' });

  registry.ensure('hamachi-poster', {
    crew: 'hamachi',
    role: 'poster',
    workspacePath: '/w/poster',
  });
  // A later wake registering the same id as a coordinator must not demote it —
  // role is identity, and an operator edit outranks a default.
  registry.ensure('hamachi-poster', {
    crew: 'hamachi',
    role: 'coordinator',
    workspacePath: '/w/elsewhere',
  });

  const agent = registry.get('hamachi-poster');
  assert.equal(agent.role, 'poster');
  assert.equal(agent.workspacePath, '/w/poster');
  registry.close();
});

test('clearSession forgets the session, not the agent', () => {
  const registry = new AgentRegistry(tempDb(), { crew: 'hamachi' });
  const identity = { crew: 'hamachi', role: 'coordinator', workspacePath: '/w/1' };

  registry.ensure('1', identity);
  registry.recordSession('1', 'cccccccc-1111-4222-8333-444455556666', '/w/1', identity);
  registry.clearSession('1');

  const agent = registry.get('1');
  assert.ok(agent, 'the row survives — it is the address mail is delivered to');
  assert.equal(agent.sessionId, '');
  registry.close();
});

test('status is declared, not inferred', () => {
  const registry = new AgentRegistry(tempDb(), { crew: 'hamachi' });
  registry.ensure('hamachi-engineer1', {
    crew: 'hamachi',
    role: 'engineer',
    workspacePath: '/w/e1',
    spawnedBy: 'hamachi-coordinator',
  });

  assert.equal(registry.get('hamachi-engineer1').status, 'live');
  assert.equal(registry.get('hamachi-engineer1').spawnedBy, 'hamachi-coordinator');
  registry.setStatus('hamachi-engineer1', 'dead');
  assert.equal(registry.get('hamachi-engineer1').status, 'dead');
  registry.close();
});

/**
 * The status page says `dead` is a word nothing writes yet. This is the pin.
 *
 * `status/` renders the declared status beside `lastActive` and explains, in
 * the UI and in `status/README.md`, that a column of it alone would be the
 * same word on every row — because kill is CLAWSKY.md phase 5 and `setStatus`
 * has no caller outside this suite. That is a claim about code in a different
 * package, made in prose, which is exactly the kind of sentence that goes
 * quietly false when the code beside it changes (Clawcius #69).
 *
 * So it is asserted here, next to the method. When phase 5 lands and something
 * finally calls `setStatus`, this fails and names the copy to go and fix
 * rather than leaving a status page confidently explaining that a feature it
 * is now rendering does not exist.
 */
test('nothing outside this suite writes a status — the status page says so', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  // Resolved against this file, not against `process.cwd()`. A relative 'src'
  // silently scans whichever package the runner happened to start in — and
  // `status/` has one too, so the test would pass green having checked the
  // wrong tree entirely.
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

  // `src/` only. The registry class lives in `src/store.ts` and nothing else
  // holds one — `ops/` reaches the same table through its own `Board`, which
  // has no setStatus at all. Widening this to ops/ would catch the unrelated
  // `setStatus` on the waker-status stub in ops/src/selftest.ts.
  const callers = [];
  const entries = await readdir(srcDir, { withFileTypes: true, recursive: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const path = joinPath(entry.parentPath ?? srcDir, entry.name);
    const source = await readFile(path, 'utf8');
    source.split('\n').forEach((line, index) => {
      // A call is always `<something>.setStatus(`; the declaration in store.ts
      // has no receiver, so it does not match itself.
      if (/\.setStatus\(/.test(line)) callers.push(`${path}:${index + 1}`);
    });
  }

  assert.equal(entries.length > 0, true, 'scanned nothing — this test would pass vacuously');
  assert.deepEqual(
    callers,
    [],
    'Something now writes a dead status. status/src/views.ts, status/public/app.js and ' +
      'status/README.md all say nothing does — update them in the same change.',
  );
});

// ── create(): the row a spawn writes ────────────────────────────────────────

test('create writes a spawned row and records who spawned it', () => {
  const registry = new AgentRegistry(tempDb(), { crew: 'hamachi' });

  const row = registry.create('hamachi-engineer1', {
    crew: 'hamachi',
    role: 'engineer',
    workspacePath: '/var/lib/hamachi/workspaces/hamachi-engineer1',
    spawnedBy: 'hamachi-coordinator',
  });

  assert.equal(row.role, 'engineer');
  assert.equal(row.crew, 'hamachi');
  assert.equal(row.status, 'live');
  assert.equal(row.spawnedBy, 'hamachi-coordinator');
  assert.equal(row.sessionId, '', 'a session id does not exist until the session starts');
  assert.equal(registry.get('hamachi-engineer1').role, 'engineer');
  registry.close();
});

test('create refuses an id that is taken, where ensure would adopt it', () => {
  const registry = new AgentRegistry(tempDb(), { crew: 'hamachi' });
  registry.create('hamachi-engineer1', {
    crew: 'hamachi',
    role: 'engineer',
    workspacePath: '/w/1',
    spawnedBy: 'hamachi-coordinator',
  });

  // The difference that makes them two methods. `ensure` is idempotent because
  // a wake must not disturb a row that is already there; for a spawn the same
  // answer would hand a new agent somebody else's inbox.
  const adopted = registry.ensure('hamachi-engineer1', {
    crew: 'hamachi',
    role: 'researcher',
    workspacePath: '/w/other',
  });
  assert.equal(adopted.role, 'engineer');

  assert.throws(
    () =>
      registry.create('hamachi-engineer1', {
        crew: 'hamachi',
        role: 'researcher',
        workspacePath: '/w/other',
        spawnedBy: 'hamachi-coordinator',
      }),
    /already exists/,
  );
  assert.equal(registry.get('hamachi-engineer1').workspacePath, '/w/1', 'and nothing was rewritten');
  registry.close();
});

test('recording a session does not rewrite who an agent is', () => {
  // The upsert in `recordSession` runs after every turn. Its conflict clause
  // touches the session and nothing else, which is what keeps a spawned
  // engineer an engineer — `coordinator` is the role that may DM the host
  // agent, so a role rewritten on the way past would be a privilege handed out
  // by the waker.
  const registry = new AgentRegistry(tempDb(), { crew: 'hamachi' });
  registry.create('hamachi-engineer1', {
    crew: 'hamachi',
    role: 'engineer',
    workspacePath: '/w/1',
    spawnedBy: 'hamachi-coordinator',
  });

  registry.recordSession('hamachi-engineer1', '0b3f4d1e-1111-4222-8333-444455556666', '/w/1', {
    crew: 'hamachi',
    role: 'coordinator',
    workspacePath: '/w/1',
    spawnedBy: null,
  });

  const row = registry.get('hamachi-engineer1');
  assert.equal(row.role, 'engineer');
  assert.equal(row.spawnedBy, 'hamachi-coordinator');
  assert.equal(row.sessionId, '0b3f4d1e-1111-4222-8333-444455556666');
  registry.close();
});

test('the upsert mints a row when there is none — which is why persist must not call it', () => {
  // Pinning the behaviour that makes `SessionManager.persist`'s absent-row
  // guard necessary rather than decorative. `recordSession` is an upsert, so
  // with no row it takes the plain-INSERT branch and writes `identity.role`
  // verbatim — and the identity a missing row produces is the `coordinator`
  // fallback, which is the one role that may DM the host agent. Preferring the
  // row in `#identityFor` cannot narrow that: there is no row to prefer.
  //
  // The guard lives in agent.ts because that is where the decision belongs; the
  // store stays a store. If this test ever starts failing because the upsert
  // became an update, the guard is redundant and can go.
  const registry = new AgentRegistry(tempDb(), { crew: 'hamachi' });

  registry.recordSession('hamachi-engineer1', '0b3f4d1e-1111-4222-8333-444455556666', '/w/1', {
    crew: 'hamachi',
    role: 'coordinator',
    workspacePath: '/w/1',
    spawnedBy: null,
  });

  assert.equal(registry.get('hamachi-engineer1').role, 'coordinator');
  registry.close();
});
