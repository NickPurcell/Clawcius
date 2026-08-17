/**
 * The roster: agents from the registry, sessions hung off them.
 *
 * This is the shape Clawcius #14 asked for, so the fixture is built to look
 * like the host that produced the bug — one registry agent with two sessions,
 * and a `/tmp` directory from a permission probe that is a real transcript and
 * is not an agent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadStatusConfig } from '../dist/config.js';
import { TranscriptStore } from '../dist/transcripts.js';
import { buildAgentOverview, buildRoster } from '../dist/views.js';

const AGENT_WORKSPACE = '/var/lib/hamachi/workspaces/1467070145343258628';
const AGENT_SLUG = '-var-lib-hamachi-workspaces-1467070145343258628';
const PROBE_SLUG = '-tmp-permtest';

const CURRENT_SESSION = 'd1311d46-0116-433b-bff7-bc283b72c9ff';
const OLD_SESSION = '6259a198-424d-41cd-9ec9-e72acafe53b0';
const PROBE_SESSION = '202c3b88-07ad-4225-85d7-e50c0c73a2e6';

function writeTranscript(root, slug, sessionId, { startedAt, mtimeSeconds }) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const started = new Date(startedAt).toISOString();
  const ended = new Date(startedAt + 30_000).toISOString();
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: 'user',
        timestamp: started,
        uuid: `${sessionId}-1`,
        cwd: AGENT_WORKSPACE,
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: ended,
        uuid: `${sessionId}-2`,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] },
      }),
      '',
    ].join('\n'),
  );
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

function seedBoard(path, rows) {
  const db = new DatabaseSync(path);
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
     VALUES (?, ?, ?, ?, ?, 'live', NULL, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.crew,
      row.role,
      row.sessionId ?? '',
      row.workspacePath,
      1_700_000_000_000,
      1_700_000_500_000,
    );
  }
  db.close();
}

/**
 * A host in miniature: one instance, one registry agent with two sessions, and
 * a scratch directory nobody registered.
 *
 * The CURRENT session is given the OLDER mtime on purpose. Sorting by mtime is
 * what the page used to do, and it gets this case wrong: the session an agent
 * is actually resuming is a fact from the registry, not the file that happened
 * to be written last.
 */
function fixture({ withBoard = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'status-roster-'));
  const projectsRoot = join(base, 'agent-home', 'projects');
  const boardDb = join(base, 'hamachi.db');
  const now = Date.now();

  writeTranscript(projectsRoot, AGENT_SLUG, CURRENT_SESSION, {
    startedAt: now - 7_200_000,
    mtimeSeconds: (now - 3_600_000) / 1000,
  });
  writeTranscript(projectsRoot, AGENT_SLUG, OLD_SESSION, {
    startedAt: now - 86_400_000,
    mtimeSeconds: (now - 60_000) / 1000,
  });
  writeTranscript(projectsRoot, PROBE_SLUG, PROBE_SESSION, {
    startedAt: now - 172_800_000,
    mtimeSeconds: (now - 172_800_000) / 1000,
  });

  if (withBoard) {
    seedBoard(boardDb, [
      {
        id: 'hamachi-engineer1',
        crew: 'hamachi',
        role: 'engineer',
        sessionId: CURRENT_SESSION,
        workspacePath: AGENT_WORKSPACE,
      },
      {
        id: 'hamachi-poster',
        crew: 'hamachi',
        role: 'poster',
        workspacePath: '/var/lib/hamachi/workspaces/hamachi-poster',
      },
    ]);
  }

  const configPath = join(base, 'status-config.yaml');
  writeFileSync(
    configPath,
    [
      'agents:',
      '  - id: hamachi',
      '    label: Hamachi',
      `    projectsRoot: ${projectsRoot}`,
      ...(withBoard ? [`    boardDb: ${boardDb}`] : []),
      '',
    ].join('\n'),
  );

  const config = loadStatusConfig(configPath);
  return { config, store: new TranscriptStore(config), agent: config.agents[0], now };
}

test('the list is agents from the registry, not directories on disk', async () => {
  const { config, store, agent, now } = fixture();
  const roster = await buildRoster(store, agent, config, now);

  assert.deepEqual(
    roster.agents.map((row) => row.id),
    ['hamachi-engineer1', 'hamachi-poster'],
  );
  assert.equal(roster.registryError, null);
  assert.equal(roster.registryConfigured, true);
  assert.equal(roster.error, null);
  // Three transcripts on disk across three files, two directories.
  assert.equal(roster.sessionCount, 3);
});

test('an agent gets its own sessions, current first', async () => {
  const { config, store, agent, now } = fixture();
  const roster = await buildRoster(store, agent, config, now);
  const engineer = roster.agents.find((row) => row.id === 'hamachi-engineer1');

  assert.deepEqual(
    engineer.sessions.map((session) => session.sessionId),
    [CURRENT_SESSION, OLD_SESSION],
  );
  assert.equal(engineer.currentSessionPresent, true);
  assert.equal(engineer.projectSlug, AGENT_SLUG);
  // Historical sessions are listed, not only the current one — the operator
  // asked to "look through historical sessions as much as possible".
  assert.equal(engineer.sessions.length, 2);
});

test('a registry row with no transcripts is still an agent', async () => {
  const { config, store, agent, now } = fixture();
  const poster = (await buildRoster(store, agent, config, now)).agents.find(
    (row) => row.id === 'hamachi-poster',
  );

  assert.deepEqual(poster.sessions, []);
  assert.equal(poster.liveness, 'unknown');
  assert.equal(poster.lastTranscriptActivity, null);
  // Declared live, and it has never written a line. That pair is the whole
  // reason both are shown: the word alone would be a green light on an agent
  // that has never run.
  assert.equal(poster.declaredStatus, 'live');
  assert.equal(poster.lastActiveAt, new Date(1_700_000_500_000).toISOString());
});

test('a directory no agent claims is filed under other, not dropped', async () => {
  const { config, store, agent, now } = fixture();
  const roster = await buildRoster(store, agent, config, now);

  assert.deepEqual(
    roster.other.map((group) => group.projectSlug),
    [PROBE_SLUG],
  );
  assert.deepEqual(
    roster.other[0].sessions.map((session) => session.sessionId),
    [PROBE_SESSION],
  );
});

test('without a board the page says so instead of listing directories as agents', async () => {
  const { config, store, agent, now } = fixture({ withBoard: false });
  const roster = await buildRoster(store, agent, config, now);

  assert.equal(roster.registryConfigured, false);
  assert.equal(roster.registryError, null);
  assert.deepEqual(roster.agents, []);
  // Every directory falls through to `other`, which is the honest answer: with
  // no registry there is nothing that says which of them is an agent.
  assert.deepEqual(roster.other.map((group) => group.projectSlug).sort(), [
    PROBE_SLUG,
    AGENT_SLUG,
  ].sort());
});

test('the overview counts agents and directories as different things', async () => {
  const { config, store, agent, now } = fixture();
  const overview = await buildAgentOverview(store, agent, config, now);

  assert.equal(overview.registeredAgentCount, 2);
  assert.equal(overview.declaredLiveCount, 2);
  assert.equal(overview.sessionCount, 3);
  assert.equal(overview.unattributedSessionCount, 1);
  assert.equal(overview.registryError, null);
  assert.equal(overview.registryConfigured, true);
});
