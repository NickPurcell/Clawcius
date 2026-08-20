/**
 * Finding the subagents, all of them.
 *
 * The fixture is built to the shape counted on this host on 2026-08-17: some
 * subagents directly under `<sessionId>/subagents/`, and MORE of them one level
 * further down in `subagents/workflows/<runId>/`. That second population is
 * where 58 of the 104 transcripts under Hamachi's root live, and it was
 * invisible to this service until now — so the count is what most of these
 * tests are really about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadStatusConfig } from '../dist/config.js';
import { TranscriptStore, isValidWorkflowRunId } from '../dist/transcripts.js';
import { buildSessionDetail, buildSubagentRollup } from '../dist/views.js';

const WORKSPACE = '/var/lib/hamachi/workspaces/1467070145343258628';
const SLUG = '-var-lib-hamachi-workspaces-1467070145343258628';
const SESSION = 'd1311d46-0116-433b-bff7-bc283b72c9ff';
const RUN = 'wf_4f93cd23-af9';

function line(type, atMs, textValue) {
  return JSON.stringify({
    type,
    timestamp: new Date(atMs).toISOString(),
    uuid: `${type}-${atMs}-${Math.random()}`,
    cwd: WORKSPACE,
    message: { role: type, content: [{ type: 'text', text: textValue }] },
  });
}

/**
 * Two direct subagents, three workflow subagents, one run descriptor.
 *
 * The proportions are the point: a reader who only walks the first directory
 * gets 2 and believes it, and 2 is wrong by more than half.
 */
function fixture({ descriptor = true, badRunDir = false, secrets = false, hugeSummary = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'status-subagents-'));
  const projectsRoot = join(base, 'agent-home', 'projects');
  const sessionDir = join(projectsRoot, SLUG, SESSION);
  const now = Date.now();

  mkdirSync(join(projectsRoot, SLUG), { recursive: true });
  writeFileSync(
    join(projectsRoot, SLUG, `${SESSION}.jsonl`),
    `${line('user', now - 7_200_000, 'go')}\n${line('assistant', now - 60_000, 'done')}\n`,
  );

  const subagents = join(sessionDir, 'subagents');
  mkdirSync(subagents, { recursive: true });
  const direct = [
    {
      id: 'a000000000000001',
      agentType: 'general-purpose',
      description: secrets
        ? 'sweep the tree using ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
        : 'sweep the tree',
      model: 'opus',
      spawnDepth: 1,
    },
    { id: 'a000000000000002', agentType: 'Explore', description: 'find every caller', model: 'haiku', spawnDepth: 1 },
  ];
  for (const meta of direct) {
    writeFileSync(join(subagents, `agent-${meta.id}.jsonl`), `${line('assistant', now - 3_600_000, 'work')}\n`);
    writeFileSync(join(subagents, `agent-${meta.id}.meta.json`), JSON.stringify(meta));
  }

  const runDir = join(subagents, 'workflows', badRunDir ? 'not-a-run-id' : RUN);
  mkdirSync(runDir, { recursive: true });
  for (let i = 0; i < 3; i += 1) {
    const id = `b00000000000000${i}`;
    writeFileSync(join(runDir, `agent-${id}.jsonl`), `${line('assistant', now - 5_400_000 + i, 'lens')}\n`);
    writeFileSync(
      join(runDir, `agent-${id}.meta.json`),
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }),
    );
  }
  // The run's own log sits beside the agents and is not one.
  writeFileSync(join(runDir, 'journal.jsonl'), `${JSON.stringify({ note: 'not an agent' })}\n`);

  if (descriptor) {
    const workflows = join(sessionDir, 'workflows');
    mkdirSync(workflows, { recursive: true });
    writeFileSync(
      join(workflows, `${RUN}.json`),
      JSON.stringify({
        runId: RUN,
        workflowName: 'sudoers-audit',
        summary: hugeSummary
          ? 'y'.repeat(5000)
          : secrets
            ? 'Audit found ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA in the log'
            : 'Audit the sudoers file across lenses, then verify adversarially.',
        status: 'completed',
        agentCount: 3,
        durationMs: 2_337_635,
        startTime: now - 9_000_000,
        phases: [
          {
            title: 'Audit',
            detail: secrets ? 'six lenses, key sk-ant-AAAAAAAAAAAAAAAAAAAA' : 'six lenses',
          },
          { title: 'Verify', detail: 'three refuters per finding' },
        ],
      }),
    );
  }

  // A one-row board, so the roll-up can be asked whose subagents these are.
  // Without it every scope reads as "this instance has no registry", which is
  // a true sentence about a fixture and no test of the case that matters.
  const boardDb = join(base, 'hamachi.db');
  const db = new DatabaseSync(boardDb);
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
  db.prepare(
    `INSERT INTO agents (id, crew, role, session_id, workspace_path, status,
                         spawned_by, spawned_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, 'live', NULL, ?, ?)`,
  ).run('hamachi-engineer1', 'hamachi', 'engineer', SESSION, WORKSPACE, now, now);
  db.close();

  const configPath = join(base, 'status-config.yaml');
  writeFileSync(
    configPath,
    [
      'agents:',
      '  - id: hamachi',
      '    label: Hamachi',
      `    projectsRoot: ${projectsRoot}`,
      `    boardDb: ${boardDb}`,
      '',
    ].join('\n'),
  );
  const config = loadStatusConfig(configPath);
  return { config, store: new TranscriptStore(config), agent: config.agents[0], now };
}

