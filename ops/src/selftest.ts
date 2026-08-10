/**
 * The self-test: `npm run selftest` in `ops/`.
 *
 * This host has no docker socket inside the container these agents run in, and
 * the box this was written on has no docker at all — so none of the privileged
 * paths can be executed for real here. That is a real limitation and it is
 * stated plainly in ops/README.md rather than papered over.
 *
 * What is exercised is everything up to the exec, plus the exec itself against
 * stand-in binaries:
 *
 *   - request validation, including the hostile cases: traversal, separators,
 *     NUL and control bytes, shell metacharacters, unknown verbs, wrong types,
 *     malformed JSON, arrays-instead-of-objects, oversized files;
 *   - the spool's structural defences: size cap enforced before open, sweep
 *     cap, flood ceiling, implausible names, unlink-before-act;
 *   - the config loader's containment assertions, which are the things
 *     standing between "the agent writes the spool" and "the agent writes the
 *     breaker";
 *   - the operation lock, including that a second request queues behind a
 *     first that is blocked waiting for an idle turn;
 *   - the idle logic against synthetic waker status files, including the
 *     stale-zero case that is the dangerous one;
 *   - dry-run, verifying that mutating commands are logged and not run while
 *     read-only probes still execute, AND that the host agent session is sent
 *     settings which remove its ability to execute rather than asking it not to;
 *   - the host agent itself, against a `claude` stand-in that speaks real
 *     stream-json: task dispatch, the completeness of the audit, the
 *     snapshot-before/rollback-after ordering, the health comparison, and the
 *     refusal to spawn a session whose environment holds a credential;
 *   - the breaker across a process boundary: quarantine and freeze are written
 *     to disk and re-read by a fresh StateStore;
 *   - deadline expiry driving an automatic rollback, the quarantine that
 *     follows it, and the freeze once the consecutive-failure ceiling is hit.
 *
 * The stand-in `docker`, `git`, `systemctl` and the two scripts are shell
 * scripts written into a temp directory. They are enough to prove the argv the
 * executor builds is the argv that arrives — which, given that "never build a
 * shell string" is still the claim everywhere the executor itself runs
 * commands, is worth proving.
 *
 * ── What the claude stand-in can and cannot prove ────────────────────────
 *
 * The `claude` stand-in emits genuine stream-json and honours the deny list it
 * is handed, which lets this suite assert the things the executor is
 * responsible for: that every Bash call in the stream reaches the journal, that
 * an unparseable line fails the task, that a failure rolls back, that dry-run
 * sends settings which remove the Bash tool.
 *
 * What it cannot prove is that the REAL CLI honours those settings. That was
 * established by experiment on 2026-08-10, by running `claude -p` against the
 * exact settings this code ships, and the results are recorded in the header of
 * ops/src/host-agent.ts: `deny: ["Bash"]` removes the tool from the session
 * entirely, deny survives `--permission-mode bypassPermissions`, and denying
 * Bash alone leaves `Monitor` and friends able to run a shell command. None of
 * that is inferable from a stand-in, and none of it is what the documentation
 * would lead you to expect, which is why it was tested rather than reasoned
 * about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOpsConfig, type OpsConfig } from './config.js';
import { parseRequest, describeRequest, isDestructive, VERBS } from './request.js';
import { OpsSpool } from './spool.js';
import { readIdle } from './idle.js';
import { Runner, render } from './runner.js';
import { StateStore } from './state.js';
import { Executor, compareHealth } from './executor.js';
import { verifyInstance } from './verify.js';
import { resolveOwner } from './build.js';
import {
  assertNoSecrets,
  hostAgentEnv,
  hostAgentSettings,
  hostAgentTools,
  judge,
  DRY_RUN_TOOL_DENY,
} from './host-agent.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

/**
 * A host, faked.
 *
 * Every binary the executor invokes is replaced with a shell script that
 * records its argv, one line per argument, into `calls/`. Recording one
 * argument per line is the point of the exercise: if anything anywhere built a
 * command string, an argument containing a space or a semicolon would arrive
 * split, and the assertions below would see it.
 */
/**
 * One instance in a fake host.
 *
 * `extra` is raw YAML appended inside the instance block, indented to match.
 * It exists for `mayRequest:`, which is a nested mapping with optional keys
 * whose absence is meaningful — expressing that through a typed options object
 * would mean reimplementing the distinction the loader is being tested on.
 *
 * Every instance gets its own state directory, and therefore its own spool at
 * `<stateDir>/run/ops`, exactly as the real host does. That mirroring is the
 * point: the fixture used to have one instance and one spool, which is the
 * shape of the world in which the Hamachi bug was invisible.
 */
type InstanceSpec = { name: string; extra?: string[] };

