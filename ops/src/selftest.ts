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
 *   - the cap and the control-character strip a task text gets;
 *   - the board: who may take the host agent's row, and the refusal when
 *     somebody else already holds it;
 *   - the config loader's containment assertions, which are the things standing
 *     between "the agent writes its own bind mount" and "the agent writes the
 *     journal, the board or its own waker status file";
 *   - the operation lock: a second task is REFUSED, in the turn that asked,
 *     rather than queued;
 *   - the idle logic against synthetic waker status files, including the
 *     stale-zero case that is the dangerous one. Note that nothing consumes
 *     that verdict any more — the idle wait went with the spools — so these
 *     test a module that is still correct and no longer wired to anything
 *     (Clawcius #64);
 *   - dry-run, verifying that mutating commands are logged and not run while
 *     read-only probes still execute, AND that the host agent session is sent
 *     settings which remove its ability to execute rather than asking it not to;
 *   - the host agent itself, against a `claude` stand-in that speaks real
 *     stream-json: the task prompt, the completeness of the audit, the health
 *     comparison, and the refusal to spawn a session whose environment holds a
 *     credential;
 *   - the unit desk, which is the only way bytes reach /etc/systemd/system;
 *   - the breaker's state across a process boundary: quarantine and freeze are
 *     written to disk and re-read by a fresh StateStore. Nothing writes them
 *     now — see `Executor`, and the boot report that clears what the retired
 *     spool path left armed, which is tested.
 *
 * Seventy-one tests went on 2026-08-16 with the code they covered: the request
 * parser, the spool's structural defences, the spool DIRECTORY (a root process
 * meeting a path the sandbox controls the name of), the queue, the rate limit,
 * the per-instance `mayRequest` restriction, the idle wait, the snapshot, the
 * check-in deadline and the automatic rollback. None of that is coverage that
 * was dropped; all of it is code that no longer exists.
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
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOpsConfig, type OpsConfig } from './config.js';
import { sanitiseTask, sanitiseTaskText } from './host-agent.js';
import { Board, BoardError } from './board.js';
import { DatabaseSync } from 'node:sqlite';
import { readIdle } from './idle.js';
import { Runner, render } from './runner.js';
import { StateStore } from './state.js';
import { Executor, compareHealth } from './executor.js';
import { verifyInstance } from './verify.js';
import {
  agentProblems,
  agentWarnings,
  assertAgentIdentity,
  canReadPath,
  forbiddenGroupsFor,
  parseGroups,
  parsePasswd,
  resolveAgentUser,
  ROOT_EQUIVALENT_GROUPS,
  type AgentUser,
} from './agent-user.js';
import {
  assertNoNodeOptions,
  assertNoSecrets,
  credentialComplaint,
  describeCredentials,
  hostAgentEnv,
  hostAgentSettings,
  hostAgentTools,
  identityOptionsFor,
  judge,
  parseCredentialReport,
  privilegeDropLaunch,
  sessionSpawnOptions,
  standingPrompt,
  supportsExecve,
  CREDENTIAL_REPORT_MARKER,
  DRY_RUN_TOOL_DENY,
  PRIVILEGE_DROP_BOOTSTRAP,
  PRIVILEGE_DROP_EXIT,
} from './host-agent.js';
import {
  drainUnitRequests,
  installUnit,
  parseUnitRequest,
  removeUnit,
  validateUnitName,
  MAX_UNIT_BYTES,
} from './units.js';

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
 * It exists for nested mappings with optional keys whose absence is meaningful
 * — `board:` is the one that still has them — because expressing that through
 * a typed options object would mean reimplementing the distinction the loader
 * is being tested on.
 *
 * Every instance gets its own state directory, exactly as the real host does.
 * That mirroring is the point: the fixture used to have one instance, which is
 * the shape of the world in which the 2026-08-10 Hamachi bug was invisible.
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
  /**
   * `hostAgent.user`. Defaults to `clawcius-ops`, which the fixture passwd
   * file below defines. Point it at a name that is NOT in that file to
   * exercise the missing-account refusal.
   */
  agentUser?: string;
  /**
   * Supplementary groups the fixture agent account is a member of.
   *
   * This is how the docker-group refusal is tested without a docker daemon, a
   * root shell or a real `usermod`: `/etc/group` is a text file, so the check
   * is a text-file check, so the test writes the text file. Fixture the data,
   * not the code.
   */
  agentGroups?: string[];
  /**
   * Mode for the instances' `envFile`, which the identity check treats as a
   * secret automatically.
   *
   * Defaults to 0o000, and that needs explaining because it looks absurd. The
   * fixture's "service account" has the uid of the process running the test —
   * it has to, because dropping to a different uid needs root and this suite
   * runs as nobody in particular. So every file in the temp directory is owned
   * by the agent account, and the only way to express "this account cannot
   * read the operator's secret" is to take away the owner read bit. On the
   * real host the separation is by uid and `.env` is an ordinary 0600 file.
   * A test below flips this to 0o644 to prove the refusal fires.
   */
  envFileMode?: number;
}): {
  root: string;
  config: OpsConfig;
  callsDir: string;
  /** The fixture service account, resolved through the real code path. */
  agent: AgentUser;
  calls: () => string[][];
  setStatus: (instance: string, body: unknown) => void;
  /** That instance's ops spool, which is where its container would write. */
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
  const instanceState = (name: string) => join(root, 'state', name);
  mkdirSync(bin, { recursive: true });
  mkdirSync(callsDir, { recursive: true });
  mkdirSync(control, { recursive: true });
  // `<stateDir>/run` is what docker/run-container.sh bind-mounts, and the
  // containment assertions in config.ts are written against it. The two
  // retired spools used to live inside it; the directory itself still does.
  for (const spec of specs) {
    mkdirSync(join(instanceState(spec.name), 'run'), { recursive: true });
  }
  mkdirSync(join(root, 'repo'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  // Stands in for /etc/systemd/system. The suite cannot write the real one and
  // must not want to; what it needs to prove is that the executor computes the
  // destination itself and that nothing a task says can move it, and a temp
  // directory proves that exactly as well as /etc would.
  mkdirSync(join(root, 'units-installed'), { recursive: true });
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
   * still matter: the host agent session is dropped to its own service account.
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

  // ── The user and group databases, as files ──────────────────────────────
  //
  // `agent-user.ts` resolves the service account by parsing /etc/passwd and
  // /etc/group, so pointing it at fixture copies exercises the real resolution
  // path — including the docker-group refusal — with no root, no `usermod` and
  // no `clawcius-ops` account on the machine running the suite.
  //
  // The fixture account carries THIS PROCESS's uid and gid, because a drop to
  // any other uid requires root and would turn every task test into a spawn
  // failure. The consequence is that the fixture cannot demonstrate the drop
  // itself; that is stated in ops/README.md § Not tested, alongside everything
  // else here that needs a real host.
  const agentUser = options.agentUser ?? 'clawcius-ops';
  const agentUid = process.getuid?.() ?? 1000;
  const agentGid = process.getgid?.() ?? 1000;
  const agentHome = join(root, 'agent-home');
  mkdirSync(agentHome, { recursive: true });
  const passwdPath = join(root, 'passwd');
  const groupPath = join(root, 'group');
  writeFileSync(
    passwdPath,
    [
      'root:x:0:0:root:/root:/bin/bash',
      'npurcell:x:1000:1000:the operator:/home/npurcell:/bin/bash',
      `clawcius-ops:x:${agentUid}:${agentGid}:Clawcius host agent:${agentHome}:/usr/sbin/nologin`,
      '',
    ].join('\n'),
  );
  // Built as a table so a membership the test asks for lands in the EXISTING
  // group line rather than in a second one with the same name. A fixture where
  // `docker` appears twice would still satisfy the assertion below while being
  // a shape /etc/group never has, and a fixture that cannot be wrong in the
  // same way the real file is wrong is not testing much.
  const wanted = new Set(options.agentGroups ?? []);
  const groupTable: Array<{ name: string; gid: number; members: string[] }> = [
    { name: 'root', gid: 0, members: [] },
    // The operator is in docker on the real host, and that single fact is what
    // this whole rework is about. Present in the fixture so that "the agent is
    // not in docker" is not passing merely because the group does not exist.
    { name: 'docker', gid: 998, members: ['npurcell'] },
    { name: 'sudo', gid: 27, members: ['npurcell'] },
    { name: 'adm', gid: 4, members: ['npurcell'] },
    { name: 'clawcius-ops', gid: agentGid, members: [] },
    { name: 'clawcius-dev', gid: 1500, members: ['npurcell'] },
  ];
  for (const name of wanted) {
    const existing = groupTable.find((group) => group.name === name);
    if (existing) existing.members.push(agentUser);
    else groupTable.push({ name, gid: 9000 + groupTable.length, members: [agentUser] });
  }
  writeFileSync(
    groupPath,
    `${groupTable
      .map((group) => `${group.name}:x:${group.gid}:${group.members.join(',')}`)
      .join('\n')}\n`,
  );

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
      `unitDir: ${join(root, 'units-installed')}`,
      `snapshotKeep: ${options.snapshotKeep ?? 24}`,
      'hostAgent:',
      `  enabled: ${options.hostAgent === false ? 'false' : 'true'}`,
      `  user: ${agentUser}`,
      `  passwdPath: ${passwdPath}`,
      `  groupPath: ${groupPath}`,
      `  claudePath: ${claude}`,
      `  workDir: ${join(root, 'host-agent')}`,
      '  timeoutMinutes: 1',
      '  maxCostUsd: 1',
      '  model: ""',
      `  envPassthrough: [${(options.envPassthrough ?? []).join(', ')}]`,
      'units:',
      '  - name: clawcius.service',
      '    description: the waker',
      // A second unit and a second repo, so that anything per-instance is
      // expressible at all: with one of each, a fixture cannot tell "refused
      // because of this instance" from "refused because of the global list".
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
      ...specs.flatMap((spec, index) => [
        `  - name: ${spec.name}`,
        `    container: ${spec.name}-agent`,
        `    image: ${spec.name}-agent:latest`,
        `    stateDir: ${instanceState(spec.name)}`,
        `    envFile: ${join(root, 'env')}`,
        '    memory: 2g',
        `    wakerStatusFile: ${statusFile(spec.name)}`,
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

  // The instances' envFile, which `identityOptionsFor` folds into the secret
  // list without being asked, because on the real host it is the file holding
  // DISCORD_TOKEN. See `envFileMode` above for why the default is 0o000.
  writeFileSync(join(root, 'env'), 'X=1\n');
  chmodSync(join(root, 'env'), options.envFileMode ?? 0o000);

  const config = loadOpsConfig(configPath);

  const resolved = resolveAgentUser(config.hostAgent.user, {
    passwdPath: config.hostAgent.passwdPath,
    groupPath: config.hostAgent.groupPath,
  });

  return {
    root,
    config,
    // Resolved through the real code path rather than assembled by hand, so a
    // change to the parser shows up here rather than being papered over by a
    // fixture that knows the answer.
    agent: resolved.ok
      ? resolved.user
      : {
          user: config.hostAgent.user,
          uid: agentUid,
          gid: agentGid,
          home: agentHome,
          shell: '/usr/sbin/nologin',
          groups: [],
          gids: [agentGid],
        },
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
function journalEntries(config: OpsConfig): Array<Record<string, unknown>> {
  const path = join(config.stateDir, 'journal.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ══════════════════════════════════════════════════════════════════════════
// The task text
//
// Three sections used to stand here — request validation, the spool's
// structural defences, and the spool DIRECTORY as opposed to the files in it —
// and all of them went with the spools on 2026-08-16. A task is no longer a
// file: it is the body of a DM, delivered by the board, and everything those
// sections defended against (a hostile file name, a symlink where a directory
// should be, a FIFO that parks the sweep as root) is defended against by there
// being no directory to look in.
//
// What survived is the cap, because a message can be as long as the sender
// likes and a prompt cannot.
// ══════════════════════════════════════════════════════════════════════════

test('a task is capped and stripped of control characters, and says nothing more', () => {
  // Hygiene, not a security control. It is worth a test precisely because it
  // is easy to read the cap as one: what it buys is a journal that stays
  // greppable and a prompt of a knowable size, and the reason the executor
  // REPORTS truncation to the sender is that this function cannot tell a
  // rambling task from one whose last paragraph said what not to touch.
  assert.equal(sanitiseTask('  do the thing  '), 'do the thing');
  assert.equal(sanitiseTask('a\u0000b\u0007c'), 'a b c', 'control bytes become spaces');
  assert.equal(
    sanitiseTask('one\ntwo\tthree'),
    'one\ntwo\tthree',
    'tab, newline and carriage return survive — a task with a newline is a sentence',
  );

  const long = sanitiseTask('x'.repeat(9000));
  assert.equal(long.length, 8000, 'capped, and the cap is one number in one place');
});

test('truncation is reported only when the CAP fired, not whenever a byte was dropped', () => {
  // The reply tells the sender "your message was longer than a task may be and
  // was cut off at 8000 characters", and that sentence has to be true. The
  // obvious test — result shorter than input — is not: stripping one leading
  // control byte turns it into a space, trim() removes the space, and a
  // seventeen-character task was answered with a warning about an 8000-character
  // cap it never came near. Found by OJ in review of #67.
  assert.deepEqual(sanitiseTaskText('\u0007restart the waker'), {
    text: 'restart the waker',
    truncated: false,
  });
  assert.equal(sanitiseTaskText('  padded  ').truncated, false);
  assert.equal(sanitiseTaskText('x'.repeat(8000)).truncated, false, 'exactly the cap is not over it');
  assert.equal(sanitiseTaskText('x'.repeat(8001)).truncated, true);
  assert.equal(sanitiseTaskText('x'.repeat(8001)).text.length, 8000);
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
];

test('a waker status file inside a container mount is refused', () => {
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    'instances:',
    '  - name: clawcius',
    '    container: clawcius-agent',
    '    image: clawcius-agent:latest',
    '    stateDir: /var/lib/x',
    '    envFile: /var/lib/x/env',
    // Inside <stateDir>/run, which is bind-mounted read-write.
    '    wakerStatusFile: /var/lib/x/run/wake/waker-status.json',
  ]);
  assert.throws(
    () => loadOpsConfig(path),
    /wakerStatusFile \(.*\) is inside \/var\/lib\/x\/run, which is bind-mounted/,
  );
});

// ── The board, and the host agent's mailbox ───────────────────────────────

test('a board inside a container mount is refused', () => {
  // The board decides who is a coordinator, and a coordinator is the only
  // agent that may run commands on this host. Inside a bind mount it would be
  // a file the container rewrites, so the access control would be the
  // container's to edit.
  const path = writeConfig([
    'stateDir: /var/lib/ops-state',
    ...MINIMAL_INSTANCE('/var/lib/x'),
    '    board:',
    '      db: /var/lib/x/state/run/wake/clawcius.db',
    '      crew: clawcius',
  ]);
  assert.throws(
    () => loadOpsConfig(path),
    /board\.db \(.*\) is inside \/var\/lib\/x\/state\/run, which clawcius's container writes/,
  );
});

test('a board outside every mount loads, and neither field is guessed', () => {
  const withBoard = loadOpsConfig(
    writeConfig([
      'stateDir: /var/lib/ops-state',
      ...MINIMAL_INSTANCE('/var/lib/x'),
      '    board:',
      '      db: /var/lib/x/clawcius.db',
      '      crew: clawcius',
    ]),
  );
  assert.deepEqual(withBoard.instances[0]?.board, {
    db: '/var/lib/x/clawcius.db',
    crew: 'clawcius',
  });

  // Absent is inert: no row, no mailbox, and a coordinator DMing the host
  // agent is told there is no such recipient.
  const without = loadOpsConfig(
    writeConfig(['stateDir: /var/lib/ops-state', ...MINIMAL_INSTANCE('/var/lib/x')]),
  );
  assert.equal(without.instances[0]?.board, null);

  for (const [key, value] of [
    ['crew', ''],
    ['crew', 'Clawcius'],
  ] as const) {
    assert.throws(
      () =>
        loadOpsConfig(
          writeConfig([
            'stateDir: /var/lib/ops-state',
            ...MINIMAL_INSTANCE('/var/lib/x'),
            '    board:',
            '      db: /var/lib/x/clawcius.db',
            `      ${key}: ${value || '""'}`,
          ]),
        ),
      /board\.crew/,
    );
  }

  assert.throws(
    () =>
      loadOpsConfig(
        writeConfig([
          'stateDir: /var/lib/ops-state',
          ...MINIMAL_INSTANCE('/var/lib/x'),
          '    board:',
          '      crew: clawcius',
        ]),
      ),
    /board\.db/,
  );
});

test('the board is opened or refused, never created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-board-'));
  assert.throws(
    () => new Board({ dbPath: join(dir, 'missing.db'), crew: 'clawcius', log: () => {} }),
    (error: unknown) =>
      error instanceof BoardError && /never created here/.test((error as Error).message),
  );
  assert.equal(
    existsSync(join(dir, 'missing.db')),
    false,
    'an empty second board reads as a mailbox that works and that nobody can reach',
  );

  // A real file that is not a Clawsky database is refused by schema, not
  // adopted. This file is a second copy of the schema in src/store.ts and
  // src/mail.ts; drift has to be loud.
  const stranger = join(dir, 'stranger.db');
  const db = new DatabaseSync(stranger);
  db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY)');
  db.close();
  assert.throws(
    () => new Board({ dbPath: stranger, crew: 'clawcius', log: () => {} }),
    (error: unknown) =>
      error instanceof BoardError && /missing crew, role/.test((error as Error).message),
  );
});

test('the host agent takes its own row and will not take anybody else\'s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-board-'));
  const path = join(dir, 'clawcius.db');
  const seed = new DatabaseSync(path);
  seed.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, crew TEXT NOT NULL, role TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '', workspace_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'live', spawned_by TEXT,
      spawned_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL)`);
  seed.exec(`CREATE TABLE mail (
      id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, recipient TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, sent_at INTEGER NOT NULL)`);
  seed.exec(`CREATE TABLE mail_reads (
      mail_id INTEGER NOT NULL, reader TEXT NOT NULL, read_at INTEGER NOT NULL,
      PRIMARY KEY (mail_id, reader))`);
  const now = Date.now();
  const addAgent = (id: string, role: string) =>
    seed
      .prepare(
        `INSERT INTO agents (id, crew, role, workspace_path, spawned_at, last_active_at)
         VALUES (?, 'clawcius', ?, '/w', ?, ?)`,
      )
      .run(id, role, now, now);
  addAgent('clawcius-coordinator', 'coordinator');
  addAgent('clawcius-engineer1', 'engineer');
  seed.close();

  const board = new Board({ dbPath: path, crew: 'clawcius', log: () => {} });
  assert.equal(board.hostId, 'clawcius-host');
  assert.equal(board.register('/var/lib/clawcius-host-agent'), true);
  assert.equal(board.roleOf('clawcius-host'), 'host');
  assert.equal(board.roleOf('clawcius-coordinator'), 'coordinator');
  assert.equal(board.roleOf('nobody-at-all'), '');

  // DMs only. A feed post is addressed to everybody and carries no authority;
  // a root daemon that ran tasks off the feed would be the counterexample to
  // the rule the whole board is arranged around.
  const write = new DatabaseSync(path);
  const send = (author: string, recipient: string, body: string) =>
    write
      .prepare('INSERT INTO mail (author, recipient, subject, body, sent_at) VALUES (?,?,?,?,?)')
      .run(author, recipient, 's', body, Date.now());
  send('clawcius-coordinator', 'clawcius-host', 'restart the proxy');
  send('clawcius-poster', '*', 'a claim, never an instruction');

  const waiting = board.unread();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]?.author, 'clawcius-coordinator');
  assert.equal(waiting[0]?.body, 'restart the proxy');

  board.markRead(waiting[0]?.id ?? 0);
  assert.equal(board.unread().length, 0, 'marked read before it is acted on, so it cannot repeat');

  board.send('clawcius-coordinator', 'Done', 'three commands');
  const answered = write
    .prepare('SELECT author, recipient, body FROM mail WHERE recipient = ?')
    .get('clawcius-coordinator') as Record<string, unknown>;
  assert.equal(answered['author'], 'clawcius-host');
  assert.equal(answered['body'], 'three commands');
  board.close();

  // The id is taken by something that is not a host agent: refuse the mailbox
  // rather than hand a container agent's inbox to a root daemon.
  write.prepare(`UPDATE agents SET role = 'engineer' WHERE id = ?`).run('clawcius-host');
  write.close();
  const complaints: string[] = [];
  const second = new Board({ dbPath: path, crew: 'clawcius', log: (line) => complaints.push(line) });
  assert.equal(second.register('/var/lib/clawcius-host-agent'), false);
  assert.match(complaints.join('\n'), /already exists on this board as a engineer/);
  second.close();
});

test('a config still carrying the retired spool keys boots, and is told they are inert', () => {
  // Reported, never refused, and the distinction is the whole point of the
  // test. `clawcius-ops.service` is Restart=always with no start limit, so a
  // config the loader rejects is not one loud error — it is a root daemon in a
  // five-second restart loop. And an in-place rollback to the previous `dist/`
  // has to find a config that build can still read.
  //
  // Silence would be worse than either: an operator whose file says
  // `mayRequest:` believes an instance is restricted and it is not.
  const path = writeConfig([
    'stateDir: /var/lib/clawcius-ops',
    'spoolDir: /var/lib/x/run/ops',
    'instances:',
    '  - name: clawcius',
    '    container: clawcius-agent',
    '    image: clawcius-agent:latest',
    '    stateDir: /var/lib/x/state',
    '    envFile: /var/lib/x/env',
    '    wakerStatusFile: /var/lib/x/waker-status.json',
    '    wakeSpoolDir: /var/lib/x/state/run/wake',
    '    opsSpoolDir: /var/lib/x/state/run/ops',
    '    wakeChannelId: "123456789012345678"',
    '    mayRequest:',
    '      instances: [clawcius]',
    'limits:',
    '  maxRequestBytes: 16384',
    '  maxPerSweep: 8',
    '  maxSpoolFiles: 64',
    '  maxPerHour: 20',
    '  maxQueued: 8',
  ]);

  const config = loadOpsConfig(path);
  const said = config.deprecations.join('\n');

  for (const key of [
    'spoolDir',
    'opsSpoolDir',
    'wakeSpoolDir',
    'wakeChannelId',
    'mayRequest',
    'maxRequestBytes',
    'maxPerSweep',
    'maxSpoolFiles',
    'maxPerHour',
    'maxQueued',
  ]) {
    assert.match(said, new RegExp(`${key}[^\\n]*(RETIRED|IGNORED)`), `${key} is named`);
  }
  // The one that would leave somebody believing they are protected gets the
  // rule that actually stands in its place, by name.
  assert.match(said, /only a coordinator may DM the host agent/);
  assert.match(said, /host-mailbox\.ts/);
  // And nothing was deleted from anybody's disk on the strength of a config key.
  assert.match(said, /Nothing has been deleted from disk/);

  // maxPerHour is the one where silence costs most: it read as "this host is
  // rate limited" and nothing replaces it. The notice has to say that outright
  // rather than just naming the key.
  assert.match(said, /NOTHING REPLACES IT/);
  assert.match(said, /this host is not rate limited/);

  // Ignored means ignored: the surviving limits are the two timeouts.
  assert.deepEqual(Object.keys(config.limits).sort(), [
    'buildTimeoutSeconds',
    'commandTimeoutSeconds',
  ]);
});

test("a board or a status file inside ANY of the container's three mounts is refused", () => {
  // Found by OJ in review of #67. The rewritten guard checked
  // `<stateDir>/run` — the directory the spools lived in — while its own new
  // comment claimed that was the whole of what a container can write.
  // `run-container.sh` mounts three, all derived from the same variable:
  //
  //     -v "$CLAWCIUS_STATE/workspaces:…:rw"
  //     -v "$CLAWCIUS_STATE/run:…:rw"
  //     -v "$CLAWCIUS_STATE/agent-home:…:rw"
  //
  // board.db is the one that matters. It holds the role column `roleOf()` reads,
  // which is the only access control left on running commands on this host, and
  // under `workspaces/` it was accepted.
  const at = (path: string, extra: string[] = []): string =>
    writeConfig([
      'stateDir: /var/lib/ops-state',
      'instances:',
      '  - name: clawcius',
      '    container: clawcius-agent',
      '    image: clawcius-agent:latest',
      '    stateDir: /var/lib/x',
      '    envFile: /var/lib/x/env',
      `    wakerStatusFile: ${path}`,
      ...extra,
    ]);

  for (const child of ['run', 'workspaces', 'agent-home']) {
    assert.throws(
      () => loadOpsConfig(at(`/var/lib/x/${child}/waker-status.json`)),
      new RegExp(`wakerStatusFile .* is inside /var/lib/x/${child}`),
      `a status file under ${child}/ must be refused`,
    );
    assert.throws(
      () =>
        loadOpsConfig(
          at('/var/lib/x/waker-status.json', [
            '    board:',
            `      db: /var/lib/x/${child}/clawcius.db`,
            '      crew: clawcius',
          ]),
        ),
      new RegExp(`board\\.db .* is inside /var/lib/x/${child}`),
      `a board under ${child}/ must be refused`,
    );
  }

  // And the sibling that is outside all three still loads, so this is wider
  // rather than merely stricter.
  const ok = loadOpsConfig(
    at('/var/lib/x/waker-status.json', [
      '    board:',
      '      db: /var/lib/x/clawcius.db',
      '      crew: clawcius',
    ]),
  );
  assert.equal(ok.instances[0]?.wakerStatusFile, '/var/lib/x/waker-status.json');
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
// The executor across the retirement of the spools
// ══════════════════════════════════════════════════════════════════════════

test('a deadline armed by the retired spool path is reported and cleared, not left pending', () => {
  // The transition case, and the reason it needs a test rather than a comment.
  // A host upgrading into this build can have `pending` rows written by the
  // previous one: the spool task path armed them, and nothing arms or honours
  // them any more. Left alone they would be published in ops-status.json as
  // pending forever, which reads as a recovery in progress — and a stale
  // deadline that will never fire is worse than none at all, because it is
  // reassurance rather than an absence.
  const host = makeHost({ dryRun: true, suffix: 'stale-deadline' });
  const before = new StateStore(host.config.stateDir, 8);
  before.arm({
    instance: 'clawcius',
    deadlineAt: Date.now() + 60_000,
    reason: 'a redeploy filed through the ops spool',
    build: 'sha1',
    rollbackTag: 'snap-20260808-040000',
    fromRollback: false,
    armedAt: Date.now() - 1000,
  });

  // A quarantined build, written by the same event. Nothing consults the list
  // and nothing can add to it, so a row here is a control that is published and
  // enforced by nobody.
  before.quarantine('clawcius', 'sha1', 'missed its check-in deadline');

  // And a pending row with no `armedAt`, which is the shape that took the
  // daemon down at boot: StateStore admits a row on `instance` and `deadlineAt`
  // alone, and `new Date(undefined).toISOString()` throws. index.ts calls this
  // before the mailboxes start, so the throw was a restart loop the daemon
  // could not report from. Found by OJ in review of #67.
  before.arm({
    instance: 'hamachi',
    deadlineAt: Date.now() + 60_000,
    reason: '',
    build: '',
    rollbackTag: '',
    fromRollback: false,
    armedAt: undefined as unknown as number,
  });

  const executor = new Executor(host.config);
  executor.reportRetiredDeadlines();

  assert.equal(
    new StateStore(host.config.stateDir, 8).pendingFor('clawcius'),
    null,
    'cleared, so it is not republished on every boot forever',
  );
  assert.equal(new StateStore(host.config.stateDir, 8).pendingFor('hamachi'), null);
  assert.deepEqual(executor.snapshot().pendingCheckins, []);

  // The quarantine list goes with them. The comment on OpsStatusSnapshot
  // promises this and the method used to touch only `pending`.
  assert.deepEqual(executor.snapshot().quarantined, []);
  assert.deepEqual(new StateStore(host.config.stateDir, 8).state.quarantined, []);
  const breaker = journalEntries(host.config).filter((entry) => entry['kind'] === 'breaker');
  assert.equal(breaker.length, 1, 'and it is said out loud, not just done');
  assert.match(String(breaker[0]?.['detail'] ?? ''), /cleared rather than left being published/);

  // The row with no armedAt was reported rather than throwing, and it says so
  // in words rather than printing an invalid date.
  const forHamachi = journalEntries(host.config).find(
    (entry) => entry['kind'] === 'deadline-missed' && entry['instance'] === 'hamachi',
  );
  assert.ok(forHamachi, 'the malformed row is reported, not skipped and not fatal');
  assert.match(String(forHamachi?.['detail'] ?? ''), /at an unrecorded time/);
  assert.doesNotMatch(String(forHamachi?.['detail'] ?? ''), /Invalid|NaN/);

  // Cleared LOUDLY. If that instance really is broken it is now a person's
  // problem, and the journal is where they find out it became one.
  const missed = journalEntries(host.config).filter(
    (entry) => entry['kind'] === 'deadline-missed',
  );
  assert.equal(missed.length, 2);
  assert.match(String(missed[0]?.['detail'] ?? ''), /That path has been retired/);
  assert.match(String(missed[0]?.['detail'] ?? ''), /a redeploy filed through the ops spool/);

  // Idempotent: a second boot has nothing left to say.
  const second = new Executor(host.config);
  second.reportRetiredDeadlines();
  assert.equal(
    journalEntries(host.config).filter((entry) => entry['kind'] === 'deadline-missed').length,
    2,
  );
  assert.equal(
    journalEntries(host.config).filter((entry) => entry['kind'] === 'breaker').length,
    1,
    'the quarantine notice does not repeat either',
  );
  executor.stop();
  second.stop();
});

test('a second task is refused while one is running, and the refusal reaches the sender', async () => {
  // What replaced the queue. The old path put a second request behind a lock
  // and told it so in a journal the sender could not read; this one answers in
  // the turn that asked. That is the property worth testing — not that two
  // sessions cannot overlap, which the lock has always given, but that "no"
  // is a return value rather than a silence.
  const host = makeHost({ dryRun: true, suffix: 'busy' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  const executor = new Executor(host.config);

  const first = executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'the first',
    task: 'look at the host',
  });
  const second = await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'the second',
    task: 'look at it again',
  });

  assert.match(second.subject, /^Refused: the second/);
  assert.match(second.body, /busy with/);
  assert.match(second.body, /went with the spools/);

  const answer = await first;
  assert.match(answer.subject, /the first/);
  executor.stop();
});


// ══════════════════════════════════════════════════════════════════════════
// Unit install/remove — what replaced the `install`/`rm` sudo rules
// ══════════════════════════════════════════════════════════════════════════
//
// These are the tests that would have failed against the sudoers rules deleted
// on 2026-08-12, if a sudoers rule were a thing one could write a test for. It
// is not, and that is half the argument for moving the capability into code: a
// `Cmnd_Alias` is asserted about by reading it carefully and being right, and
// the six-lens audit that produced this change found four separate places where
// somebody had read one carefully and been wrong.
//
// The name validation is the load-bearing part. Every exploit in that audit
// came down to a string reaching a program that re-parsed it — as flags, as a
// second file, as a path with a `..` in it — so the assertions below are mostly
// "this string is refused, and nothing was written".

/** A minimal but real unit file, so the content check has something to accept. */
const UNIT_BODY = '[Unit]\nDescription=selftest\n\n[Service]\nExecStart=/bin/true\n';

/** A staging + destination pair in a temp directory, with nothing else around. */
function unitFixture(suffix: string): {
  staging: string;
  unitDir: string;
  stage: (name: string, body?: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), `ops-units-${suffix}-`));
  const staging = join(root, 'staging');
  const unitDir = join(root, 'installed');
  mkdirSync(staging, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  return {
    staging,
    unitDir,
    stage: (name, body = UNIT_BODY) => {
      const path = join(staging, name);
      writeFileSync(path, body);
      return path;
    },
  };
}

test('a unit name with a separator, a "..", a space or the wrong suffix is refused', () => {
  // The four the task brief names, plus the ones the deleted sudo rules
  // actually accepted. Each is checked through `validateUnitName` AND through
  // `installUnit`, because a validator nobody calls is a comment.
  const fixture = unitFixture('names');
  const hostile: Array<[string, RegExp]> = [
    // A separator: the destination is built by the executor and a name is a
    // NAME. `/etc/systemd/system/clawcius*.service` accepted the whole left
    // half of this string as part of its wildcard.
    ['clawcius/../ssh.service', /path separator/],
    ['/etc/sudoers.d/clawcius', /path separator/],
    ['clawcius\\ssh.service', /path separator/],
    // Traversal, without a separator in the first position.
    ['clawcius..service', /"\.\."/],
    // Whitespace. This is the whole `fnmatch` defect in one assertion: sudo
    // joined argv with spaces before matching, so a wildcard that matched a
    // space matched any number of extra arguments — `-t /etc/sudoers.d`, say.
    ['clawcius x.service', /whitespace/],
    ['clawcius\t.service', /whitespace/],
    // The whole flag-smuggling exploit as a single "name". It trips the
    // separator check first, which is why the expectation says so: the checks
    // run in a fixed order and the first one to fire is the one that explains
    // itself.
    ['-m 4755 /bin/bash clawcius.service', /path separator/],
    // The suffix. Drop-ins are how `sshd.service.d/override.conf` would get in.
    ['clawcius.conf', /not a unit name/],
    ['clawcius.service.d', /not a unit name/],
    ['clawcius.socket', /not a unit name/],
    ['clawcius.mount', /not a unit name/],
    ['clawcius.timer.bak', /not a unit name/],
    ['clawcius', /not a unit name/],
    ['', /empty/],
    // Case: systemd is case-sensitive and two spellings of one unit is a way to
    // install a second copy of something under a name a human skims past.
    ['Clawcius.service', /not a unit name/],
    // A leading hyphen is an argument to anything that later handles this name.
    ['-rf.service', /starts with "-"/],
    // Not this project's. /etc/systemd/system OVERRIDES /lib/systemd/system, so
    // without the prefix check this is how sshd gets replaced — which is what
    // the `..` climb-out bought, and what the file claimed was out of reach.
    ['ssh.service', /not one of this project's units/],
    ['sshd.service', /not one of this project's units/],
    ['docker.service', /not one of this project's units/],
    ['clawciusfoo.service', /not one of this project's units/],
    // The executor's own unit. Rewriting it is root at the next boot with
    // nothing watching, and `clawcius*` matched it.
    ['clawcius-ops.service', /is this executor's own unit/],
  ];

  for (const [name, expected] of hostile) {
    const verdict = validateUnitName(name);
    assert.equal(verdict.ok, false, `${JSON.stringify(name)} must not validate`);
    if (!verdict.ok) {
      assert.match(verdict.reason, expected, `the refusal for ${JSON.stringify(name)} says why`);
    }

    const result = installUnit({
      unit: name,
      unitDir: fixture.unitDir,
      stagingDir: fixture.staging,
      dryRun: false,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /^REFUSED: /);
  }

  // And nothing was created, anywhere, by any of them.
  assert.deepEqual(readdirSync(fixture.unitDir), []);

  // Non-strings are refused rather than coerced. `{"unit": 42}` is a rejection.
  for (const value of [42, null, undefined, ['clawcius.service'], { name: 'x' }]) {
    const verdict = validateUnitName(value);
    assert.equal(verdict.ok, false);
  }

  // The names that MUST work, or the capability is gone rather than fixed.
  for (const name of [
    'clawcius.service',
    'clawcius-status.service',
    'clawcius-snapshot.timer',
    'hamachi.service',
    'hamachi-container.service',
    'oj.service',
  ]) {
    const verdict = validateUnitName(name);
    assert.equal(verdict.ok, true, `${name} must still be installable`);
  }
});

test('an install lands at the path the executor computed, 0644, and nowhere else', () => {
  const fixture = unitFixture('install');
  fixture.stage('clawcius-selftest.service');

  const result = installUnit({
    unit: 'clawcius-selftest.service',
    unitDir: fixture.unitDir,
    stagingDir: fixture.staging,
    dryRun: false,
  });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.path, join(fixture.unitDir, 'clawcius-selftest.service'));
  assert.equal(readFileSync(result.path, 'utf8'), UNIT_BODY);
  // The claim the old sudoers comment made and could not keep. It is kept here
  // by `fchmod` on the descriptor that was written, not by a pattern asking an
  // `install` invocation to behave — `install -m 0644 -m 0777` really does
  // produce 0777, which is why the rule pinned nothing.
  assert.equal(statSync(result.path).mode & 0o7777, 0o644);
  // Exactly one file, and no leftover temp: an interrupted install must not
  // leave `.clawcius-selftest.service.tmp` for systemd to find.
  assert.deepEqual(readdirSync(fixture.unitDir), ['clawcius-selftest.service']);

  // Reinstalling replaces it in place, atomically.
  fixture.stage('clawcius-selftest.service', `${UNIT_BODY}# second\n`);
  const again = installUnit({
    unit: 'clawcius-selftest.service',
    unitDir: fixture.unitDir,
    stagingDir: fixture.staging,
    dryRun: false,
  });
  assert.equal(again.ok, true, again.detail);
  assert.match(readFileSync(result.path, 'utf8'), /# second/);
  assert.deepEqual(readdirSync(fixture.unitDir), ['clawcius-selftest.service']);

  const removed = removeUnit({
    unit: 'clawcius-selftest.service',
    unitDir: fixture.unitDir,
    stagingDir: fixture.staging,
    dryRun: false,
  });
  assert.equal(removed.ok, true, removed.detail);
  assert.deepEqual(readdirSync(fixture.unitDir), []);

  // Removing what is not there says so instead of succeeding quietly.
  const missing = removeUnit({
    unit: 'clawcius-selftest.service',
    unitDir: fixture.unitDir,
    stagingDir: fixture.staging,
    dryRun: false,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /not installed/);
});

test('a staged symlink is refused rather than published into /etc/systemd/system', () => {
  // CWE-59, and the exact exploit the deleted rule permitted with no symlink at
  // all: `install … /root/.ssh/id_ed25519 /etc/systemd/system/clawcius-leak.service`
  // copied any root-only file somewhere world-readable. The staging directory
  // belongs to the agent account, so the same thing is available here by
  // pointing a staged name at a file the ROOT executor can read.
  const fixture = unitFixture('symlink');
  const secret = join(fixture.staging, '..', 'pretend-id_ed25519');
  writeFileSync(secret, 'PRIVATE KEY MATERIAL\n');
  symlinkSync(secret, join(fixture.staging, 'clawcius-leak.service'));

  const result = installUnit({
    unit: 'clawcius-leak.service',
    unitDir: fixture.unitDir,
    stagingDir: fixture.staging,
    dryRun: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /could not open .* as a plain file/);
  assert.deepEqual(readdirSync(fixture.unitDir), [], 'nothing was published');

  // Same refusal for a directory, and for a staging directory that has itself
  // been replaced by a symlink — the check is on the object, never on the name.
  mkdirSync(join(fixture.staging, 'clawcius-dir.service'));
  const asDir = installUnit({
    unit: 'clawcius-dir.service',
    unitDir: fixture.unitDir,
    stagingDir: fixture.staging,
    dryRun: false,
  });
  assert.equal(asDir.ok, false);

  const swapped = join(fixture.staging, '..', 'staging-link');
  symlinkSync(fixture.staging, swapped);
  const throughLink = installUnit({
    unit: 'clawcius-selftest.service',
    unitDir: fixture.unitDir,
    stagingDir: swapped,
    dryRun: false,
  });
  assert.equal(throughLink.ok, false);
  assert.match(throughLink.detail, /symlink/);

  // And a symlink where the INSTALLED unit belongs is refused rather than
  // silently replaced: something else put it there.
  fixture.stage('clawcius-planted.service');
  symlinkSync('/etc/passwd', join(fixture.unitDir, 'clawcius-planted.service'));
  const overPlanted = installUnit({
    unit: 'clawcius-planted.service',
    unitDir: fixture.unitDir,
    stagingDir: fixture.staging,
    dryRun: false,
  });
  assert.equal(overPlanted.ok, false);
  assert.match(overPlanted.detail, /not a regular file/);
  assert.equal(lstatSync(join(fixture.unitDir, 'clawcius-planted.service')).isSymbolicLink(), true);
  const removePlanted = removeUnit({
    unit: 'clawcius-planted.service',
    unitDir: fixture.unitDir,
    stagingDir: fixture.staging,
    dryRun: false,
  });
  assert.equal(removePlanted.ok, false);
  assert.match(removePlanted.detail, /Refusing to unlink/);
});

test('an empty, oversized or non-unit staged file is not installed', () => {
  const fixture = unitFixture('content');

  fixture.stage('clawcius-empty.service', '');
  assert.match(
    installUnit({ unit: 'clawcius-empty.service', unitDir: fixture.unitDir, stagingDir: fixture.staging, dryRun: false }).detail,
    /is empty/,
  );

  fixture.stage('clawcius-big.service', 'x'.repeat(MAX_UNIT_BYTES + 1));
  assert.match(
    installUnit({ unit: 'clawcius-big.service', unitDir: fixture.unitDir, stagingDir: fixture.staging, dryRun: false }).detail,
    /over the .* ceiling. It was not read/,
  );

  // Not a unit file at all. This is what a session that has been talked into
  // "just put this file somewhere root-owned" produces.
  fixture.stage('clawcius-notaunit.service', 'clawcius-ops ALL=(ALL) NOPASSWD: ALL\n');
  assert.match(
    installUnit({ unit: 'clawcius-notaunit.service', unitDir: fixture.unitDir, stagingDir: fixture.staging, dryRun: false }).detail,
    /no \[Section\] header/,
  );

  assert.deepEqual(readdirSync(fixture.unitDir), []);
});

test('a dry run stages nothing into the unit directory', () => {
  const fixture = unitFixture('dryrun');
  fixture.stage('clawcius-selftest.service');
  const result = installUnit({
    unit: 'clawcius-selftest.service',
    unitDir: fixture.unitDir,
    stagingDir: fixture.staging,
    dryRun: true,
  });
  // Reported as ok AND as skipped, the same shape `Runner` uses: a dry run that
  // reported failure would train whoever reads a week of it to ignore failures.
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.match(result.detail, /DRY RUN/);
  assert.deepEqual(readdirSync(fixture.unitDir), []);
});

test('a unit request carries a name and nothing else — no path, no mode, no owner', () => {
  // The shape of the request is the other half of the fix. The deleted sudo
  // rule let the caller supply the source, the destination, the mode and the
  // owner; this one has two fields and neither is a path.
  const good = parseUnitRequest('{"op":"install","unit":"clawcius-x.service"}');
  assert.equal(good.ok, true);

  for (const body of [
    '{"op":"install","unit":"clawcius-x.service","mode":"4755"}',
    '{"op":"install","unit":"clawcius-x.service","dest":"/etc/sudoers.d/clawcius"}',
    '{"op":"install","unit":"clawcius-x.service","owner":"root"}',
    '{"op":"install","unit":"clawcius-x.service","source":"/root/.ssh/id_ed25519"}',
  ]) {
    const parsed = parseUnitRequest(body);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.reason, /unknown field/);
  }

  for (const body of [
    'not json at all',
    '[]',
    '"clawcius-x.service"',
    '{"op":"chmod","unit":"clawcius-x.service"}',
    '{"op":"install"}',
    '{"unit":"clawcius-x.service"}',
  ]) {
    assert.equal(parseUnitRequest(body).ok, false, body);
  }
});

test('a request being renamed into place is not eaten by a sweep that lands mid-write', () => {
  // Clawcius #66, which was filed as a flaky test and was a real bug behind it.
  //
  // The briefing tells the session to write `<name>.json.tmp` and `mv` it, so
  // that what appears under `.json` is already complete. The desk polls every
  // second WHILE the session runs, and it used to discard every name failing
  // its strict pattern — including that temp file. A poll landing in the window
  // between the shell opening the file and the rename deleted it, the `mv` then
  // failed with no source, and the unit was never installed. The log line said
  // "implausible unit-request file name" about a file doing exactly as it was
  // told.
  const fixture = unitFixture('race');
  const requests = join(fixture.staging, '..', 'requests');
  const results = join(fixture.staging, '..', 'results');
  mkdirSync(requests);
  mkdirSync(results);
  fixture.stage('clawcius-race.service');

  const logs: string[] = [];
  const drain = () =>
    drainUnitRequests({
      requestDir: requests,
      resultDir: results,
      stagingDir: fixture.staging,
      unitDir: fixture.unitDir,
      dryRun: false,
      max: 8,
      onLog: (line) => logs.push(line),
    });

  writeFileSync(
    join(requests, 'a.json.tmp'),
    '{"op":"install","unit":"clawcius-race.service"}',
  );

  // A sweep catching the halfway state must do nothing at all to it.
  assert.deepEqual(drain(), [], 'a .tmp is not a request yet');
  assert.deepEqual(
    readdirSync(requests),
    ['a.json.tmp'],
    'and it is still there for the rename to land on',
  );
  assert.deepEqual(logs, [], 'and nothing is said about it, because nothing happened');

  // The rename, and the sweep after it, behave exactly as documented.
  renameSync(join(requests, 'a.json.tmp'), join(requests, 'a.json'));
  const served = drain();
  assert.equal(served.length, 1);
  assert.equal(served[0]?.ok, true, served[0]?.detail);
  assert.equal(existsSync(join(fixture.unitDir, 'clawcius-race.service')), true);

  // Still discarded: a name ending `.json` that is otherwise implausible.
  // Skipping the temp file must not have turned the strict check off.
  writeFileSync(join(requests, '.hidden.json'), '{}');
  drain();
  assert.equal(
    existsSync(join(requests, '.hidden.json')),
    false,
    'an implausible .json name is still discarded unread',
  );
});

test('the desk serves a request, answers it, and never serves it twice', () => {
  const fixture = unitFixture('desk');
  const requests = join(fixture.staging, '..', 'requests');
  const results = join(fixture.staging, '..', 'results');
  mkdirSync(requests);
  mkdirSync(results);
  fixture.stage('clawcius-desk.service');

  const logs: string[] = [];
  const drain = (max = 8) =>
    drainUnitRequests({
      requestDir: requests,
      resultDir: results,
      stagingDir: fixture.staging,
      unitDir: fixture.unitDir,
      dryRun: false,
      max,
      onLog: (line) => logs.push(line),
    });

  writeFileSync(join(requests, '1.json'), '{"op":"install","unit":"clawcius-desk.service"}');
  const served = drain();
  assert.equal(served.length, 1);
  assert.equal(served[0]?.ok, true, served[0]?.detail);
  assert.equal(existsSync(join(fixture.unitDir, 'clawcius-desk.service')), true);

  // The answer is where the session can read it, and the request is gone. Gone
  // BEFORE it was acted on, like an ops request: a removal that throws must not
  // come back on the next drain.
  const answer = JSON.parse(readFileSync(join(results, '1.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(answer['ok'], true);
  assert.equal(answer['path'], join(fixture.unitDir, 'clawcius-desk.service'));
  assert.deepEqual(readdirSync(requests), []);
  assert.deepEqual(drain(), [], 'a served request does not come back');

  // A refusal is served and answered too, rather than being dropped silently —
  // a session that gets no answer retries, and a run of refusals is what
  // somebody probing the name validation looks like from outside.
  writeFileSync(join(requests, '2.json'), '{"op":"remove","unit":"/etc/sudoers.d/clawcius"}');
  const refused = drain();
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.ok, false);
  assert.match(String(refused[0]?.detail), /path separator/);

  // Implausible names, oversized files and non-files are discarded unread, and
  // the ceiling bounds a session that loops.
  writeFileSync(join(requests, 'no-suffix'), '{"op":"install","unit":"clawcius-desk.service"}');
  writeFileSync(join(requests, '3.json'), 'x'.repeat(9000));
  assert.deepEqual(drain(), []);
  assert.deepEqual(readdirSync(requests), []);

  for (let n = 0; n < 5; n += 1) {
    writeFileSync(join(requests, `4${n}.json`), '{"op":"install","unit":"clawcius-desk.service"}');
  }
  assert.equal(drain(2).length, 2, 'the ceiling stops after two');
  assert.equal(readdirSync(requests).length, 3, 'the rest are left where they are');
});

test('a task can install a unit without sudo, and it lands in the journal as its own kind', async () => {
  // End to end, through the real executor: the fake session writes the unit and
  // files the request with the shell, exactly as the briefing tells it to, and
  // the executor — which is the only thing here that could be root — does the
  // write. No `install` command appears anywhere, because there is no longer a
  // sudo rule for one.
  const host = makeHost({ dryRun: false, suffix: 'unitdesk' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  const staging = join(host.root, 'host-agent', 'units');
  const requests = join(host.root, 'host-agent', 'unit-requests');
  host.setPlan([
    `printf '[Unit]\\nDescription=x\\n' > ${join(staging, 'clawcius-e2e.service')}`,
    `printf '{"op":"install","unit":"clawcius-e2e.service"}' > ${join(requests, 'a.json.tmp')}` +
      ` && mv ${join(requests, 'a.json.tmp')} ${join(requests, 'a.json')}`,
    'sleep 2',
  ]);

  const executor = new Executor(host.config);
  await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'a task',
    task: 'install the new unit',
  });

  const installed = join(host.root, 'units-installed', 'clawcius-e2e.service');
  assert.equal(existsSync(installed), true, 'the executor installed it');
  assert.equal(statSync(installed).mode & 0o7777, 0o644);

  const entries = journalEntries(host.config);
  const unitEntry = entries.find((entry) => entry['kind'] === 'unit');
  assert.ok(unitEntry, 'the install is its own journal kind, not an audited sudo command');
  assert.equal(unitEntry?.['what'], 'install clawcius-e2e.service');
  assert.equal(unitEntry?.['command'], installed, 'the destination is recorded');
  assert.equal(
    unitEntry?.['requester'],
    'clawcius-coordinator',
    'and who asked for the task that did it — the mail row\'s author column',
  );

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
  await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'a task',
    task: 'the waker is wedged, work out why and fix it',
  });

  const call = host.claudeCall();
  assert.ok(call, 'the host agent must actually have been started');

  const prompt = call.argv[call.argv.indexOf('-p') + 1] ?? '';
  assert.match(prompt, /the waker is wedged, work out why and fix it/);
  assert.match(prompt, /by DM on the Clawsky board, by "clawcius-coordinator"/);

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
  await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'a task',
    task: 'do three things',
  });

  assert.deepEqual(auditedCommands(host.config), plan, 'every command, in order, byte for byte');

  // Written BEFORE the result is known, which is what makes the record survive
  // a process that dies mid-task. Asserted as an ordering in the journal: the
  // first audit entry precedes the `finished` entry rather than being flushed
  // with it.
  const kinds = journalEntries(host.config).map((entry) => entry['kind']);
  assert.ok(kinds.indexOf('audit') < kinds.lastIndexOf('finished'));

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
  await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'a task',
    task: 'create a file',
  });

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

