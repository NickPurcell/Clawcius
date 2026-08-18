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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(fileURLToPath(import.meta.url), '..', '..', 'scripts', 'build-info.mjs');

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

test('the long dirty list is truncated in the line but kept whole in the data', () => {
  const { dir, pkgDir, cleanup } = scratch();
  try {
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

    // The build still succeeds. A service that cannot name itself must still
    // ship; a build that fails because of it helps nobody.
    assert.equal(status, 0);
    assert.equal(info.commit, null);
    assert.equal(info.shortCommit, null);
    // Not `false`. "We could not ask" and "the tree was clean" are different
    // facts and only one of them is reassuring.
    assert.equal(info.dirty, null);
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

test('every package that is built wires the generator into its build script', () => {
  // The generated file is gitignored, so a package that forgot this line does
  // not fail loudly on the author's machine — it fails on a fresh clone, or
  // worse, compiles against a stale one. A silent partial sweep is the defect
  // this whole change is about, so it is asserted rather than remembered.
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  for (const pkg of ['.', 'status', 'ops']) {
    const manifest = JSON.parse(readFileSync(join(root, pkg, 'package.json'), 'utf8'));
    for (const script of ['build', 'typecheck']) {
      assert.match(
        manifest.scripts[script],
        /build-info\.mjs/,
        `${pkg}/package.json scripts.${script} does not run the build-info generator`,
      );
    }
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
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  for (const pkg of ['.', 'status', 'ops']) {
    const target = join(root, pkg, 'src', 'build-info.ts');
    const result = spawnSync('git', ['check-ignore', '-q', target], { cwd: root });
    assert.equal(
      result.status,
      0,
      `${target} is not gitignored — every build would rewrite a tracked file, so every ` +
        'build would leave the tree dirty and every artefact would report itself dirty',
    );
  }
});
