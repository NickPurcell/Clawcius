import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { readMailFor, FEED } from '../dist/mail.js';

const COORD = '1467070145343258628';
const ENGINEER = 'hamachi-engineer1';

function seedBoard(rows) {
  const path = join(mkdtempSync(join(tmpdir(), 'status-mail-')), 'hamachi.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE mail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT NOT NULL, recipient TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, sent_at INTEGER NOT NULL
    )`);
  const insert = db.prepare('INSERT INTO mail (author, recipient, subject, body, sent_at) VALUES (?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(row.author, row.recipient, row.subject ?? '', row.body ?? '', row.sentAt);
  db.close();
  return path;
}

test('an agent sees what it sent and what it received, oldest first, and nobody else\'s DMs', () => {
  const path = seedBoard([
    { author: COORD, recipient: ENGINEER, subject: 'Fix it', sentAt: 3000 },
    { author: ENGINEER, recipient: COORD, subject: 'Done', sentAt: 5000 },
    { author: 'hamachi-engineer2', recipient: COORD, subject: 'Not for engineer1', sentAt: 4000 },
    { author: ENGINEER, recipient: ENGINEER, subject: 'Reminder: self', sentAt: 1000 },
  ]);
  const window = readMailFor(path, ENGINEER, 0, null, 1000);
  assert.equal(window.error, null);
  assert.deepEqual(window.rows.map((row) => [row.subject, row.sentAt]), [
    ['Reminder: self', 1000],
    ['Fix it', 3000],
    ['Done', 5000],
  ]);
});

test('the window is after-exclusive and until-inclusive, so consecutive pages neither gap nor overlap', () => {
  const path = seedBoard([1000, 2000, 3000, 4000].map((sentAt) => ({ author: COORD, recipient: ENGINEER, subject: String(sentAt), sentAt })));
  const first = readMailFor(path, ENGINEER, 0, 2000, 1000).rows.map((row) => row.sentAt);
  const second = readMailFor(path, ENGINEER, 2000, 4000, 1000).rows.map((row) => row.sentAt);
  assert.deepEqual(first, [1000, 2000]);
  assert.deepEqual(second, [3000, 4000]);
});

test('a feed post counts for its author only; readers are every agent and the lane does not repeat it', () => {
  const path = seedBoard([{ author: 'hamachi-poster', recipient: FEED, subject: 'Post', sentAt: 1000 }]);
  assert.equal(readMailFor(path, 'hamachi-poster', 0, null, 1000).rows.length, 1);
  assert.equal(readMailFor(path, ENGINEER, 0, null, 1000).rows.length, 0);
});

test('bodies are redacted on the way out and cut to the limit, saying so', () => {
  const path = seedBoard([
    { author: COORD, recipient: ENGINEER, body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and more', sentAt: 1 },
    { author: COORD, recipient: ENGINEER, body: 'x'.repeat(50), sentAt: 2 },
  ]);
  const [secret, long] = readMailFor(path, ENGINEER, 0, null, 20).rows;
  assert.doesNotMatch(secret.body, /ghp_/);
  assert.equal(long.body.length, 20);
  assert.equal(long.bodyTruncated, true);
  assert.equal(secret.bodyTruncated, true);
});

test('a board without a mail table reports an error rather than no mail', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'status-mail-')), 'wrong.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE agents (id TEXT)');
  db.close();
  const window = readMailFor(path, ENGINEER, 0, null, 1000);
  assert.deepEqual(window.rows, []);
  assert.equal(typeof window.error, 'string');
});

test('a file that is not a database is an error, and a crew with no board is not', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'status-mail-')), 'notadb.db');
  writeFileSync(path, 'not a database');
  assert.notEqual(readMailFor(path, ENGINEER, 0, null, 1000).error, null);
  assert.deepEqual(readMailFor(null, ENGINEER, 0, null, 1000), { rows: [], error: null });
});
