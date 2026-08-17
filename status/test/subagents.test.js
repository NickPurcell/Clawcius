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

  const configPath = join(base, 'status-config.yaml');
  writeFileSync(
    configPath,
    ['agents:', '  - id: hamachi', '    label: Hamachi', `    projectsRoot: ${projectsRoot}`, ''].join('\n'),
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

test('the roll-up groups by role and says how many came from workflows', async () => {
  const { config, store, agent, now } = fixture();
  const rollup = await buildSubagentRollup(store, agent, config, now);

  assert.equal(rollup.total, 5);
  assert.equal(rollup.fromWorkflows, 3);
  assert.deepEqual(
    rollup.roles.map((group) => [group.role, group.count]),
    [
      ['workflow-subagent', 3],
      ['Explore', 1],
      ['general-purpose', 1],
    ],
  );
  assert.equal(rollup.workflows.length, 1);
  assert.equal(rollup.workflows[0].observedAgents, 3);
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
  const group = rollup.roles.find((candidate) => candidate.role === 'workflow-subagent');

  for (const entry of group.subagents) {
    assert.equal(entry.description, '');
    assert.equal(entry.workflowRunId, RUN);
    assert.equal(entry.workflowName, 'sudoers-audit');
  }
});

test('without a descriptor the run name is null rather than guessed at', async () => {
  const { config, store, agent, now } = fixture({ descriptor: false });
  const rollup = await buildSubagentRollup(store, agent, config, now);
  const group = rollup.roles.find((candidate) => candidate.role === 'workflow-subagent');

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
  const described = rollup.roles
    .flatMap((group) => group.subagents)
    .find((entry) => entry.description.includes('[redacted]'));
  assert.notEqual(described, undefined, 'a subagent description was redacted');
  assert.doesNotMatch(described.description, /ghp_A{36}/);
});

test('metadata prose is capped, so a label cannot be a document', async () => {
  const { store, agent } = fixture({ hugeSummary: true });
  const { sessions } = await store.sessions(agent);
  const run = (await store.workflowRuns(sessions[0])).get(RUN);

  assert.equal(run.summary.length, 2000);
});

test('the session tree carries the workflow agents too, labelled by their run', async () => {
  const { config, store, agent, now } = fixture();
  const { sessions } = await store.sessions(agent);
  const detail = await buildSessionDetail(store, sessions[0], config, now);

  assert.equal(detail.subagentCount, 5);
  const all = [...detail.subagents, ...detail.orphans];
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