test('subagents are found in both places, not just the first', async () => {
  const { store, agent } = fixture();
  const { sessions } = await store.sessions(agent);
  const refs = await store.subagents(sessions[0]);

  // Two directly, three under the run. Reading only `subagents/` gives 2, and
  // that was this service's answer until 2026-08-17.
  assert.equal(refs.length, 5);
  assert.equal(refs.filter((ref) => ref.workflowRunId === null).length, 2);
  assert.equal(refs.filter((ref) => ref.workflowRunId === RUN).length, 3);
});

test('journal.jsonl sits beside the agents and is not one', async () => {
  const { store, agent } = fixture();
  const { sessions } = await store.sessions(agent);
  const refs = await store.subagents(sessions[0]);

  assert.equal(
    refs.some((ref) => ref.agentId.includes('journal')),
    false,
  );
  // Required by prefix rather than excluded by name, so an unfamiliar file
  // appearing in a run directory later is skipped instead of rendered as an
  // agent with a strange id.
  assert.equal(refs.every((ref) => /^[ab]\d+$/.test(ref.agentId)), true);
});

test('a run directory whose name is not a run id is not walked', async () => {
  assert.equal(isValidWorkflowRunId(RUN), true);
  assert.equal(isValidWorkflowRunId('not-a-run-id'), false);
  assert.equal(isValidWorkflowRunId('..'), false);
  assert.equal(isValidWorkflowRunId('wf_../../etc'), false);

  const { store, agent } = fixture({ badRunDir: true });
  const { sessions } = await store.sessions(agent);
  const refs = await store.subagents(sessions[0]);
  // The two direct ones only — the misnamed directory is skipped whole.
  assert.equal(refs.length, 2);
});

test('the run descriptor names the agents its sidecars do not', async () => {
  const { store, agent } = fixture();
  const { sessions } = await store.sessions(agent);
  const runs = await store.workflowRuns(sessions[0]);

  const run = runs.get(RUN);
  assert.equal(run.name, 'sudoers-audit');
  assert.equal(run.status, 'completed');
  assert.equal(run.agentCount, 3);
  assert.equal(run.durationSeconds, 2338);
  assert.equal(run.phases.length, 2);
  assert.equal(run.phases[0].title, 'Audit');
});

test('a run in flight has agents on disk and no descriptor, and that is not an error', async () => {
  const { store, agent } = fixture({ descriptor: false });
  const { sessions } = await store.sessions(agent);

  assert.equal((await store.workflowRuns(sessions[0])).size, 0);
  assert.equal((await store.subagents(sessions[0])).length, 5);
});

test('the roll-up groups by subagent type and says how many came from workflows', async () => {
  const { config, store, agent, now } = fixture();
  const rollup = await buildSubagentRollup(store, agent, config, now);

  assert.equal(rollup.total, 5);
  assert.equal(rollup.fromWorkflows, 3);
  assert.deepEqual(
    rollup.types.map((group) => [group.subagentType, group.count]),
    [
      ['workflow-subagent', 3],
      ['Explore', 1],
      ['general-purpose', 1],
    ],
  );
  assert.equal(rollup.workflows.length, 1);
  assert.equal(rollup.workflows[0].observedAgents, 3);

  // Unscoped, and it says so on the wire. "5 on this instance" and "5 for this
  // agent" are different claims and the page has to be able to tell them apart.
  assert.equal(rollup.projectSlug, null);
  assert.equal(rollup.scopeNote, null);

  // `subagent_type` is not called a role anywhere in this payload. That
  // conflation is the whole bug — `general-purpose` shown where a person came
  // looking for `engineer`.
  assert.equal(JSON.stringify(rollup).includes('"role"'), false);
});