test('a NODE_* variable is refused, because the drop now runs node as root first', () => {
  // Introduced with the #21 fix and worth its own test: the first process in
  // the session is `node -e <bootstrap>` and it is root until it calls setuid.
  // NODE_OPTIONS=--require=… would run a file of somebody's choosing as root
  // before any privilege had been dropped, which is a worse hole than the one
  // the bootstrap closes.
  for (const name of ['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_EXTRA_CA_CERTS']) {
    assert.throws(() => assertNoNodeOptions({ [name]: 'x' }), /runs as ROOT until it calls setuid/, name);
  }
  assert.doesNotThrow(() => assertNoNodeOptions({ PATH: '/usr/bin', NODEJS_HOME: '/x' }));

  // Unlike the credential check, envPassthrough does NOT exempt it: that key is
  // exactly the route by which one would arrive.
  const host = makeHost({
    dryRun: true,
    suffix: 'node-options',
    envPassthrough: ['NODE_OPTIONS'],
  });
  const previous = process.env['NODE_OPTIONS'];
  process.env['NODE_OPTIONS'] = '--require=/tmp/pwn.js';
  try {
    assert.throws(() => hostAgentEnv(host.config, host.agent), /NODE_OPTIONS/);
  } finally {
    if (previous === undefined) delete process.env['NODE_OPTIONS'];
    else process.env['NODE_OPTIONS'] = previous;
  }
});

