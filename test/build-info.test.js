/**
 * scripts/build-info.mjs — the thing that lets a journal answer "did the deploy
 * work?".
 *
 * These run the real script against real temporary git repositories, because
 * every property worth having here is a property of what git actually says:
 * that a dirty tree is reported as dirty, that a detached HEAD is not printed
 * as a branch, that a directory with no repository above it produces UNKNOWN
 * rather than something plausible, and that none of those cases is allowed to
 * fail the build.
 *
 * The generated file is `import()`ed as TypeScript-flavoured source, so it is
 * checked by parsing the JSON out of it rather than by executing it — the
 * script's contract is the shape of `BUILD_INFO`, and asserting on the emitted
 * text keeps the test from depending on a compiler.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'build-info.mjs');

/** git, with an identity, so these tests do not depend on the runner's gitconfig. */
function git(cwd, args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A temporary package directory, optionally inside a fresh git repository. */
function scratch({ repo = true, packageName = 'scratch-pkg' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'build-info-'));
  const pkgDir = join(dir, 'pkg');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    `${JSON.stringify({ name: packageName, version: '9.9.9' }, null, 2)}\n`,
  );
  if (repo) {
    git(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'tracked.txt'), 'one\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'initial']);
  }
  return { dir, pkgDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run the generator in `pkgDir` and give back its exit code plus the parsed object. */
function generate(pkgDir) {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: pkgDir, encoding: 'utf8' });
  const out = join(pkgDir, 'src', 'build-info.ts');
  let info = null;
  try {
    const source = readFileSync(out, 'utf8');
    const start = source.indexOf('export const BUILD_INFO: BuildInfo = ');
    assert.notEqual(start, -1, 'generated file has no BUILD_INFO export');
    const json = source.slice(source.indexOf('{', start), source.lastIndexOf('}') + 1);
    info = JSON.parse(json);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    info = { readError: String(error) };
  }
  return { status: result.status, stderr: result.stderr, info, path: out };
}

test('a clean checkout is reported as the commit it is, and as clean', () => {
  const { dir, pkgDir, cleanup } = scratch();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const { status, info } = generate(pkgDir);

    assert.equal(status, 0);
    assert.equal(info.commit, head);
    assert.equal(info.shortCommit, head.slice(0, 7));
    assert.equal(info.branch, 'main');
    assert.equal(info.dirty, false);
    assert.deepEqual(info.dirtyFiles, []);
    assert.equal(info.unknownReason, null);
    assert.match(info.line, /^[0-9a-f]{7} \(main\) built .* from a clean tree$/);
  } finally {
    cleanup();
  }
});

test('the package names itself, so one journal line identifies which service it is', () => {
  const { pkgDir, cleanup } = scratch({ packageName: 'clawcius-imaginary' });
  try {
    const { info } = generate(pkgDir);
    assert.equal(info.service, 'clawcius-imaginary');
    assert.equal(info.version, '9.9.9');
  } finally {
    cleanup();
  }
});

test('a modified tracked file makes the build DIRTY and names the file', () => {
  const { dir, pkgDir, cleanup } = scratch();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'two\n');
    const { status, info } = generate(pkgDir);

    assert.equal(status, 0);
    assert.equal(info.dirty, true);
    assert.deepEqual(info.dirtyFiles, ['tracked.txt']);
    assert.equal(info.dirtyFileCount, 1);
    assert.match(info.line, /from a DIRTY tree — 1 uncommitted path\(s\): tracked\.txt/);
    // The sha is still printed, and it is explicitly disowned. A sha over a
    // dirty tree that did not say so would be the exact lie this is for.
    assert.match(info.line, /This artefact is NOT [0-9a-f]{7}\./);
  } finally {
    cleanup();
  }
});

test('an untracked file counts as dirty — a hand-built dist is not a clean tree', () => {
  const { dir, pkgDir, cleanup } = scratch();
  try {
    writeFileSync(join(dir, 'left-behind.txt'), 'hotfix\n');
    const { info } = generate(pkgDir);
    assert.equal(info.dirty, true);
    assert.ok(info.dirtyFiles.includes('left-behind.txt'), info.dirtyFiles.join(','));
  } finally {
    cleanup();
  }
});

