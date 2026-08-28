import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadStatusConfig } from '../dist/config.js';
import { TranscriptStore } from '../dist/transcripts.js';
import { buildInstanceOverview, buildRoster } from '../dist/views.js';

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
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.crew,
      row.role,
      row.sessionId ?? '',
      row.workspacePath,
      row.status ?? 'live',
      1_700_000_000_000,
      1_700_000_500_000,
    );
  }
  db.close();
}

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
      // Declared dead, so `declaredLiveCount` is not simply the row count.
      {
        id: 'hamachi-engineer0',
        crew: 'hamachi',
        role: 'engineer',
        status: 'dead',
        workspacePath: '/var/lib/hamachi/workspaces/hamachi-engineer0',
      },
      // A session id the registry believes in, and no transcript anywhere for
      // it: what the whole page degrades into if the slug join stops matching.
      {
        id: 'hamachi-ghost',
        crew: 'hamachi',
        role: 'researcher',
        sessionId: 'cccccccc-3333-4333-8333-333333333333',
        workspacePath: '/var/lib/hamachi/workspaces/hamachi-ghost',
      },
      // The host agent: empty session id, and a workspace outside every
      // agent-home, so its slug names no directory under any projects root.
      {
        id: 'hamachi-host',
        crew: 'hamachi',
        role: 'host',
        workspacePath: '/var/lib/clawcius-host-agent',
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
  return { config, store: new TranscriptStore(config), agent: config.agents[0], now, boardDb };
}

