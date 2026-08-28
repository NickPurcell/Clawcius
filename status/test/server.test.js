import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const COORD = '1467070145343258628';
const ENGINEER = 'hamachi-engineer1';
const T0 = Date.UTC(2026, 7, 24, 16, 0, 0);
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

const user = (seconds, content, extra = {}) => ({ type: 'user', timestamp: at(seconds), uuid: `u${seconds}`, message: { role: 'user', content }, ...extra });
const assistant = (seconds, blocks) => ({ type: 'assistant', timestamp: at(seconds), uuid: `a${seconds}`, message: { role: 'assistant', content: blocks } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'status-server-'));
  const projects = join(root, 'projects');
  const workspaces = join(root, 'workspaces');
  const coordWorkspace = join(workspaces, COORD);
  const coordSlug = coordWorkspace.replace(/[^A-Za-z0-9]/g, '-');
  const sessionDir = join(projects, coordSlug);
  mkdirSync(join(sessionDir, 'sess-1', 'subagents'), { recursive: true });
  mkdirSync(join(coordWorkspace, 'vidbot', 'run'), { recursive: true });
  mkdirSync(join(workspaces, '.bots', 'pollbot'), { recursive: true });

  writeFileSync(
    join(sessionDir, 'sess-1.jsonl'),
    jsonl([
      { type: 'queue-operation', operation: 'dequeue', timestamp: at(0) },
      user(1, '1 new message:\n\n[18:00] brutaltomrammen: hello\n\nchannel_id: 1\nlatest message_id: 2'),
      assistant(2, [{ type: 'text', text: 'Hi.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
      user(3, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a\nb' }]),
      assistant(4, [{ type: 'tool_use', id: 'toolu_2', name: 'Task', input: { subagent_type: 'general-purpose', description: 'Count files' } }]),
      user(5, [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'agentId: abc123def done' }]),
      // Idle for ten minutes, then a mail wake.
      user(600, 'checkMail →\n\n1 message.\n\n── [DM] from hamachi-engineer1 · 2026-08-24 09:10 PT\nsubject: Done\nAll green.', { isMeta: true }),
      assistant(601, [{ type: 'text', text: 'Noted.' }]),
    ]),
  );
  writeFileSync(
    join(sessionDir, 'sess-1', 'subagents', 'agent-abc123def.jsonl'),
    jsonl([user(4, 'Count files'), assistant(5, [{ type: 'text', text: '3 files.' }])]),
  );
  writeFileSync(
    join(sessionDir, 'sess-1', 'subagents', 'agent-abc123def.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Count files', toolUseId: 'toolu_2' }),
  );
  writeFileSync(join(coordWorkspace, 'vidbot', 'run', 'health.json'), JSON.stringify({ mode: 'gateway', detail: '282', since: at(0), updated: at(500), needs_human: null, counts: { reconnects: 2 } }));
  writeFileSync(join(workspaces, '.bots', 'pollbot', 'health.json'), JSON.stringify({ mode: 'polling', since: at(0), updated: at(400), needs_human: 'token expired' }));

  const dbPath = join(root, 'hamachi.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, crew TEXT NOT NULL, role TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live', spawned_by TEXT, spawned_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
    CREATE TABLE mail (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, sent_at INTEGER NOT NULL);
  `);
  const agent = db.prepare('INSERT INTO agents (id, crew, role, session_id, workspace_path, spawned_by, spawned_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  agent.run(ENGINEER, 'hamachi', 'engineer', '', join(workspaces, ENGINEER), COORD, T0, T0);
  agent.run(COORD, 'hamachi', 'coordinator', 'sess-1', coordWorkspace, null, T0, T0);
  const mail = db.prepare('INSERT INTO mail (author, recipient, subject, body, sent_at) VALUES (?, ?, ?, ?, ?)');
  mail.run(COORD, ENGINEER, 'Go', 'please', T0 + 2500);
  mail.run(ENGINEER, COORD, 'Done', 'All green.', T0 + 599_000);
  mail.run('deploy', COORD, 'deployed', 'a1042e5', T0 + 700_000);
  db.close();

  return { root, projects, workspaces, dbPath };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let child = null;
let base = '';

before(async () => {
  const { root, projects, workspaces, dbPath } = fixture();
  const port = await freePort();
  const configPath = join(root, 'status-config.yaml');
  writeFileSync(
    configPath,
    [
      'server:', '  host: 127.0.0.1', `  port: ${port}`,
      'agents:', '  - id: hamachi', '    label: Hamachi', `    projectsRoot: ${projects}`, `    boardDb: ${dbPath}`, `    workspacesRoot: ${workspaces}`,
      'read:', '  pageSize: 4',
      'stream:', '  tickSeconds: 0',
      '',
    ].join('\n'),
  );
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(PACKAGE, 'dist', 'index.js')], { env: { ...process.env, STATUS_CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => {
  child?.kill('SIGTERM');
});

async function get(path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}

test('/api/board lists the crews and answers about the snapshot either way', async () => {
  const { status, body } = await get('/api/board');
  assert.equal(status, 200);
  assert.deepEqual(body.crews, [{ id: 'hamachi', label: 'Hamachi' }]);
  assert.equal(typeof body.snapshot.available, 'boolean');
});

test('the timeline names rows for people, orders the coordinator first, nests the subagent, and carries spans and bots', async () => {
  const { status, body } = await get('/api/crews/hamachi/timeline');
  assert.equal(status, 200);
  assert.equal(body.error, null);
  assert.deepEqual(body.rows.map((row) => [row.id, row.name, row.depth, row.parent]), [
    [`a:${COORD}`, 'Hamachi coordinator', 0, null],
    ['s:abc123def', 'Count files', 1, `a:${COORD}`],
    [`a:${ENGINEER}`, 'Hamachi engineer1', 0, null],
  ]);
  const coordinator = body.rows[0];
  assert.deepEqual(coordinator.spans, [[T0, T0 + 5000], [T0 + 600_000, T0 + 601_000]]);
  // Every stamped line, the operational record included: the lane pages over all of them.
  assert.equal(coordinator.lines, 8);
  assert.deepEqual(body.rows[2].spans, []);
  assert.deepEqual(body.bots.map((bot) => [bot.bot, bot.workspace, bot.needsHuman]), [
    ['pollbot', '', 'token expired'],
    ['vidbot', 'Hamachi coordinator', null],
  ]);
  assert.deepEqual(body.bots[1].counts, { reconnects: 2 });
});

test('a lane pages in order, labels by origin, folds results under calls, and merges the board by time', async () => {
  const first = await get(`/api/crews/hamachi/lane?row=a:${COORD}&from=0`);
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 8);
  assert.equal(first.body.from, 0);
  // pageSize 4: the operational record, the bundle, the assistant line and its tool result.
  assert.equal(first.body.nextFrom, 4);
  assert.deepEqual(first.body.entries.map((entry) => [entry.key, entry.label]), [
    ['n1.0.0', 'Discord · brutaltomrammen'],
    ['n2.0', 'Assistant'],
    ['n2.1', 'Tool: Bash'],
    ['m1', '→ Hamachi engineer1: Go'],
  ]);
  assert.equal(first.body.entries[2].detail, 'a\nb');

  const second = await get(`/api/crews/hamachi/lane?row=a:${COORD}&from=${first.body.nextFrom}`);
  assert.equal(second.body.nextFrom, null);
  assert.deepEqual(second.body.entries.map((entry) => [entry.key, entry.kind, entry.label]), [
    ['n4.0', 'tool', 'Tool: Task'],
    ['m2', 'mail-in', '← Hamachi engineer1: Done'],
    ['n6.0.0', 'mail', 'Mail from Hamachi engineer1'],
    ['n7.0', 'assistant', 'Assistant'],
    ['m3', 'system', 'System'],
  ]);
  assert.equal(second.body.entries[0].detail, 'agentId: abc123def done');
});

test('`at` lands on the first line at or after a time, and the tail poll returns only what follows', async () => {
  const page = await get(`/api/crews/hamachi/lane?row=a:${COORD}&at=${T0 + 300_000}`);
  assert.equal(page.body.from, 6);
  assert.equal(page.body.entries[0].key, 'm2');

  const tail = await get(`/api/crews/hamachi/lane?row=a:${COORD}&from=8`);
  assert.equal(tail.body.from, 8);
  assert.deepEqual(tail.body.entries.map((entry) => entry.key), ['m3']);
});

test('a subagent lane reads its own transcript and carries no mail', async () => {
  const { body } = await get('/api/crews/hamachi/lane?row=s:abc123def&from=0');
  assert.equal(body.total, 2);
  assert.deepEqual(body.entries.map((entry) => entry.label), ['Prompt', 'Assistant']);
});

test('unknown crews, rows and endpoints are 404s; a missing row parameter is a 400; writes are refused', async () => {
  assert.equal((await get('/api/crews/nope/timeline')).status, 404);
  assert.equal((await get('/api/crews/hamachi/lane?row=a:nobody')).status, 404);
  assert.equal((await get('/api/crews/hamachi/lane')).status, 400);
  assert.equal((await get('/api/nothing')).status, 404);
  assert.equal((await fetch(`${base}/api/board`, { method: 'POST' })).status, 405);
});

test('/healthz says what build this is and how many streams are open', async () => {
  const { status, body } = await get('/healthz');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.build.line, 'string');
  assert.equal(body.crews, 1);
  assert.equal(body.streams, 0);
});

test('the page and its assets are served with a self-only CSP', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
});
