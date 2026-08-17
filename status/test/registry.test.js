/**
 * Reading the board, and the two ways it fails on this host.
 *
 * Run against `dist/`, not `src/`, for the reason the root suite gives: Node's
 * type stripping does not resolve a `.js` specifier to a `.ts` file, and
 * testing the built output is also what catches the stale-`dist/` failure this
 * repository keeps hitting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { readRegistry, slugifyWorkspace } from '../dist/registry.js';
import { isValidProjectSlug } from '../dist/transcripts.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'status-registry-'));
}

/** A board exactly as `src/store.ts` leaves it: WAL, `agents`, rows. */
function seedBoard(path, rows, { close = true } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE agents (
      id             TEXT PRIMARY KEY,
      crew           TEXT NOT NULL,
      role           TEXT NOT NULL,
      session_id     TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'live',
      spawned_by     TEXT,
      spawned_at     INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    )
  `);
  const insert = db.prepare(
    `INSERT INTO agents (id, crew, role, session_id, workspace_path, status,
                         spawned_by, spawned_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.crew,
      row.role,
      row.sessionId ?? '',
      row.workspacePath,
      row.status ?? 'live',
      row.spawnedBy ?? null,
      row.spawnedAt ?? 1_700_000_000_000,
      row.lastActiveAt ?? 1_700_000_500_000,
    );
  }
  if (close) db.close();
  return db;
}

/**
 * The join, pinned.
 *
 * `slug(workspace_path)` naming the agent's transcript directory is the entire
 * reason this feature needs no schema change. The values below are the real
 * ones off this host on 2026-08-16 — if upstream ever changes its encoding,
 * this is the test that says so rather than a page that quietly shows every
 * agent as having no sessions.
 */
test('a workspace path slugifies to its transcript directory', () => {
  assert.equal(
    slugifyWorkspace('/var/lib/hamachi/workspaces/1467070145343258628'),
    '-var-lib-hamachi-workspaces-1467070145343258628',
  );
  assert.equal(slugifyWorkspace('/tmp/ojprobe'), '-tmp-ojprobe');
  assert.equal(slugifyWorkspace('/var/lib/clawcius/crew/hamachi-engineer1'), '-var-lib-clawcius-crew-hamachi-engineer1');
  // Dots and underscores are not preserved; upstream replaces everything that
  // is not alphanumeric, and matching it exactly matters more than tidiness.
  assert.equal(slugifyWorkspace('/home/agent/my_repo.git'), '-home-agent-my-repo-git');
});

test('every slug it produces is one the traversal guard will accept', () => {
  for (const path of [
    '/var/lib/hamachi/workspaces/1467070145343258628',
    '/tmp/ojprobe',
    '/home/agent/my_repo.git',
  ]) {
    assert.equal(isValidProjectSlug(slugifyWorkspace(path)), true, path);
  }
});

test('reads the rows a board holds, with status left exactly as declared', () => {
  const path = join(tempDir(), 'clawcius.db');
  seedBoard(path, [
    {
      id: 'hamachi-engineer1',
      crew: 'hamachi',
      role: 'engineer',
      sessionId: 'd1311d46-0116-433b-bff7-bc283b72c9ff',
      workspacePath: '/var/lib/hamachi/workspaces/1467070145343258628',
      spawnedBy: 'hamachi-coordinator',
    },
    {
      id: 'hamachi-poster',
      crew: 'hamachi',
      role: 'poster',
      workspacePath: '/var/lib/hamachi/workspaces/hamachi-poster',
      status: 'dead',
    },
  ]);

  const snapshot = readRegistry(path);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.agents.length, 2);

  const engineer = snapshot.agents.find((row) => row.id === 'hamachi-engineer1');
  assert.equal(engineer.role, 'engineer');
  assert.equal(engineer.crew, 'hamachi');
  assert.equal(engineer.spawnedBy, 'hamachi-coordinator');
  assert.equal(engineer.projectSlug, '-var-lib-hamachi-workspaces-1467070145343258628');
  assert.equal(engineer.lastActiveAt, new Date(1_700_000_500_000).toISOString());

  // Verbatim, both of them. The page decides how to present a declared status;
  // this layer must not normalise one away.
  assert.equal(engineer.declaredStatus, 'live');
  assert.equal(snapshot.agents.find((row) => row.id === 'hamachi-poster').declaredStatus, 'dead');
});