test('a gitignored file does not make the build dirty', () => {
  const { dir, pkgDir, cleanup } = scratch();
  try {
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'ignore']);
    writeFileSync(join(dir, 'ignored.txt'), 'noise\n');

    const { info } = generate(pkgDir);
    // This is the property that lets the generated file itself be gitignored
    // without every build declaring itself dirty for having run.
    assert.equal(info.dirty, false);
  } finally {
    cleanup();
  }
});

test('the line shows ten names; the data keeps more, up to its own cap', () => {
  const { dir, pkgDir, cleanup } = scratch();
  try {
    // 14 — above what the line prints and below what the data keeps, so this
    // pins the gap between the two limits. The cap itself is the next test.
    for (let index = 0; index < 14; index += 1) {
      writeFileSync(join(dir, `f${String(index).padStart(2, '0')}.txt`), 'x\n');
    }
    const { info } = generate(pkgDir);
    assert.equal(info.dirtyFileCount, 14);
    assert.equal(info.dirtyFiles.length, 14);
    assert.match(info.line, /14 uncommitted path\(s\)/);
    assert.match(info.line, /, and 4 more\./);
  } finally {
    cleanup();
  }
});

test('the dirty list is capped in the data, and the COUNT still tells the truth', () => {
  const { dir, pkgDir, cleanup } = scratch();
  try {
    for (let index = 0; index < 262; index += 1) {
      writeFileSync(join(dir, `f${String(index).padStart(3, '0')}.txt`), 'x\n');
    }
    const { info } = generate(pkgDir);

    // 262 is the number OJ reproduced on #98, which produced a 10098-byte
    // waker-status.json — over `MAX_STATUS_BYTES`, so ops read the instance as
    // BUSY. And because the value is compiled in, every publish from that
    // artefact would have been the same oversized file: not a transient fat
    // write, but an instance that is never idle again for the life of the
    // build, with the journal blaming the waker for it.
    assert.equal(info.dirtyFileCount, 262, 'the count is uncapped and authoritative');
    assert.equal(info.dirtyFiles.length, 20, 'the list is capped');
    assert.match(info.line, /262 uncommitted path\(s\)/);
    assert.match(info.line, /, and 252 more\./);
  } finally {
    cleanup();
  }
});

test('a very long path is elided rather than carried whole', () => {
  const { dir, pkgDir, cleanup } = scratch();
  try {
    // Nested deeply enough that the path exceeds the 100-character cap, with a
    // distinctive head and tail so the elision can be checked for keeping both.
    const deep = join(dir, 'aaaaaaaaaa', 'b'.repeat(40), 'c'.repeat(40), 'ddddddddd');
    mkdirSync(deep, { recursive: true });
    const file = join(deep, 'the-file-that-matters.txt');
    writeFileSync(file, 'x\n');

    // Committed first, then modified. An UNTRACKED file inside a new directory
    // is collapsed by `git status --porcelain` to the directory alone
    // (`aaaaaaaaaa/`), which is 11 characters and would not exercise the cap at
    // all — the long-path case only arrives via a tracked file.
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'deep']);
    writeFileSync(file, 'y\n');

    const { info } = generate(pkgDir);
    const path = info.dirtyFiles[0];
    assert.ok(path.length <= 100, `path is ${path.length} characters: ${path}`);
    assert.ok(path.includes('…'), 'an elided path must say so');
    // Both ends survive: the head names the package, the tail names the file.
    assert.match(path, /^aaaaaaaaaa\//);
    assert.match(path, /the-file-that-matters\.txt$/);
  } finally {
    cleanup();
  }
});