test('the host agent environment is built from nothing and carries no token', () => {
  const host = makeHost({ dryRun: true, suffix: 'env' });
  const agent = host.agent;

  const previous = process.env['DISCORD_TOKEN'];
  const noise = process.env['SOMETHING_UNRELATED'];
  process.env['SOMETHING_UNRELATED'] = 'should not be inherited';
  try {
    const env = hostAgentEnv(host.config, agent);
    assert.equal(env['SOMETHING_UNRELATED'], undefined, 'an allowlist, not a filter');
    assert.equal(env['DISCORD_TOKEN'], undefined);
    // HOME is the SERVICE ACCOUNT's, not root's and — since 2026-08-11 — not
    // the operator's either. It is where Claude Code finds the OAuth
    // credentials it authenticates with, so this is the line that decides
    // whose login the session is using.
    assert.equal(env['HOME'], agent.home);
    assert.equal(env['USER'], agent.user);
    assert.equal(env['LOGNAME'], agent.user);
    assert.ok(!env['HOME']?.startsWith('/home/npurcell'), 'not the operator\'s home');
    assert.ok((env['PATH'] ?? '').includes('/usr/bin'));

    // And a token in the executor's own environment does not reach it — it
    // stops the session starting at all.
    process.env['DISCORD_TOKEN'] = 'a-very-real-looking-token-value';
    assert.doesNotThrow(() => hostAgentEnv(host.config, agent));
    assert.throws(
      () => assertNoSecrets({ ...hostAgentEnv(host.config, agent), DISCORD_TOKEN: 'x' }),
      /looks like a credential/,
    );
  } finally {
    if (previous === undefined) delete process.env['DISCORD_TOKEN'];
    else process.env['DISCORD_TOKEN'] = previous;
    if (noise === undefined) delete process.env['SOMETHING_UNRELATED'];
    else process.env['SOMETHING_UNRELATED'] = noise;
  }
});