/**
 * Scoping to one agent, without any transcript becoming unreachable.
 *
 * Clawcius #80 was 58 of 104 subagent transcripts living in a directory
 * nothing read. Moving subagents off the front page must not do that again, so
 * this asserts the property directly: every entry the unscoped roll-up returns
 * is returned by exactly one scope, and the scopes together are the whole.
 */
test('a scoped roll-up partitions the unscoped one — nothing is unreachable', async () => {
  const { config, store, agent, now } = fixture();
  const all = await buildSubagentRollup(store, agent, config, now);
  const everyId = all.types.flatMap((group) => group.subagents.map((entry) => entry.agentId));
  assert.equal(everyId.length, 5);

  const slugs = [...new Set(all.types.flatMap((group) =>
    group.subagents.map((entry) => entry.projectSlug),
  ))];

  const reached = new Set();
  for (const slug of slugs) {
    const scoped = await buildSubagentRollup(store, agent, config, now, { projectSlug: slug });
    assert.equal(scoped.projectSlug, slug);
    for (const group of scoped.types) {
      for (const entry of group.subagents) {
        assert.equal(entry.projectSlug, slug);
        assert.equal(reached.has(entry.agentId), false, 'an entry appeared under two scopes');
        reached.add(entry.agentId);
      }
    }
  }

  assert.deepEqual([...reached].sort(), [...everyId].sort());
});

test('scoping to a registered agent needs no note — the two sources agree', async () => {
  const { config, store, agent, now } = fixture();
  const scoped = await buildSubagentRollup(store, agent, config, now, { projectSlug: SLUG });

  assert.equal(scoped.projectSlug, SLUG);
  // Null because a registry row does claim this directory. The note exists for
  // the case where they DISAGREE, and a note on every page is a note nobody
  // reads.
  assert.equal(scoped.scopeNote, null);
  assert.equal(scoped.total, 5);
});

test('a scope that matches nothing is an empty roll-up, not an error', async () => {
  const { config, store, agent, now } = fixture();
  const scoped = await buildSubagentRollup(store, agent, config, now, {
    projectSlug: '-var-lib-nobody',
  });

  assert.equal(scoped.total, 0);
  assert.deepEqual(scoped.types, []);
  assert.equal(scoped.error, null);
  // And it says the scope belongs to no agent, rather than captioning an empty
  // list with a name the registry never gave it.
  assert.match(scoped.scopeNote, /No agent in the registry/);
});

/**
 * The join that stops the list saying "no description recorded" three times.
 *
 * A workflow subagent's sidecar is `{agentType, spawnDepth}` and identical on
 * every one of them. The run's name is the only thing that says what they were
 * for, and it is carried per-entry so the UI can label it AS the run's rather
 * than passing it off as the agent's own description.
 */
test('a workflow subagent carries its run name, and no invented description', async () => {
  const { config, store, agent, now } = fixture();
  const rollup = await buildSubagentRollup(store, agent, config, now);
  const group = rollup.types.find((candidate) => candidate.subagentType === 'workflow-subagent');

  for (const entry of group.subagents) {
    assert.equal(entry.description, '');
    assert.equal(entry.workflowRunId, RUN);
    assert.equal(entry.workflowName, 'sudoers-audit');
  }
});

test('without a descriptor the run name is null rather than guessed at', async () => {
  const { config, store, agent, now } = fixture({ descriptor: false });
  const rollup = await buildSubagentRollup(store, agent, config, now);
  const group = rollup.types.find((candidate) => candidate.subagentType === 'workflow-subagent');

  assert.equal(group.count, 3);
  for (const entry of group.subagents) assert.equal(entry.workflowName, null);
});

/**
 * Metadata prose is rendered, so it goes through `redact()` like everything
 * else that is.
 *
 * `index.ts` states the redaction as a property of the service, without
 * qualification, and until now `description`, `workflowName`, `summary` and
 * `phases[].detail` were the exception — all four are free prose written by a
 * model that has just been reading files, and the real workflow summary on
 * this host is the report of a sudoers audit.
 */
test('descriptions and workflow prose are redacted, like every other rendered string', async () => {
  const { config, store, agent, now } = fixture({ secrets: true });
  const { sessions } = await store.sessions(agent);

  const runs = await store.workflowRuns(sessions[0]);
  const run = runs.get(RUN);
  assert.match(run.summary, /\[redacted\]/);
  assert.doesNotMatch(run.summary, /ghp_A{36}/);
  assert.doesNotMatch(run.phases[0].detail, /sk-ant-A{20}/);

  const rollup = await buildSubagentRollup(store, agent, config, now);
  const described = rollup.types
    .flatMap((group) => group.subagents)
    .find((entry) => entry.description.includes('[redacted]'));
  assert.notEqual(described, undefined, 'a subagent description was redacted');
  assert.doesNotMatch(described.description, /ghp_A{36}/);
});

