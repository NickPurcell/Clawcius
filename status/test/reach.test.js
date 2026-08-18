/**
 * reach.ts — what this process can actually reach.
 *
 * The point of every one of these is the difference between a statement about
 * `status-config.yaml` and a statement about the world. The old boot banner
 * printed the configured path and nothing else, which reads the same on a host
 * where the path was renamed; these assert that each way a path can be unusable
 * produces a distinguishable sentence with an errno in it, and — for the two
 * cases where the config is not merely absent but wrong — that it says what was
 * found instead.
 *
 * A board is probed as a FILE here. Whether it can be QUERIED is a different
 * question, answered by `describeBoardError` in registry.ts, and #72 is the gap
 * between them: a readable file in WAL mode with no `-shm` is unqueryable by
 * this service. That is deliberately not duplicated in reach.ts.
 */

import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { probe, probeAll, processIdentity, targetsFor } = await import('../dist/reach.js');

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'reach-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a readable directory reports its entry count, mode and owner', async () => {
  const { dir, cleanup } = scratch();
  try {
    const root = join(dir, 'projects');
    mkdirSync(root);
    mkdirSync(join(root, 'session-a'));
    mkdirSync(join(root, 'session-b'));

    const result = await probe({ scope: 'clawcius', what: 'projects root', path: root, kind: 'directory' });
    assert.equal(result.ok, true);
    assert.match(result.detail, /readable directory, 2 entries/);
    assert.match(result.detail, /mode 0[0-7]{3}/);
    assert.match(result.detail, /owned by uid \d+:gid \d+/);
    assert.ok(Date.parse(result.checkedAt) > 0, 'every result carries when it was checked');
  } finally {
    cleanup();
  }
});

test('one entry is "1 entry", not "1 entries" — this line is read by people', async () => {
  const { dir, cleanup } = scratch();
  try {
    mkdirSync(join(dir, 'only'));
    const result = await probe({ scope: 'x', what: 'root', path: dir, kind: 'directory' });
    assert.match(result.detail, /1 entry,/);
  } finally {
    cleanup();
  }
});

test('a missing path says ENOENT and says what that means', async () => {
  const { dir, cleanup } = scratch();
  try {
    const result = await probe({
      scope: 'clawcius',
      what: 'projects root',
      path: join(dir, 'renamed-last-tuesday'),
      kind: 'directory',
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /^ENOENT: nothing exists at this path/);
  } finally {
    cleanup();
  }
});

test('a file where a directory was configured is named as such, not as missing', async () => {
  const { dir, cleanup } = scratch();
  try {
    const path = join(dir, 'projects');
    writeFileSync(path, 'not a directory\n');
    const result = await probe({ scope: 'clawcius', what: 'projects root', path, kind: 'directory' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not a directory — this path is a regular file/);
  } finally {
    cleanup();
  }
});

test('a directory where a board file was configured is named as such', async () => {
  const { dir, cleanup } = scratch();
  try {
    const path = join(dir, 'clawcius.db');
    mkdirSync(path);
    const result = await probe({ scope: 'clawcius', what: 'board file', path, kind: 'file' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not a regular file — this path is a directory/);
  } finally {
    cleanup();
  }
});

test('a readable board file reports its size and mtime', async () => {
  const { dir, cleanup } = scratch();
  try {
    const path = join(dir, 'clawcius.db');
    writeFileSync(path, 'sixteen bytes!!\n');
    const result = await probe({ scope: 'clawcius', what: 'board file', path, kind: 'file' });
    assert.equal(result.ok, true);
    assert.match(result.detail, /readable file, 16 bytes/);
    // The mtime is the answer to "is anything still writing to this board".
    assert.match(result.detail, /modified \d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup();
  }
});

test('a symlinked root is followed, because a symlinked deployment is normal', async () => {
  const { dir, cleanup } = scratch();
  try {
    const real = join(dir, 'real');
    mkdirSync(real);
    mkdirSync(join(real, 'session'));
    const link = join(dir, 'link');
    symlinkSync(real, link);

    const result = await probe({ scope: 'x', what: 'root', path: link, kind: 'directory' });
    assert.equal(result.ok, true);
    assert.match(result.detail, /readable directory, 1 entry/);
  } finally {
    cleanup();
  }
});

test('a dangling symlink is ENOENT rather than a confident "readable"', async () => {
  const { dir, cleanup } = scratch();
  try {
    const link = join(dir, 'link');
    symlinkSync(join(dir, 'gone'), link);
    const result = await probe({ scope: 'x', what: 'root', path: link, kind: 'directory' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /^ENOENT/);
  } finally {
    cleanup();
  }
});

test('a directory this process may not read says EACCES and prints the mode and owner', async (t) => {
  // Root can read anything, so this case cannot be produced as root. Skipping
  // is stated rather than silently passing: a green run under root has NOT
  // checked this, and that is the difference between a test and a decoration.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root — mode 0000 is not a permission failure for uid 0');
    return;
  }

  const { dir, cleanup } = scratch();
  try {
    const root = join(dir, 'projects');
    mkdirSync(root);
    chmodSync(root, 0o000);

    const result = await probe({ scope: 'clawcius', what: 'projects root', path: root, kind: 'directory' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /EACCES: it exists and this process is not permitted to read it/);
    // The fix for this on this host is always a group, and that conversation
    // starts with the mode and the owning uid.
    assert.match(result.detail, /mode 0000, owned by uid \d+/);
  } finally {
    chmodSync(join(dir, 'projects'), 0o700);
    cleanup();
  }
});

test('probeAll preserves order, so the banner reads the same every boot', async () => {
  const { dir, cleanup } = scratch();
  try {
    mkdirSync(join(dir, 'a'));
    const targets = [
      { scope: 'one', what: 'root', path: join(dir, 'a'), kind: 'directory' },
      { scope: 'two', what: 'root', path: join(dir, 'missing'), kind: 'directory' },
      { scope: 'three', what: 'root', path: dir, kind: 'directory' },
    ];
    const results = await probeAll(targets);
    assert.deepEqual(
      results.map((result) => result.scope),
      ['one', 'two', 'three'],
    );
    assert.deepEqual(
      results.map((result) => result.ok),
      [true, false, true],
    );
  } finally {
    cleanup();
  }
});

test('targetsFor covers every projects root, every configured board, and OJ', () => {
  const targets = targetsFor({
    agents: [
      { id: 'clawcius', projectsRoot: '/var/lib/clawcius/agent-home/projects', boardDb: '/var/lib/clawcius/clawcius.db' },
      // A board is optional; an instance without one must not produce a target
      // that would then be reported UNREACHABLE forever.
      { id: 'hamachi', projectsRoot: '/var/lib/hamachi/agent-home/projects', boardDb: null },
    ],
    oj: { workersRoot: '/var/lib/oj/workers' },
  });

  assert.deepEqual(
    targets.map((target) => [target.scope, target.kind, target.path]),
    [
      ['clawcius', 'directory', '/var/lib/clawcius/agent-home/projects'],
      ['clawcius', 'file', '/var/lib/clawcius/clawcius.db'],
      ['hamachi', 'directory', '/var/lib/hamachi/agent-home/projects'],
      ['oj', 'directory', '/var/lib/oj/workers'],
    ],
  );
});

test('the identity line names the uid the answers are about', () => {
  const identity = processIdentity();
  assert.match(identity, /^uid -?\d+, gid -?\d+, groups \[/);
});
