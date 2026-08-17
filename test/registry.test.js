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

  // `src/` only. The registry class lives in `src/store.ts` and nothing else
  // holds one — `ops/` reaches the same table through its own `Board`, which
  // has no setStatus at all. Widening this to ops/ would catch the unrelated
  // `setStatus` on the waker-status stub in ops/src/selftest.ts.
  const callers = [];
  const entries = await readdir('src', { withFileTypes: true, recursive: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const path = joinPath(entry.parentPath ?? 'src', entry.name);
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