test('metadata prose is capped, and says where it cut', async () => {
  const { store, agent } = fixture({ hugeSummary: true });
  const { sessions } = await store.sessions(agent);
  const run = (await store.workflowRuns(sessions[0])).get(RUN);

  assert.equal(run.summary.length, 2001);
  // Marked, not silent. Everything else here that shortens says so, and a body
  // cut without a marker is one the reader believes is complete.
  assert.equal(run.summary.endsWith('…'), true);

  // And a label under the cap is left exactly alone — no marker on prose that
  // was not cut.
  const short = (await store.workflowRuns((await store.sessions(agent)).sessions[0])).get(RUN);
  assert.equal(short.name, 'sudoers-audit');
});

test('the session tree carries the workflow agents too, labelled by their run', async () => {
  const { config, store, agent, now } = fixture();
  const { sessions } = await store.sessions(agent);
  const detail = await buildSessionDetail(store, sessions[0], config, now);

  assert.equal(detail.subagentCount, 5);
  const all = [...detail.subagents, ...detail.orphans];

  // Each node says how it was SPAWNED, on a field named for that. Not `role`:
  // a subagent has no registry row, so it has no crew role, and the field that
  // used to carry this name is what put `general-purpose` in front of an
  // operator looking for `engineer`.
  assert.deepEqual(
    all.map((node) => node.subagentType).sort(),
    ['Explore', 'general-purpose', 'workflow-subagent', 'workflow-subagent', 'workflow-subagent'],
  );
  assert.equal(
    all.every((node) => !Object.prototype.hasOwnProperty.call(node, 'role')),
    true,
  );

  const workflowNodes = all.filter((node) => node.workflowRunId === RUN);
  assert.equal(workflowNodes.length, 3);
  for (const node of workflowNodes) assert.equal(node.workflowName, 'sudoers-audit');
  // They are not orphans. Nothing spawned them by a tool call we can see, but
  // we know exactly what they belong to, and "orphan" would say we do not.
  assert.equal(detail.orphans.length, 0);
});

/**
 * The cache limit has to stay above one session, and the cliff has to be loud.
 *
 * `buildSessionDetail` walks a session's own transcript plus every subagent,
 * in order. If that exceeds the LRU, each pass evicts exactly what the next
 * pass asks for first — so the cache does not degrade, it stops working.
 * Measured on this host when finding the other 58 subagents took one session
 * to 104 transcripts against a limit of 64: warm rebuilds went from 107ms to
 * 786ms, on a page that rebuilds on every change event.
 *
 * The default is pinned because the failure is invisible from the outside: the
 * page renders correctly and slowly, which is how 64 survived.
 */
test('the default index cache is larger than the largest session on this host', async () => {
  const { loadStatusConfig: load } = await import('../dist/config.js');
  const { mkdtempSync: mk, writeFileSync: write } = await import('node:fs');
  const path = join(mk(join(tmpdir(), 'status-cache-')), 'status-config.yaml');
  write(path, ['agents:', '  - id: hamachi', '    projectsRoot: /tmp/x', ''].join('\n'));

  // 104 transcripts: one session plus 103 subagents, counted under Hamachi's
  // root on 2026-08-17. Raise this number when a bigger session appears — and
  // raise the default with it.
  assert.equal(
    load(path).read.maxCachedSessions > 104,
    true,
    'read.maxCachedSessions must exceed the transcript count of one session, or every ' +
      'rebuild of that session re-parses all of it. It counts TRANSCRIPTS, not sessions.',
  );
});

test('a session that does not fit the cache says so, once, naming the number to raise', async () => {
  const { resetOversizeWarnings } = await import('../dist/views.js');
  // Module state, shared by every test in this file. Without this reset the
  // assertion below depends on no earlier test having warned for the same
  // fixture session id — which is a constant — and the failure would read as
  // the warning being broken rather than as ordering.
  resetOversizeWarnings();

  const { config, store, agent, now } = fixture();
  const { sessions } = await store.sessions(agent);
  const tiny = { ...config, read: { ...config.read, maxCachedSessions: 2 } };

  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    await buildSessionDetail(store, sessions[0], tiny, now);
    await buildSessionDetail(store, sessions[0], tiny, now);
  } finally {
    console.warn = original;
  }

  // Once per session, not once per rebuild: this is a configuration problem,
  // and a line per change event is noise the next reader filters out.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /6 transcripts/);
  assert.match(warnings[0], /read\.maxCachedSessions is 2/);
  assert.match(warnings[0], /Raise read\.maxCachedSessions above 6/);
});
