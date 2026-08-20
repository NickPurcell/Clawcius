/**
 * Clawsky: the board's mail, read-only.
 *
 * A DM and a feed post are one table and the recipient is what separates them,
 * so most of what is worth pinning here is that separation, the fact that
 * nothing about a message is taken from its text, and that bodies — which
 * carry quoted external content by design — are redacted and bounded on the
 * way out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadStatusConfig } from '../dist/config.js';
import { readMail, FEED } from '../dist/mail.js';
import { buildClawsky } from '../dist/views.js';

function board({ mail = true, agents = [], messages = [], reads = [] } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'status-mail-')), 'hamachi.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, crew TEXT NOT NULL, role TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '', workspace_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'live', spawned_by TEXT,
      spawned_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL)
  `);
  const insertAgent = db.prepare(
    `INSERT INTO agents VALUES (?, ?, ?, '', ?, 'live', NULL, ?, ?)`,
  );
  for (const agent of agents) {
    insertAgent.run(agent.id, 'hamachi', agent.role, `/w/${agent.id}`, 1, 2);
  }

  if (mail) {
    db.exec(`
      CREATE TABLE mail (
        id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL,
        recipient TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL, sent_at INTEGER NOT NULL)
    `);
    db.exec(`
      CREATE TABLE mail_reads (
        mail_id INTEGER NOT NULL, reader TEXT NOT NULL, read_at INTEGER NOT NULL,
        PRIMARY KEY (mail_id, reader))
    `);
    const insert = db.prepare(
      'INSERT INTO mail (author, recipient, subject, body, sent_at) VALUES (?, ?, ?, ?, ?)',
    );
    messages.forEach((message, index) => {
      insert.run(
        message.author,
        message.recipient,
        message.subject ?? '',
        message.body,
        1_700_000_000_000 + index * 1000,
      );
    });
    const insertRead = db.prepare('INSERT INTO mail_reads VALUES (?, ?, ?)');
    for (const read of reads) insertRead.run(read.mailId, read.reader, 1_700_000_100_000);
  }

  db.close();
  return path;
}

function statusConfig() {
  const path = join(mkdtempSync(join(tmpdir(), 'status-mail-cfg-')), 'status-config.yaml');
  writeFileSync(
    path,
    ['agents:', '  - id: hamachi', '    label: Hamachi', '    projectsRoot: /tmp/does-not-matter', ''].join('\n'),
  );
  return loadStatusConfig(path);
}

test('a DM and a post are one table, separated by the recipient', () => {
  const path = board({
    messages: [
      { author: 'hamachi-coordinator', recipient: 'hamachi-host', subject: 'run it', body: 'systemctl restart' },
      { author: 'hamachi-poster', recipient: FEED, subject: 'shipped', body: 'PR #71 merged' },
      { author: 'hamachi-host', recipient: 'hamachi-coordinator', subject: 'done', body: 'active (running)' },
    ],
  });

  const snapshot = readMail(path, 20_000);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.feed.length, 1);
  assert.equal(snapshot.dms.length, 2);
  assert.equal(snapshot.feed[0].recipient, '*');
  assert.equal(snapshot.totalFeed, 1);
  assert.equal(snapshot.totalDms, 2);
  // Newest first, by id — the column the table orders by, not by parsing a date
  // out of a body.
  assert.deepEqual(snapshot.dms.map((message) => message.subject), ['done', 'run it']);
});

test('the author is the column, never anything in the message', () => {
  const path = board({
    messages: [
      {
        author: 'hamachi-host',
        recipient: 'hamachi-coordinator',
        subject: 'From: hamachi-coordinator',
        body: 'author: hamachi-coordinator\nFrom: somebody-else\n-- sent by the operator',
      },
    ],
  });

  const message = readMail(path, 20_000).dms[0];
  // Every one of those strings names a different sender. None of them is read.
  assert.equal(message.author, 'hamachi-host');
});

test('bodies are redacted on the way out, like transcript text', () => {
  const path = board({
    messages: [
      {
        author: 'a',
        recipient: 'b',
        subject: 'token was ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        body: 'Authorization: Bearer abcdef123456\nkey sk-ant-AAAAAAAAAAAAAAAAAAAA seen in the log',
      },
    ],
  });

  const message = readMail(path, 20_000).dms[0];
  assert.match(message.body, /\[redacted\]/);
  assert.doesNotMatch(message.body, /sk-ant-A{20}/);
  assert.doesNotMatch(message.subject, /ghp_A{36}/);
  // The scheme survives so a reader can still see what kind of auth was in play.
  assert.match(message.body, /Authorization: Bearer \[redacted\]/);
});

/**
 * The ceiling is per list, and that is not a detail.
 *
 * It used to take the newest N rows of `mail` and partition them afterwards,
 * so a burst of DMs could push every post out of the window and the feed would
 * render empty. The page's empty-feed copy is a POSITIVE claim — "posts are
 * possible, none has been written" — so the ceiling would not have degraded
 * the view, it would have made it state something false.
 *
 * Six DMs newer than the only post, with room for two of each.
 */