// ══════════════════════════════════════════════════════════════════════════
// The service account — 2026-08-11
//
// Everything below runs with no root, no docker, no systemd and no
// `clawcius-ops` account on the machine: /etc/passwd and /etc/group are text
// files, so the checks that read them are tested against text files. That is
// the point of `hostAgent.passwdPath` and `hostAgent.groupPath` existing.
// ══════════════════════════════════════════════════════════════════════════

test('the named service account is resolved, with its primary and supplementary groups', () => {
  const host = makeHost({ dryRun: true, suffix: 'agent-resolve', agentGroups: ['clawcius-dev'] });
  const resolved = resolveAgentUser(host.config.hostAgent.user, {
    passwdPath: host.config.hostAgent.passwdPath,
    groupPath: host.config.hostAgent.groupPath,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  assert.equal(resolved.user.user, 'clawcius-ops');
  assert.ok(resolved.user.home.endsWith('agent-home'));
  assert.equal(resolved.user.shell, '/usr/sbin/nologin');
  // The primary group comes from the gid, the supplementary ones from the
  // member lists, and BOTH have to be looked at. A check that only read the
  // member lists would miss an account whose PRIMARY group is docker, which is
  // exactly how somebody would set this up without thinking about it.
  assert.ok(resolved.user.groups.includes('clawcius-ops'), 'primary group by gid');
  assert.ok(resolved.user.groups.includes('clawcius-dev'), 'supplementary group by membership');
  // The full gid list is what gets handed to setgroups(2) before the spawn.
  assert.deepEqual(resolved.user.gids, [resolved.user.gid, 1500]);
  assert.equal(forbiddenGroupsFor(resolved.user).length, 0, 'the shared group is not forbidden');
});

test('a primary group that is docker is caught, not just a supplementary one', () => {
  // Assembled by hand rather than through makeHost, because the fixture ties
  // the agent's primary gid to the test process's. The parser is what is under
  // test here and it is fed a group file where docker IS the primary group.
  const groups = parseGroups('docker:x:998:\nclawcius-dev:x:1500:clawcius-ops\n');
  const passwd = parsePasswd(
    'clawcius-ops:x:900:998:agent:/var/lib/clawcius-ops:/usr/sbin/nologin\n',
  );
  const entry = passwd[0];
  assert.ok(entry);
  const primary = groups.find((group) => group.gid === entry.gid);
  assert.equal(primary?.name, 'docker');

  const user: AgentUser = {
    user: entry.user,
    uid: entry.uid,
    gid: entry.gid,
    home: entry.home,
    shell: entry.shell,
    groups: ['docker', 'clawcius-dev'],
    gids: [998, 1500],
  };
  assert.deepEqual(forbiddenGroupsFor(user), ['docker']);
});

test('a missing service account refuses the task and never falls back', async () => {
  const host = makeHost({ dryRun: false, suffix: 'agent-missing', agentUser: 'nosuchagent' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);

  const executor = new Executor(host.config);
  const identity = executor.resolveAgentIdentity();
  assert.equal(identity.ok, false);

  await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'a task',
    task: 'do something',
  });

  const failed = journalEntries(host.config).filter((entry) => entry['kind'] === 'failed');
  assert.equal(failed.length, 1, 'the task fails, it does not run as somebody else');
  const detail = String(failed[0]?.['detail'] ?? '');
  assert.match(detail, /there is no user "nosuchagent"/);
  // The refusal has to carry the fix. A daemon that says "no" without saying
  // "run this" is a daemon somebody works around by hand.
  assert.match(detail, /useradd --system/);
  // And nothing was started. This is the assertion that matters: the old
  // behaviour was to stat the checkout and become its owner, which on this
  // host is the operator.
  assert.equal(host.claudeCall(), null, 'no session was spawned');
});

test('an agent account in the docker group refuses the task, with the gpasswd to run', async () => {
  const host = makeHost({ dryRun: false, suffix: 'agent-docker', agentGroups: ['docker'] });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);

  const executor = new Executor(host.config);
  const identity = executor.resolveAgentIdentity();
  assert.equal(identity.ok, true, 'the account exists; it is its membership that is wrong');
  if (!identity.ok) return;
  assert.deepEqual(forbiddenGroupsFor(identity.user), ['docker']);

  await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'a task',
    task: 'do something',
  });

  const failed = journalEntries(host.config).filter((entry) => entry['kind'] === 'failed');
  assert.equal(failed.length, 1);
  const detail = String(failed[0]?.['detail'] ?? '');
  assert.match(detail, /is in the "docker" group/);
  assert.match(detail, /docker run -v \/:\/host/);
  assert.match(detail, /sudo gpasswd -d clawcius-ops docker/);
  assert.equal(host.claudeCall(), null, 'no session was spawned');

  // The status file has to say so too. "hostAgent enabled: true" while every
  // task is being refused would be reassurance rather than status.
  const status = executor.snapshot();
  assert.equal(status.hostAgent.identity.ok, false);
  assert.match(status.hostAgent.identity.detail, /docker/);

  // And the innermost gate throws on its own, independently of the executor —
  // so a future code path that reaches the spawn without going through
  // #doTask still cannot start a session as a docker-group account.
  assert.throws(
    () => assertAgentIdentity(identity.user, identityOptionsFor(host.config)),
    /refusing to start the host agent[\s\S]*docker/,
  );
});