test('the list is agents from the registry, not directories on disk', async () => {
  const { config, store, agent, now } = fixture();
  const roster = await buildRoster(store, agent, config, now);

  // Ordered by crew, then ROLE, then id — `readRegistry`'s ORDER BY, not the
  // filesystem's. Hence poster (role `poster`) before ghost (`researcher`).
  assert.deepEqual(
    roster.agents.map((row) => row.id),
    [
      'hamachi-engineer0',
      'hamachi-engineer1',
      'hamachi-host',
      'hamachi-poster',
      'hamachi-ghost',
    ],
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
  // Historical sessions are listed, not only the current one.
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
  // Declared live, and it has never written a line. Both are shown.
  assert.equal(poster.declaredStatus, 'live');
  assert.equal(poster.lastActiveAt, new Date(1_700_000_500_000).toISOString());
  // No session id either, which is what separates "has not run" from the ghost
  // below. The client needs both halves to say the first without lying.
  assert.equal(poster.sessionId, '');
  assert.equal(poster.currentSessionPresent, false);
});

/** The contradiction the page must not paper over. */
test('a row with a session id and no transcript is not reported as never having run', async () => {
  const { config, store, agent, now } = fixture();
  const ghost = (await buildRoster(store, agent, config, now)).agents.find(
    (row) => row.id === 'hamachi-ghost',
  );

  assert.deepEqual(ghost.sessions, []);
  assert.notEqual(ghost.sessionId, '');
  // Both flags on the wire, so the client can tell this apart from the poster.
  // It renders the mismatch warning; it must not render "it has not run".
  assert.equal(ghost.currentSessionPresent, false);
});

test('the host agent has a live last-active time and no transcripts, and both are true', async () => {
  const { config, store, agent, now } = fixture();
  const host = (await buildRoster(store, agent, config, now)).agents.find(
    (row) => row.id === 'hamachi-host',
  );

  assert.equal(host.role, 'host');
  assert.deepEqual(host.sessions, []);
  assert.equal(host.sessionId, '');
  // There is no session id to disagree with here, so only the copy can say it.
  assert.equal(host.currentSessionPresent, false);
  assert.equal(host.lastActiveAt, new Date(1_700_000_500_000).toISOString());
  // Its workspace is outside the projects root by construction, so the slug is
  // one that can never name a directory there however busy the agent is.
  assert.equal(host.projectSlug, '-var-lib-clawcius-host-agent');
  assert.equal(host.projectSlug.startsWith('-var-lib-hamachi-workspaces'), false);
});

test('declaredLiveCount counts declarations, not rows', async () => {
  const { config, store, agent, now } = fixture();
  const roster = await buildRoster(store, agent, config, now);

  assert.equal(roster.agents.length, 5);
  assert.equal(roster.agents.filter((row) => row.declaredStatus === 'live').length, 4);
  assert.equal(
    roster.agents.find((row) => row.id === 'hamachi-engineer0').declaredStatus,
    'dead',
  );
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
  const overview = await buildInstanceOverview(store, agent, config, now);

  assert.equal(overview.registeredAgentCount, 5);
  assert.equal(overview.declaredLiveCount, 4);
  assert.equal(overview.sessionCount, 3);
  assert.equal(overview.unattributedSessionCount, 1);
  assert.equal(overview.registryError, null);
  assert.equal(overview.registryConfigured, true);
});

/** The front page lists agents, with the CREW role on each. */
test('the overview lists registry agents, labelled by crew role', async () => {
  const { config, store, agent, now } = fixture();
  const overview = await buildInstanceOverview(store, agent, config, now);

  assert.deepEqual(
    overview.agents.map((row) => [row.id, row.role]),
    [
      ['hamachi-engineer0', 'engineer'],
      ['hamachi-engineer1', 'engineer'],
      ['hamachi-host', 'host'],
      ['hamachi-poster', 'poster'],
      ['hamachi-ghost', 'researcher'],
    ],
  );
  assert.equal(overview.agents.length, overview.registeredAgentCount);

  // No `subagent_type` anywhere on the front page's payload: subagents are not on this list.
  const wire = JSON.stringify(overview.agents);
  for (const harnessType of ['general-purpose', 'Explore', 'workflow-subagent', 'subagentType']) {
    assert.equal(wire.includes(harnessType), false, `front page carries ${harnessType}`);
  }
});

test('the overview carries declared status and observed liveness per agent', async () => {
  const { config, store, agent, now } = fixture();
  const overview = await buildInstanceOverview(store, agent, config, now);
  const byId = new Map(overview.agents.map((row) => [row.id, row]));

  const engineer1 = byId.get('hamachi-engineer1');
  assert.equal(engineer1.declaredStatus, 'live');
  assert.equal(engineer1.sessionCount, 2);
  assert.equal(engineer1.liveness, 'running');
  assert.equal(
    Math.round((now - Date.parse(engineer1.lastActivity)) / 1000),
    60,
  );

  const dead = byId.get('hamachi-engineer0');
  assert.equal(dead.declaredStatus, 'dead');
  // Declared dead AND never wrote a transcript. `unknown` rather than `stale`:
  // an agent with no transcripts has not gone quiet, it has never spoken.
  assert.equal(dead.liveness, 'unknown');
  assert.equal(dead.lastActivity, null);
  assert.equal(dead.sessionCount, 0);

  // The probe directory is a directory, not an agent, and no row claims it.
  assert.equal(
    overview.agents.some((row) => row.projectSlug === PROBE_SLUG),
    false,
  );
});

/** No registry, no agents — and the sessions are still counted and reported. */
test('an instance with no registry lists no agents rather than guessing', async () => {
  const { config, store, agent, now } = fixture({ withBoard: false });
  const overview = await buildInstanceOverview(store, agent, config, now);

  assert.deepEqual(overview.agents, []);
  assert.equal(overview.registryConfigured, false);
  assert.equal(overview.sessionCount, 3);
  assert.equal(overview.unattributedSessionCount, 3);
});

test('when the registry cannot be read the transcripts still render', { skip: process.getuid?.() === 0 ? 'runs as root; mode bits do not apply' : false }, async () => {
  const { config, store, agent, now, boardDb } = fixture();
  chmodSync(boardDb, 0o000);
  try {
    const roster = await buildRoster(store, agent, config, now);
    assert.deepEqual(roster.agents, []);
    assert.match(roster.registryError, /not readable by this service/);
    assert.equal(roster.registryConfigured, true);

    // The point: every session is still listed and still reachable, just with
    // nothing to attribute it to.
    assert.equal(roster.sessionCount, 3);
    assert.equal(
      roster.other.reduce((sum, group) => sum + group.sessions.length, 0),
      3,
    );
    assert.equal(roster.error, null);

    const overview = await buildInstanceOverview(store, agent, config, now);
    assert.equal(overview.registeredAgentCount, 0);
    // And no agent rows either. An unreadable board must not produce a front
    // page listing agents it could not read — an empty list beside a rendered
    // error is the honest shape.
    assert.deepEqual(overview.agents, []);
    assert.match(overview.registryError, /not readable by this service/);
    // Which is what the overview tiles have to qualify rather than print flat:
    // zero agents and every session unattributed is not a fact about the crew.
    assert.equal(overview.unattributedSessionCount, 3);
    assert.equal(overview.sessionCount, 3);
  } finally {
    chmodSync(boardDb, 0o644);
  }
});