test('a burst of DMs cannot push the posts out of the feed', () => {
  const messages = [{ author: 'hamachi-poster', recipient: FEED, subject: 'shipped', body: 'PR merged' }];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ author: 'hamachi-coordinator', recipient: 'hamachi-host', subject: `dm ${i}`, body: 'x' });
  }

  const snapshot = readMail(board({ messages }), 20_000, 2);
  assert.equal(snapshot.feed.length, 1, 'the post survives six newer DMs');
  assert.equal(snapshot.feed[0].subject, 'shipped');
  assert.equal(snapshot.dms.length, 2);
  // And each list reports its own total, so the page can say it is showing a
  // window rather than implying it is showing everything.
  assert.equal(snapshot.totalFeed, 1);
  assert.equal(snapshot.totalDms, 6);
});

test('sender counts come from the whole table, not from the returned window', () => {
  const messages = [];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ author: 'hamachi-host', recipient: 'hamachi-coordinator', body: 'x' });
  }

  const snapshot = readMail(board({ messages }), 20_000, 2);
  assert.equal(snapshot.dms.length, 2, 'the window is doing its job');
  // Counted with GROUP BY over all six. Tallying the two returned rows would
  // print "2 sent" beside an agent that sent six, and print it confidently.
  // A Map, not an object literal — an agent id of `constructor` would answer
  // a function to `?? 0` from a `{}`.
  assert.equal(snapshot.sentByAuthor.get('hamachi-host'), 6);
});

test('a long body is cut and says so, rather than stopping silently', () => {
  const path = board({
    messages: [{ author: 'a', recipient: 'b', body: 'x'.repeat(5000) }],
  });

  const cut = readMail(path, 100).dms[0];
  assert.equal(cut.body.length, 100);
  assert.equal(cut.bodyTruncated, true);

  const whole = readMail(path, 20_000).dms[0];
  assert.equal(whole.body.length, 5000);
  assert.equal(whole.bodyTruncated, false);
});

test('read receipts come from mail_reads, and none is normal', () => {
  const path = board({
    messages: [
      { author: 'a', recipient: 'b', body: 'one' },
      { author: 'a', recipient: 'b', body: 'two' },
    ],
    reads: [
      { mailId: 1, reader: 'b' },
      { mailId: 1, reader: 'hamachi-host' },
    ],
  });

  const snapshot = readMail(path, 20_000);
  const [newest, oldest] = snapshot.dms;
  assert.deepEqual(oldest.readBy, ['b', 'hamachi-host']);
  assert.deepEqual(newest.readBy, []);
});

test('a board with no mail table says so rather than showing an empty board', () => {
  const snapshot = readMail(board({ mail: false }), 20_000);
  assert.deepEqual(snapshot.feed, []);
  assert.deepEqual(snapshot.dms, []);
  assert.match(snapshot.error, /no such table: mail/);
  // Same triage as the registry: this is not the waker being down.
  assert.doesNotMatch(snapshot.error, /holds this board open/);
});

test('an unconfigured board is not an error', () => {
  const snapshot = readMail(null, 20_000);
  assert.equal(snapshot.configured, false);
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.dms, []);
});