test('every root-equivalent group is refused, not just docker', () => {
  // A check that knows one name is a check that fails on the second one — the
  // same argument assertNoSecrets makes about credential-shaped variables.
  for (const group of Object.keys(ROOT_EQUIVALENT_GROUPS)) {
    const user: AgentUser = {
      user: 'clawcius-ops',
      uid: 900,
      gid: 900,
      home: '/var/lib/clawcius-ops',
      shell: '/usr/sbin/nologin',
      groups: ['clawcius-ops', group],
      gids: [900, 9000],
    };
    assert.deepEqual(forbiddenGroupsFor(user), [group], group);
    assert.throws(
      () => assertAgentIdentity(user, { forbiddenGroups: [], secretPaths: [] }),
      new RegExp(`is in the "${group}" group`),
      group,
    );
  }

  // hostAgent.forbiddenGroups only ever ADDS. There is deliberately no key
  // that takes `docker` off the list.
  const ordinary: AgentUser = {
    user: 'clawcius-ops',
    uid: 900,
    gid: 900,
    home: '/var/lib/clawcius-ops',
    shell: '/usr/sbin/nologin',
    groups: ['clawcius-ops', 'clawcius-dev'],
    gids: [900, 1500],
  };
  assert.equal(forbiddenGroupsFor(ordinary).length, 0);
  assert.deepEqual(forbiddenGroupsFor(ordinary, ['clawcius-dev']), ['clawcius-dev']);
});

