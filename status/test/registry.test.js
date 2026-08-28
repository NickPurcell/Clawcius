import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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

/** The truncation branch. */
test('an over-long workspace path is truncated and hashed, exactly as upstream does it', () => {
  const long = `/var/lib/clawcius/workspaces/${'a'.repeat(200)}`;
  const slug = slugifyWorkspace(long);

  assert.equal(long.length, 229);
  assert.equal(
    slug,
    `-var-lib-clawcius-workspaces-${'a'.repeat(171)}-mwqg9m`,
  );
  assert.equal(slug.length, 207);
  // 200 characters of slug, then the separator, then the hash.
  assert.equal(slug.slice(0, 200).length, 200);
  assert.equal(slug[200], '-');
});

test('the hash is of the original path, so two paths sharing a prefix do not collide', () => {
  const a = `/var/lib/clawcius/workspaces/${'a'.repeat(200)}`;
  const b = `${a}/b`;

  assert.equal(slugifyWorkspace(a).slice(0, 200), slugifyWorkspace(b).slice(0, 200));
  assert.notEqual(slugifyWorkspace(a), slugifyWorkspace(b));
  assert.equal(slugifyWorkspace(b), `-var-lib-clawcius-workspaces-${'a'.repeat(171)}-3qsszd`);
});

test('exactly 200 characters is not truncated — the boundary is <=, not <', () => {
  const slug = slugifyWorkspace(`/${'a'.repeat(199)}`);
  assert.equal(slug.length, 200);
  assert.equal(slug, `-${'a'.repeat(199)}`);
});

test('every slug it produces is one the traversal guard will accept', () => {
  for (const path of [
    '/var/lib/hamachi/workspaces/1467070145343258628',
    '/tmp/ojprobe',
    '/home/agent/my_repo.git',
    // The truncated form is longer than any ordinary path and still has to
    // pass, or the guard would reject exactly the agents this branch exists for.
    `/var/lib/clawcius/workspaces/${'a'.repeat(300)}`,
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

/** The board is NEVER created here. */
test('a missing board is reported and not created', () => {
  const path = join(tempDir(), 'nowhere.db');
  const snapshot = readRegistry(path);

  assert.equal(existsSync(path), false);
  assert.equal(snapshot.configured, true);
  assert.match(snapshot.error, /does not exist/);
  assert.match(snapshot.error, /CLAWCIUS_DB_PATH/);
});

/** Two failures that have nothing to do with the waker, and must not say it does. */
test('a board without an agents table says so, and does not blame the waker', () => {
  const path = join(tempDir(), 'wrong.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE something_else (a INTEGER)');
  db.close();

  const snapshot = readRegistry(path);
  assert.equal(existsSync(`${path}-shm`), false);
  assert.deepEqual(snapshot.agents, []);
  assert.match(snapshot.error, /no such table: agents/);
  assert.doesNotMatch(snapshot.error, /waker/);
});

test('a file that is not a database says so, and does not blame the waker', () => {
  const path = join(tempDir(), 'notadb.db');
  writeFileSync(path, 'this is not a database, it is a file with words in it, at some length');

  const snapshot = readRegistry(path);
  assert.deepEqual(snapshot.agents, []);
  assert.match(snapshot.error, /file is not a database/);
  assert.doesNotMatch(snapshot.error, /waker/);
});

test('a board that exists and cannot be read is not reported as missing', { skip: process.getuid?.() === 0 ? 'runs as root; mode bits do not apply' : false }, () => {
  const path = join(tempDir(), 'locked.db');
  seedBoard(path, [
    { id: 'hamachi-coordinator', crew: 'hamachi', role: 'coordinator', workspacePath: '/w/c' },
  ]);
  chmodSync(path, 0o000);
  try {
    const snapshot = readRegistry(path);
    // `existsSync` alone would answer "does not exist" here.
    assert.doesNotMatch(snapshot.error, /does not exist/);
    assert.match(snapshot.error, /not readable by this service/);
  } finally {
    chmodSync(path, 0o644);
  }
});

test('a WAL board nothing holds open reports that, without naming a daemon', { skip: process.getuid?.() === 0 ? 'runs as root; mode bits do not apply' : false }, () => {
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
    assert.match(snapshot.error, /no process currently holds this board open/);
    assert.match(snapshot.error, /ProtectSystem=strict/);
    assert.match(snapshot.error, /Transcripts are unaffected/);
    // The observation, not a conclusion about which daemon. `normally` is
    // allowed — asserting one is down is not.
    assert.doesNotMatch(snapshot.error, /waker (for this instance )?is down/);
  } finally {
    chmodSync(dir, 0o755);
  }
});

/** The other half of the same story: while the waker holds the board open, the `-shm` exists and a read-only reader can map it even where it could not create it. */
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
