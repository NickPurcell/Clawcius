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
 *     read-only probes still execute;
 *   - the breaker across a process boundary: quarantine and freeze are written
 *     to disk and re-read by a fresh StateStore;
 *   - deadline expiry driving an automatic rollback, the quarantine that
 *     follows it, and the freeze once the consecutive-failure ceiling is hit.
 *
 * The stand-in `docker`, `git`, `systemctl` and the two scripts are shell
 * scripts written into a temp directory. They are enough to prove the argv the
 * executor builds is the argv that arrives — which, given that "never build a
 * shell string" is the central claim, is the thing most worth proving.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOpsConfig, type OpsConfig } from './config.js';
import { parseRequest, describeRequest, isDestructive, VERBS } from './request.js';
import { OpsSpool, ensureSpoolDir } from './spool.js';
import { readIdle } from './idle.js';
import { Runner, render } from './runner.js';
import { StateStore } from './state.js';
import { Executor } from './executor.js';
import { verifyInstance } from './verify.js';
import { planBuild, resolveOwner, runBuild } from './build.js';

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
  /** Make the npm stand-in exit non-zero for one subcommand (`ci` or `build`). */
  failBuild: (which: string) => void;
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
  mkdirSync(join(root, 'tools'), { recursive: true });
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

  const systemctl = recorder('systemctl', '');
  const runContainer = recorder('run-container.sh', '');
  const snapshot = recorder('snapshot.sh', '');

  /**
   * The npm stand-in, which records more than the others.
   *
   * `cwd=` and `uid=` go into the call file because the two properties this
   * suite has to prove about the build are *where* it ran and *as whom*, and
   * neither is visible in the argv. The uid is the real one — the tests do not
   * run as root, so nothing is actually dropped here; what is asserted about
   * dropping is asserted against planBuild(), which is pure.
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
      'units:',
      '  - name: clawcius.service',
      '    description: the waker',
      // A second unit and a second repo, so that "allowed for one instance,
      // refused for another" is expressible. With one of each, every refusal
      // in a mayRequest test would also be refused by the global allowlist,
      // and the test could not tell which rule had fired.
      '  - name: hamachi.service',
      '    description: the second waker',
      'repos:',
      '  - name: clawcius',
      `    path: ${join(root, 'repo')}`,
      '    branch: main',
      `    buildDirs: [${(options.buildDirs ?? ['.']).map((d) => JSON.stringify(d)).join(', ')}]`,
      '  - name: tools',
      `    path: ${join(root, 'tools')}`,
      '    branch: main',
      '    buildDirs: []',
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
        .map((name) =>
          readFileSync(join(callsDir, name), 'utf8')
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
    failBuild: (which) => {
      writeFileSync(join(control, 'npm-fail'), `${which}\n`);
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

test('every verb in the closed list parses when well formed', () => {
  const bodies: Record<string, unknown> = {
    restart: { verb: 'restart', unit: 'clawcius.service' },
    pull: { verb: 'pull', repo: 'clawcius' },
    redeploy: { verb: 'redeploy', instance: 'hamachi', reason: 'new build' },
    snapshot: { verb: 'snapshot', instance: 'hamachi' },
    rollback: { verb: 'rollback', instance: 'hamachi', tag: 'snap-20260808-040000' },
    checkin: { verb: 'checkin', instance: 'hamachi', detail: 'all good' },
    wake: { verb: 'wake', channel: '123456789012345678', detail: 'do the thing' },
  };
  for (const verb of VERBS) {
    const result = parseRequest(JSON.stringify(bodies[verb]));
    assert.equal(result.ok, true, `${verb} should parse: ${JSON.stringify(result)}`);
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
    const result = parseRequest(JSON.stringify({ verb: 'redeploy', instance }));
    assert.equal(result.ok, false, `"${instance}" must be rejected`);
    if (!result.ok) {
      assert.match(result.reason, /traversal|path separator|does not match/);
    }
  }
});

test('NUL and control bytes in an identifier are rejected', () => {
  const withNul = `{"verb":"redeploy","instance":"clawcius\\u0000extra"}`;
  const nul = parseRequest(withNul);
  assert.equal(nul.ok, false);
  if (!nul.ok) assert.match(nul.reason, /NUL byte/);

  // No separator in this one, so it exercises the control-character branch
  // rather than being caught earlier by the path check.
  const withControl = `{"verb":"redeploy","instance":"clawcius\\u0007bell"}`;
  const control = parseRequest(withControl);
  assert.equal(control.ok, false);
  if (!control.ok) assert.match(control.reason, /control character/);

  const withNewline = `{"verb":"redeploy","instance":"clawcius\\nrm -rf /"}`;
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
    const result = parseRequest(JSON.stringify({ verb: 'redeploy', instance }));
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
    const body = JSON.stringify({ verb: 'redeploy', instance });
    const result = parseRequest(body);
    assert.equal(result.ok, false, `${body} must be rejected`);
  }
});

test('a missing required field is a rejection, not a default', () => {
  assert.equal(parseRequest('{"verb":"restart"}').ok, false);
  assert.equal(parseRequest('{"verb":"pull"}').ok, false);
  assert.equal(parseRequest('{"verb":"redeploy"}').ok, false);
  assert.equal(parseRequest('{"verb":"wake","channel":"123456789012345678"}').ok, false);
});

test('unknown fields are reported and never acted on', () => {
  const result = parseRequest(
    JSON.stringify({
      verb: 'restart',
      unit: 'clawcius.service',
      args: ['--force'],
      env: { LD_PRELOAD: '/tmp/x.so' },
      command: 'rm -rf /',
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.request.unknownFields.sort(), ['args', 'command', 'env']);
    // And none of them appear anywhere in the parsed request.
    assert.equal(JSON.stringify(result.request).includes('LD_PRELOAD'), false);
  }
});

test('free text is kept but stripped of control characters and capped', () => {
  const result = parseRequest(
    JSON.stringify({
      verb: 'redeploy',
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

test('destructive verbs are exactly redeploy and rollback', () => {
  assert.equal(isDestructive('redeploy'), true);
  assert.equal(isDestructive('rollback'), true);
  assert.equal(isDestructive('restart'), false);
  assert.equal(isDestructive('pull'), false);
  assert.equal(isDestructive('snapshot'), false);
  assert.equal(isDestructive('checkin'), false);
  assert.equal(isDestructive('wake'), false);
});

test('describeRequest never returns an empty target', () => {
  const result = parseRequest(JSON.stringify({ verb: 'snapshot', instance: 'clawcius' }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(describeRequest(result.request), 'snapshot clawcius');
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
// The spool DIRECTORY, as opposed to the files in it
//
// Added 2026-08-11, after review of PR #8 found that `ensureSpoolDir()` was an
// arbitrary-path root chown. The whole section exists because of one fact that
// is easy to forget while reading this file: the spool's PARENT
// (`<stateDir>/run`) is bind-mounted read-write into the container and is
// owned by the agent. The agent cannot forge a request, but it can absolutely
// delete the directory those requests arrive in and put something else there.
//
// So every one of these tests is about a root process meeting a path that the
// least trusted party on the machine controls the name of. None of them needs
// root to run: what is asserted is what was created, what was refused, and —
// most importantly — what was left alone.
// ══════════════════════════════════════════════════════════════════════════

test('a symlink where the spool should be is refused, not chowned and not swept', () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-spool-symlink-'));
  const stateDir = join(root, 'state');
  mkdirSync(join(stateDir, 'run'), { recursive: true });
  const spool = join(stateDir, 'run', 'ops');

  // Whatever the agent points the link at. On the host the interesting choices
  // are /etc, /root/.ssh, the checkout — or /var/lib/clawcius-ops, the
  // executor's own state directory, whose unreachability is the only reason
  // the circuit breaker cannot be edited by the instance it has quarantined.
  const victim = join(root, 'victim');
  mkdirSync(victim);
  const loot = join(victim, 'important.json');
  writeFileSync(loot, '{"verb":"snapshot","instance":"clawcius"}');
  symlinkSync(victim, spool);

  const logs: string[] = [];
  const usable = ensureSpoolDir(spool, stateDir, (line) => logs.push(line));

  assert.equal(usable, false, 'a symlink is not a spool that needs repairing');
  assert.match(logs.join('\n'), /REFUSING/);
  assert.match(logs.join('\n'), /symlink/);
  // Untouched in both directions. The link is still a link — deleting it as
  // root inside a directory the agent owns is another primitive, and the agent
  // can remove it itself — and the target still has everything it had.
  assert.equal(lstatSync(spool).isSymbolicLink(), true, 'not deleted, just refused');
  assert.equal(existsSync(loot), true);

  // And the sweeper has to agree, which is the half that matters most:
  // `drain()` does `readdir` and, critically, `unlink` as root. A followed
  // symlink there deletes every file behind it that ends in `.json` — and
  // feeds their contents to the request parser on the way out.
  const seen: string[] = [];
  const watcher = new OpsSpool({
    dir: spool,
    instance: 'clawcius',
    ownerOf: stateDir,
    maxBytes: 4096,
    maxPerSweep: 3,
    maxFiles: 5,
    pollSeconds: 3600,
    log: (line) => logs.push(line),
    onRequest: (raw) => seen.push(raw.name),
  });
  watcher.start();
  watcher.drain();
  watcher.stop();

  assert.deepEqual(seen, [], 'nothing behind the link may be read as a request');
  assert.equal(existsSync(loot), true, 'and nothing behind it may be unlinked');
});

test('a file or a symlink where the spool should be is never followed or read through', () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-spool-notdir-'));
  const stateDir = join(root, 'state');
  mkdirSync(join(stateDir, 'run'), { recursive: true });
  const spool = join(stateDir, 'run', 'ops');
  // Not a symlink this time, just not a directory. Same refusal: the executor
  // does not remove it and does not try to turn it into one.
  writeFileSync(spool, 'not a directory');

  const logs: string[] = [];
  assert.equal(ensureSpoolDir(spool, stateDir, (line) => logs.push(line)), false);
  assert.match(logs.join('\n'), /not a directory/);
  assert.equal(readFileSync(spool, 'utf8'), 'not a directory');

  // A symlinked FILE inside a real spool is the same argument one level down:
  // the executor would otherwise read a host file as a request, report its
  // contents as malformed JSON in the journal, and unlink the link.
  const real = mkdtempSync(join(tmpdir(), 'ops-spool-links-'));
  const secret = join(real, 'secret.txt');
  writeFileSync(secret, 'not for the journal');
  symlinkSync(secret, join(real, 'a.json'));

  const seen: string[] = [];
  const spoolObj = new OpsSpool({
    dir: real,
    instance: 'clawcius',
    maxBytes: 4096,
    maxPerSweep: 3,
    maxFiles: 5,
    pollSeconds: 3600,
    log: (line) => logs.push(line),
    onRequest: (raw) => seen.push(raw.body),
  });
  spoolObj.start();
  spoolObj.drain();
  spoolObj.stop();

  assert.deepEqual(seen, [], 'a symlink is not a regular file');
  assert.equal(readFileSync(secret, 'utf8'), 'not for the journal', 'the target is untouched');
});

test('a FIFO named like a request cannot park the sweep, and with it every deadline', () => {
  // Added 2026-08-11, second review of PR #8: the test above is named for a
  // FIFO and never made one, so the `O_NONBLOCK` that the whole no-hang claim
  // rests on was unexercised. Deleting the flag left the suite green.
  //
  // The threat is small to write and large to suffer. The agent owns the spool
  // directory, so it can `mkfifo 1.json`. A synchronous `open(O_RDONLY)` on a
  // FIFO with no writer blocks until one appears — forever, if the agent never
  // opens the other end. `O_NOFOLLOW` does not help (a FIFO is not a symlink)
  // and the `fstat().isFile()` guard runs only after `open` has returned, so
  // `O_NONBLOCK` is the only thing between here and a wedged daemon — and this
  // daemon is the one holding every armed rollback deadline, so a hang here is
  // an outage that cannot be rolled back.
  //
  // Which is also why this runs in a CHILD process. A hang cannot be asserted
  // about from inside the thread that is hung: `openSync` is synchronous, no
  // timer would ever run, and the test would take the whole suite down with it
  // instead of failing. The child gets a deadline; missing it is the failure.
  const dir = mkdtempSync(join(tmpdir(), 'ops-spool-fifo-'));
  const fifo = join(dir, '1.json');
  execFileSync('mkfifo', [fifo]);
  assert.equal(lstatSync(fifo).isFIFO(), true, 'the fixture must really be a FIFO');

  // Sorted after the FIFO, so it is only reached if the FIFO did not stop the
  // sweep. A sweep that hangs never gets here even if the process is killed.
  fileRequest(dir, '2', '{"verb":"snapshot","instance":"clawcius"}');

  // Beside the spool, not in it: everything in the spool is evidence.
  const script = join(mkdtempSync(join(tmpdir(), 'ops-spool-fifo-runner-')), 'drain.mjs');
  writeFileSync(
    script,
    [
      `import { OpsSpool } from ${JSON.stringify(new URL('./spool.js', import.meta.url).href)};`,
      'const seen = [];',
      'const logs = [];',
      'const spool = new OpsSpool({',
      '  dir: process.argv[2], instance: "clawcius", maxBytes: 4096, maxPerSweep: 10,',
      '  maxFiles: 50, pollSeconds: 3600,',
      '  log: (line) => logs.push(line), onRequest: (raw) => seen.push(raw.name),',
      '});',
      'spool.drain();',
      'process.stdout.write(JSON.stringify({ seen, logs }));',
    ].join('\n'),
  );

  let output: string;
  try {
    output = execFileSync(process.execPath, [script, dir], {
      encoding: 'utf8',
      timeout: 15_000,
      // The child is blocked inside a syscall if this regresses; do not
      // negotiate with it.
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    assert.fail(
      'the sweep did not finish with a FIFO in the spool — the request files are opened ' +
        'O_RDONLY | O_NOFOLLOW | O_NONBLOCK, and without O_NONBLOCK this open blocks until ' +
        `a writer appears, hanging the daemon that holds every rollback deadline: ${String(error)}`,
    );
  }

  const result = JSON.parse(output) as { seen: string[]; logs: string[] };
  assert.deepEqual(result.seen, ['2.json'], 'a FIFO is not a request, and it did not stop the one behind it');
  assert.match(result.logs.join('\n'), /1\.json: not a regular file/);
  assert.equal(existsSync(fifo), false, 'and it is discarded rather than left to be met again');
});

test('a fresh host gets a spool the container can actually write, ancestors included', () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-spool-fresh-'));
  // The state directory exists — systemd's StateDirectory= or the instance
  // unit's first start made it — but nothing under it does, because no
  // container has ever run. This is the case ensureSpoolDir exists for, and
  // the case it got wrong until 2026-08-11: it created `run/` and `run/ops`
  // as root and chowned neither, so the container could not traverse to its
  // own spool and its requests silently never arrived.
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  const spool = join(stateDir, 'run', 'ops');

  const logs: string[] = [];
  assert.equal(ensureSpoolDir(spool, stateDir, (line) => logs.push(line)), true);

  const reference = statSync(stateDir);
  for (const dir of [join(stateDir, 'run'), spool]) {
    const stat = statSync(dir);
    assert.equal(stat.isDirectory(), true, `${dir} must exist`);
    assert.equal(stat.uid, reference.uid, `${dir} must be owned like the state directory`);
    assert.equal(stat.gid, reference.gid, `${dir} — the intermediate one matters too`);
    // 0770 applied with fchmod, not left to mkdir's mode argument: that one is
    // masked by the umask, and 0770 & ~022 is 0750, which is a spool the
    // container's group cannot write. The symptom is an agent whose requests
    // vanish, which is the failure this function exists to prevent.
    assert.equal(stat.mode & 0o777, 0o770, `${dir} must be group-writable`);
  }
});

test('an already-existing spool with the wrong owner is swept, but never silently', () => {
  // Added 2026-08-11, second review of PR #8. The warning below existed and
  // the daemon could not reach it: `#ready()` only called `ensureSpoolDir` when
  // the directory was MISSING, so a spool that already existed with the wrong
  // owner was watched, swept and never mentioned. The container gets EACCES on
  // every `mv`, its requests never arrive, and the journal says nothing —
  // which is the failure mode this whole PR is about.
  //
  // It is a state the host reaches without an adversary: `run-container.sh`'s
  // `mkdir -p "$OPS_DIR"` assumes it runs as `npurcell`, and the executor
  // invokes that script itself, as root, on a `--recreate`.
  //
  // Arranging a wrongly-owned directory without root is the awkward part. A
  // test that is not root cannot chown anything to anyone, so the mismatch is
  // made from whichever side this process can reach: as root, by chowning the
  // spool away; otherwise by pointing `ownerOf` at a directory this user does
  // not own. Either way the property under test is the same one — the spool's
  // uid/gid differ from the state directory's, and the daemon must say so.
  const root = mkdtempSync(join(tmpdir(), 'ops-spool-badowner-'));
  const stateDir = join(root, 'state');
  const spool = join(stateDir, 'run', 'ops');
  mkdirSync(spool, { recursive: true, mode: 0o770 });

  let ownerOf = stateDir;
  if ((process.getuid?.() ?? 0) === 0) {
    chownSync(spool, 65534, 65534);
  } else {
    // Owned by root on every host there is, and this process is not root.
    ownerOf = '/';
    assert.notEqual(lstatSync(ownerOf).uid, lstatSync(spool).uid, 'the fixture needs a mismatch');
  }
  const want = lstatSync(ownerOf);

  const logs: string[] = [];
  const seen: string[] = [];
  const spoolObj = new OpsSpool({
    dir: spool,
    instance: 'clawcius',
    ownerOf,
    maxBytes: 4096,
    maxPerSweep: 3,
    maxFiles: 5,
    pollSeconds: 3600,
    log: (line) => logs.push(line),
    onRequest: (raw) => seen.push(raw.name),
  });

  // Everything the daemon would do in three sweeps, then the assertions —
  // with `stop()` guaranteed, because `start()` attaches an fs.watch and a
  // failed assertion between the two would leave the test runner holding an
  // open handle and hanging forever instead of reporting.
  try {
    spoolObj.start();
    // Still swept — a real directory is safe to read, and the operator may
    // have fixed the mode without the owner. Refusing here would turn a
    // warning into an outage.
    fileRequest(spool, '1', '{"verb":"snapshot","instance":"clawcius"}');
    spoolObj.drain();
    // And the complaint is made once, not once per five-second sweep, or the
    // incident buries itself in its own alarm.
    spoolObj.drain();
    spoolObj.drain();
  } finally {
    spoolObj.stop();
  }

  const warning = logs.filter((line) => /WARNING/.test(line));
  assert.equal(warning.length, 1, 'a locked-out agent must produce a journal line, not silence');
  assert.match(String(warning[0]), /probably cannot write its own spool/);
  // The exact command to run, because "ownership is wrong" without it is a
  // puzzle at 3am.
  assert.equal(
    String(warning[0]).includes(`chown ${want.uid}:${want.gid} ${spool} && chmod 0770 ${spool}`),
    true,
    'the warning has to carry the exact command',
  );

  // Not repaired: the directory above it is writable by the container, and
  // chowning a path we did not create is how a symlink becomes a root chown.
  const after = lstatSync(spool);
  assert.equal(after.uid !== want.uid || after.gid !== want.gid, true, 'reported, not repaired');

  assert.deepEqual(seen, ['1.json'], 'a warning is not a refusal; the requests still arrive here');
});

test('with no state directory to copy ownership from, nothing is created as root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-spool-noowner-'));
  const stateDir = join(root, 'state');
  const spool = join(stateDir, 'run', 'ops');

  const logs: string[] = [];
  const seen: string[] = [];
  const spoolObj = new OpsSpool({
    dir: spool,
    instance: 'clawcius',
    ownerOf: stateDir,
    maxBytes: 4096,
    maxPerSweep: 3,
    maxFiles: 5,
    pollSeconds: 3600,
    log: (line) => logs.push(line),
    onRequest: (raw) => seen.push(raw.name),
  });

  spoolObj.start();
  assert.equal(existsSync(stateDir), false, 'a root-owned tree is worse than no tree');
  assert.match(logs.join('\n'), /does not exist yet/);

  // `clawcius-ops.service` is deliberately not ordered after the instance
  // units, so it can and does win this race on a first boot. It has to recover
  // without anybody restarting it: the state directory appears, and the next
  // ordinary sweep creates the spool and starts delivering.
  mkdirSync(stateDir);
  spoolObj.drain();
  assert.equal(statSync(spool).isDirectory(), true, 'the sweep repaired it');

  fileRequest(spool, '1', '{"verb":"snapshot","instance":"clawcius"}');
  spoolObj.drain();
  spoolObj.stop();

  assert.deepEqual(seen, ['1.json'], 'and requests arrive from then on');
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

test('a unit outside the allowlist is refused with the allowlist named', async () => {
  const host = makeHost({ dryRun: true, suffix: 'unit' });
  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"restart","unit":"sshd.service"}' });
  await settle(executor);

  const rejected = journalEntries(host.config).filter((entry) => entry['kind'] === 'rejected');
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]?.['detail']), /not in the units allowlist/);
  assert.match(String(rejected[0]?.['detail']), /clawcius\.service/);
  assert.equal(host.calls().some((call) => call[0] === 'systemctl'), false);
  executor.stop();
});

test('the executor refuses to restart itself', async () => {
  const host = makeHost({ dryRun: true, suffix: 'self' });
  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"restart","unit":"clawcius-ops.service"}' });
  await settle(executor);
  const rejected = journalEntries(host.config).filter((entry) => entry['kind'] === 'rejected');
  assert.match(String(rejected[0]?.['detail']), /this process/);
  executor.stop();
});

test('an instance outside the allowlist is refused', async () => {
  const host = makeHost({ dryRun: true, suffix: 'inst' });
  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"hamachi"}' });
  await settle(executor);
  const rejected = journalEntries(host.config).filter((entry) => entry['kind'] === 'rejected');
  assert.match(String(rejected[0]?.['detail']), /not in the instances allowlist/);
  executor.stop();
});

test('a destructive verb abandons rather than interrupting a live turn', async () => {
  const host = makeHost({ dryRun: true, suffix: 'busy' });
  // A turn in flight.
  host.setStatus('clawcius', { at: Date.now(), liveCount: 1 });

  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
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
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
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
    executor.intake({ requester: 'clawcius', name: `r${i}.json`, body: '{"verb":"snapshot","instance":"clawcius"}' });
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
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });

  // Give the first one a moment to take the lock and start waiting.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(executor.snapshot().current, 'redeploy clawcius');

  executor.intake({ requester: 'clawcius', name: 'b.json', body: '{"verb":"snapshot","instance":"clawcius"}' });
  assert.equal(executor.snapshot().queued, 1, 'the second must queue, not run');

  // Now go idle; the first finishes and the second follows.
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  await settle(executor, 30_000);

  const entries = journalEntries(host.config);
  const started = entries.filter((entry) => entry['kind'] === 'started').map((e) => e['what']);
  assert.deepEqual(started, ['redeploy clawcius', 'snapshot clawcius']);
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
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // limits.maxQueued is 2.
  for (let i = 0; i < 4; i += 1) {
    executor.intake({ requester: 'clawcius', name: `q${i}.json`, body: '{"verb":"snapshot","instance":"clawcius"}' });
  }

  const refused = journalEntries(host.config).filter(
    (entry) => entry['kind'] === 'rejected' && /already queued/.test(String(entry['detail'])),
  );
  assert.equal(refused.length, 2);

  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  await settle(executor, 30_000);
  executor.stop();
});

test('a live redeploy takes a snapshot, recreates, arms a deadline and files a wake', async () => {
  const host = makeHost({ dryRun: false, suffix: 'redeploy' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  const executor = new Executor(host.config);
  executor.intake({
    requester: 'clawcius',
    name: 'a.json',
    body: '{"verb":"redeploy","instance":"clawcius","reason":"new build"}',
  });
  await settle(executor);

  const calls = host.calls();
  const order = calls.map((call) => call[0]);
  assert.equal(order.includes('snapshot.sh'), true, 'snapshot before anything destructive');
  assert.equal(order.includes('run-container.sh'), true);
  assert.ok(
    order.indexOf('snapshot.sh') < order.indexOf('run-container.sh'),
    'the rollback target must be captured before the container is destroyed',
  );

  const recreate = calls.find((call) => call[0] === 'run-container.sh');
  assert.deepEqual(recreate, ['run-container.sh', '--recreate']);

  const pending = executor.state.pendingFor('clawcius');
  assert.ok(pending, 'a check-in deadline must be armed');
  assert.equal(pending?.rollbackTag, 'snap-20260808-040000', 'newest snapshot is the target');
  assert.equal(pending?.build, 'deadbeefcafe0000000000000000000000000000');

  // And the instance was told, in its own wake spool.
  const wakeDir = join(host.root, 'state', 'clawcius', 'run', 'wake');
  const files = readdirSync(wakeDir).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1);
  const wakeFile = files[0] ?? '';
  const wake = JSON.parse(readFileSync(join(wakeDir, wakeFile), 'utf8')) as Record<string, string>;
  assert.equal(wake['channel'], '123456789012345678');
  assert.match(wake['prompt'] ?? '', /You were rebuilt/);
  assert.match(wake['prompt'] ?? '', /new build/);
  assert.match(wake['prompt'] ?? '', /checkin/);

  executor.stop();
});

test('a dry run arms nothing and files nothing', async () => {
  const host = makeHost({ dryRun: true, suffix: 'dryredeploy' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
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
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
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
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
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

  executor.intake({ requester: 'clawcius', name: 'c.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
  await settle(executor);
  const breaker = journalEntries(config).filter(
    (entry) => entry['kind'] === 'breaker' && /will not be deployed again/.test(String(entry['detail'])),
  );
  assert.ok(breaker.length >= 1, 'a quarantined build must be refused');

  executor.stop();
});

test('a deadline rollback that queues behind a busy operation still quarantines', async () => {
  // The finding from review of PR #8, 2026-08-11. The deadline handler used to
  // pass the origin and the pending record straight into #doRollback, which
  // only happened on the branch where the executor was idle. If it was busy,
  // the job went on the queue and both were lost: #dispatch called
  // #doRollback(job, 'requested'), the whole quarantine/breaker/freeze block
  // is gated on origin === 'deadline', and so the failed build was restored
  // and left free to be deployed again — defeating the breaker in exactly the
  // situation it exists for, since #waitForIdle can hold the lock for half an
  // hour and deadlines expire during incidents, not during quiet afternoons.
  const host = makeHost({
    dryRun: false,
    suffix: 'deadlinequeued',
    instances: [{ name: 'clawcius' }, { name: 'hamachi' }],
  });
  const config: OpsConfig = {
    ...host.config,
    // One second to check in, and an idle wait long enough to park an
    // operation across it.
    deadline: { minutes: 1 / 60, autoRollback: true },
    idle: { ...host.config.idle, maxWaitMinutes: 1, pollSeconds: 1 },
  };

  host.setStatus('hamachi', { at: Date.now(), liveCount: 0 });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });

  const executor = new Executor(config);

  // Rebuild Hamachi, which arms its check-in deadline.
  executor.intake({
    requester: 'hamachi',
    name: 'a.json',
    body: '{"verb":"redeploy","instance":"hamachi"}',
  });
  await settle(executor);
  const pending = executor.state.pendingFor('hamachi');
  assert.ok(pending, 'the redeploy must have armed a deadline');
  const build = pending?.build ?? '';
  assert.ok(build);

  // Now park the executor on something else: a rollback of Clawcius, which is
  // mid-turn, so it sits in #waitForIdle holding the lock.
  host.setStatus('clawcius', { at: Date.now(), liveCount: 1 });
  executor.intake({
    requester: 'clawcius',
    name: 'b.json',
    body: '{"verb":"rollback","instance":"clawcius"}',
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(executor.snapshot().current, 'rollback clawcius', 'the lock is held');

  // Hamachi's deadline passes while that is stuck. The rollback has nowhere to
  // go but the queue.
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(executor.snapshot().queued, 1, 'the automatic rollback queued behind it');
  assert.equal(
    journalEntries(config).some(
      (entry) => entry['kind'] === 'queued' && /automatic rollback waiting behind/.test(String(entry['detail'])),
    ),
    true,
  );

  // Let the parked operation through; the queued rollback follows it.
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  await settle(executor, 30_000);

  // The assertion the old code failed: the build that missed its deadline is
  // quarantined even though the rollback went through the queue.
  assert.ok(
    executor.state.isQuarantined('hamachi', build),
    'a rollback that waited its turn is still a deadline rollback',
  );
  assert.equal(
    journalEntries(config).some(
      (entry) =>
        entry['kind'] === 'breaker' &&
        entry['instance'] === 'hamachi' &&
        /will not be deployed again/.test(String(entry['detail'])),
    ),
    true,
  );
  // And it is still the executor's own action, not the instance's.
  assert.equal(
    journalEntries(config).some(
      (entry) => entry['kind'] === 'started' && /rollback hamachi/.test(String(entry['what'])) &&
        entry['requester'] === '(executor)',
    ),
    true,
  );
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

  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
  executor.intake({ requester: 'clawcius', name: 'b.json', body: '{"verb":"snapshot","instance":"clawcius"}' });
  await settle(executor);

  const entries = journalEntries(host.config);
  assert.equal(
    entries.some((entry) => entry['kind'] === 'rejected' && /FROZEN/.test(String(entry['detail']))),
    true,
  );
  // Non-destructive work still runs: a freeze is about not rebuilding, not
  // about refusing to take a backup.
  assert.equal(
    entries.some((entry) => entry['kind'] === 'started' && entry['what'] === 'snapshot clawcius'),
    true,
  );
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

test('a pull is refused on the wrong branch and outside the allowlist', async () => {
  const host = makeHost({ dryRun: false, suffix: 'pull' });
  const executor = new Executor(host.config);

  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"pull","repo":"clawcius"}' });
  await settle(executor);
  // The stand-in git reports branch `main` and a clean tree, so this succeeds.
  assert.equal(
    journalEntries(host.config).some(
      (entry) => entry['kind'] === 'finished' && /pull clawcius/.test(String(entry['what'])),
    ),
    true,
  );
  const pull = host.calls().find((call) => call[0] === 'git' && call.includes('pull'));
  assert.deepEqual(pull, ['git', '-C', join(host.root, 'repo'), 'pull', '--ff-only']);

  executor.intake({ requester: 'clawcius', name: 'b.json', body: '{"verb":"pull","repo":"not-allowed"}' });
  await settle(executor);
  assert.equal(
    journalEntries(host.config).some((entry) =>
      /not in the repos allowlist/.test(String(entry['detail'])),
    ),
    true,
  );
  executor.stop();
});

// ══════════════════════════════════════════════════════════════════════════
// The build step, and the dirty tree
//
// Four properties, all of them added on 2026-08-10 after a night of deploying
// this stack by hand:
//
//   1. `pull` builds. A pull that only fetches source, next to a `restart`
//      verb, is a machine for restarting onto a stale dist/ — which is what
//      cost an hour when always-on-channels was merged, pulled, restarted and
//      did nothing at all.
//   2. A failed build aborts. Nothing is restarted or recreated afterwards,
//      because the two states a failed build leaves are "stale" and
//      "half-written" and both of them start cleanly and behave wrongly.
//   3. A dirty tree is refused, by name, and never forced past.
//   4. The build does not run as root.
//
// Each is asserted as an ORDERING or an ABSENCE rather than as a log line,
// because every one of these failures was silent on the host: exit code 0, no
// stderr, unit active (running).
// ══════════════════════════════════════════════════════════════════════════

test('pull builds before anything can be restarted onto it', async () => {
  const host = makeHost({ dryRun: false, suffix: 'pullbuild', buildDirs: ['.', 'status'] });
  const executor = new Executor(host.config);

  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"pull","repo":"clawcius"}' });
  await settle(executor);

  const calls = host.calls();
  const order = calls.map((call) => call[0]);
  assert.ok(order.includes('git'), 'the pull itself should have run');
  assert.ok(order.includes('npm'), 'a pull that does not build is the bug this fixes');

  // The pull comes first, and every npm invocation comes after it: building
  // before fetching would compile the previous commit and report success.
  const pullAt = calls.findIndex((call) => call[0] === 'git' && call.includes('pull'));
  const firstNpm = order.indexOf('npm');
  assert.ok(pullAt >= 0 && firstNpm > pullAt, 'the build must run after the pull, not before');

  // `npm ci`, not `npm install`. `install` rewrites package-lock.json when it
  // disagrees with it, which is an unreviewed change arriving in a checkout
  // that is about to be deployed, made by a root daemon, unattended.
  const npm = npmCalls(calls);
  assert.deepEqual(
    npm.map((call) => call.argv.join(' ')),
    ['npm ci', 'npm run build', 'npm ci', 'npm run build'],
    'ci then build, once per configured buildDir',
  );
  assert.equal(
    npm.some((call) => call.argv.includes('install')),
    false,
    'npm install would rewrite the lockfile unattended',
  );

  // And in the right directories, in the configured order.
  assert.deepEqual(
    npm.map((call) => call.cwd),
    [
      join(host.root, 'repo'),
      join(host.root, 'repo'),
      join(host.root, 'repo', 'status'),
      join(host.root, 'repo', 'status'),
    ],
  );

  const entries = journalEntries(host.config);
  assert.ok(
    entries.some((entry) => entry['kind'] === 'build' && entry['ok'] === true),
    'the build should be its own journal kind, greppable by one word',
  );
  executor.stop();
});

test('a failed build aborts the operation and restarts nothing', async () => {
  const host = makeHost({ dryRun: false, suffix: 'buildfail' });
  host.failBuild('build');
  const executor = new Executor(host.config);

  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"pull","repo":"clawcius"}' });
  await settle(executor);

  const npm = npmCalls(host.calls());
  // `npm ci` ran, `npm run build` ran and failed, and nothing after it did.
  assert.deepEqual(npm.map((call) => call.argv.join(' ')), ['npm ci', 'npm run build']);

  const entries = journalEntries(host.config);
  const failure = entries.find(
    (entry) => entry['kind'] === 'failed' && /^build /.test(String(entry['what'])),
  );
  assert.ok(failure, 'a failed build must be journalled as a failure, loudly');
  assert.match(String(failure?.['detail']), /STOPPING HERE/);
  assert.match(String(failure?.['detail']), /stale|half-built|half-written/);

  assert.equal(
    host.calls().some((call) => call[0] === 'systemctl'),
    false,
    'nothing may be restarted after a build failure',
  );
  executor.stop();
});

test('a failed build stops a redeploy before the container is touched', async () => {
  const host = makeHost({ dryRun: false, suffix: 'redeploybuildfail' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.failBuild('ci');
  const executor = new Executor(host.config);

  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
  await settle(executor);

  const order = host.calls().map((call) => call[0]);
  assert.equal(order.includes('npm'), true, 'the build should have been attempted');
  assert.equal(
    order.includes('run-container.sh'),
    false,
    'a redeploy must not recreate the container after a failed build',
  );
  assert.equal(
    order.includes('snapshot.sh'),
    false,
    'and it should fail before spending two gigabytes on a snapshot',
  );
  assert.equal(executor.state.pendingFor('clawcius'), null, 'and arm no deadline');
  executor.stop();
});

test('redeploy builds before it snapshots or recreates', async () => {
  const host = makeHost({ dryRun: false, suffix: 'redeploybuild' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  const executor = new Executor(host.config);

  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
  await settle(executor);

  const order = host.calls().map((call) => call[0]);
  const npmAt = order.indexOf('npm');
  const snapAt = order.indexOf('snapshot.sh');
  const recreateAt = order.indexOf('run-container.sh');
  assert.ok(npmAt >= 0, 'a redeploy must build the checkout it deploys');
  assert.ok(snapAt >= 0 && recreateAt >= 0);
  assert.ok(npmAt < snapAt, 'build first: the cheapest thing that can say no goes first');
  assert.ok(npmAt < recreateAt, 'and certainly before anything is destroyed');
  executor.stop();
});

test('a dirty tree refuses the pull, names the files, and forces nothing', async () => {
  const host = makeHost({ dryRun: false, suffix: 'dirty' });
  // Exactly what the host reported on 2026-08-09.
  host.setDirty([' M docker/run-container.sh', '?? notes.txt']);
  const executor = new Executor(host.config);

  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"pull","repo":"clawcius"}' });
  await settle(executor);

  const entries = journalEntries(host.config);
  const failure = entries.find(
    (entry) => entry['kind'] === 'failed' && /pull clawcius/.test(String(entry['what'])),
  );
  assert.ok(failure, 'a dirty tree must fail the operation, not warn about it');
  const detail = String(failure?.['detail']);
  // The files, by name. A refusal that says "the tree is dirty" and stops
  // sends the operator to `git status`; this one is the answer.
  assert.match(detail, /docker\/run-container\.sh/);
  assert.match(detail, /notes\.txt/);
  assert.match(detail, /REFUSING/);

  const calls = host.calls();
  // Nothing was pulled…
  assert.equal(
    calls.some((call) => call[0] === 'git' && call.includes('pull')),
    false,
    'the pull must not be attempted over a dirty tree',
  );
  // …nothing was built on top of it…
  assert.equal(calls.some((call) => call[0] === 'npm'), false);
  // …and, the assertion that matters most: not one of the four ways past a
  // dirty tree was used. There is no code path in this daemon that runs any of
  // them, and this is what keeps it that way.
  for (const forbidden of ['reset', 'checkout', 'stash', 'clean', 'restore', '--force', '-f']) {
    assert.equal(
      calls.some((call) => call[0] === 'git' && call.includes(forbidden)),
      false,
      `git ${forbidden} must never be used to get past a dirty tree`,
    );
  }
  executor.stop();
});

test('a dirty tree refuses a redeploy too, because the breaker names builds by HEAD', async () => {
  const host = makeHost({ dryRun: false, suffix: 'dirtyredeploy' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setDirty([' M src/index.ts']);
  const executor = new Executor(host.config);

  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"redeploy","instance":"clawcius"}' });
  await settle(executor);

  const order = host.calls().map((call) => call[0]);
  assert.equal(order.includes('run-container.sh'), false);
  assert.equal(order.includes('npm'), false);
  assert.equal(executor.state.pendingFor('clawcius'), null);
  assert.match(
    String(journalEntries(host.config).find((e) => e['kind'] === 'failed')?.['detail']),
    /src\/index\.ts/,
  );
  executor.stop();
});

test('a git status that cannot be read is treated as dirty, not as clean', async () => {
  const host = makeHost({ dryRun: false, suffix: 'statusbroken' });
  const executor = new Executor({ ...host.config, gitPath: '/nonexistent/git' });

  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"pull","repo":"clawcius"}' });
  await settle(executor);

  // The branch probe fails first here, which is itself the right answer; the
  // property under test is that no path through #doPull reaches `git pull`
  // when the checkout's state could not be established.
  assert.equal(host.calls().some((call) => call.includes('pull')), false);
  executor.stop();
});

// ── The privilege drop ────────────────────────────────────────────────────
//
// planBuild() and resolveOwner() are pure and are tested directly, because the
// property — "the build does not run as root" — cannot be observed by running
// the build in a suite that is not root to begin with. Testing the plan is not
// a compromise here: the plan IS the decision, and the decision is what was
// wrong on 2026-08-09.

test('the build plan drops to the checkout owner and never runs as root', () => {
  const host = makeHost({ dryRun: false, suffix: 'plan', buildDirs: ['.', 'ops'] });
  const repo = host.config.repos[0];
  assert.ok(repo);
  const owner = { uid: 1000, gid: 1000, user: 'npurcell', home: '/home/npurcell' };

  const steps = planBuild(host.config, repo, owner, true);
  assert.equal(steps.length, 4, 'ci and build, per buildDir');
  for (const step of steps) {
    assert.equal(step.uid, 1000, 'every build step must drop to the owner');
    assert.equal(step.gid, 1000);
    assert.notEqual(step.uid, 0, 'a root build leaves root-owned node_modules/ and dist/');
    // HOME and the npm cache follow the owner, or npm writes into /root/.npm
    // as a user that cannot read it.
    assert.equal(step.env['HOME'], '/home/npurcell');
    assert.equal(step.env['npm_config_cache'], '/home/npurcell/.npm');
    // npm re-execs node and runs tsc through sh, so npm's own directory has to
    // be on PATH — node is not on the system PATH on this host.
    assert.ok(step.env['PATH']?.startsWith(join(host.root, 'bin')));
    assert.equal(step.timeoutSeconds, 60);
  }
  assert.deepEqual(
    steps.map((step) => step.argv.slice(1).join(' ')),
    ['ci', 'run build', 'ci', 'run build'],
  );
  assert.deepEqual(
    steps.map((step) => step.cwd),
    [
      join(host.root, 'repo'),
      join(host.root, 'repo'),
      join(host.root, 'repo', 'ops'),
      join(host.root, 'repo', 'ops'),
    ],
  );

  // And when the executor already IS the owner there is nothing to drop, so
  // no uid is set at all — `uid: undefined` and "no uid" are not the same
  // thing to libuv, and "run as whoever we already are" must stay the default
  // that costs nothing to reason about.
  const undropped = planBuild(host.config, repo, owner, false);
  assert.equal(undropped[0]?.uid, undefined);
  assert.equal('uid' in (undropped[0] ?? {}), false);
});

test('the owner is discovered by stat, never hardcoded, and refused when unknowable', () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-owner-'));
  const passwd = join(root, 'passwd');
  const me = process.getuid?.() ?? 0;

  // A passwd file that does not describe the owner of the directory is the
  // "cannot determine" case, and it must refuse rather than fall back to root.
  writeFileSync(passwd, 'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n');
  const unknown = resolveOwner(root, passwd);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.match(unknown.reason, /no entry in/);
    assert.match(unknown.reason, /Refusing to build/);
  }

  // A directory that does not exist is the other "cannot determine" case.
  const missing = resolveOwner(join(root, 'nope'), passwd);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /cannot stat/);

  // And the happy path: the uid comes off the directory, and the home comes
  // out of passwd. Nothing here is a constant in the source.
  writeFileSync(passwd, `someone:x:${me}:${me}:someone:/home/someone:/bin/sh\n`);
  const found = resolveOwner(root, passwd);
  assert.equal(found.ok, true);
  if (found.ok) {
    assert.equal(found.owner.uid, me);
    assert.equal(found.owner.user, 'someone');
    assert.equal(found.owner.home, '/home/someone');
    // The suite runs as the owner of a directory it just created, so there is
    // nothing to drop — which is the honest answer, not a skipped check.
    assert.equal(found.drop, false);
  }
});

test('a dry run logs the build it would have run, including the uid', async () => {
  const host = makeHost({ dryRun: true, suffix: 'drybuild' });
  const logged: string[] = [];
  const runner = new Runner(true, 20, (line) => logged.push(line));
  const repo = host.config.repos[0];
  assert.ok(repo);

  const outcome = await runBuild(runner, host.config, repo);
  assert.equal(outcome.ok, true);
  assert.match(outcome.detail, /DRY RUN/);
  // Nothing ran…
  assert.equal(host.calls().some((call) => call[0] === 'npm'), false);
  // …but the plan is legible, which is the entire point of the mode: "would
  // the build have run as root?" is the question a week of this log is read to
  // answer.
  assert.match(logged.join('\n'), /DRY-RUN would run: .*npm ci/);
  assert.match(logged.join('\n'), /DRY-RUN would run: .*npm run build/);
  assert.match(logged.join('\n'), /HOME=/);
});

test('buildDirs may not escape the checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'ops-builddirs-'));
  const write = (dirs: string) =>
    writeFileSync(
      join(root, 'ops-config.yaml'),
      [
        `stateDir: ${join(root, 'state')}`,
        'repos:',
        '  - name: clawcius',
        `    path: ${join(root, 'repo')}`,
        '    branch: main',
        `    buildDirs: ${dirs}`,
        '',
      ].join('\n'),
    );

  for (const dirs of ['["../elsewhere"]', '["/etc"]', '["ops/../../.."]']) {
    write(dirs);
    assert.throws(
      () => loadOpsConfig(join(root, 'ops-config.yaml')),
      /buildDirs/,
      `${dirs} must be refused: buildDirs names a subdirectory of an already-authorised checkout, not a second way to nominate one`,
    );
  }

  write('[".", "ops", "status"]');
  const config = loadOpsConfig(join(root, 'ops-config.yaml'));
  assert.deepEqual(config.repos[0]?.buildDirs, ['.', 'ops', 'status']);
});

test('the ops-status.json the page reads is valid and describes the current state', async () => {
  const host = makeHost({ dryRun: true, suffix: 'status' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  const executor = new Executor(host.config);
  executor.intake({ requester: 'clawcius', name: 'a.json', body: '{"verb":"snapshot","instance":"clawcius"}' });
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

  fileRequest(host.spoolDir('clawcius'), '1-good', '{"verb":"restart","unit":"clawcius.service"}');
  fileRequest(host.spoolDir('clawcius'), '2-bad', '{"verb":"nuke","unit":"clawcius.service"}');
  fileRequest(
    host.spoolDir('clawcius'),
    '3-evil',
    '{"verb":"restart","unit":"../../../sshd.service"}',
  );

  spool.start();
  await settle(executor);
  spool.stop();

  const entries = journalEntries(host.config);
  assert.equal(
    entries.some((entry) => entry['kind'] === 'started' && entry['what'] === 'restart clawcius.service'),
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
  // Dry run: the allowed restart was logged, not executed.
  assert.equal(host.calls().some((call) => call[0] === 'systemctl'), false);
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
  fileRequest(host.spoolDir('clawcius'), '1', '{"verb":"snapshot","instance":"hamachi"}');
  fileRequest(host.spoolDir('hamachi'), '2', '{"verb":"snapshot","instance":"hamachi"}');

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
    '{"verb":"snapshot","instance":"hamachi","requester":"clawcius","from":"clawcius"}',
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

test('provenance distinguishes an instance rebuilding itself from one rebuilding its neighbour', async () => {
  const host = twoInstances('neighbour');
  const executor = new Executor(host.config);

  executor.intake({
    requester: 'hamachi',
    name: 'a.json',
    body: '{"verb":"snapshot","instance":"hamachi"}',
  });
  await settle(executor);
  executor.intake({
    requester: 'hamachi',
    name: 'b.json',
    body: '{"verb":"snapshot","instance":"clawcius"}',
  });
  await settle(executor);

  const finished = journalEntries(host.config).filter((entry) => entry['kind'] === 'finished');
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
    body: '{"verb":"redeploy","instance":"clawcius"}',
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
    body: '{"verb":"snapshot","instance":"hamachi"}',
  });
  await settle(executor);

  // Out of scope: the neighbour's.
  executor.intake({
    requester: 'hamachi',
    name: 'b.json',
    body: '{"verb":"snapshot","instance":"clawcius"}',
  });
  await settle(executor);

  // And the same request from the unrestricted instance still goes through,
  // which is what makes this a per-instance rule rather than an allowlist gap.
  executor.intake({
    requester: 'clawcius',
    name: 'c.json',
    body: '{"verb":"snapshot","instance":"clawcius"}',
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

test('mayRequest.units and mayRequest.repos are enforced, and say which list refused', async () => {
  // Added 2026-08-11: the review of PR #8 pointed out that of the four
  // `mayRequest` lists, only `verbs` and `instances` had any test at all. The
  // units and repos branches could have been deleted and the suite would have
  // stayed green — and a restriction that silently does not apply is worse
  // than no restriction, because the operator believes it is there.
  //
  // Both refusals below name something that IS in the global allowlist. That
  // is what makes the test mean anything: a name outside the allowlist would
  // be refused anyway, and the assertion could not tell which rule had fired.
  const host = twoInstances('scopeunitsrepos', {
    hamachi: [
      '    mayRequest:',
      '      units: [hamachi.service]',
      '      repos: [tools]',
    ],
  });
  assert.deepEqual(host.config.instances[1]?.mayRequest?.units, ['hamachi.service']);
  assert.deepEqual(host.config.instances[1]?.mayRequest?.repos, ['tools']);

  const executor = new Executor(host.config);

  // In scope: its own unit, and the repo it was granted.
  executor.intake({
    requester: 'hamachi',
    name: 'a.json',
    body: '{"verb":"restart","unit":"hamachi.service"}',
  });
  await settle(executor);
  executor.intake({ requester: 'hamachi', name: 'b.json', body: '{"verb":"pull","repo":"tools"}' });
  await settle(executor);

  // Out of scope: the neighbour's unit and the other checkout, both of them
  // perfectly legal for an unrestricted instance.
  executor.intake({
    requester: 'hamachi',
    name: 'c.json',
    body: '{"verb":"restart","unit":"clawcius.service"}',
  });
  await settle(executor);
  executor.intake({
    requester: 'hamachi',
    name: 'd.json',
    body: '{"verb":"pull","repo":"clawcius"}',
  });
  await settle(executor);

  // And the unrestricted instance may still do both, which is what makes this
  // a per-instance rule rather than a hole in the allowlist.
  executor.intake({
    requester: 'clawcius',
    name: 'e.json',
    body: '{"verb":"restart","unit":"clawcius.service"}',
  });
  await settle(executor);

  const entries = journalEntries(host.config);
  const rejected = entries.filter((entry) => entry['kind'] === 'rejected');
  assert.equal(rejected.length, 2);
  assert.match(String(rejected[0]?.['detail']), /may not name unit "clawcius\.service"/);
  assert.match(String(rejected[0]?.['detail']), /mayRequest\.units .* allows: hamachi\.service/);
  assert.match(String(rejected[1]?.['detail']), /may not name repo "clawcius"/);
  assert.match(String(rejected[1]?.['detail']), /mayRequest\.repos .* allows: tools/);
  assert.equal(
    rejected.every((entry) => entry['requester'] === 'hamachi'),
    true,
  );

  const started = entries
    .filter((entry) => entry['kind'] === 'started')
    .map((entry) => `${String(entry['requester'])}: ${String(entry['what'])}`);
  assert.deepEqual(started, [
    'hamachi: restart hamachi.service',
    'hamachi: pull tools',
    'clawcius: restart clawcius.service',
  ]);
  executor.stop();
});

test('an empty mayRequest list denies every unit and every repo, and says so', async () => {
  // Present-and-empty is not absent. `units: []` is a legitimate way to say
  // "this instance may never restart anything", and the loader has to keep the
  // two distinguishable or the meaning inverts.
  const host = twoInstances('scopeempty', {
    hamachi: ['    mayRequest:', '      units: []', '      repos: []'],
  });
  assert.deepEqual(host.config.instances[1]?.mayRequest?.units, []);
  assert.deepEqual(host.config.instances[1]?.mayRequest?.repos, []);
  assert.equal(host.config.instances[1]?.mayRequest?.verbs, null, 'absent stays unrestricted');

  // And then the half that was missing until 2026-08-11: the loader parsing
  // `[]` as `[]` proves nothing about the runtime, where an empty list is one
  // `length === 0` away from being read as "no restriction". Empty means deny
  // everything, including the instance's own unit and the repo any other
  // instance may pull.
  const executor = new Executor(host.config);
  executor.intake({
    requester: 'hamachi',
    name: 'a.json',
    body: '{"verb":"restart","unit":"hamachi.service"}',
  });
  await settle(executor);
  executor.intake({ requester: 'hamachi', name: 'b.json', body: '{"verb":"pull","repo":"tools"}' });
  await settle(executor);
  // The unrestricted neighbour still gets through, so this is a rule about
  // hamachi and not a broken fixture.
  executor.intake({
    requester: 'clawcius',
    name: 'c.json',
    body: '{"verb":"restart","unit":"clawcius.service"}',
  });
  await settle(executor);
  executor.stop();

  const entries = journalEntries(host.config);
  const rejected = entries.filter((entry) => entry['kind'] === 'rejected');
  assert.equal(rejected.length, 2, 'an empty list denies, it does not permit');
  assert.match(String(rejected[0]?.['detail']), /may not name unit "hamachi\.service"/);
  assert.match(String(rejected[1]?.['detail']), /may not name repo "tools"/);
  assert.deepEqual(
    entries
      .filter((entry) => entry['kind'] === 'started')
      .map((entry) => `${String(entry['requester'])}: ${String(entry['what'])}`),
    ['clawcius: restart clawcius.service'],
  );
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
      body: '{"verb":"snapshot","instance":"hamachi"}',
    });
  }
  await settle(executor);

  executor.intake({
    requester: 'clawcius',
    name: 'ok.json',
    body: '{"verb":"snapshot","instance":"clawcius"}',
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

test("a waker status file inside ANOTHER instance's WAKE spool is refused too", () => {
  // The pairing the first version of these checks missed, found in review of
  // PR #8 on 2026-08-11. A status file was checked against its own wake spool
  // and against any ops spool, but never against a NEIGHBOUR's wake spool —
  // which is bind-mounted read-write into that neighbour's container exactly
  // like the ops spool is. Hamachi could have written Clawcius's status file
  // and declared it idle, and Clawcius would have been recreated mid-turn.
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    'instances:',
    '  - name: clawcius',
    '    container: clawcius-agent',
    '    image: clawcius-agent:latest',
    '    stateDir: /var/lib/x',
    '    envFile: /var/lib/x/env',
    '    wakerStatusFile: /var/lib/y/run/wake/waker-status.json',
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
  assert.throws(
    () => loadOpsConfig(path),
    /wakerStatusFile is inside instances\[hamachi\]\.wakeSpoolDir/,
  );

  // The default arrangement — status files outside every spool — still loads.
  const good = writeConfig([
    'stateDir: /var/lib/ops-state',
    ...MINIMAL_INSTANCE('/var/lib/x'),
  ]);
  assert.equal(loadOpsConfig(good).instances.length, 1);
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

test('an explicit opsSpoolDir is never silently replaced by the legacy key', () => {
  // The hole found in review of PR #8 on 2026-08-11: the disagreement check
  // asked "is this value the derived default?" instead of "did the operator
  // write it?", and those are different questions. An operator spelling the
  // default out by hand — an entirely ordinary thing to do while migrating off
  // the old key — had it silently overwritten with the legacy path, and since
  // run-container.sh hard-codes the container's spool to <stateDir>/run/ops,
  // the executor would then watch a directory no container writes. Every
  // request would vanish: the exact failure this release exists to end.
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    'spoolDir: /var/lib/x/state/oldreqs',
    ...MINIMAL_INSTANCE('/var/lib/x'),
    // The default, written out. Indistinguishable from an absent key by value,
    // which is why the loader tracks presence separately.
    '    opsSpoolDir: /var/lib/x/state/run/ops',
  ]);
  assert.throws(() => loadOpsConfig(path), /name different directories/);
  assert.throws(() => loadOpsConfig(path), /an explicit key means the operator meant it/);

  // Written twice and agreeing is not an error — there is nothing to migrate,
  // and the deprecation notice still goes into the boot journal.
  const agreeing = writeConfig([
    'stateDir: /var/lib/ops-state',
    'spoolDir: /var/lib/x/state/oldreqs',
    ...MINIMAL_INSTANCE('/var/lib/x'),
    '    opsSpoolDir: /var/lib/x/state/oldreqs',
  ]);
  const config = loadOpsConfig(agreeing);
  assert.equal(config.instances[0]?.opsSpoolDir, '/var/lib/x/state/oldreqs');
  assert.equal(config.deprecations.length, 1);

  // And with no explicit key at all, the legacy value is still adopted — that
  // is the migration path, and it must keep working.
  const migrated = loadOpsConfig(
    writeConfig([
      'stateDir: /var/lib/ops-state',
      'spoolDir: /var/lib/x/state/oldreqs',
      ...MINIMAL_INSTANCE('/var/lib/x'),
    ]),
  );
  assert.equal(migrated.instances[0]?.opsSpoolDir, '/var/lib/x/state/oldreqs');
});

test('the check-in instructions point the instance at its OWN spool', async () => {
  const host = twoInstances('checkinpath');
  const liveHost = makeHost({
    dryRun: false,
    suffix: 'checkinpath-live',
    instances: [{ name: 'clawcius' }, { name: 'hamachi' }],
  });
  liveHost.setStatus('hamachi', { at: Date.now(), liveCount: 0 });

  const executor = new Executor(liveHost.config);
  executor.intake({
    requester: 'hamachi',
    name: 'a.json',
    body: '{"verb":"redeploy","instance":"hamachi"}',
  });
  await settle(executor);

  const wakeDir = join(liveHost.root, 'state', 'hamachi', 'run', 'wake');
  const files = readdirSync(wakeDir).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1);
  const wake = JSON.parse(readFileSync(join(wakeDir, files[0] ?? ''), 'utf8')) as Record<
    string,
    string
  >;
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