test('an account with uid 0 is refused however it is spelled', () => {
  const root = makeHost({ dryRun: true, suffix: 'agent-root' });
  writeFileSync(
    join(root.root, 'passwd'),
    'toor:x:0:0:another root:/root:/bin/bash\n',
  );
  const resolved = resolveAgentUser('toor', {
    passwdPath: join(root.root, 'passwd'),
    groupPath: join(root.root, 'group'),
  });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, /has uid 0/);
});

test('an unreadable group file is a refusal, never a pass', () => {
  const host = makeHost({ dryRun: true, suffix: 'agent-nogroup' });
  const resolved = resolveAgentUser(host.config.hostAgent.user, {
    passwdPath: host.config.hostAgent.passwdPath,
    groupPath: join(host.root, 'group-that-does-not-exist'),
  });
  // The docker-group assertion is the one the rest of the design rests on, so
  // a check that cannot be evaluated must not read as a pass.
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, /must not fail\s+open/);
});

test('a secret the agent account can read refuses the task', async () => {
  // The envFile holds DISCORD_TOKEN on the real host, and it is folded into
  // the secret list automatically — asserting that the token is not in the
  // session's ENVIRONMENT means nothing if the session can `cat` the file.
  const host = makeHost({ dryRun: false, suffix: 'agent-secret', envFileMode: 0o644 });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);

  const executor = new Executor(host.config);
  await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'a task',
    task: 'do something',
  });

  const failed = journalEntries(host.config).filter((entry) => entry['kind'] === 'failed');
  assert.equal(failed.length, 1);
  const detail = String(failed[0]?.['detail'] ?? '');
  assert.match(detail, /can read .*env/);
  assert.match(detail, /chmod go-rwx/);
  assert.equal(host.claudeCall(), null, 'no session was spawned');

  // Tightening it lets the same task through, without a restart. The check is
  // evaluated per task on purpose.
  chmodSync(join(host.root, 'env'), 0o000);
  await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'a task',
    task: 'do something',
  });
  assert.notEqual(host.claudeCall(), null, 'the session starts once the secret is protected');
});

