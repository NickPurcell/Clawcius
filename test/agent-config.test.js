/**
 * A file a privileged process trusts must not sit where the agent can write it.
 *
 * Two files are in that class. `status.file` is read by the ops executor, which
 * used to recreate containers on the strength of it; `container.execEnvDir`
 * holds this instance's Discord and GitHub tokens in plain text, and two of the
 * container's mounts are shared by BOTH deployments.
 *
 * The check for the first was wrong by exactly one directory level until
 * 2026-08-16 (Clawcius #55). It compared against `wake.spoolDir`, which was
 * `<stateDir>/run/wake`, while what `docker/run-container.sh` bind-mounts is its
 * PARENT, `<stateDir>/run`:
 *
 *     CLAWCIUS_STATE=${CLAWCIUS_STATE_DIR:-/var/lib/clawcius}
 *     -v "$CLAWCIUS_STATE/run:$CLAWCIUS_STATE/run:rw"
 *
 * So `<stateDir>/run/waker-status.json` passed every check in both loaders and
 * was writable by the agent — the precise file the comment above the check
 * describes as the one that must not be. Retiring the wake spool removed the key
 * the derivation came from, so `container.stateDir` now names the mount
 * directly.
 *
 * These drive the real loader against a real file, because the thing under test
 * is what a boot does with an operator's YAML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadAgentConfig } from '../dist/agent-config.js';

/** Exactly the lines given, for tests about the container block itself. */
function writeConfigRaw(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-'));
  const path = join(dir, 'agent-config.yaml');
  writeFileSync(path, [...lines, ''].join('\n'));
  return path;
}

/** A config with just enough in it to load, plus whatever is under test. */
function writeConfig(lines) {
  return writeConfigRaw(['container:', '  stateDir: /var/lib/x', ...lines]);
}

test('a status file inside the container mount is refused, not just one inside a spool', () => {
  // Clawcius #55, as reported: one level above the directory the old check
  // named, and inside the one the container actually gets.
  assert.throws(
    () =>
      loadAgentConfig(
        writeConfig([
          '  execEnvDir: /var/lib/x-env',
          'status:',
          '  file: /var/lib/x/run/waker-status.json',
        ]),
      ),
    /status\.file .* is inside .* bind-mounted read-write/,
  );

  // And the deeper path the old check did catch still fails, so this is wider
  // rather than different.
  assert.throws(
    () =>
      loadAgentConfig(
        writeConfig([
          '  execEnvDir: /var/lib/x-env',
          'status:',
          '  file: /var/lib/x/run/wake/waker-status.json',
        ]),
      ),
    /status\.file .* is inside .* bind-mounted read-write/,
  );
});

test('the default layout loads: every trusted path is a sibling of the mount', () => {
  const config = loadAgentConfig(
    writeConfig([
      '  execEnvDir: /var/lib/x/exec-env',
      'sessions:',
      '  workspaceRoot: /var/lib/x/workspaces',
      'status:',
      '  file: /var/lib/x/waker-status.json',
    ]),
  );
  assert.equal(config.container.stateDir, '/var/lib/x');
  assert.equal(config.status.file, '/var/lib/x/waker-status.json');
});

test('container.stateDir is required, absolute, and has no default', () => {
  // The three values OJ put through the loader in review of #67. Each one makes
  // the #55 fix pass a status.file that is inside a real bind mount, so each one
  // silently undoes the thing this key was added to do.

  // Relative: resolves against the WAKER'S cwd, so isInside() compares against a
  // directory that does not exist and everything passes.
  assert.throws(
    () =>
      loadAgentConfig(
        writeConfigRaw(['container:', '  stateDir: var/lib/x', '  execEnvDir: /var/lib/x-env']),
      ),
    /container\.stateDir .* must be an absolute path/,
  );

  // Empty: same, and it is what a half-finished edit leaves behind.
  assert.throws(
    () =>
      loadAgentConfig(writeConfigRaw(['container:', '  stateDir: ""', '  execEnvDir: /x-env'])),
    /container\.stateDir is required/,
  );

  // Absent: the one that would actually happen. The key is new; a default would
  // be /var/lib/clawcius, so an agent-config.hamachi.yaml that simply lacks it
  // would point Hamachi's containment check at CLAWCIUS's mount and wave
  // Hamachi's own run/ straight through.
  assert.throws(
    () => loadAgentConfig(writeConfigRaw(['container:', '  execEnvDir: /var/lib/x-env'])),
    /container\.stateDir is required and has no default/,
  );
});

test('both shipped agent configs set container.stateDir, and set it to their own', () => {
  // The check above only bites if somebody writes the key. This is the one that
  // says the two files in this repository are correct, and that they differ —
  // a copy-paste that left Hamachi pointing at /var/lib/clawcius would pass
  // every other test in this file.
  const clawcius = loadAgentConfig('agent-config.yaml');
  const hamachi = loadAgentConfig('agent-config.hamachi.yaml');
  assert.equal(clawcius.container.stateDir, '/var/lib/clawcius');
  assert.equal(hamachi.container.stateDir, '/var/lib/hamachi');
  assert.notEqual(clawcius.container.stateDir, hamachi.container.stateDir);
});

test('all three read-write mounts are checked, not just the one the spools lived in', () => {
  // `run-container.sh` mounts workspaces/, run/ and agent-home/ read-write, all
  // derived from CLAWCIUS_STATE. Until 2026-08-16 this file checked `run/` and
  // named agent-home as a known gap, while ops/src/config.ts checked all three
  // — two halves of one change disagreeing about the completeness of one
  // enumeration. Both files check three now.
  for (const child of ['run', 'workspaces', 'agent-home']) {
    assert.throws(
      () =>
        loadAgentConfig(
          writeConfig([
            '  execEnvDir: /var/lib/x-env',
            'status:',
            `  file: /var/lib/x/${child}/waker-status.json`,
          ]),
        ),
      /status\.file .* is inside .* bind-mounted read-write/,
      `a status file under ${child}/ must be refused`,
    );
    assert.throws(
      () => loadAgentConfig(writeConfig([`  execEnvDir: /var/lib/x/${child}/exec-env`])),
      /container\.execEnvDir .* is inside/,
      `an exec env directory under ${child}/ must be refused`,
    );
  }
});

test('the exec env directory is refused inside the container mount too', () => {
  // Same list, same rule. This one has always been checked against the mount;
  // the point of asserting it here is that both files now share one answer to
  // "where can the agent write", so a fix to one cannot drift from the other.
  assert.throws(
    () => loadAgentConfig(writeConfig(['  execEnvDir: /var/lib/x/run/exec-env'])),
    /container\.execEnvDir .* is inside/,
  );
});

test('a near-miss prefix is not containment', () => {
  // /var/lib/x-ops is not inside /var/lib/x, and a naive startsWith says it is.
  const config = loadAgentConfig(
    writeConfig(['  execEnvDir: /var/lib/x-ops/exec-env', 'status:', '  file: /var/lib/x-run/s.json']),
  );
  assert.equal(config.container.execEnvDir, '/var/lib/x-ops/exec-env');
});