test('an unconfigured board is not an error, and reads as no agents', () => {
  const snapshot = readRegistry(null);
  assert.equal(snapshot.configured, false);
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.agents, []);
});

/**
 * The board is NEVER created here.
 *
 * `new DatabaseSync(path)` creates an empty database by default, and an empty
 * one next to the real board renders as a crew with no agents — which looks
 * exactly like a working page. `readOnly` is what prevents it; this asserts the
 * consequence rather than the flag.
 */
test('a missing board is reported and not created', () => {
  const path = join(tempDir(), 'nowhere.db');
  const snapshot = readRegistry(path);

  assert.equal(existsSync(path), false);
  assert.equal(snapshot.configured, true);
  assert.match(snapshot.error, /does not exist/);
  assert.match(snapshot.error, /CLAWCIUS_DB_PATH/);
});

test('a board without an agents table says so rather than rendering empty', () => {
  const path = join(tempDir(), 'wrong.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE something_else (a INTEGER)');
  db.close();

  const snapshot = readRegistry(path);
  assert.deepEqual(snapshot.agents, []);
  assert.match(snapshot.error, /could not be read/);
});

/**
 * The deployment hazard, reproduced.
 *
 * A WAL database needs its `-shm` wal-index, and SQLite deletes that on the
 * last clean close. Creating it again needs write access to the directory,
 * which `clawcius-status.service` does not have under ProtectSystem=strict. So
 * the registry becomes unreadable exactly while the waker is stopped — the
 * moment the page is most wanted — and the error has to name the waker rather
 * than showing a host with no agents.
 *
 * Mode 555 on the directory is the stand-in for the read-only mount. Root
 * ignores permission bits, so this asserts nothing when run as root and says
 * so instead of passing vacuously.
 */
test('a WAL board whose writer has gone reports the waker, not an empty crew', { skip: process.getuid?.() === 0 ? 'runs as root; mode bits do not apply' : false }, () => {
  const dir = tempDir();
  const path = join(dir, 'clawcius.db');
  seedBoard(path, [
    { id: 'hamachi-coordinator', crew: 'hamachi', role: 'coordinator', workspacePath: '/w/c' },
  ]);

  // Closed cleanly, so -wal and -shm are gone, as they are after a
  // `systemctl stop` of the waker.
  assert.equal(existsSync(`${path}-shm`), false);
  chmodSync(dir, 0o555);
  try {
    const snapshot = readRegistry(path);
    assert.deepEqual(snapshot.agents, []);
    assert.match(snapshot.error, /waker for this instance is down/);
    assert.match(snapshot.error, /ProtectSystem=strict/);
    // And it says the transcripts are unaffected, because they are: they are
    // read off disk and do not go through SQLite at all.
    assert.match(snapshot.error, /Transcripts below are unaffected/);
  } finally {
    chmodSync(dir, 0o755);
  }
});

/**
 * The other half of the same story: while the waker holds the board open, the
 * `-shm` exists and a read-only reader can map it even where it could not
 * create it. This is the normal case and it has to keep working.
 */
test('a WAL board with its writer still holding it reads fine from a read-only directory', { skip: process.getuid?.() === 0 ? 'runs as root; mode bits do not apply' : false }, () => {
  const dir = tempDir();
  const path = join(dir, 'clawcius.db');
  const writer = seedBoard(
    path,
    [{ id: 'hamachi-coordinator', crew: 'hamachi', role: 'coordinator', workspacePath: '/w/c' }],
    { close: false },
  );

  assert.equal(existsSync(`${path}-shm`), true);
  chmodSync(dir, 0o555);
  try {
    const snapshot = readRegistry(path);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.agents.length, 1);
  } finally {
    chmodSync(dir, 0o755);
    writer.close();
  }
});