test('the readability check walks the directory it is in, not just the file', () => {
  const host = makeHost({ dryRun: true, suffix: 'agent-read' });
  const agent = host.agent;

  const dir = join(host.root, 'sealed');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'secret');
  writeFileSync(file, 'DISCORD_TOKEN=x\n');
  chmodSync(file, 0o644);
  assert.equal(canReadPath(file, agent).readable, true, '0644 in a traversable directory');

  // ~/.ssh is the shape that matters: 0600 keys inside a 0700 directory. A
  // check that only looked at the file would be right by accident here and
  // wrong about every 0644 file under a 0700 home.
  chmodSync(dir, 0o000);
  const verdict = canReadPath(file, agent);
  assert.equal(verdict.readable, false);
  assert.match(verdict.why, /not traversable/);
  chmodSync(dir, 0o700);
  assert.equal(canReadPath(file, agent).readable, true);

  // A path that does not exist is not readable — and it is reported with the
  // reason, so a typo in hostAgent.secretPaths does not read as "safe".
  const missing = canReadPath(join(dir, 'nope'), agent);
  assert.equal(missing.readable, false);
  assert.match(missing.why, /could not be stat'ed/);
});

test('a checkout the agent cannot write is a warning, not a refusal', async () => {
  const host = makeHost({ dryRun: false, suffix: 'agent-warn' });
  host.setStatus('clawcius', { at: Date.now(), liveCount: 0 });
  host.setPlan(['true']);

  // Take the write bit off the checkout. On the real host this is what a
  // missing shared group looks like: the agent user is not npurcell, the tree
  // is not group-writable, and every `npm ci` dies with an EACCES naming a
  // file nobody edited.
  chmodSync(join(host.root, 'repo'), 0o500);
  try {
    const warnings = agentWarnings(host.agent, identityOptionsFor(host.config));
    assert.ok(
      warnings.some((warning) => /cannot write/.test(warning) && /chgrp -R clawcius-dev/.test(warning)),
      'the warning names the fix',
    );
    // Warnings do not stop a task. A refusal here would mean a chmod nobody
    // noticed takes the whole ops mechanism offline, and the failure it is
    // warning about is loud on its own — the build fails, in the audit.
    assert.equal(agentProblems(host.agent, identityOptionsFor(host.config)).length, 0);

    const executor = new Executor(host.config);
    await executor.runMailTask({
      crew: 'clawcius',
      requester: 'clawcius-coordinator',
      subject: 'a task',
      task: 'do something',
    });
    assert.notEqual(host.claudeCall(), null, 'a warning does not stop the session');
    assert.ok(
      journalEntries(host.config).some((entry) =>
        /host agent identity warning/.test(String(entry['detail'] ?? '')),
      ),
      'and it is in the durable record',
    );
  } finally {
    chmodSync(join(host.root, 'repo'), 0o700);
  }
});

test('the standing prompt tells the session which account it holds', () => {
  const host = makeHost({ dryRun: false, suffix: 'agent-prompt' });
  const prompt = standingPrompt(host.config, false);
  assert.match(prompt, /unprivileged service account "clawcius-ops"/);
  assert.match(prompt, /NOT in the docker group/);
  // The self-restart rule is now enforced by the sudoers file as well as
  // stated here, and the prompt says so rather than leaving the session to
  // discover it as an unexplained refusal.
  assert.match(prompt, /clawcius-ops\.service is not on it/);
});

// ══════════════════════════════════════════════════════════════════════════
// The privilege drop — #21.
//
// The session came up as `clawcius-ops` holding only its primary group, while
// the boot banner and the session log line both named all three. Cause: libuv's
// `uv__process_child_init` runs `setgroups(0, NULL)` in the forked child
// whenever the `uid` OR `gid` spawn option is used, a few instructions before
// it calls setgid/setuid. So no arrangement of the PARENT's group list can ever
// reach the child, and the old `withSupplementaryGroups` could not have worked.
//
// None of that is executable here: this process is not root, so it cannot
// setgroups to anything and cannot observe a real drop. What IS executable, and
// is below, is everything the fix is made of —
//
//   * that `agent.gids` is numbers and never group names;
//   * that the spawn options carry no `uid`/`gid` on the bootstrap path, which
//     is the mistake, expressed as an assertion;
//   * the bootstrap itself, run end-to-end against the credentials this test
//     process already holds, proving it verifies against the kernel and then
//     replaces itself with the target — and that it REFUSES to exec anything
//     when the numbers do not match.
//
// The last of those is the important one. The reason #21 survived a boot
// banner, a session log line and two reviews is that nothing anywhere compared
// an observed credential with an intended one, and a check nobody can run
// without root is a check that rots. This one runs as anybody.
// ══════════════════════════════════════════════════════════════════════════

/** This test process, dressed as an AgentUser. The bootstrap should accept it. */
function selfAsAgent(): AgentUser {
  const gids = process.getgroups?.() ?? [];
  return {
    user: 'self',
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    home: tmpdir(),
    shell: '/usr/sbin/nologin',
    groups: ['self'],
    gids,
  };
}