test('the worst case BUILD_INFO leaves room under the reader ops actually uses', () => {
  // The coupling this exists for: `waker-status.json` embeds BUILD_INFO whole,
  // and ops/src/idle.ts treats anything over MAX_STATUS_BYTES as BUSY rather
  // than as unreadable. A ceiling that can still be crossed is the same bug
  // with a bigger number, so the real constant is read out of the real file —
  // lowering it, or raising a cap in the generator, fails here.
  const idle = readFileSync(join(REPO_ROOT, 'ops', 'src', 'idle.ts'), 'utf8');
  const declared = /const MAX_STATUS_BYTES = (\d+) \* (\d+);/.exec(idle);
  assert.ok(declared, 'could not find MAX_STATUS_BYTES in ops/src/idle.ts');
  const maxStatusBytes = Number(declared[1]) * Number(declared[2]);
  assert.equal(maxStatusBytes, 8192);

  // Built to the generator's documented caps: 20 paths of 100 characters, every
  // other string at its own limit.
  const worstBuild = {
    service: 'S'.repeat(200),
    version: 'V'.repeat(200),
    commit: 'a'.repeat(40),
    shortCommit: 'a'.repeat(7),
    branch: 'B'.repeat(200),
    repoRoot: 'R'.repeat(200),
    dirty: true,
    dirtyFileCount: 999999,
    dirtyFiles: Array.from({ length: 20 }, () => 'p'.repeat(100)),
    builtAt: new Date().toISOString(),
    unknownReason: 'U'.repeat(300),
    // The line carries ten of those paths plus its prose.
    line: `${'L'.repeat(300)}${Array.from({ length: 10 }, () => 'p'.repeat(100)).join(', ')}`,
  };

  // The whole file as waker-status.ts writes it: pretty-printed at indent 2,
  // with every one of the waker's own fields present at a generous width.
  const worstFile = `${JSON.stringify(
    {
      build: worstBuild,
      instance: 'I'.repeat(64),
      liveCount: 99,
      maxConcurrent: 99,
      pid: 4194304,
      at: Date.now(),
      atIso: new Date().toISOString(),
      publishIntervalSeconds: 3600,
    },
    null,
    2,
  )}\n`;

  assert.ok(
    Buffer.byteLength(worstFile) < maxStatusBytes,
    `worst-case waker-status.json is ${Buffer.byteLength(worstFile)} bytes against a ` +
      `${maxStatusBytes}-byte ceiling — ops would read every publish from such a build as ` +
      'BUSY, for the life of that build',
  );
});

test('a detached HEAD is not printed as a branch called HEAD', () => {
  const { dir, pkgDir, cleanup } = scratch();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '-q', '--detach', head]);

    const { info } = generate(pkgDir);
    assert.equal(info.branch, null);
    assert.match(info.line, /\(detached HEAD\)/);
    assert.doesNotMatch(info.line, /\(HEAD\)/);
  } finally {
    cleanup();
  }
});

test('no git repository yields UNKNOWN, not a plausible-looking answer', () => {
  const { pkgDir, cleanup } = scratch({ repo: false });
  try {
    const { status, info } = generate(pkgDir);

    // NOT KNOWING is not a failure. A service that cannot name itself must
    // still ship, saying so. (Not WRITING is a failure — see below.)
    assert.equal(status, 0);
    assert.equal(info.commit, null);
    assert.equal(info.shortCommit, null);
    // Not `false`. "We could not ask" and "the tree was clean" are different
    // facts and only one of them is reassuring.
    assert.equal(info.dirty, null);
    // And the count tracks it. A `0` sitting beside an unknown reads as "no
    // dirty files" rather than "nobody looked", in a field a person scans.
    assert.equal(info.dirtyFileCount, null);
    assert.ok(typeof info.unknownReason === 'string' && info.unknownReason.length > 0);
    assert.match(info.line, /^UNKNOWN — /);
  } finally {
    cleanup();
  }
});

test('the generated file is written even when git cannot be found at all', () => {
  const { pkgDir, cleanup } = scratch({ repo: false });
  try {
    // An empty PATH: `git` is not resolvable, which is the deployed-from-a-
    // tarball case as well as the broken-image case.
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: pkgDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 0, result.stderr);

    const source = readFileSync(join(pkgDir, 'src', 'build-info.ts'), 'utf8');
    assert.match(source, /"commit": null/);
    assert.match(source, /UNKNOWN — /);
  } finally {
    cleanup();
  }
});

/**
 * Every package in this repository, DISCOVERED rather than listed.
 *
 * The first draft of the two sweeps below iterated `['.', 'status', 'ops']`
 * while calling itself the check for something that would otherwise be
 * remembered — which it was not. A fourth package would have been exactly as
 * invisible to a hardcoded array as to memory, and a silent partial sweep
 * reading as complete is the defect this entire change is about. Git is asked
 * instead, so adding `foo/` and forgetting its generator fails here.
 */