function makeHost(options: {
  dryRun: boolean;
  suffix: string;
  buildDirs?: string[];
  /** Defaults to a single instance named `clawcius`. */
  instances?: InstanceSpec[];
  /** Set false to test the "tasks refused, everything else still works" mode. */
  hostAgent?: boolean;
  snapshotKeep?: number;
  envPassthrough?: string[];
}): {
  root: string;
  config: OpsConfig;
  callsDir: string;
  calls: () => string[][];
  setStatus: (instance: string, body: unknown) => void;
  /** That instance's ops spool, which is where its container would write. */
  spoolDir: (instance: string) => string;
  /** Make `git status --porcelain` report these lines. Empty means clean. */
  setDirty: (porcelain: string[]) => void;
  /** The commands the fake session will issue, in order. */
  setPlan: (commands: string[]) => void;
  /** Make the fake session report `is_error: true`. */
  failTask: () => void;
  /** Make the fake session emit a line that is not JSON. */
  corruptStream: () => void;
  /** The fake session's final report text. */
  setReport: (text: string) => void;
  /** The claude stand-in's recorded argv, decoded. */
  claudeCall: () => { argv: string[]; cwd: string; home: string; envNames: string[] } | null;
} {
  const root = mkdtempSync(join(tmpdir(), `ops-selftest-${options.suffix}-`));
  const bin = join(root, 'bin');
  const callsDir = join(root, 'calls');
  const control = join(root, 'control');
  const stateDir = join(root, 'ops-state');
  const specs = options.instances ?? [{ name: 'clawcius' }];
  // Distinct Discord snowflakes per instance, because `wake` routes by
  // channel and two instances sharing one would make that routing ambiguous
  // in the fixture in a way it never is on the host.
  const channels = ['123456789012345678', '223456789012345678', '323456789012345678'];
  const instanceState = (name: string) => join(root, 'state', name);
  const spoolDirOf = (name: string) => join(instanceState(name), 'run', 'ops');
  mkdirSync(bin, { recursive: true });
  mkdirSync(callsDir, { recursive: true });
  mkdirSync(control, { recursive: true });
  for (const spec of specs) {
    mkdirSync(spoolDirOf(spec.name), { recursive: true });
    mkdirSync(join(instanceState(spec.name), 'run', 'wake'), { recursive: true });
  }
  mkdirSync(join(root, 'repo'), { recursive: true });
  // The build steps run with cwd set to these, and execFile fails to spawn at
  // all if the cwd does not exist — which would look like a missing binary
  // rather than a missing directory.
  for (const dir of options.buildDirs ?? ['.']) {
    mkdirSync(join(root, 'repo', dir), { recursive: true });
  }

  const recorder = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        `out="${callsDir}/$(date +%s%N)-${name}"`,
        `printf '%s\\n' "${name}" > "$out"`,
        'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$out"; done',
        body,
        'exit 0',
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(path, 0o755);
    return path;
  };

  // docker: enough surface for images/inspect/tag/rm/exec/run.
  const docker = recorder(
    'docker',
    [
      'if [ "$1" = "images" ]; then',
      "  printf 'snap-20260801-040000\\nsnap-20260808-040000\\nlatest\\n'",
      'elif [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
      "  printf 'sha256:abc123def456\\n'",
      'elif [ "$1" = "container" ] && [ "$2" = "inspect" ]; then',
      "  printf 'running\\n'",
      'fi',
    ].join('\n'),
  );

  const git = recorder(
    'git',
    [
      'shift 2 2>/dev/null || true',
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then',
      "  printf 'main\\n'",
      'elif [ "$1" = "rev-parse" ]; then',
      "  printf 'deadbeefcafe0000000000000000000000000000\\n'",
      'elif [ "$1" = "status" ]; then',
      // Clean unless the test says otherwise. Reading it from a file rather
      // than baking it in means one fixture can serve both the clean and the
      // dirty case within a single executor's lifetime.
      `  if [ -s "${control}/dirty" ]; then cat "${control}/dirty"; fi`,
      'fi',
    ].join('\n'),
  );

  // `is-active` answers from a control file so a test can make a task break a
  // service and watch the health comparison catch it. Silent (and exit 0)
  // otherwise, which the executor reads as "active".
  const systemctl = recorder(
    'systemctl',
    [
      'if [ "$1" = "is-active" ]; then',
      `  if [ -s "${control}/is-active" ]; then cat "${control}/is-active"; fi`,
      'fi',
    ].join('\n'),
  );
  const runContainer = recorder('run-container.sh', '');
  const snapshot = recorder('snapshot.sh', '');

  /**
   * The npm stand-in, which records more than the others.
   *
   * The executor no longer runs npm itself — a task does, through Bash, and
   * that command lands in the audit like any other. This is kept because
   * `npmPath` is still config (its directory goes on the host agent's PATH) and
   * because a task in a test may legitimately invoke it.
   *
   * `cwd=` and `uid=` go into the call file because *where* something ran and
   * *as whom* are the two properties that are not visible in an argv, and both
   * still matter: the host agent session is dropped to the checkout's owner.
   */
  const npm = join(bin, 'npm');
  writeFileSync(
    npm,
    [
      '#!/bin/sh',
      `out="${callsDir}/$(date +%s%N)-npm"`,
      "printf '%s\\n' npm > \"$out\"",
      'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$out"; done',
      'printf \'cwd=%s\\n\' "$(pwd)" >> "$out"',
      'printf \'uid=%s\\n\' "$(id -u)" >> "$out"',
      'printf \'home=%s\\n\' "$HOME" >> "$out"',
      `if [ -s "${control}/npm-fail" ] && grep -qx "$1" "${control}/npm-fail"; then`,
      '  echo "npm stand-in: told to fail on $1" >&2',
      '  exit 1',
      'fi',
      `if [ -s "${control}/npm-fail" ] && [ "$1" = run ] && grep -qx "$2" "${control}/npm-fail"; then`,
      '  echo "npm stand-in: told to fail on $2" >&2',
      '  exit 1',
      'fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(npm, 0o755);

  /**
   * The `claude` stand-in.
   *
   * A real Node program rather than a shell script, because it has to emit
   * well-formed stream-json — the executor's audit is built by parsing that
   * stream, and a stand-in that only approximated the format would be testing
   * the test.
   *
   * It records its own argv the same way every other stand-in does, so the
   * suite can assert on the flags the executor passes (the deny list, the tool
   * list, the working directory, the model). Then it reads the control files
   * and behaves accordingly:
   *
   *   plan       — one command per line, each emitted as a Bash tool_use;
   *   claude-fail    — emit `is_error: true` in the result;
   *   claude-garbage — emit a line that is not JSON, which must make the
   *                    executor treat the whole audit as incomplete;
   *   claude-result  — the text of the final report.
   *
   * Crucially it HONOURS THE DENY LIST it is handed: if `--settings` denies
   * Bash it emits no tool_use at all and reports the commands as prose, which
   * is exactly what the real CLI was observed doing on 2026-08-10. That is what
   * makes the dry-run assertions below mean something rather than merely
   * checking a flag was passed.
   */
  const claudeJs = join(root, 'fake-claude.mjs');
  writeFileSync(
    claudeJs,
    `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const argv = process.argv.slice(2);
const out = ${JSON.stringify(callsDir)} + '/' + Date.now() + process.hrtime.bigint() + '-claude';
// One JSON object rather than one argument per line, unlike every other
// stand-in here. The others record line-per-argument precisely to prove no
// shell string was built; this one is handed a multi-line prompt on purpose,
// so line-per-argument would be unreadable and would lose the newlines that
// matter.
writeFileSync(out, JSON.stringify({
  argv,
  cwd: process.cwd(),
  uid: process.getuid(),
  home: process.env.HOME ?? '',
  envNames: Object.keys(process.env).sort(),
}) + '\\n');

const control = ${JSON.stringify(control)};
const read = (name) => existsSync(control + '/' + name) ? readFileSync(control + '/' + name, 'utf8') : '';
const plan = read('plan').split('\\n').filter((line) => line.length > 0);
const failing = read('claude-fail').trim() === '1';
const garbage = read('claude-garbage').trim() === '1';
const report = read('claude-result') || 'done';

// Honour the deny list exactly as the real CLI was observed to: a denied Bash
// is a Bash tool that does not exist in this session.
const settingsIndex = argv.indexOf('--settings');
const settings = settingsIndex >= 0 ? JSON.parse(argv[settingsIndex + 1]) : { permissions: { deny: [] } };
const bashDenied = (settings.permissions?.deny ?? []).includes('Bash');

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'fake', tools: bashDenied ? ['Read'] : ['Bash', 'Read'] });

if (garbage) process.stdout.write('this line is not json at all\\n');

if (!bashDenied) {
  let n = 0;
  for (const command of plan) {
    n += 1;
    emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'tool_' + n, name: 'Bash', input: { command, description: 'step ' + n } }] },
    });
    // Actually run it, so a test can assert on a side effect if it wants to.
    // A stand-in that only claimed to run commands would let a bug that never
    // executes anything pass every assertion in this file.
    try {
      const { execSync } = await import('node:child_process');
      execSync(command, { stdio: 'ignore' });
    } catch {
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_' + n, is_error: true, content: 'command failed' }] } });
    }
  }
}

emit({
  type: 'result',
  subtype: failing ? 'error_during_execution' : 'success',
  is_error: failing,
  num_turns: plan.length + 1,
  total_cost_usd: 0.25,
  permission_denials: [],
  result: bashDenied
    ? 'I have no Bash tool in this session. The commands I would have run:\\n' + plan.join('\\n')
    : report,
});
`,
  );
  const claude = join(bin, 'claude');
  writeFileSync(
    claude,
    ['#!/bin/sh', `exec ${process.execPath} ${claudeJs} "$@"`, ''].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(claude, 0o755);

  const statusFile = (instance: string) => join(root, `${instance}-waker-status.json`);

  const configPath = join(root, 'ops-config.yaml');
  writeFileSync(
    configPath,
    [
      `dryRun: ${options.dryRun}`,
      `stateDir: ${stateDir}`,
      'pollSeconds: 1',
      `runContainerScript: ${runContainer}`,
      `snapshotScript: ${snapshot}`,
      `systemctlPath: ${systemctl}`,
      `dockerPath: ${docker}`,
      `gitPath: ${git}`,
      `npmPath: ${npm}`,
      `snapshotKeep: ${options.snapshotKeep ?? 24}`,
      'hostAgent:',
      `  enabled: ${options.hostAgent === false ? 'false' : 'true'}`,
      `  claudePath: ${claude}`,
      `  workDir: ${join(root, 'host-agent')}`,
      '  timeoutMinutes: 1',
      '  maxCostUsd: 1',
      '  model: ""',
      `  envPassthrough: [${(options.envPassthrough ?? []).join(', ')}]`,
      'units:',
      '  - name: clawcius.service',
      '    description: the waker',
      'repos:',
      '  - name: clawcius',
      `    path: ${join(root, 'repo')}`,
      '    branch: main',
      `    buildDirs: [${(options.buildDirs ?? ['.']).map((d) => JSON.stringify(d)).join(', ')}]`,
      'instances:',
      // Each instance's spool is left to the default — `<stateDir>/run/ops` —
      // because that default is itself under test. Writing it out here would
      // mean the suite never exercises the derivation that makes a newly
      // added instance reachable without anybody remembering a second key.
      ...specs.flatMap((spec, index) => [
        `  - name: ${spec.name}`,
        `    container: ${spec.name}-agent`,
        `    image: ${spec.name}-agent:latest`,
        `    stateDir: ${instanceState(spec.name)}`,
        `    envFile: ${join(root, 'env')}`,
        '    memory: 2g',
        `    wakerStatusFile: ${statusFile(spec.name)}`,
        `    wakeSpoolDir: ${join(instanceState(spec.name), 'run', 'wake')}`,
        `    wakeChannelId: "${channels[index] ?? '923456789012345678'}"`,
        '    buildRepo: clawcius',
        ...(spec.extra ?? []),
      ]),
      'limits:',
      '  maxRequestBytes: 4096',
      '  maxPerSweep: 3',
      '  maxSpoolFiles: 5',
      '  maxPerHour: 6',
      '  maxQueued: 2',
      '  commandTimeoutSeconds: 20',
      '  buildTimeoutSeconds: 60',
      'idle:',
      '  staleSeconds: 60',
      '  maxWaitMinutes: 0',
      '  pollSeconds: 1',
      'deadline:',
      '  minutes: 1',
      '  autoRollback: true',
      'breaker:',
      '  maxConsecutiveFailedRecoveries: 2',
      '  maxQuarantined: 8',
      'snapshotVerify:',
      '  enabled: true',
      `  instances: [${specs.map((spec) => spec.name).join(', ')}]`,
      '  startTimeoutSeconds: 5',
      '  probe: [/bin/true]',
      '',
    ].join('\n'),
  );

  writeFileSync(join(root, 'env'), 'X=1\n');

  const config = loadOpsConfig(configPath);

  return {
    root,
    config,
    callsDir,
    calls: () => {
      if (!existsSync(callsDir)) return [];
      return readdirSync(callsDir)
        .sort()
        // The claude stand-in records JSON rather than one argument per line
        // (its prompt is multi-line on purpose), so it is read through
        // claudeCall() instead. It still shows up here as a single-element
        // 'claude' entry, because several assertions are about ORDERING —
        // snapshot before the session, restore after it — and those need it in
        // the same sequence as everything else.
        .map((name) =>
          name.endsWith('-claude')
            ? ['claude']
            : readFileSync(join(callsDir, name), 'utf8')
                .split('\n')
                .filter((line) => line.length > 0),
        );
    },
    spoolDir: spoolDirOf,
    setStatus: (instance, body) => {
      writeFileSync(statusFile(instance), JSON.stringify(body));
    },
    setDirty: (porcelain) => {
      writeFileSync(join(control, 'dirty'), porcelain.length ? `${porcelain.join('\n')}\n` : '');
    },
    setPlan: (commands) => {
      writeFileSync(join(control, 'plan'), commands.length ? `${commands.join('\n')}\n` : '');
    },
    failTask: () => writeFileSync(join(control, 'claude-fail'), '1\n'),
    corruptStream: () => writeFileSync(join(control, 'claude-garbage'), '1\n'),
    setReport: (text) => writeFileSync(join(control, 'claude-result'), text),
    claudeCall: () => {
      if (!existsSync(callsDir)) return null;
      const file = readdirSync(callsDir)
        .sort()
        .find((name) => name.endsWith('-claude'));
      if (!file) return null;
      return JSON.parse(readFileSync(join(callsDir, file), 'utf8')) as {
        argv: string[];
        cwd: string;
        home: string;
        envNames: string[];
      };
    },
  };
}

/** The npm invocations recorded by the stand-in, in order, decoded. */
function npmCalls(calls: string[][]): Array<{ argv: string[]; cwd: string; home: string }> {
  return calls
    .filter((call) => call[0] === 'npm')
    .map((call) => ({
      argv: call.filter((line) => !/^(cwd|uid|home)=/.test(line)),
      cwd: call.find((line) => line.startsWith('cwd='))?.slice(4) ?? '',
      home: call.find((line) => line.startsWith('home='))?.slice(5) ?? '',
    }));
}

/** Drop a request into the spool the way an agent is told to: temp then rename. */
function fileRequest(spoolDir: string, name: string, body: string): void {
  const temp = join(spoolDir, `.${name}.tmp`);
  writeFileSync(temp, body);
  renameSync(temp, join(spoolDir, `${name}.json`));
}

function journalEntries(config: OpsConfig): Array<Record<string, unknown>> {
  const path = join(config.stateDir, 'journal.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function settle(executor: Executor, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = executor.snapshot();
    if (snapshot.current === 'idle' && snapshot.queued === 0) return;
    if (Date.now() > deadline) throw new Error(`executor still busy: ${snapshot.current}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Request validation — the hostile inputs
// ══════════════════════════════════════════════════════════════════════════

test('every verb parses when well formed', () => {
  const cases = [
    '{"verb":"task","task":"restart the waker, it is wedged"}',
    '{"verb":"task","instance":"clawcius","task":"free some disk"}',
    '{"verb":"rollback","instance":"clawcius","tag":"snap-20260810-120000"}',
    '{"verb":"checkin","instance":"clawcius","detail":"back up"}',
    '{"verb":"wake","channel":"123456789012345678","detail":"hello"}',
  ];
  for (const body of cases) {
    const parsed = parseRequest(body);
    assert.equal(parsed.ok, true, `${body} should parse: ${parsed.ok ? '' : parsed.reason}`);
  }
});

test('a task needs an actual task, and the instance is optional', () => {
  // Optional, because most of what the operator needed on 2026-08-10 — chown,
  // mkdir, installing a unit, reading a journal — concerns no instance at all.
  const unnamed = parseRequest('{"verb":"task","task":"install the new timer unit"}');
  assert.equal(unnamed.ok, true);
  assert.equal(unnamed.ok && unnamed.request.instance, '');

  // Required, because "do something" filed against a root shell is the request
  // most likely to be an accident and least likely to be what anyone wanted.
  const empty = parseRequest('{"verb":"task","instance":"clawcius"}');
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? '' : empty.reason, /requires "task"/);

  const blank = parseRequest('{"verb":"task","task":"   "}');
  assert.equal(blank.ok, false);
});

test('the deleted verbs are gone and are rejected by name', () => {
  // Not "unknown-ish". An agent that has been filing `redeploy` for two days
  // gets a rejection naming the verbs that exist, so its next attempt is a
  // task and not a retry.
  for (const verb of ['restart', 'pull', 'redeploy', 'snapshot']) {
    const parsed = parseRequest(`{"verb":"${verb}","instance":"clawcius","unit":"clawcius.service","repo":"clawcius"}`);
    assert.equal(parsed.ok, false, `${verb} must no longer be a verb`);
    assert.match(parsed.ok ? '' : parsed.reason, /known verbs: task, checkin, rollback, wake/);
  }
});

test('rollback without a tag is allowed and means "the newest"', () => {
  const result = parseRequest(JSON.stringify({ verb: 'rollback', instance: 'hamachi' }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.request.tag, '');
});

test('unknown verbs are rejected, never approximated', () => {
  for (const verb of ['reboot', 'RESTART', 'restart ', 'restar', 'exec', '__proto__', '']) {
    const result = parseRequest(JSON.stringify({ verb, unit: 'clawcius.service' }));
    assert.equal(result.ok, false, `"${verb}" must be rejected`);
  }
});

test('malformed JSON is discarded whole, never partially parsed', () => {
  for (const body of [
    '',
    '{',
    '{"verb": "restart", "unit": "clawcius.service"',
    'not json at all',
    '{"verb": "restart"} trailing garbage',
    ' ',
  ]) {
    const result = parseRequest(body);
    assert.equal(result.ok, false, `${JSON.stringify(body)} must be rejected`);
    if (!result.ok) assert.match(result.reason, /not valid JSON/);
  }
});

test('a JSON array or scalar is not a request', () => {
  for (const body of ['[]', '[{"verb":"restart"}]', '"restart"', '42', 'null', 'true']) {
    const result = parseRequest(body);
    assert.equal(result.ok, false, `${body} must be rejected`);
  }
});

test('path traversal in an identifier is rejected', () => {
  const cases = [
    '../../etc/systemd/system',
    '..',
    '.',
    'a/../b',
    'clawcius/../../root',
    './clawcius',
    'a\\b',
    'a/b',
  ];
  for (const instance of cases) {
    const result = parseRequest(JSON.stringify({ verb: 'checkin', instance }));
    assert.equal(result.ok, false, `"${instance}" must be rejected`);
    if (!result.ok) {
      assert.match(result.reason, /traversal|path separator|does not match/);
    }
  }
});

test('NUL and control bytes in an identifier are rejected', () => {
  const withNul = `{"verb":"checkin","instance":"clawcius\\u0000extra"}`;
  const nul = parseRequest(withNul);
  assert.equal(nul.ok, false);
  if (!nul.ok) assert.match(nul.reason, /NUL byte/);

  // No separator in this one, so it exercises the control-character branch
  // rather than being caught earlier by the path check.
  const withControl = `{"verb":"checkin","instance":"clawcius\\u0007bell"}`;
  const control = parseRequest(withControl);
  assert.equal(control.ok, false);
  if (!control.ok) assert.match(control.reason, /control character/);

  const withNewline = `{"verb":"checkin","instance":"clawcius\\nrm -rf /"}`;
  const newline = parseRequest(withNewline);
  assert.equal(newline.ok, false);
  if (!newline.ok) assert.match(newline.reason, /path separator/);
});

test('shell metacharacters never make it through an identifier', () => {
  const attempts = [
    'clawcius; rm -rf /',
    'clawcius && curl evil.example',
    'clawcius`id`',
    'clawcius$(id)',
    'clawcius|tee /etc/passwd',
    'clawcius >/etc/cron.d/x',
    '$(reboot)',
    '--privileged',
    '-v/:/host',
  ];
  for (const instance of attempts) {
    const result = parseRequest(JSON.stringify({ verb: 'checkin', instance }));
    assert.equal(result.ok, false, `"${instance}" must be rejected`);
  }
  // The same applied to a unit name, which has a looser pattern.
  for (const unit of ['clawcius.service; reboot', 'a b.service', '../x.service']) {
    const result = parseRequest(JSON.stringify({ verb: 'restart', unit }));
    assert.equal(result.ok, false, `"${unit}" must be rejected`);
  }
});

test('a snapshot tag must look exactly like one snapshot.sh writes', () => {
  for (const tag of [
    'latest',
    'snap-2026-08-08',
    'snap-20260808-04000',
    'snap-20260808-0400000',
    'snap-20260808-040000-extra',
    'SNAP-20260808-040000',
  ]) {
    const result = parseRequest(JSON.stringify({ verb: 'rollback', instance: 'clawcius', tag }));
    assert.equal(result.ok, false, `"${tag}" must be rejected`);
  }
  const good = parseRequest(
    JSON.stringify({ verb: 'rollback', instance: 'clawcius', tag: 'snap-20260808-040000' }),
  );
  assert.equal(good.ok, true);
});

test('types are not coerced', () => {
  for (const instance of [1, true, null, {}, [], 1.5]) {
    const body = JSON.stringify({ verb: 'checkin', instance });
    const result = parseRequest(body);
    assert.equal(result.ok, false, `${body} must be rejected`);
  }
});

test('a missing required field is a rejection, not a default', () => {
  assert.equal(parseRequest('{"verb":"checkin"}').ok, false);
  assert.equal(parseRequest('{"verb":"rollback"}').ok, false);
  assert.equal(parseRequest('{"verb":"task"}').ok, false);
  assert.equal(parseRequest('{"verb":"wake","channel":"123456789012345678"}').ok, false);
});

test('unknown fields are reported and never acted on', () => {
  const result = parseRequest(
    JSON.stringify({
      verb: 'task',
      task: 'restart clawcius.service',
      // `unit` and `repo` were fields until 2026-08-10. They are unknown now,
      // which is the correct treatment of a request written against the old
      // schema: reported, ignored, never quietly honoured.
      unit: 'sshd.service',
      repo: 'somewhere-else',
      args: ['--force'],
      env: { LD_PRELOAD: '/tmp/x.so' },
      command: 'rm -rf /',
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.request.unknownFields.sort(), [
      'args',
      'command',
      'env',
      'repo',
      'unit',
    ]);
    // And none of them appear anywhere in the parsed request.
    assert.equal(JSON.stringify(result.request).includes('LD_PRELOAD'), false);
  }
});

test('free text is kept but stripped of control characters and capped', () => {
  const result = parseRequest(
    JSON.stringify({
      verb: 'task',
      task: 'do the thing',
      instance: 'clawcius',
      reason: `line one\u0000\u0007 line two\nkept`,
      detail: 'x'.repeat(5000),
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.reason.includes('\u0000'), false);
    assert.equal(result.request.reason.includes('\u0007'), false);
    assert.equal(result.request.reason.includes('\n'), true, 'newlines are prose, not an attack');
    assert.equal(result.request.detail.length, 2000);
  }
});

test('every task counts as destructive, because a sentence cannot be read', () => {
  assert.equal(isDestructive('task'), true);
  assert.equal(isDestructive('rollback'), true);
  assert.equal(isDestructive('checkin'), false);
  assert.equal(isDestructive('wake'), false);

  // The point of the assertion: there is no attempt to classify a task by its
  // text. A `task` that says "just read the logs" is destructive as far as this
  // executor is concerned, and it waits for an idle turn and takes a snapshot
  // like any other, because the alternative is guessing about prose.
  assert.equal(isDestructive(parseRequest('{"verb":"task","task":"just read the logs"}').ok ? 'task' : 'task'), true);
});

test('describeRequest never returns an empty target, and clips a task', () => {
  const rollback = parseRequest(JSON.stringify({ verb: 'rollback', instance: 'clawcius' }));
  assert.equal(rollback.ok, true);
  if (rollback.ok) assert.equal(describeRequest(rollback.request), 'rollback clawcius');

  // The journal's prose lines are read in a terminal during an incident, and an
  // eight-thousand-character `what` makes journalctl useless at the one moment
  // it is needed. The full text is in the request entry's detail.
  const long = parseRequest(JSON.stringify({ verb: 'task', task: `${'x'.repeat(400)}\nsecond line` }));
  assert.equal(long.ok, true);
  if (long.ok) {
    const described = describeRequest(long.request);
    assert.ok(described.length < 100, described.length.toString());
    assert.match(described, /^task x+…$/);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// The spool's structural defences
// ══════════════════════════════════════════════════════════════════════════

test('an oversized request is discarded without being read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-spool-size-'));
  const seen: string[] = [];
  const logs: string[] = [];
  const spool = new OpsSpool({
    dir,
    instance: 'clawcius',
    maxBytes: 100,
    maxPerSweep: 10,
    maxFiles: 50,
    pollSeconds: 3600,
    log: (line) => logs.push(line),
    onRequest: (raw) => seen.push(raw.name),
  });

  fileRequest(dir, 'big', JSON.stringify({ verb: 'restart', pad: 'x'.repeat(500) }));
  fileRequest(dir, 'small', JSON.stringify({ verb: 'restart', unit: 'clawcius.service' }));

  spool.start();
  spool.stop();

  assert.deepEqual(seen, ['small.json']);
  assert.equal(logs.some((line) => /exceeds the 100-byte cap/.test(line)), true);
  assert.equal(existsSync(join(dir, 'big.json')), false, 'oversized file must be removed');
});

test('the per-sweep cap bounds work and leaves the rest for later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-spool-cap-'));
  const seen: string[] = [];
  const spool = new OpsSpool({
    dir,
    instance: 'clawcius',
    maxBytes: 4096,
    maxPerSweep: 2,
    maxFiles: 50,
    pollSeconds: 3600,
    log: () => {},
    onRequest: (raw) => seen.push(raw.name),
  });

  for (let i = 0; i < 5; i += 1) {
    fileRequest(dir, `req-${i}`, JSON.stringify({ verb: 'snapshot', instance: 'clawcius' }));
  }

  spool.start();
  assert.equal(seen.length, 2);
  spool.drain();
  assert.equal(seen.length, 4);
  spool.drain();
  assert.equal(seen.length, 5);
  spool.stop();
});

test('a flooded spool is drained unread', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-spool-flood-'));
  const seen: string[] = [];
  const logs: string[] = [];
  const spool = new OpsSpool({
    dir,
    instance: 'clawcius',
    maxBytes: 4096,
    maxPerSweep: 100,
    maxFiles: 4,
    pollSeconds: 3600,
    log: (line) => logs.push(line),
    onRequest: (raw) => seen.push(raw.name),
  });

  for (let i = 0; i < 20; i += 1) {
    fileRequest(dir, `flood-${i}`, JSON.stringify({ verb: 'redeploy', instance: 'clawcius' }));
  }

  spool.start();
  spool.stop();

  assert.equal(seen.length, 0, 'nothing from a flood is processed');
  assert.equal(logs.some((line) => /SPOOL FLOODED/.test(line)), true);
});

test('implausible file names are discarded unread', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-spool-names-'));
  const seen: string[] = [];
  const spool = new OpsSpool({
    dir,
    instance: 'clawcius',
    maxBytes: 4096,
    maxPerSweep: 10,
    maxFiles: 50,
    pollSeconds: 3600,
    log: () => {},
    onRequest: (raw) => seen.push(raw.name),
  });

  const body = JSON.stringify({ verb: 'snapshot', instance: 'clawcius' });
  writeFileSync(join(dir, '-leading-dash.json'), body);
  writeFileSync(join(dir, `${'x'.repeat(200)}.json`), body);
  writeFileSync(join(dir, 'ignored.txt'), body);
  fileRequest(dir, 'fine', body);

  spool.start();
  spool.stop();

  assert.deepEqual(seen, ['fine.json']);
  // The non-.json file is not ours and is left alone rather than deleted.
  assert.equal(existsSync(join(dir, 'ignored.txt')), true);
});

test('a request is removed before the handler runs, so a throw cannot loop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-spool-unlink-'));
  let calls = 0;
  const spool = new OpsSpool({
    dir,
    instance: 'clawcius',
    maxBytes: 4096,
    maxPerSweep: 10,
    maxFiles: 50,
    pollSeconds: 3600,
    log: () => {},
    onRequest: () => {
      calls += 1;
      throw new Error('handler exploded');
    },
  });

  fileRequest(dir, 'boom', JSON.stringify({ verb: 'snapshot', instance: 'clawcius' }));
  spool.start();
  spool.drain();
  spool.drain();
  spool.stop();

  assert.equal(calls, 1, 'a request that throws is not retried');
  assert.equal(existsSync(join(dir, 'boom.json')), false);
});

// ══════════════════════════════════════════════════════════════════════════
// Idle detection — the stale-zero case is the dangerous one
// ══════════════════════════════════════════════════════════════════════════

test('idle detection fails safe in every ambiguous case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-idle-'));
  const path = join(dir, 'waker-status.json');
  const now = Date.now();

  assert.equal(readIdle(path, 60, now).idle, false, 'missing file => busy');
  assert.match(readIdle(path, 60, now).reason, /not running/);

  writeFileSync(path, 'not json');
  assert.equal(readIdle(path, 60, now).idle, false, 'malformed => busy');

  writeFileSync(path, '[]');
  assert.equal(readIdle(path, 60, now).idle, false, 'not an object => busy');

  writeFileSync(path, JSON.stringify({ liveCount: 0 }));
  assert.equal(readIdle(path, 60, now).idle, false, 'no timestamp => busy');

  writeFileSync(path, JSON.stringify({ at: now }));
  assert.equal(readIdle(path, 60, now).idle, false, 'no liveCount => busy');

  writeFileSync(path, JSON.stringify({ at: now, liveCount: '0' }));
  assert.equal(readIdle(path, 60, now).idle, false, 'liveCount must be a number');

  writeFileSync(path, JSON.stringify({ at: now, liveCount: 2 }));
  assert.equal(readIdle(path, 60, now).idle, false, 'a live turn => busy');

  // The one that matters: a waker that crashed leaves a zero on disk forever.
  writeFileSync(path, JSON.stringify({ at: now - 3_600_000, liveCount: 0 }));
  const stale = readIdle(path, 60, now);
  assert.equal(stale.idle, false, 'a stale zero must not read as permission');
  assert.match(stale.reason, /stale/);

  writeFileSync(path, JSON.stringify({ at: now + 600_000, liveCount: 0 }));
  const future = readIdle(path, 60, now);
  assert.equal(future.idle, false, 'a future timestamp => busy');
  assert.match(future.reason, /FUTURE/);

  writeFileSync(path, JSON.stringify({ at: now - 5_000, liveCount: 0 }));
  const good = readIdle(path, 60, now);
  assert.equal(good.idle, true);
  assert.equal(good.liveCount, 0);
});

test('an implausibly large status file is treated as busy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-idle-big-'));
  const path = join(dir, 'waker-status.json');
  writeFileSync(path, JSON.stringify({ at: Date.now(), liveCount: 0, pad: 'x'.repeat(20000) }));
  assert.equal(readIdle(path, 60).idle, false);
});

// ══════════════════════════════════════════════════════════════════════════
// Config containment — the assertions that keep the breaker out of reach
// ══════════════════════════════════════════════════════════════════════════

function writeConfig(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-config-'));
  const path = join(dir, 'ops-config.yaml');
  writeFileSync(path, lines.join('\n'));
  return path;
}

const MINIMAL_INSTANCE = (root: string) => [
  'instances:',
  '  - name: clawcius',
  '    container: clawcius-agent',
  '    image: clawcius-agent:latest',
  `    stateDir: ${root}/state`,
  `    envFile: ${root}/env`,
  `    wakerStatusFile: ${root}/waker-status.json`,
  `    wakeSpoolDir: ${root}/state/run/wake`,
  '    wakeChannelId: "123456789012345678"',
];

test('stateDir inside an instance spool is refused', () => {
  // The default spool for this instance is /var/lib/x/run/ops, and the state
  // directory is put inside it. Written without naming opsSpoolDir on purpose:
  // the derived default is a real path with real consequences and the
  // containment checks have to see it, not just the explicit form.
  const path = writeConfig([
    'stateDir: /var/lib/x/state/run/ops/state',
    ...MINIMAL_INSTANCE('/var/lib/x'),
  ]);
  assert.throws(() => loadOpsConfig(path), /stateDir .* is inside instances\[clawcius\]\.opsSpoolDir/);
});

test('a waker status file inside a container mount is refused', () => {
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    'instances:',
    '  - name: clawcius',
    '    container: clawcius-agent',
    '    image: clawcius-agent:latest',
    '    stateDir: /var/lib/x',
    '    envFile: /var/lib/x/env',
    // Inside the wake spool, which is bind-mounted read-write.
    '    wakerStatusFile: /var/lib/x/run/wake/waker-status.json',
    '    wakeSpoolDir: /var/lib/x/run/wake',
    '    wakeChannelId: "123456789012345678"',
  ]);
  assert.throws(() => loadOpsConfig(path), /wakerStatusFile is inside its wakeSpoolDir/);
});

test('a near-miss prefix is not treated as containment', () => {
  // /var/lib/clawcius-ops is NOT inside /var/lib/clawcius, and a naive
  // startsWith would say it is.
  const path = writeConfig([
    'stateDir: /var/lib/clawcius-ops',
    ...MINIMAL_INSTANCE('/var/lib/clawcius'),
  ]);
  const config = loadOpsConfig(path);
  assert.equal(config.stateDir, '/var/lib/clawcius-ops');
  assert.equal(config.instances[0]?.opsSpoolDir, '/var/lib/clawcius/state/run/ops');
});

test('structural config errors fail the boot with the key named', () => {
  assert.throws(
    () => loadOpsConfig(writeConfig(['units:', '  - name: not-a-unit'])),
    /units\[0\]\.name/,
  );
  assert.throws(
    () => loadOpsConfig(writeConfig(['repos:', '  - name: Clawcius', '    path: /x', '    branch: main'])),
    /repos\[0\]\.name/,
  );
  assert.throws(
    () => loadOpsConfig(writeConfig(['repos:', '  - name: ok', '    path: relative/path', '    branch: main'])),
    /must be an absolute path/,
  );
  assert.throws(
    () =>
      loadOpsConfig(
        writeConfig([...MINIMAL_INSTANCE('/var/lib/z'), '    buildRepo: nonexistent']),
      ),
    /names no entry under repos/,
  );
  assert.throws(
    () =>
      loadOpsConfig(
        writeConfig([...MINIMAL_INSTANCE('/var/lib/z'), 'snapshotVerify:', '  instances: [nope]']),
      ),
    /names no entry under instances/,
  );
  assert.throws(
    () =>
      loadOpsConfig(
        writeConfig([...MINIMAL_INSTANCE('/var/lib/z'), 'snapshotVerify:', '  probe: []']),
      ),
    /must have at least one element/,
  );
  assert.throws(
    () =>
      loadOpsConfig(
        writeConfig([
          'units:',
          '  - name: a.service',
          '  - name: a.service',
          ...MINIMAL_INSTANCE('/var/lib/z'),
        ]),
      ),
    /two entries named/,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// The runner: argv arrays, and dry-run
// ══════════════════════════════════════════════════════════════════════════

test('arguments reach the child intact, one argv element each', async () => {
  const host = makeHost({ dryRun: false, suffix: 'argv' });
  const runner = new Runner(false, 20, () => {});
  const hostile = 'a b; rm -rf / $(id) `id` "quoted" \'single\'';
  const result = await runner.run([host.config.systemctlPath, 'restart', hostile]);
  assert.equal(result.ok, true);

  const calls = host.calls();
  const call = calls.find((entry) => entry[0] === 'systemctl');
  assert.ok(call, 'systemctl stand-in should have been called');
  // One line per argument. If anything had built a command string, this would
  // have arrived as several arguments.
  assert.deepEqual(call, ['systemctl', 'restart', hostile]);
});

test('dry-run suppresses mutating commands and still runs read-only probes', async () => {
  const host = makeHost({ dryRun: true, suffix: 'dry' });
  const logged: string[] = [];
  const runner = new Runner(true, 20, (line) => logged.push(line));

  const mutated = await runner.run([host.config.systemctlPath, 'restart', 'clawcius.service']);
  assert.equal(mutated.skipped, true);
  assert.equal(mutated.ok, true);
  assert.equal(
    host.calls().some((call) => call[0] === 'systemctl'),
    false,
    'nothing should have been executed',
  );
  assert.equal(logged.some((line) => line.startsWith('DRY-RUN would run:')), true);
  assert.match(logged.join('\n'), /restart clawcius\.service/);

  const probed = await runner.probe([host.config.dockerPath, 'images', 'clawcius-agent']);
  assert.equal(probed.skipped, false);
  assert.equal(
    host.calls().some((call) => call[0] === 'docker'),
    true,
    'probes must still run, or a dry run reports fiction',
  );
});

test('render() quotes for humans and is never fed back to a shell', () => {
  assert.equal(render(['docker', 'rm', '-f', 'clawcius-agent']), 'docker rm -f clawcius-agent');
  assert.equal(render(['echo', 'a b']), 'echo "a b"');
});

test('a missing binary is reported as a spawn failure, not a non-zero exit', async () => {
  const runner = new Runner(false, 5, () => {});
  const result = await runner.run(['/nonexistent/definitely-not-here', 'x']);
  assert.equal(result.ok, false);
  assert.match(result.spawnError, /ENOENT/);
});

// ══════════════════════════════════════════════════════════════════════════
// Breaker persistence — across a process boundary, which is the point
// ══════════════════════════════════════════════════════════════════════════

test('quarantine and freeze survive a fresh StateStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-state-'));

  const first = new StateStore(dir, 8);
  assert.equal(first.isQuarantined('clawcius', 'sha-bad'), null);
  first.quarantine('clawcius', 'sha-bad', 'missed its check-in');
  first.recordRecoveryFailure();
  first.freeze('two consecutive failed recoveries');

  // A brand-new store, as after `systemctl restart clawcius-ops` — which is
  // itself a verb the agent can ask for.
  const second = new StateStore(dir, 8);
  assert.ok(second.isQuarantined('clawcius', 'sha-bad'));
  assert.equal(second.isQuarantined('clawcius', 'sha-good'), null);
  assert.equal(second.isQuarantined('hamachi', 'sha-bad'), null, 'quarantine is per instance');
  assert.equal(second.state.frozen, true);
  assert.equal(second.state.consecutiveFailedRecoveries, 1);

  second.unfreeze();
  assert.equal(new StateStore(dir, 8).state.frozen, false);
  assert.ok(
    new StateStore(dir, 8).isQuarantined('clawcius', 'sha-bad'),
    'unfreezing does not un-quarantine a build that already failed',
  );
});

test('the quarantine ring is bounded and evicts oldest first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-state-ring-'));
  const store = new StateStore(dir, 3);
  for (const build of ['b1', 'b2', 'b3', 'b4']) store.quarantine('clawcius', build, 'x');
  assert.equal(store.isQuarantined('clawcius', 'b1'), null, 'oldest evicted');
  assert.ok(store.isQuarantined('clawcius', 'b4'));
  assert.equal(store.state.quarantined.length, 3);
});

test('a corrupt state file refuses to start rather than starting empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-state-corrupt-'));
  writeFileSync(join(dir, 'state.json'), '{"version": 1, "quarantined": [');
  assert.throws(() => new StateStore(dir, 8), /Refusing to start/);

  writeFileSync(join(dir, 'state.json'), '{"version": 99}');
  assert.throws(() => new StateStore(dir, 8), /expected 1/);
});

test('armed deadlines persist and can be disarmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-state-deadline-'));
  const store = new StateStore(dir, 8);
  store.arm({
    instance: 'clawcius',
    deadlineAt: Date.now() + 60_000,
    reason: 'redeploy',
    build: 'sha1',
    rollbackTag: 'snap-20260808-040000',
    fromRollback: false,
    armedAt: Date.now(),
  });
  assert.ok(new StateStore(dir, 8).pendingFor('clawcius'));
  store.disarm('clawcius');
  assert.equal(new StateStore(dir, 8).pendingFor('clawcius'), null);
});

// ══════════════════════════════════════════════════════════════════════════
// The executor: allowlists, the lock, the deadline, the breaker
// ══════════════════════════════════════════════════════════════════════════

test('a task naming an instance that does not exist is refused', async () => {
  const host = makeHost({ dryRun: true, suffix: 'inst' });
  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"hamachi","task":"restart it"}',
  });
  await settle(executor);
  const rejected = journalEntries(host.config).filter((entry) => entry['kind'] === 'rejected');
  assert.match(String(rejected[0]?.['detail']), /not in the instances allowlist/);
  // And nothing was started. The instance name still selects a config entry
  // rather than supplying a value, which is the one part of the old rule that
  // survives — it decides what gets snapshotted and rolled back.
  assert.equal(host.claudeCall(), null);
  executor.stop();
});

test('tasks can be switched off without dropping the deadlines', async () => {
  const host = makeHost({ dryRun: false, suffix: 'disabled', hostAgent: false });
  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"task","task":"anything"}' });
  await settle(executor);

  const rejected = journalEntries(host.config).filter((entry) => entry['kind'] === 'rejected');
  assert.match(String(rejected[0]?.['detail']), /hostAgent\.enabled is false/);
  assert.equal(host.claudeCall(), null);

  // The point of the setting: a check-in still closes a deadline. Turning tasks
  // off must not be the same as stopping the unit, which would drop every armed
  // rollback deadline on a host somebody is already worried about.
  executor.state.arm({
    instance: 'clawcius',
    deadlineAt: Date.now() + 600_000,
    reason: 'a task',
    build: 'abc',
    rollbackTag: 'snap-20260808-040000',
    fromRollback: false,
    armedAt: Date.now(),
  });
  executor.intake({
    requester: 'clawcius',
    name: 'b.json',
    body: '{"verb":"checkin","instance":"clawcius"}',
  });
  await settle(executor);
  assert.equal(executor.state.pendingFor('clawcius'), null, 'the check-in must still land');
  executor.stop();
});

test('a destructive verb abandons rather than interrupting a live turn', async () => {
  const host = makeHost({ dryRun: true, suffix: 'busy' });
  // A turn in flight.
  host.setStatus('clawcius', { at: Date.now(), liveCount: 1 });

  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}' });
  await settle(executor);

  const entries = journalEntries(host.config);
  assert.equal(
    entries.some(
      (entry) => entry['kind'] === 'failed' && /ABANDONED, not deferred/.test(String(entry['detail'])),
    ),
    true,
  );
  assert.equal(
    host.calls().some((call) => call.includes('--recreate')),
    false,
    'the container must not be recreated while a turn is live',
  );
  executor.stop();
});

test('a missing waker status file also blocks a destructive verb', async () => {
  const host = makeHost({ dryRun: true, suffix: 'nostatus' });
  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}' });
  await settle(executor);
  const entries = journalEntries(host.config);
  assert.equal(
    entries.some((entry) => /the waker is not running/.test(String(entry['detail']))),
    true,
  );
  executor.stop();
});

test('the rolling-hour cap refuses work with a stated reason', async () => {
  const host = makeHost({ dryRun: true, suffix: 'rate' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  // A deep queue, so what refuses these is the hourly cap and not the queue
  // ceiling — the two limits are checked in that order and the test should say
  // which one it is exercising.
  const executor = new Executor({
    ...host.config,
    limits: { ...host.config.limits, maxQueued: 50 },
  });

  // limits.maxPerHour is 6 in the fixture.
  for (let i = 0; i < 9; i += 1) {
    executor.intake({ requester: 'clawcius', name: `r${i}.json`, body: '{"verb":"task","instance":"clawcius","task":"take a snapshot"}' });
  }
  await settle(executor);

  const rejected = journalEntries(host.config).filter(
    (entry) => entry['kind'] === 'rejected' && /rate limit/.test(String(entry['detail'])),
  );
  assert.equal(rejected.length, 3);
  executor.stop();
});

test('one operation at a time: the second request queues behind the first', async () => {
  const host = makeHost({ dryRun: true, suffix: 'lock' });
  // Busy, so the first redeploy sits in the idle wait. maxWaitMinutes is 0 in
  // the fixture, so make it wait by hand for this one test.
  const config: OpsConfig = {
    ...host.config,
    idle: { ...host.config.idle, maxWaitMinutes: 1, pollSeconds: 1 },
  };
  host.setStatus('clawcius', { at: Date.now(), liveCount: 1 });

  const executor = new Executor(config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}' });

  // Give the first one a moment to take the lock and start waiting.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(executor.snapshot().current, 'task clawcius: recreate the container');

  executor.intake({ requester: 'clawcius', name: 'b.json', body: '{"verb":"task","instance":"clawcius","task":"take a snapshot"}' });
  assert.equal(executor.snapshot().queued, 1, 'the second must queue, not run');

  // Now go idle; the first finishes and the second follows.
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  await settle(executor, 30_000);

  const entries = journalEntries(host.config);
  const started = entries.filter((entry) => entry['kind'] === 'started').map((e) => e['what']);
  assert.deepEqual(started, [
    'task clawcius: recreate the container',
    'task clawcius: take a snapshot',
  ]);
  assert.equal(
    entries.some((entry) => entry['kind'] === 'queued'),
    true,
  );
  executor.stop();
});

test('the queue has a ceiling and says so', async () => {
  const host = makeHost({ dryRun: true, suffix: 'queuecap' });
  const config: OpsConfig = {
    ...host.config,
    idle: { ...host.config.idle, maxWaitMinutes: 1, pollSeconds: 1 },
  };
  host.setStatus('clawcius', { at: Date.now(), liveCount: 1 });

  const executor = new Executor(config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}' });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // limits.maxQueued is 2.
  for (let i = 0; i < 4; i += 1) {
    executor.intake({ requester: 'clawcius', name: `q${i}.json`, body: '{"verb":"task","instance":"clawcius","task":"take a snapshot"}' });
  }

  const refused = journalEntries(host.config).filter(
    (entry) => entry['kind'] === 'rejected' && /already queued/.test(String(entry['detail'])),
  );
  assert.equal(refused.length, 2);

  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  await settle(executor, 30_000);
  executor.stop();
});

test('a live task snapshots first, runs the session, and reports back', async () => {
  const host = makeHost({ dryRun: false, suffix: 'live' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"clawcius","task":"recreate the container","reason":"new build"}',
  });
  await settle(executor, 40_000);

  const order = host.calls().map((call) => call[0]);
  assert.ok(
    order.indexOf('snapshot.sh') >= 0 && order.indexOf('snapshot.sh') < order.indexOf('claude'),
    'the rollback target must be captured before the session is allowed to start',
  );

  const snapshot = host.calls().find((call) => call[0] === 'snapshot.sh');
  assert.deepEqual(snapshot, ['snapshot.sh'], 'no arguments; everything goes through the env');

  const finished = journalEntries(host.config).filter((entry) => entry['kind'] === 'finished');
  assert.ok(finished.some((entry) => /host agent session/.test(String(entry['detail']))));

  executor.stop();
});

test('a dry run arms nothing and files nothing', async () => {
  const host = makeHost({ dryRun: true, suffix: 'dryredeploy' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}' });
  await settle(executor);

  assert.equal(executor.state.pendingFor('clawcius'), null, 'a dry run must not arm a rollback');
  const wakeDir = join(host.root, 'state', 'clawcius', 'run', 'wake');
  assert.equal(
    readdirSync(wakeDir).filter((n) => n.endsWith('.json')).length,
    0,
  );
  assert.equal(host.calls().some((call) => call[0] === 'run-container.sh'), false);
  executor.stop();
});

test('a check-in meets the deadline and resets the failure count', async () => {
  const host = makeHost({ dryRun: false, suffix: 'checkin' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}' });
  await settle(executor);
  assert.ok(executor.state.pendingFor('clawcius'));

  executor.intake({
    requester: 'clawcius',
    name: 'b.json',
    body: '{"verb":"checkin","instance":"clawcius","detail":"cron is back, login intact"}',
  });
  await settle(executor);

  assert.equal(executor.state.pendingFor('clawcius'), null);
  const met = journalEntries(host.config).filter((entry) => entry['kind'] === 'deadline-met');
  assert.equal(met.length, 1);
  assert.match(String(met[0]?.['detail']), /cron is back/);
  executor.stop();
});

test('a missed deadline rolls back, quarantines the build, and refuses it again', async () => {
  const host = makeHost({ dryRun: false, suffix: 'deadline' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  // A one-second deadline, so the expiry runs for real rather than being
  // simulated. Everything else is the shipped path.
  const config: OpsConfig = {
    ...host.config,
    deadline: { minutes: 1 / 60, autoRollback: true },
  };

  const executor = new Executor(config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}' });
  await settle(executor);
  const pending = executor.state.pendingFor('clawcius');
  assert.ok(pending);
  const build = pending?.build ?? '';

  // Wait for the deadline to pass and the automatic rollback to run.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await settle(executor);

  const entries = journalEntries(config);
  assert.equal(
    entries.some((entry) => entry['kind'] === 'deadline-missed'),
    true,
  );
  assert.equal(
    entries.some(
      (entry) => entry['kind'] === 'finished' && /rollback clawcius to snap-/.test(String(entry['what'])),
    ),
    true,
  );

  // The snapshot was restored by retagging, then the container recreated.
  const tagCall = host
    .calls()
    .find((call) => call[0] === 'docker' && call[1] === 'tag');
  assert.deepEqual(tagCall, [
    'docker',
    'tag',
    'clawcius-agent:snap-20260808-040000',
    'clawcius-agent:latest',
  ]);

  // And the build is quarantined — permanently, not backed off.
  assert.ok(executor.state.isQuarantined('clawcius', build));

  executor.intake({ requester: 'clawcius', name: 'c.json', body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}' });
  await settle(executor);
  const breaker = journalEntries(config).filter(
    (entry) => entry['kind'] === 'breaker' && /will not be deployed again/.test(String(entry['detail'])),
  );
  assert.ok(breaker.length >= 1, 'a quarantined build must be refused');

  executor.stop();
});

test('consecutive failed recoveries freeze the executor, and a freeze refuses destructive verbs', async () => {
  const host = makeHost({ dryRun: true, suffix: 'freeze' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  // Reach the ceiling directly — the path from a missed deadline to
  // recordRecoveryFailure() is covered by the test above, and driving two full
  // rollback cycles here would only re-test it slowly.
  const store = new StateStore(host.config.stateDir, host.config.breaker.maxQuarantined);
  store.recordRecoveryFailure();
  store.recordRecoveryFailure();
  store.freeze('2 consecutive failed recoveries');

  const executor = new Executor(host.config);
  assert.equal(executor.state.state.frozen, true, 'the freeze is read back from disk at boot');

  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}',
  });
  await settle(executor);

  const entries = journalEntries(host.config);
  assert.equal(
    entries.some((entry) => entry['kind'] === 'rejected' && /FROZEN/.test(String(entry['detail']))),
    true,
  );
  assert.equal(host.claudeCall(), null, 'a frozen executor starts no session at all');

  // What a freeze still lets through has changed with the verbs, and the new
  // list is the interesting part: `checkin` and `wake`. Everything that could
  // touch the host is refused — there is no such thing as a "non-destructive
  // task", because a task is a sentence — but an instance that is alive must
  // still be able to say so, or a freeze would guarantee the next deadline is
  // missed as well.
  executor.state.arm({
    instance: 'clawcius',
    deadlineAt: Date.now() + 600_000,
    reason: 'a task',
    build: 'abc',
    rollbackTag: 'snap-20260808-040000',
    fromRollback: false,
    armedAt: Date.now(),
  });
  executor.intake({
    requester: 'clawcius',
    name: 'b.json',
    body: '{"verb":"checkin","instance":"clawcius"}',
  });
  await settle(executor);
  assert.equal(executor.state.pendingFor('clawcius'), null, 'a check-in must survive a freeze');
  executor.stop();
});

test('deadlines that expired while the executor was down are honoured, not forgiven', async () => {
  const host = makeHost({ dryRun: false, suffix: 'restore' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  const store = new StateStore(host.config.stateDir, 8);
  store.arm({
    instance: 'clawcius',
    deadlineAt: Date.now() - 60_000,
    reason: 'a redeploy nobody was around for',
    build: 'sha-from-before-the-restart',
    rollbackTag: 'snap-20260801-040000',
    fromRollback: false,
    armedAt: Date.now() - 120_000,
  });

  const executor = new Executor(host.config);
  executor.restoreDeadlines();
  await settle(executor);

  const entries = journalEntries(host.config);
  assert.equal(
    entries.some(
      (entry) =>
        entry['kind'] === 'deadline-missed' &&
        /while the executor was not running/.test(String(entry['detail'])),
    ),
    true,
  );
  assert.ok(executor.state.isQuarantined('clawcius', 'sha-from-before-the-restart'));
  executor.stop();
});

// ══════════════════════════════════════════════════════════════════════════
// The host agent
//
// Everything from here to the containment section is about the mechanism that
// replaced the verb list on 2026-08-10. The properties under test are the ones
// the operator was promised in exchange for the sandbox stopping being a
// boundary for this component: a snapshot before, a rollback after, an audit
// that is complete, and a dry-run that genuinely cannot act.
// ══════════════════════════════════════════════════════════════════════════

/** Every Bash command the journal recorded for this run, in order. */
function auditedCommands(config: OpsConfig): string[] {
  return journalEntries(config)
    .filter((entry) => entry['kind'] === 'audit' && entry['what'] === 'bash')
    .map((entry) => String(entry['command']));
}

test('a task reaches a host agent session, with the task text and nothing else', async () => {
  const host = makeHost({ dryRun: false, suffix: 'task' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: JSON.stringify({
      verb: 'task',
      instance: 'clawcius',
      task: 'the waker is wedged, work out why and fix it',
    }),
  });
  await settle(executor, 40_000);

  const call = host.claudeCall();
  assert.ok(call, 'the host agent must actually have been started');

  const prompt = call.argv[call.argv.indexOf('-p') + 1] ?? '';
  assert.match(prompt, /the waker is wedged, work out why and fix it/);
  assert.match(prompt, /filed by the sandboxed agent "clawcius"/);

  // The working directory is NOT the checkout. Claude Code reads CLAUDE.md and
  // project settings from its cwd, and the checkout is a tree the agents get
  // commits merged into — so a session pointed at it would take standing
  // instructions from anything they could merge.
  assert.equal(call.cwd, join(host.root, 'host-agent'));
  assert.notEqual(call.cwd, join(host.root, 'repo'));

  // Only the operator's settings, no MCP, no skills.
  assert.deepEqual(
    ['--setting-sources', 'user'],
    call.argv.slice(call.argv.indexOf('--setting-sources'), call.argv.indexOf('--setting-sources') + 2),
  );
  assert.ok(call.argv.includes('--strict-mcp-config'));
  assert.ok(call.argv.includes('--disable-slash-commands'));
  // A fresh session every time. Never --resume and never --continue: a task
  // must not inherit anything an earlier task was talked into leaving behind.
  assert.ok(call.argv.includes('--session-id'));
  assert.equal(call.argv.includes('--resume'), false);
  assert.equal(call.argv.includes('--continue'), false);
  // And a dollar ceiling, which the timeout does not cover.
  assert.ok(call.argv.includes('--max-budget-usd'));

  executor.stop();
});

test('every Bash command the session issues is written into the journal, in full', async () => {
  const host = makeHost({ dryRun: false, suffix: 'audit' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  // Includes a command with spaces, quotes and a semicolon, because the audit
  // must record what was ISSUED rather than something tidied up. Evidence that
  // has been normalised is not evidence.
  const plan = [
    'true',
    'echo "hello world"; echo again',
    "sh -c 'exit 0'",
  ];
  host.setPlan(plan);

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"clawcius","task":"do three things"}',
  });
  await settle(executor, 40_000);

  assert.deepEqual(auditedCommands(host.config), plan, 'every command, in order, byte for byte');

  // Written BEFORE the result is known, which is what makes the record survive
  // a process that dies mid-task. Asserted as an ordering in the journal: the
  // first audit entry precedes the `finished` entry rather than being flushed
  // with it.
  const kinds = journalEntries(host.config).map((entry) => entry['kind']);
  assert.ok(kinds.indexOf('audit') < kinds.lastIndexOf('finished'));

  executor.stop();
});

test('an audit with a hole in it fails the task and rolls it back', async () => {
  const host = makeHost({ dryRun: false, suffix: 'garbage' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);
  host.corruptStream();

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"clawcius","task":"do something"}',
  });
  await settle(executor, 40_000);

  const entries = journalEntries(host.config);
  const failed = entries.filter((entry) => entry['kind'] === 'failed');
  assert.ok(
    failed.some((entry) => /AUDIT INCOMPLETE/.test(String(entry['detail']))),
    'an unparseable line must fail the task on its own',
  );
  // And the auditor said so at the time, not only in the summary.
  assert.ok(
    entries.some(
      (entry) =>
        entry['kind'] === 'audit' && /could not be parsed as JSON/.test(String(entry['detail'])),
    ),
  );

  // The whole point: the session may have run a command nobody recorded, so the
  // container goes back to where it was.
  const order = host.calls().map((call) => call[0]);
  assert.ok(order.includes('run-container.sh'), 'a broken audit must trigger the rollback');

  executor.stop();
});

test('a task snapshots before it starts and rolls back when the agent reports failure', async () => {
  const host = makeHost({ dryRun: false, suffix: 'rollback' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);
  host.failTask();

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"clawcius","task":"break something"}',
  });
  await settle(executor, 40_000);

  const order = host.calls().map((call) => call[0]);
  assert.ok(
    order.indexOf('snapshot.sh') >= 0 && order.indexOf('snapshot.sh') < order.indexOf('claude'),
    'the rollback target is captured BEFORE the session runs, not after',
  );
  assert.ok(
    order.indexOf('claude') < order.lastIndexOf('run-container.sh'),
    'the restore happens after the session, not instead of it',
  );

  // Restored to the pre-task snapshot by name, not to "the newest", which after
  // a failed task could easily be one taken of the broken state.
  const tag = host.calls().find((call) => call[0] === 'docker' && call[1] === 'tag');
  assert.deepEqual(tag, ['docker', 'tag', 'clawcius-agent:snap-20260808-040000', 'clawcius-agent:latest']);

  // A failed task arms nothing. There is nothing to check in about.
  assert.equal(executor.state.pendingFor('clawcius'), null);
  // And it counted towards the breaker, because a rollback actually happened.
  assert.equal(executor.state.state.consecutiveFailedRecoveries, 1);

  executor.stop();
});

test('a task that fails without a rollback does not push the breaker', async () => {
  // A typo, a refusal, an agent that decided the request was unsafe. Two of
  // those in a row must not freeze the whole mechanism — that would make a
  // pair of badly worded sentences an outage.
  const host = makeHost({ dryRun: false, suffix: 'harmless' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    // No instance named and no instances in scope beyond the one configured,
    // but the request is refused before anything runs.
    name: 'a.json',
    body: '{"verb":"task","instance":"nope","task":"x"}',
  });
  await settle(executor, 40_000);
  assert.equal(executor.state.state.consecutiveFailedRecoveries, 0);
  executor.stop();
});

test('a health regression rolls back even when the agent says it succeeded', async () => {
  const host = makeHost({ dryRun: false, suffix: 'health' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  // The systemctl stand-in prints nothing, so `is-active` reads as "active"
  // both times — until the plan tells it to start failing. The control file the
  // stand-in checks is the same one the npm stand-in uses; here the task itself
  // breaks the unit, which is precisely the case the check exists for.
  host.setPlan([`echo inactive > ${join(host.root, 'control', 'is-active')}`]);
  host.setReport('All done, everything is fine.');

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"clawcius","task":"restart the waker"}',
  });
  await settle(executor, 40_000);

  const failed = journalEntries(host.config).filter((entry) => entry['kind'] === 'failed');
  assert.ok(
    failed.some((entry) => /HEALTH REGRESSED/.test(String(entry['detail']))),
    'the agent claiming success does not settle the question',
  );
  assert.ok(host.calls().some((call) => call[0] === 'docker' && call[1] === 'tag'));
  executor.stop();
});

test('compareHealth only reports things that got worse', () => {
  // Asymmetric on purpose. A strict "anything different is a regression" fires
  // on every deliberate restart — systemctl reports `activating` for a second —
  // and the first thing anybody does about a rollback triggered by a service
  // coming back up correctly is switch the whole mechanism off.
  const before = {
    units: { 'a.service': 'active', 'b.service': 'failed' },
    containers: { 'x-agent': 'running', 'y-agent': 'exited' },
  };

  assert.deepEqual(compareHealth(before, before), []);

  assert.deepEqual(
    compareHealth(before, {
      units: { 'a.service': 'active', 'b.service': 'active' },
      containers: { 'x-agent': 'running', 'y-agent': 'running' },
    }),
    [],
    'fixing something is not a regression',
  );

  const worse = compareHealth(before, {
    units: { 'a.service': 'failed', 'b.service': 'failed' },
    containers: { 'x-agent': 'exited', 'y-agent': 'exited' },
  });
  assert.equal(worse.length, 2);
  assert.match(worse[0] ?? '', /a\.service was active and is now "failed"/);
  assert.match(worse[1] ?? '', /x-agent was running and is now "exited"/);

  // A unit that vanished from the sample entirely reads as a regression, not as
  // "no news". Unknown and dangerous are the same state, which is the rule the
  // idle check follows too.
  assert.equal(compareHealth(before, { units: {}, containers: {} }).length, 2);
});

test('dry-run removes the ability to act rather than asking it not to', async () => {
  const host = makeHost({ dryRun: true, suffix: 'dryagent' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  const marker = join(host.root, 'DRY-RUN-BREACH');
  host.setPlan([`touch ${marker}`]);

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"clawcius","task":"create a file"}',
  });
  await settle(executor, 40_000);

  const call = host.claudeCall();
  assert.ok(call);

  // The settings actually sent. `deny: ["Bash"]` was verified against the real
  // CLI on 2026-08-10 to REMOVE the tool from the session — the init message's
  // tool list does not contain it — and to survive
  // `--permission-mode bypassPermissions`.
  const settings = JSON.parse(call.argv[call.argv.indexOf('--settings') + 1] ?? '{}');
  assert.ok(settings.permissions.deny.includes('Bash'));

  // And not only Bash. The same experiment found the session still holding
  // `Task`, `Monitor`, `CronCreate`, `Write` and `Edit`, and the model pointed
  // out unprompted that `Monitor` runs a shell command. A dry run with one of
  // those left enabled is a dry run with a hole in it.
  for (const tool of ['Task', 'Monitor', 'Write', 'Edit', 'WebFetch']) {
    assert.ok(settings.permissions.deny.includes(tool), `${tool} must be denied in dry-run`);
  }

  // The independent second limit: the built-in tool list itself.
  const tools = call.argv.slice(call.argv.indexOf('--tools') + 1, call.argv.indexOf('--append-system-prompt'));
  assert.deepEqual(tools, ['Read', 'Glob', 'Grep']);

  // And nothing happened. The stand-in honours the deny list the way the real
  // one was observed to, so this asserts the whole chain rather than a flag.
  assert.equal(existsSync(marker), false, 'dry-run must not be able to touch the filesystem');
  assert.deepEqual(auditedCommands(host.config), []);
  assert.equal(host.calls().some((call) => call[0] === 'run-container.sh'), false);
  assert.equal(executor.state.pendingFor('clawcius'), null, 'a dry run arms nothing');

  executor.stop();
});

test('the dry-run deny list is a superset of everything that can execute', () => {
  const dry = JSON.parse(hostAgentSettings(true)).permissions.deny as string[];
  assert.deepEqual(dry, [...DRY_RUN_TOOL_DENY]);
  assert.deepEqual(hostAgentTools(true), ['Read', 'Glob', 'Grep']);

  const live = JSON.parse(hostAgentSettings(false)).permissions.deny as string[];
  assert.ok(hostAgentTools(false).includes('Bash'), 'a live session must be able to work');

  // The live denials are about untrusted content reaching a session that holds
  // everything, which is the security model now that the sandbox is not.
  for (const rule of ['WebFetch', 'WebSearch', 'Bash(gh:*)', 'Bash(curl:*)']) {
    assert.ok(live.includes(rule), `${rule} must be denied even when live`);
  }
  // Task is denied for a second reason: a sub-agent's tool calls do not appear
  // in this session's stream, so a Bash command inside one would run unaudited.
  assert.ok(live.includes('Task'));
});

test('the host agent is refused a Discord token, and refuses to start if it has one', () => {
  // The assertion the operator asked for by name. This session has a shell and
  // sudo; it must not also be able to speak as the bot. It reports back through
  // the spool and the sandboxed agent does the talking.
  assert.throws(
    () => assertNoSecrets({ PATH: '/usr/bin', DISCORD_TOKEN: 'abc' }),
    /DISCORD_TOKEN.*looks like a credential/s,
  );
  // And not only that one name. A check that knows one name fails on the second.
  for (const name of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'DB_PASSWORD', 'MY_SECRET', 'DISCORD_WEBHOOK']) {
    assert.throws(() => assertNoSecrets({ [name]: 'x' }), /looks like a credential/, name);
  }
  // Ordinary things pass.
  assert.doesNotThrow(() => assertNoSecrets({ PATH: '/usr/bin', HOME: '/home/n', HTTPS_PROXY: 'http://p:3128' }));
  // And an operator can say "yes, I mean it" — in a file that gets reviewed.
  assert.doesNotThrow(() => assertNoSecrets({ MY_TOKEN: 'x' }, ['MY_TOKEN']));
});

test('the host agent environment is built from nothing and carries no token', () => {
  const host = makeHost({ dryRun: true, suffix: 'env' });
  const owner = resolveOwner(join(host.root, 'repo'));
  assert.equal(owner.ok, true);
  if (!owner.ok) return;

  const previous = process.env['DISCORD_TOKEN'];
  const noise = process.env['SOMETHING_UNRELATED'];
  process.env['SOMETHING_UNRELATED'] = 'should not be inherited';
  try {
    const env = hostAgentEnv(host.config, owner.owner);
    assert.equal(env['SOMETHING_UNRELATED'], undefined, 'an allowlist, not a filter');
    assert.equal(env['DISCORD_TOKEN'], undefined);
    // HOME is the checkout owner's, not root's: it is where Claude Code finds
    // the OAuth credentials it authenticates with, and it is why the unit must
    // never carry ProtectHome in any form.
    assert.equal(env['HOME'], owner.owner.home);
    assert.equal(env['USER'], owner.owner.user);
    assert.ok((env['PATH'] ?? '').includes('/usr/bin'));

    // And a token in the executor's own environment does not reach it — it
    // stops the session starting at all.
    process.env['DISCORD_TOKEN'] = 'a-very-real-looking-token-value';
    assert.doesNotThrow(() => hostAgentEnv(host.config, owner.owner));
    assert.throws(
      () => assertNoSecrets({ ...hostAgentEnv(host.config, owner.owner), DISCORD_TOKEN: 'x' }),
      /looks like a credential/,
    );
  } finally {
    if (previous === undefined) delete process.env['DISCORD_TOKEN'];
    else process.env['DISCORD_TOKEN'] = previous;
    if (noise === undefined) delete process.env['SOMETHING_UNRELATED'];
    else process.env['SOMETHING_UNRELATED'] = noise;
  }
});

test('a clean exit with is_error is a failure, not a success', () => {
  // The CLI exits 0 and reports `is_error: true` when the model's own turn ends
  // badly. Reading the exit code alone would record a failed task as a clean
  // run, which would then arm a deadline and skip the rollback.
  const base = { code: 0, signal: null, sawResult: true, resultIsError: false, resultSubtype: 'success', resultText: 'ok', stderr: '' };
  assert.equal(judge(base).ok, true);
  assert.equal(judge({ ...base, resultIsError: true }).ok, false);
  assert.equal(judge({ ...base, sawResult: false }).reason, 'no-result');
  assert.equal(judge({ ...base, code: 1 }).reason, 'exit');
  assert.equal(judge({ ...base, resultSubtype: 'error_max_budget' }).reason, 'budget');
});

test('an unnamed task scopes to every instance, and a restricted one may not file it', async () => {
  const host = makeHost({
    dryRun: false,
    suffix: 'scope',
    instances: [
      { name: 'clawcius' },
      { name: 'hamachi', extra: ['    mayRequest:', '      instances: [hamachi]'] },
    ],
  });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setStatus('hamachi', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);

  const executor = new Executor(host.config);

  // Unrestricted: an unnamed task takes BOTH instances into scope, so both are
  // snapshotted. That default is the expensive one on purpose — "which
  // containers might this sentence disturb" has no answer, and the safe reading
  // of no answer is "all of them".
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","task":"free some disk space in /var/log"}',
  });
  await settle(executor, 40_000);

  const snapshots = host
    .calls()
    .filter((call) => call[0] === 'snapshot.sh').length;
  assert.equal(snapshots, 2, 'an unnamed task snapshots every instance');

  // Restricted: the same request would widen its reach rather than narrow it,
  // so it is refused with the fix in the message.
  executor.intake({
    requester: 'hamachi',
    name: 'b.json',
    body: '{"verb":"task","task":"free some disk space in /var/log"}',
  });
  await settle(executor, 40_000);
  const rejected = journalEntries(host.config).filter((entry) => entry['kind'] === 'rejected');
  assert.ok(
    rejected.some((entry) => /naming no instance/.test(String(entry['detail']))),
    'an unnamed task from a restricted instance must be refused',
  );

  executor.stop();
});

test('a deadline is armed for whatever the audit shows the task touched', async () => {
  const host = makeHost({ dryRun: false, suffix: 'touched' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  // The task names no instance, and the command names the container. The audit
  // is what connects the two — which is the point of having one.
  host.setPlan(['echo clawcius-agent']);

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","task":"look at the container"}',
  });
  await settle(executor, 40_000);

  const pending = executor.state.pendingFor('clawcius');
  assert.ok(pending, 'a command naming a container means that instance owes a check-in');
  assert.equal(pending?.rollbackTag, 'snap-20260808-040000');
  executor.stop();
});

test('the result is reported back through the spool, not spoken by the host agent', async () => {
  const host = makeHost({ dryRun: false, suffix: 'report' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);
  host.setReport('I restarted the waker and it came back. journalctl was clean.');

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"clawcius","task":"restart the waker"}',
  });
  await settle(executor, 40_000);

  const wakeDir = join(host.root, 'state', 'clawcius', 'run', 'wake');
  const wakes = readdirSync(wakeDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(wakeDir, name), 'utf8')) as Record<string, string>);
  const report = wakes.find((wake) => /SUCCEEDED|FAILED/.test(wake['prompt'] ?? ''));
  assert.ok(report, 'the requester must be told what happened');
  assert.match(report?.['prompt'] ?? '', /I restarted the waker and it came back/);
  assert.match(report?.['prompt'] ?? '', /1 command\(s\)/);
  executor.stop();
});

test('no code path in ops/src forces past a dirty tree', () => {
  // This assertion survives the verbs and matters more than it did. The check
  // that refused a pull on a dirty tree is gone — the host agent runs git
  // itself and is told, in its standing prompt and with the filenames in its
  // briefing, never to force past one. What must remain true is that this
  // daemon has no such command of its own, so grep is the test.
  //
  // On 2026-08-09 the local edits blocking a pull on this host turned out to be
  // real fixes made by hand during an incident, and every way of "getting the
  // pull to go through" would have destroyed or hidden them.
  // Resolved from this module's own URL, not from cwd. `npm run selftest` runs
  // from `ops/`, so a `readdirSync('.')` here would scan a directory with no
  // compiled output in it and the assertion would pass by finding nothing —
  // which is the shape of a test that has quietly stopped testing anything.
  const dist = dirname(fileURLToPath(import.meta.url));
  const names = readdirSync(dist).filter(
    (name) => name.endsWith('.js') && !name.startsWith('selftest'),
  );
  assert.ok(names.length > 5, `expected the compiled sources in ${dist}, found ${names.length}`);
  const sources = names.map((name) => readFileSync(join(dist, name), 'utf8'));

  // Quoted argv ELEMENTS, not prose. The words themselves legitimately appear
  // in host-agent.ts, in the standing prompt that tells the session never to do
  // any of this — a scan for the bare word would fail on the instruction
  // forbidding the thing, which is the wrong way round. What must not exist is
  // one of these as an argument this daemon hands to git.
  //
  // `-f` is deliberately not on the list: `docker container inspect -f` uses it.
  const banned = ['reset', 'stash', 'clean', 'restore', 'checkout', '--hard', '-fd'];
  for (const [index, source] of sources.entries()) {
    for (const word of banned) {
      for (const quoted of [`'${word}'`, `"${word}"`]) {
        assert.equal(
          source.includes(quoted),
          false,
          `${quoted} must not appear as an argv element in ops/src (${names[index]})`,
        );
      }
    }
  }
});

test('the ops-status.json the page reads is valid and describes the current state', async () => {
  const host = makeHost({ dryRun: true, suffix: 'status' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"task","instance":"clawcius","task":"take a snapshot"}' });
  await settle(executor);

  const payload = JSON.parse(
    readFileSync(join(host.config.stateDir, 'ops-status.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(payload['service'], 'clawcius-ops');
  const state = payload['state'] as Record<string, unknown>;
  assert.equal(state['current'], 'idle');
  assert.equal(state['dryRun'], true);
  assert.ok(Array.isArray(payload['events']));
  executor.stop();
});

// ══════════════════════════════════════════════════════════════════════════
// Snapshot restore verification
// ══════════════════════════════════════════════════════════════════════════

test('the verifier restores the newest snapshot, probes it, and always removes it', async () => {
  const host = makeHost({ dryRun: false, suffix: 'verify' });
  const runner = new Runner(false, 20, () => {});
  const instance = host.config.instances[0];
  assert.ok(instance);

  const outcome = await verifyInstance(host.config, runner, instance);
  assert.equal(outcome.ok, true, outcome.detail);
  assert.equal(outcome.tag, 'snap-20260808-040000', 'the newest snapshot is the one tested');

  const calls = host.calls().filter((call) => call[0] === 'docker');
  const run = calls.find((call) => call[1] === 'run');
  assert.ok(run, 'a throwaway container should have been started');
  // The name is the instance's, suffixed — never the live container.
  assert.equal(run?.includes('clawcius-agent-verify'), true);
  assert.equal(run?.includes('clawcius-agent'), false, 'must not touch the live container name');
  // And it is inert: no env file, no bind mounts, no restart policy.
  assert.equal(run?.includes('--env-file'), false);
  assert.equal(run?.includes('-v'), false);
  assert.equal(run?.includes('--restart'), false);
  assert.equal(run?.includes('clawcius-agent:snap-20260808-040000'), true);

  // Started, then inspected, then probed, then removed — and removed twice,
  // because the pre-emptive cleanup runs first.
  assert.equal(
    calls.some((call) => call[1] === 'exec' && call.includes('/bin/true')),
    true,
    'running is not usable; the probe is what tells them apart',
  );
  const removals = calls.filter((call) => call[1] === 'rm' && call.includes('-f'));
  assert.equal(removals.length, 2, 'pre-emptive cleanup plus the finally');
});

test('a verify dry run says plainly that it proves nothing', async () => {
  const host = makeHost({ dryRun: true, suffix: 'verifydry' });
  const runner = new Runner(true, 20, () => {});
  const instance = host.config.instances[0];
  assert.ok(instance);

  const outcome = await verifyInstance(host.config, runner, instance);
  assert.equal(outcome.ok, true);
  assert.match(outcome.detail, /NOT evidence/);
  assert.equal(host.calls().some((call) => call[1] === 'run'), false);
});

test('an end-to-end spool drop reaches the executor and is refused correctly', async () => {
  const host = makeHost({ dryRun: true, suffix: 'e2e' });
  const executor = new Executor(host.config);
  const spool = new OpsSpool({
    dir: host.spoolDir('clawcius'),
    instance: 'clawcius',
    maxBytes: host.config.limits.maxRequestBytes,
    maxPerSweep: host.config.limits.maxPerSweep,
    maxFiles: host.config.limits.maxSpoolFiles,
    pollSeconds: 3600,
    log: () => {},
    onRequest: (raw) => executor.intake(raw),
  });

  fileRequest(host.spoolDir('clawcius'), '1-good', '{"verb":"task","task":"restart clawcius.service"}');
  fileRequest(host.spoolDir('clawcius'), '2-bad', '{"verb":"nuke","unit":"clawcius.service"}');
  fileRequest(
    host.spoolDir('clawcius'),
    '3-evil',
    '{"verb":"rollback","instance":"../../../etc"}',
  );

  spool.start();
  await settle(executor);
  spool.stop();

  const entries = journalEntries(host.config);
  assert.equal(
    entries.some(
      (entry) => entry['kind'] === 'started' && entry['what'] === 'task restart clawcius.service',
    ),
    true,
  );
  assert.equal(
    entries.some((entry) => /unknown verb "nuke"/.test(String(entry['detail']))),
    true,
  );
  assert.equal(
    entries.some((entry) => /path separator/.test(String(entry['detail']))),
    true,
  );
  // Dry run: the session was started with no ability to execute, and the
  // executor itself ran nothing that changes the machine.
  assert.equal(host.calls().some((call) => call[0] === 'run-container.sh'), false);
  executor.stop();
});

// ══════════════════════════════════════════════════════════════════════════
// Per-instance spools, provenance, and the restriction
//
// Added 2026-08-10. The bug these are about was invisible in the old suite for
// a structural reason worth stating: the fixture had ONE instance and ONE
// spool, which is precisely the world in which a shared spool looks correct.
// Every test below needs two instances to mean anything, which is why the
// fixture grew the ability to have them before any of this was written.
// ══════════════════════════════════════════════════════════════════════════

/** A host with both agents, as the real one has had since 2026-08-08. */
function twoInstances(suffix: string, extra?: Record<string, string[]>) {
  return makeHost({
    dryRun: true,
    suffix,
    instances: [
      { name: 'clawcius', extra: extra?.['clawcius'] },
      { name: 'hamachi', extra: extra?.['hamachi'] },
    ],
  });
}

test('each instance gets its own spool, defaulted inside its own bind mount', () => {
  const host = twoInstances('spools');
  const [clawcius, hamachi] = host.config.instances;

  // The property that was actually broken: Hamachi's spool is under Hamachi's
  // state directory, which is what run-container.sh mounts into Hamachi's
  // container. The old single spool was under Clawcius's, and did not exist
  // inside Hamachi's container at all.
  assert.equal(clawcius?.opsSpoolDir, join(clawcius?.stateDir ?? '', 'run', 'ops'));
  assert.equal(hamachi?.opsSpoolDir, join(hamachi?.stateDir ?? '', 'run', 'ops'));
  assert.notEqual(clawcius?.opsSpoolDir, hamachi?.opsSpoolDir);
  assert.equal(
    hamachi?.opsSpoolDir.startsWith(clawcius?.stateDir ?? ''),
    false,
    "no instance's spool may live under another instance's state directory",
  );
});

test('two spools are watched concurrently and each request is attributed to its own', async () => {
  const host = twoInstances('concurrent');
  const executor = new Executor(host.config);

  const spools = host.config.instances.map(
    (instance) =>
      new OpsSpool({
        dir: instance.opsSpoolDir,
        instance: instance.name,
        maxBytes: host.config.limits.maxRequestBytes,
        maxPerSweep: host.config.limits.maxPerSweep,
        maxFiles: host.config.limits.maxSpoolFiles,
        pollSeconds: 3600,
        log: () => {},
        onRequest: (raw) => executor.intake(raw),
      }),
  );

  // The same verb, the same target, filed into two different directories. On
  // the old shared spool these two files were indistinguishable once written.
  fileRequest(host.spoolDir('clawcius'), '1', '{"verb":"task","instance":"hamachi","task":"take a snapshot"}');
  fileRequest(host.spoolDir('hamachi'), '2', '{"verb":"task","instance":"hamachi","task":"take a snapshot"}');

  for (const spool of spools) spool.start();
  await settle(executor);
  for (const spool of spools) spool.stop();

  const started = journalEntries(host.config).filter((entry) => entry['kind'] === 'started');
  assert.equal(started.length, 2);
  assert.deepEqual(
    started.map((entry) => entry['requester']).sort(),
    ['clawcius', 'hamachi'],
    'both spools were drained, and each request carries the name of the one it came from',
  );
  // Both name the same target; only the requester tells them apart. That is
  // the whole change in one assertion.
  assert.deepEqual(started.map((entry) => entry['instance']), ['hamachi', 'hamachi']);
  executor.stop();
});

test('a request in instance A\'s spool is attributed to A, whatever the file claims', async () => {
  const host = twoInstances('forgery');
  const executor = new Executor(host.config);

  const spool = new OpsSpool({
    dir: host.spoolDir('hamachi'),
    instance: 'hamachi',
    maxBytes: host.config.limits.maxRequestBytes,
    maxPerSweep: host.config.limits.maxPerSweep,
    maxFiles: host.config.limits.maxSpoolFiles,
    pollSeconds: 3600,
    log: () => {},
    onRequest: (raw) => executor.intake(raw),
  });

  // The obvious attack on any provenance scheme: say you are someone else.
  fileRequest(
    host.spoolDir('hamachi'),
    '1',
    '{"verb":"task","instance":"hamachi","task":"look at the disk","requester":"clawcius","from":"clawcius"}',
  );

  spool.start();
  await settle(executor);
  spool.stop();

  const entries = journalEntries(host.config);
  assert.equal(
    entries.every((entry) => entry['requester'] === undefined || entry['requester'] === 'hamachi'),
    true,
    'the spool directory decides, not the file',
  );
  // And the attempt is visible rather than merely ineffective: `requester` is
  // not a known field, so it is reported as ignored.
  assert.equal(
    entries.some((entry) => /ignoring unknown field\(s\): requester, from/.test(String(entry['detail']))),
    true,
  );
  executor.stop();
});

test('provenance distinguishes an instance acting on itself from one acting on its neighbour', async () => {
  const host = twoInstances('neighbour');
  // Both idle: a task always waits for an idle turn on everything in scope,
  // which was not true of the old `snapshot` verb this test used to use.
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setStatus('hamachi', { at: Date.now(), liveCount: 0 });
  const executor = new Executor(host.config);

  executor.intake({
    requester: 'hamachi',
    name: 'a.json',
    body: '{"verb":"task","instance":"hamachi","task":"take a snapshot"}',
  });
  await settle(executor);
  executor.intake({
    requester: 'hamachi',
    name: 'b.json',
    body: '{"verb":"task","instance":"clawcius","task":"take a snapshot"}',
  });
  await settle(executor);

  const finished = journalEntries(host.config)
    .filter((entry) => entry['kind'] === 'finished' && /^task /.test(String(entry['what'])));
  assert.deepEqual(
    finished.map((entry) => `${String(entry['requester'])} -> ${String(entry['instance'])}`),
    ['hamachi -> hamachi', 'hamachi -> clawcius'],
    'these two lines were byte-identical before per-instance spools existed',
  );
  executor.stop();
});

test('the executor attributes its own automatic rollback to itself, not to the instance', async () => {
  const host = makeHost({ dryRun: false, suffix: 'selfattrib' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"task","instance":"clawcius","task":"recreate the container"}',
  });
  await settle(executor);

  const pending = executor.state.pendingFor('clawcius');
  assert.ok(pending);
  executor.state.arm({ ...pending, deadlineAt: Date.now() - 1000 });
  executor.restoreDeadlines();
  await settle(executor);

  const missed = journalEntries(host.config).filter((entry) => entry['kind'] === 'deadline-missed');
  assert.ok(missed.length > 0);
  assert.equal(
    missed.every((entry) => entry['requester'] === '(executor)'),
    true,
    'a rollback nobody asked for must not be attributed to the instance it happens to',
  );
  executor.stop();
});

test('a per-instance restriction refuses an out-of-scope request and names why', async () => {
  const host = twoInstances('scope', {
    // Hamachi may look after itself and nothing else. Clawcius is left
    // unrestricted, which is the default and the pre-existing behaviour.
    hamachi: ['    mayRequest:', '      instances: [hamachi]', '      units: [clawcius.service]'],
  });

  assert.equal(host.config.instances[0]?.mayRequest, null, 'absent means unrestricted');
  assert.deepEqual(host.config.instances[1]?.mayRequest?.instances, ['hamachi']);
  // A key left out of a present mayRequest is still unrestricted.
  assert.equal(host.config.instances[1]?.mayRequest?.repos, null);

  const executor = new Executor(host.config);

  // In scope: its own container.
  executor.intake({
    requester: 'hamachi',
    name: 'a.json',
    body: '{"verb":"task","instance":"hamachi","task":"take a snapshot"}',
  });
  await settle(executor);

  // Out of scope: the neighbour's.
  executor.intake({
    requester: 'hamachi',
    name: 'b.json',
    body: '{"verb":"task","instance":"clawcius","task":"take a snapshot"}',
  });
  await settle(executor);

  // And the same request from the unrestricted instance still goes through,
  // which is what makes this a per-instance rule rather than an allowlist gap.
  executor.intake({
    requester: 'clawcius',
    name: 'c.json',
    body: '{"verb":"task","instance":"clawcius","task":"take a snapshot"}',
  });
  await settle(executor);

  const entries = journalEntries(host.config);
  const rejected = entries.filter((entry) => entry['kind'] === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.['requester'], 'hamachi');
  assert.match(String(rejected[0]?.['detail']), /out of scope/);
  assert.match(String(rejected[0]?.['detail']), /may not name instance "clawcius"/);

  const started = entries.filter((entry) => entry['kind'] === 'started');
  assert.deepEqual(
    started.map((entry) => `${String(entry['requester'])} -> ${String(entry['instance'])}`),
    ['hamachi -> hamachi', 'clawcius -> clawcius'],
    'the in-scope request and the unrestricted instance both ran',
  );
  executor.stop();
});

test('an out-of-scope request does not consume the hourly budget', async () => {
  const host = twoInstances('scoperate', {
    hamachi: ['    mayRequest:', '      verbs: [checkin]'],
  });
  const executor = new Executor(host.config);

  // maxPerHour is 6 in the fixture. Ten refused requests must not exhaust it.
  for (let i = 0; i < 10; i += 1) {
    executor.intake({
      requester: 'hamachi',
      name: `r${i}.json`,
      body: '{"verb":"task","instance":"hamachi","task":"take a snapshot"}',
    });
  }
  await settle(executor);

  executor.intake({
    requester: 'clawcius',
    name: 'ok.json',
    body: '{"verb":"task","instance":"clawcius","task":"take a snapshot"}',
  });
  await settle(executor);

  const entries = journalEntries(host.config);
  assert.equal(
    entries.some((entry) => /rate limit/.test(String(entry['detail']))),
    false,
    'refusals are free; an agent looping on requests it may not make must not starve the other',
  );
  assert.equal(
    entries.some((entry) => entry['kind'] === 'started' && entry['requester'] === 'clawcius'),
    true,
  );
  executor.stop();
});

test('a restricted instance may not wake its neighbour, which routes by channel', async () => {
  const host = twoInstances('scopewake', {
    hamachi: ['    mayRequest:', '      instances: [hamachi]'],
  });
  const executor = new Executor(host.config);

  // Clawcius's channel, from Hamachi's spool. The target is not a field on the
  // request — it is discovered by routing — so this is refused in #doWake
  // rather than at intake.
  executor.intake({
    requester: 'hamachi',
    name: 'a.json',
    body: '{"verb":"wake","channel":"123456789012345678","detail":"hello neighbour"}',
  });
  await settle(executor);

  const rejected = journalEntries(host.config).filter((entry) => entry['kind'] === 'rejected');
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]?.['detail']), /may not wake clawcius/);
  assert.equal(
    readdirSync(join(host.root, 'state', 'clawcius', 'run', 'wake')).filter((n) =>
      n.endsWith('.json'),
    ).length,
    0,
    'no wake file was written into the neighbour\'s spool',
  );
  executor.stop();
});

test('a mayRequest naming something that does not exist fails the boot', () => {
  const bad = (lines: string[]) =>
    writeConfig([
      'stateDir: /var/lib/ops-state',
      'units:',
      '  - name: clawcius.service',
      ...MINIMAL_INSTANCE('/var/lib/x'),
      ...lines,
    ]);

  // Each of these would otherwise be a silent, total denial: the operator
  // believes they granted something and every request is refused with a
  // message that reads like a problem somewhere else.
  assert.throws(
    () => loadOpsConfig(bad(['    mayRequest:', '      units: [sshd.service]'])),
    /mayRequest\.units .*names no entry under units/,
  );
  assert.throws(
    () => loadOpsConfig(bad(['    mayRequest:', '      instances: [nope]'])),
    /mayRequest\.instances .*names no entry under instances/,
  );
  assert.throws(
    () => loadOpsConfig(bad(['    mayRequest:', '      verbs: [rm-rf]'])),
    /mayRequest\.verbs .*is not a verb/,
  );
});

// ── Containment, across several spools ────────────────────────────────────

test('two instances may not share a spool', () => {
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    ...MINIMAL_INSTANCE('/var/lib/x'),
    '    opsSpoolDir: /var/lib/shared/ops',
    '  - name: hamachi',
    '    container: hamachi-agent',
    '    image: hamachi-agent:latest',
    '    stateDir: /var/lib/y',
    '    envFile: /var/lib/y/env',
    '    wakerStatusFile: /var/lib/y/waker-status.json',
    '    wakeSpoolDir: /var/lib/y/run/wake',
    '    wakeChannelId: "223456789012345678"',
    '    opsSpoolDir: /var/lib/shared/ops',
  ]);
  assert.throws(() => loadOpsConfig(path), /share opsSpoolDir/);
});

test('one instance\'s spool may not be nested inside another\'s', () => {
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    ...MINIMAL_INSTANCE('/var/lib/x'),
    '    opsSpoolDir: /var/lib/x/run/ops',
    '  - name: hamachi',
    '    container: hamachi-agent',
    '    image: hamachi-agent:latest',
    '    stateDir: /var/lib/y',
    '    envFile: /var/lib/y/env',
    '    wakerStatusFile: /var/lib/y/waker-status.json',
    '    wakeSpoolDir: /var/lib/y/run/wake',
    '    wakeChannelId: "223456789012345678"',
    // Inside Clawcius's spool: Clawcius could write files that arrive
    // attributed to Hamachi.
    '    opsSpoolDir: /var/lib/x/run/ops/hamachi',
  ]);
  assert.throws(() => loadOpsConfig(path), /is inside instances\[clawcius\]\.opsSpoolDir/);
});

test('a waker status file inside ANY instance\'s ops spool is refused', () => {
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    'instances:',
    '  - name: clawcius',
    '    container: clawcius-agent',
    '    image: clawcius-agent:latest',
    '    stateDir: /var/lib/x',
    '    envFile: /var/lib/x/env',
    // Hamachi's spool. Clawcius could declare Clawcius idle by writing it.
    '    wakerStatusFile: /var/lib/y/run/ops/waker-status.json',
    '    wakeSpoolDir: /var/lib/x/run/wake',
    '    wakeChannelId: "123456789012345678"',
    '  - name: hamachi',
    '    container: hamachi-agent',
    '    image: hamachi-agent:latest',
    '    stateDir: /var/lib/y',
    '    envFile: /var/lib/y/env',
    '    wakerStatusFile: /var/lib/y/waker-status.json',
    '    wakeSpoolDir: /var/lib/y/run/wake',
    '    wakeChannelId: "223456789012345678"',
  ]);
  assert.throws(() => loadOpsConfig(path), /wakerStatusFile is inside instances\[hamachi\]\.opsSpoolDir/);
});

test('an ops spool that would swallow a wake spool is refused', () => {
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    ...MINIMAL_INSTANCE('/var/lib/x'),
    // /var/lib/x/state/run contains the wake spool at .../run/wake. The ops
    // spool unlinks every file it sweeps before parsing it, so this would eat
    // the waker's queue silently.
    '    opsSpoolDir: /var/lib/x/state/run',
  ]);
  assert.throws(() => loadOpsConfig(path), /would silently eat wakes/);
});

test('the state directory may not be inside any of several spools', () => {
  const base = (stateDir: string) =>
    writeConfig([
      `stateDir: ${stateDir}`,
      ...MINIMAL_INSTANCE('/var/lib/x'),
      '  - name: hamachi',
      '    container: hamachi-agent',
      '    image: hamachi-agent:latest',
      '    stateDir: /var/lib/y',
      '    envFile: /var/lib/y/env',
      '    wakerStatusFile: /var/lib/y/waker-status.json',
      '    wakeSpoolDir: /var/lib/y/run/wake',
      '    wakeChannelId: "223456789012345678"',
    ]);

  // Inside the SECOND instance's spool. A check written against one spool
  // passes this and is wrong.
  assert.throws(
    () => loadOpsConfig(base('/var/lib/y/run/ops/state')),
    /stateDir .* is inside instances\[hamachi\]\.opsSpoolDir/,
  );
  assert.throws(
    () => loadOpsConfig(base('/var/lib/x/state/run/ops/state')),
    /stateDir .* is inside instances\[clawcius\]\.opsSpoolDir/,
  );
  // And a state directory outside both is fine.
  assert.equal(loadOpsConfig(base('/var/lib/ops-state')).stateDir, '/var/lib/ops-state');
});

// ── Migration off the old single spoolDir ─────────────────────────────────

test('the deprecated spoolDir is accepted as an alias for the instance that owns it', () => {
  // Exactly the shape of the config running on the host on 2026-08-10.
  const path = writeConfig([
    'stateDir: /var/lib/clawcius-ops',
    'spoolDir: /var/lib/clawcius/run/ops',
    'instances:',
    '  - name: clawcius',
    '    container: clawcius-agent',
    '    image: clawcius-agent:latest',
    '    stateDir: /var/lib/clawcius',
    '    envFile: /var/lib/clawcius/env',
    '    wakerStatusFile: /var/lib/clawcius/waker-status.json',
    '    wakeSpoolDir: /var/lib/clawcius/run/wake',
    '    wakeChannelId: "123456789012345678"',
    '  - name: hamachi',
    '    container: hamachi-agent',
    '    image: hamachi-agent:latest',
    '    stateDir: /var/lib/hamachi',
    '    envFile: /var/lib/hamachi/env',
    '    wakerStatusFile: /var/lib/hamachi/waker-status.json',
    '    wakeSpoolDir: /var/lib/hamachi/run/wake',
    '    wakeChannelId: "223456789012345678"',
  ]);

  const config = loadOpsConfig(path);
  // Clawcius keeps watching exactly what it watched before the upgrade…
  assert.equal(config.instances[0]?.opsSpoolDir, '/var/lib/clawcius/run/ops');
  // …and Hamachi finally has one, inside the mount it has always had.
  assert.equal(config.instances[1]?.opsSpoolDir, '/var/lib/hamachi/run/ops');
  // Loud, and durable: the notice goes into the boot journal, not just stdout.
  assert.equal(config.deprecations.length, 1);
  assert.match(config.deprecations[0] ?? '', /DEPRECATED/);
  assert.match(config.deprecations[0] ?? '', /attributed to instance "clawcius"/);
});

test('a spoolDir belonging to nobody fails the boot with the lines to write', () => {
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    // Inside no instance's stateDir, so it cannot be attributed — and an
    // unattributable spool is the exact thing this release abolishes.
    'spoolDir: /var/lib/somewhere-else/ops',
    ...MINIMAL_INSTANCE('/var/lib/x'),
  ]);
  assert.throws(() => loadOpsConfig(path), /cannot be attributed to any configured instance/);
  assert.throws(() => loadOpsConfig(path), /opsSpoolDir: \/var\/lib\/x\/state\/run\/ops/);
});

test('spoolDir and opsSpoolDir disagreeing fails rather than picking one', () => {
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    'spoolDir: /var/lib/x/state/run/ops',
    ...MINIMAL_INSTANCE('/var/lib/x'),
    '    opsSpoolDir: /var/lib/x/other/ops',
  ]);
  assert.throws(() => loadOpsConfig(path), /name different directories/);
});

test('the check-in instructions point the instance at its OWN spool', async () => {
  const host = twoInstances('checkinpath');
  const liveHost = makeHost({
    dryRun: false,
    suffix: 'checkinpath-live',
    instances: [{ name: 'clawcius' }, { name: 'hamachi' }],
  });
  liveHost.setStatus('hamachi', { at: Date.now(), liveCount: 0 });
  liveHost.setPlan(['true']);

  const executor = new Executor(liveHost.config);
  executor.intake({
    requester: 'hamachi',
    name: 'a.json',
    body: '{"verb":"task","instance":"hamachi","task":"recreate the container"}',
  });
  await settle(executor, 40_000);

  // Two wakes now, and both go to hamachi's own spool: the report of what the
  // task did, and the "you owe a check-in" that arms the deadline. It is the
  // second one whose instructions have to be right.
  const wakeDir = join(liveHost.root, 'state', 'hamachi', 'run', 'wake');
  const files = readdirSync(wakeDir).filter((n) => n.endsWith('.json'));
  const wakes = files.map(
    (name) => JSON.parse(readFileSync(join(wakeDir, name), 'utf8')) as Record<string, string>,
  );
  const wake = wakes.find((entry) => /check in/i.test(entry['prompt'] ?? '')) ?? {};
  // The one instruction sent to an agent that has just been rebuilt, at the
  // moment it most needs to answer. Pointing it at the other instance's spool
  // is how a working rebuild becomes a rolled-back one.
  assert.match(wake['prompt'] ?? '', new RegExp(liveHost.spoolDir('hamachi')));
  assert.equal(
    (wake['prompt'] ?? '').includes(liveHost.spoolDir('clawcius')),
    false,
  );
  assert.ok(host.config.instances.length === 2);
  executor.stop();
});