function runBootstrap(intent: unknown): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['-e', PRIVILEGE_DROP_BOOTSTRAP, JSON.stringify(intent)],
    { encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('the gid list handed to setgroups is numbers, never group names', () => {
  // #21's first hypothesis, and the one worth nailing down permanently: a
  // STRING element would be resolved by process.setgroups() through NSS as a
  // group NAME. `groups` (names) and `gids` (numbers) are built on adjacent
  // lines from the same data and the log line prints the former, which is
  // exactly how you end up believing you passed the latter.
  const host = makeHost({ dryRun: true, suffix: 'gids-numeric', agentGroups: ['clawcius-dev'] });
  const resolved = resolveAgentUser(host.config.hostAgent.user, {
    passwdPath: host.config.hostAgent.passwdPath,
    groupPath: host.config.hostAgent.groupPath,
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  assert.ok(resolved.user.gids.length >= 2, 'primary plus at least one supplementary');
  for (const gid of resolved.user.gids) {
    assert.equal(typeof gid, 'number', `gid ${String(gid)} is a ${typeof gid}, not a number`);
    assert.ok(Number.isInteger(gid), `gid ${String(gid)} is not a whole number`);
  }
  assert.equal(resolved.user.gids[0], resolved.user.gid, 'primary gid first');
  assert.equal(
    resolved.user.gids.length,
    resolved.user.groups.length,
    'one gid per group name — if these ever diverge the log line stops describing the drop',
  );

  // A malformed /etc/group line cannot smuggle a NaN in either: the parser
  // drops the line rather than keeping a group with a broken gid.
  const junk = parseGroups('fine:x:1500:clawcius-ops\nbroken:x:notanumber:clawcius-ops\n');
  assert.deepEqual(junk.map((group) => group.name), ['fine']);
});

test('the session is never spawned with the uid/gid options — that is what clears the groups', () => {
  const agent = selfAsAgent();
  const base = { cwd: tmpdir(), env: { PATH: '/usr/bin' }, agent };

  // The fix, stated as an assertion. libuv calls setgroups(0, NULL) in the
  // child if EITHER of these keys is present, so their absence is not a detail
  // of the bootstrap — it IS the bootstrap working.
  const dropped = sessionSpawnOptions({ ...base, dropping: true, viaBootstrap: true });
  assert.equal('uid' in dropped, false, 'no uid option on the bootstrap path');
  assert.equal('gid' in dropped, false, 'no gid option on the bootstrap path');
  assert.equal(dropped.detached, true);
  assert.deepEqual(dropped.stdio, ['ignore', 'pipe', 'pipe']);

  // Not dropping at all (the self-test's own case) is likewise clean.
  const same = sessionSpawnOptions({ ...base, dropping: false, viaBootstrap: false });
  assert.equal('uid' in same, false);

  // The documented fallback for a node without process.execve does use them,
  // and the comment in host-agent.ts says what it costs: a session with an
  // empty supplementary list, which is less capable rather than less contained.
  const fallback = sessionSpawnOptions({ ...base, dropping: true, viaBootstrap: false });
  assert.equal(fallback.uid, agent.uid);
  assert.equal(fallback.gid, agent.gid);

  // And the launcher hands `spawn` this node plus the bootstrap, with the whole
  // intent in one JSON argument — no shell, so nothing to quote wrong even
  // when the task prompt is full of quotes and newlines.
  const argv = ['-p', 'a "quoted" prompt\nwith a newline and $HOME', '--verbose'];
  const launch = privilegeDropLaunch(agent, '/usr/local/bin/claude', argv);
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.argv[0], '-e');
  assert.equal(launch.argv[1], PRIVILEGE_DROP_BOOTSTRAP);
  const payload = JSON.parse(launch.argv[2] ?? '{}') as Record<string, unknown>;
  assert.equal(payload['uid'], agent.uid);
  assert.equal(payload['gid'], agent.gid);
  assert.deepEqual(payload['gids'], agent.gids);
  assert.equal(payload['command'], '/usr/local/bin/claude');
  assert.deepEqual(payload['argv'], argv);
});

test('the privilege-drop bootstrap verifies against the kernel and then execs', () => {
  // Runnable without root because the bootstrap is idempotent: handed the
  // credentials this process already holds, it makes no syscall, reads them
  // back from the kernel anyway, and execs. That short-circuit is the only
  // reason this code is testable at all, and untestable is how the last
  // version of it shipped broken.
  assert.equal(supportsExecve(), true, 'node >= 22.15 — the fallback path is not what ships');
  const me = selfAsAgent();
  const launch = privilegeDropLaunch(me, '/bin/sh', ['-c', 'echo I-AM-THE-SESSION']);
  const run = spawnSync(launch.command, launch.argv, { encoding: 'utf8' });

  assert.equal(run.status, 0, run.stderr);
  // execve REPLACED the bootstrap: this is the target's stdout on the same pid,
  // which is what keeps child.pid, killTree and the detached process group
  // meaning what they meant before.
  assert.match(run.stdout, /I-AM-THE-SESSION/);

  const line = run.stderr.split('\n').find((l) => l.includes(CREDENTIAL_REPORT_MARKER));
  assert.ok(line, `no credential report in stderr: ${run.stderr}`);
  const report = parseCredentialReport(line);
  assert.ok(report, 'the credential report parses');
  assert.equal(report.uid, me.uid);
  assert.equal(report.gid, me.gid);
  // Observed, not intended. This is the line whose absence is the whole bug.
  assert.equal(credentialComplaint(me, report), null);
  assert.match(describeCredentials(me, report), /read back from the kernel/);
});

test('the bootstrap refuses to exec anything when the credentials would be wrong', () => {
  const me = selfAsAgent();
  const base = {
    uid: me.uid,
    gid: me.gid,
    gids: me.gids,
    command: '/bin/sh',
    // If any of these cases reaches execve the test fails loudly rather than
    // silently: NOTHING is allowed to run when the drop did not take.
    argv: ['-c', 'echo THIS-MUST-NEVER-RUN'],
  };

  const cases: Array<[string, unknown, RegExp]> = [
    // #21's first hypothesis. A string here would be resolved as a group NAME.
    ['a group name instead of a gid', { ...base, gids: ['clawcius-dev'] }, /not a number/],
    ['a uid this process cannot take', { ...base, uid: me.uid + 1 }, /not root/],
    ['a group list this process does not hold', { ...base, gids: [...me.gids, 4242] }, /not root/],
    ['uid 0', { ...base, uid: 0 }, /refusing to "drop" to uid 0/],
    ['a claudePath that is not executable', { ...base, command: '/etc/hostname' }, /not executable/],
  ];

  for (const [what, intent, expected] of cases) {
    const run = runBootstrap(intent);
    assert.equal(run.status, PRIVILEGE_DROP_EXIT, `${what}: expected a refusal, got ${run.stderr}`);
    assert.match(run.stderr, expected, what);
    assert.doesNotMatch(run.stdout, /THIS-MUST-NEVER-RUN/, `${what}: the session must not start`);
    assert.doesNotMatch(run.stderr, new RegExp(CREDENTIAL_REPORT_MARKER.trim()), `${what}: no report`);
  }
});

test('credentialComplaint names the difference between what was asked for and what happened', () => {
  const agent: AgentUser = {
    user: 'clawcius-ops',
    uid: 997,
    gid: 988,
    home: '/var/lib/clawcius-agent',
    shell: '/usr/sbin/nologin',
    groups: ['clawcius-ops', 'clawcius-dev', 'systemd-journal'],
    gids: [988, 1500, 999],
  };

  assert.equal(credentialComplaint(agent, { uid: 997, gid: 988, groups: [988, 999, 1500] }), null);

  // The exact shape of #21: the session reported `groups=988(clawcius-ops)`.
  const observed = credentialComplaint(agent, { uid: 997, gid: 988, groups: [988] });
  assert.ok(observed);
  assert.match(observed, /groups are \[988\], expected \[988,999,1500\]/);
  assert.match(observed, /missing 999,1500/);

  // And the shape the OLD comment feared — the child still carrying root's list.
  const roots = credentialComplaint(agent, { uid: 997, gid: 988, groups: [0, 988] });
  assert.ok(roots);
  assert.match(roots, /unexpected 0/);

  const wrongUser = credentialComplaint(agent, { uid: 1000, gid: 1000, groups: [988, 999, 1500] });
  assert.ok(wrongUser);
  assert.match(wrongUser, /uid is 1000, expected 997/);
  assert.match(wrongUser, /gid is 1000, expected 988/);

  // Report parsing fails closed: anything that is not a credential line is not
  // mistaken for one, so "no report" can never look like "a clean report".
  assert.equal(parseCredentialReport('claude: some ordinary stderr'), null);
  assert.equal(parseCredentialReport(`${CREDENTIAL_REPORT_MARKER}not json`), null);
  assert.equal(parseCredentialReport(`${CREDENTIAL_REPORT_MARKER}{"uid":"997"}`), null);
  assert.equal(parseCredentialReport(`${CREDENTIAL_REPORT_MARKER}{"uid":1,"gid":2}`), null);
  assert.deepEqual(parseCredentialReport(`${CREDENTIAL_REPORT_MARKER}{"uid":1,"gid":2,"groups":[2]}`), {
    uid: 1,
    gid: 2,
    groups: [2],
  });
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
  await executor.runMailTask({
    crew: 'clawcius',
    requester: 'clawcius-coordinator',
    subject: 'a task',
    task: 'take a snapshot',
  });

  const payload = JSON.parse(
    readFileSync(join(host.config.stateDir, 'ops-status.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(payload['service'], 'clawcius-ops');
  const state = payload['state'] as Record<string, unknown>;
  assert.equal(state['current'], 'idle');
  assert.equal(state['dryRun'], true);
  assert.ok(Array.isArray(payload['events']));

  // Which code wrote the file. Without this, `ops-status.json` describes the
  // daemon's state in detail and says nothing about whether the daemon is the
  // commit anybody deployed — which is #89: 22,675 consecutive failed starts
  // on a `dist/` older than its own config, found by listing a directory.
  //
  // The value is asserted as PRESENT and SHAPED, not as any particular sha:
  // it is whatever the generator baked in, and in a temporary checkout or a
  // tarball that is legitimately `null` with a reason.
  const build = payload['build'] as Record<string, unknown> | undefined;
  assert.ok(build, 'ops-status.json must say which build wrote it');
  assert.equal(build['service'], 'clawcius-ops');
  assert.ok('commit' in build, 'build.commit must be present, even when null');
  assert.equal(typeof build['line'], 'string');
  // `dirty` is a tri-state on purpose. `false` means git said clean; `null`
  // means git could not be asked, and rendering that as clean is the lie the
  // whole mechanism exists to avoid.
  assert.ok(
    build['dirty'] === true || build['dirty'] === false || build['dirty'] === null,
    'build.dirty must be true, false or null — never absent',
  );
  if (build['commit'] === null) {
    assert.equal(build['dirty'], null, 'an unknown commit cannot have a known tree state');
    assert.equal(typeof build['unknownReason'], 'string');
    assert.match(build['line'] as string, /^UNKNOWN — /);
  }

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
// ── Containment, across every instance's bind mount ───────────────────────
