/**
 * Noticing that the board changed.
 *
 * `RootWatcher` watches directories; the board is a single SQLite file in none
 * of them, so before `BoardWatcher` the Clawsky page refreshed only when some
 * unrelated transcript happened to change. Mail delivery usually causes one —
 * it wakes an agent — but the host agent writes no transcripts under any
 * projects root, so a DM to or from `<crew>-host` could leave the page stale
 * under a header correctly reporting "live".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { BoardWatcher } from '../dist/watch.js';

function board() {
  const path = join(mkdtempSync(join(tmpdir(), 'status-boardwatch-')), 'hamachi.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, crew TEXT, role TEXT,
    session_id TEXT DEFAULT '', workspace_path TEXT, status TEXT DEFAULT 'live',
    spawned_by TEXT, spawned_at INTEGER, last_active_at INTEGER)`);
  db.exec(`CREATE TABLE mail (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT,
    recipient TEXT, subject TEXT DEFAULT '', body TEXT, sent_at INTEGER)`);
  db.prepare(`INSERT INTO agents VALUES ('c', 'hamachi', 'coordinator', '', '/w', 'live', NULL, 1, 1)`).run();
  return { path, db };
}

/**
 * The fingerprint is four integers and has to move for each of the things the
 * page renders. Driven through the public surface: a watcher whose interval has
 * elapsed publishes exactly when one of them differs.
 */
async function changesFingerprint(mutate) {
  const { path, db } = board();
  const events = [];
  const watcher = new BoardWatcher([{ scope: 'hamachi', dbPath: path }], 0.05);
  watcher.subscribe((event) => events.push(event));
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const before = events.length;

  mutate(db);
  await new Promise((resolve) => setTimeout(resolve, 200));
  watcher.stop();
  db.close();
  return { quietBefore: before, firedAfter: events.length - before };
}

test('an idle board fires nothing, and a new message fires once', async () => {
  const result = await changesFingerprint((db) =>
    db.prepare(`INSERT INTO mail (author, recipient, subject, body, sent_at)
                VALUES ('c', 'h', 's', 'b', 1)`).run(),
  );
  // No events while nothing changed — a watcher that fired on every poll would
  // make the page rebuild every ten seconds forever.
  assert.equal(result.quietBefore, 0);
  assert.equal(result.firedAfter >= 1, true);
});

test('an agent last_active_at touch fires, because the roster renders it', async () => {
  const result = await changesFingerprint((db) =>
    db.prepare(`UPDATE agents SET last_active_at = 999 WHERE id = 'c'`).run(),
  );
  assert.equal(result.quietBefore, 0);
  assert.equal(result.firedAfter >= 1, true);
});

test('a deletion fires too — counts, not just maxima', async () => {
  const { path, db } = board();
  db.prepare(`INSERT INTO mail (author, recipient, subject, body, sent_at)
              VALUES ('c', 'h', 's', 'b', 1)`).run();
  const events = [];
  const watcher = new BoardWatcher([{ scope: 'hamachi', dbPath: path }], 0.05);
  watcher.subscribe((event) => events.push(event));
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 120));

  // MAX(id) is unchanged by deleting the only row's predecessor; the count is
  // what sees it. Both are in the fingerprint for exactly this reason.
  db.prepare('DELETE FROM mail').run();
  await new Promise((resolve) => setTimeout(resolve, 200));
  watcher.stop();
  db.close();
  assert.equal(events.length >= 1, true);
});

test('an unreadable board does not fire and does not throw', async () => {
  const events = [];
  const watcher = new BoardWatcher(
    [{ scope: 'hamachi', dbPath: '/nonexistent/nowhere.db' }],
    0.05,
  );
  watcher.subscribe((event) => events.push(event));
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  watcher.stop();

  // The page already explains an unreadable board from its own read; a watcher
  // that threw here would take the process down for a condition that is handled.
  assert.deepEqual(events, []);
});

test('polling can be turned off', async () => {
  const { path, db } = board();
  const events = [];
  const watcher = new BoardWatcher([{ scope: 'hamachi', dbPath: path }], 0);
  watcher.subscribe((event) => events.push(event));
  watcher.start();
  db.prepare(`INSERT INTO mail (author, recipient, subject, body, sent_at)
              VALUES ('c', 'h', 's', 'b', 1)`).run();
  await new Promise((resolve) => setTimeout(resolve, 150));
  watcher.stop();
  db.close();
  assert.deepEqual(events, []);
});