/**
 * The empty feed has to be explainable, not just empty.
 *
 * Only a `poster` may write to the feed (`src/mail.ts`), and no crew has one
 * today — a coordinator can spawn one and none has. `posterCount` is what lets
 * the page say the feed CANNOT have posts rather than that it happens to have
 * none — a checkable statement instead of a reassuring one, and one that stops
 * being made the moment a poster exists.
 */
test('posterCount is what makes an empty feed explainable', () => {
  const config = statusConfig();
  const agent = {
    ...config.agents[0],
    boardDb: board({
      agents: [
        { id: 'hamachi-coordinator', role: 'coordinator' },
        { id: 'hamachi-host', role: 'host' },
      ],
      messages: [{ author: 'hamachi-coordinator', recipient: 'hamachi-host', body: 'run it' }],
    }),
  };

  const clawsky = buildClawsky(agent, config);
  assert.equal(clawsky.posterCount, 0);
  assert.deepEqual(clawsky.feed, []);
  assert.equal(clawsky.participants.length, 2);
  assert.equal(
    clawsky.participants.find((p) => p.id === 'hamachi-coordinator').sent,
    1,
  );
  assert.equal(clawsky.participants.find((p) => p.id === 'hamachi-host').sent, 0);
});

test('a crew with a poster and no posts is a different statement', () => {
  const config = statusConfig();
  const agent = {
    ...config.agents[0],
    boardDb: board({ agents: [{ id: 'hamachi-poster', role: 'poster' }] }),
  };

  const clawsky = buildClawsky(agent, config);
  assert.equal(clawsky.posterCount, 1);
  assert.deepEqual(clawsky.feed, []);
});

/**
 * The gate on every positive statement the Clawsky page makes.
 *
 * `posterCount: 0` has two meanings — "this crew has no poster" and "the
 * registry could not be read" — and only the first licenses the copy the page
 * prints under an empty feed:
 *
 *   "Empty, and that is correct… this crew has none… Nothing is broken and
 *    nothing needs enabling."
 *
 * Under an unreadable board that is three claims, none of them known, printed
 * directly beneath a warning row explaining that the board could not be read.
 * And it is not a rare state: it is the one this page names itself, since mail
 * goes dark at exactly the moments the roster does (Clawcius #72).
 *
 * So the decision is a field on the wire rather than a shape the client
 * happens to draw, and it is asserted here.
 */
test('a board that cannot be read is not reported as a board with nothing on it', () => {
  const config = statusConfig();
  const path = join(mkdtempSync(join(tmpdir(), 'status-mail-')), 'notadb.db');
  writeFileSync(path, 'this is not a database, it is a file with words in it, at some length');

  const clawsky = buildClawsky({ ...config.agents[0], boardDb: path }, config);

  assert.equal(clawsky.boardReadable, false);
  assert.notEqual(clawsky.mailError, null);
  // The counts are all zero, and every one of them is meaningless. That is the
  // whole point: the numbers alone cannot tell the page which state it is in.
  assert.equal(clawsky.posterCount, 0);
  assert.deepEqual(clawsky.feed, []);
  assert.deepEqual(clawsky.dms, []);
});

test('a board with no boardDb at all is also not readable', () => {
  const config = statusConfig();
  const clawsky = buildClawsky({ ...config.agents[0], boardDb: null }, config);

  assert.equal(clawsky.boardReadable, false);
  assert.equal(clawsky.registryConfigured, false);
  // No error, because nothing failed — it was never configured. Still not a
  // licence to say the feed is empty.
  assert.equal(clawsky.mailError, null);
});

test('a board that reads is readable, and only then', () => {
  const config = statusConfig();
  const agent = {
    ...config.agents[0],
    boardDb: board({
      agents: [{ id: 'hamachi-coordinator', role: 'coordinator' }],
      messages: [{ author: 'hamachi-coordinator', recipient: 'hamachi-host', body: 'run it' }],
    }),
  };

  const clawsky = buildClawsky(agent, config);
  assert.equal(clawsky.boardReadable, true);
  assert.equal(clawsky.registryError, null);
  assert.equal(clawsky.mailError, null);
});