function packageDirs() {
  const listed = spawnSync('git', ['ls-files', '--', 'package.json', '*/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const dirs = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => (path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length)));

  // Discovery returning nothing would make every assertion below vacuously
  // pass, and a green sweep over an empty list is worse than no sweep.
  assert.ok(dirs.includes('.'), `the root package was not discovered (found: ${dirs.join(', ')})`);
  assert.ok(dirs.length >= 3, `expected at least three packages, found: ${dirs.join(', ')}`);
  return dirs;
}

test('every package wires the generator into build, typecheck and dev', () => {
  // The generated file is gitignored, so a package that forgot this line does
  // not fail loudly on the author's machine — it fails on a fresh clone, or
  // worse, compiles against a stale one.
  //
  // `dev` is asserted too. All three are correct today; it is the assertion
  // that was missing, which makes `dev` the one that can be dropped later with
  // nothing noticing — and it would then fail to resolve `./build-info.js` at
  // the moment somebody was trying to reproduce something.
  for (const pkg of packageDirs()) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pkg, 'package.json'), 'utf8'));
    for (const script of ['build', 'typecheck', 'dev']) {
      assert.ok(manifest.scripts?.[script], `${pkg}/package.json has no scripts.${script}`);
      assert.match(
        manifest.scripts[script],
        /build-info\.mjs/,
        `${pkg}/package.json scripts.${script} does not run the build-info generator`,
      );
    }
  }
});

test('an unwritable output stops the build, with a sentence rather than a stack', (t) => {
  // The one case where failing IS right: `&& tsc` continuing here would compile
  // against whatever build-info.ts an earlier build left behind, so the
  // artefact would report someone else's commit — the same lie by a new route.
  // Root ignores the mode bits, so this cannot be produced as root; saying so
  // beats passing quietly.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root — mode 0500 is not a write failure for uid 0');
    return;
  }

  const { pkgDir, cleanup } = scratch();
  const src = join(pkgDir, 'src');
  try {
    chmodSync(src, 0o500);
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: pkgDir, encoding: 'utf8' });

    assert.equal(result.status, 1, 'a write failure must stop the build');
    assert.match(result.stderr, /CANNOT WRITE/);
    assert.match(result.stderr, /build-info\.ts/, 'the message must name the file');
    assert.match(result.stderr, /previous build/, 'and say why continuing would be wrong');
    // A raw ERR_ stack is the thing this replaced.
    assert.doesNotMatch(result.stderr, /at Object\.<anonymous>/);
  } finally {
    chmodSync(src, 0o700);
    cleanup();
  }
});

test('the banner is printed even when the process is about to die in its config loader', () => {
  // The point of the whole mechanism. `src/config.ts` throws at IMPORT time on
  // a missing environment variable, so this is a waker that cannot start — the
  // #89 shape, where 22,675 consecutive failed starts said nothing about which
  // `dist/` was failing. The banner has to come out of that process anyway,
  // which is why it lives in a module imported before `./config.js` rather than
  // in the body of index.ts.
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const result = spawnSync(process.execPath, [join(root, 'dist', 'index.js')], {
    cwd: root,
    encoding: 'utf8',
    // A deliberately empty environment for the variables config.ts requires.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    timeout: 30_000,
  });

  assert.notEqual(result.status, 0, 'this run is expected to fail; that is the scenario');
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /\[clawcius\] build /, `no build banner in:\n${output.slice(0, 2000)}`);
  // And it really did die where the test claims it did.
  assert.match(output, /Missing required environment variable/);
});

test('every generated build-info.ts is gitignored', () => {
  for (const pkg of packageDirs()) {
    const target = join(REPO_ROOT, pkg, 'src', 'build-info.ts');
    const result = spawnSync('git', ['check-ignore', '-q', target], { cwd: REPO_ROOT });
    assert.equal(
      result.status,
      0,
      `${target} is not gitignored — every build would rewrite a tracked file, so every ` +
        'build would leave the tree dirty and every artefact would report itself dirty',
    );
  }
});
