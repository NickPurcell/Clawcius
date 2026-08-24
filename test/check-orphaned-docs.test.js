/**
 * Tests for `scripts/check-orphaned-docs.mjs`.
 *
 * WHY THIS FILE EXISTS AT ALL. The script's failure mode has never been a false
 * alarm — it is printing `ok` about a question it did not ask. Three times it
 * has done exactly that: against a mistyped base ref, run from `ops/` where it
 * compared files across packages, and in its no-argument form after a commit.
 * A guard whose whole risk is silent success cannot be reviewed by reading it;
 * it has to be watched failing.
 *
 * So these drive the REAL SCRIPT as a subprocess, in a real git repository, and
 * assert on its exit code and its output. Not an extracted copy of the detector
 * — the thing that ships, with its `git rev-parse` precondition, its toplevel
 * anchoring and its `readdirSync('src')` all in play. An extracted function
 * would pass while the plumbing around it was broken, which is the shape of
 * defect this repository spent a day naming.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const SCRIPT = resolve('scripts/check-orphaned-docs.mjs');
const NODE_PATH = resolve('node_modules');

/** A throwaway git repo with `src/<name>.ts` committed, then rewritten. */
function repoWith({ committed, working }) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'test');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), committed ?? working);
  git('add', '-A');
  git('commit', '-qm', 'base');
  if (working !== undefined) writeFileSync(join(dir, 'src', 'a.ts'), working);
  return dir;
}

function run(dir, ...args) {
  // NODE_PATH so the script's `import ts from 'typescript'` resolves from this
  // repository's node_modules while running with the temp repo as cwd.
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('an orphaned block is reported, and the script exits non-zero', () => {
  // The shape from #241 and #234: a declaration inserted between an existing
  // doc block and the thing it documented. Two blocks in a row, last one wins,
  // and the first documents nothing. Invisible in a diff — the prose is
  // unchanged, in the same file, and now describes something else.
  const dir = repoWith({
    working: [
      '/** Header for the file. */',
      '',
      '/** Doc that WAS for `takeIt` and is now orphaned. */',
      '/** Doc for the type that was inserted. */',
      'export type Inserted = { x: number };',
      '',
      'export function takeIt(): void {}',
      '',
    ].join('\n'),
  });

  const { code, out } = run(dir, 'HEAD');
  assert.match(out, /ORPHANED\s+src\/a\.ts:3/, `expected an orphan at line 3 — got:\n${out}`);
  assert.match(out, /documents nothing/);
  assert.equal(code, 1, 'an orphaned block must fail the check');
});

test('a file-header block is not an orphan, even when nothing attaches to it', () => {
  // `types.ts` and `schedule.ts` both open this way: a one-line summary of the
  // file, a blank line, then a documented declaration. TypeScript attaches only
  // the LAST block before a statement, so the header attaches to nothing — and
  // flagging it would be a false alarm in two of the files most likely to be
  // opened by whoever runs this script for the first time.
  //
  // The exclusion is exactly one block wide, which the previous test pins from
  // the other side: its header is skipped and the orphan three lines later is
  // still reported.
  const dir = repoWith({
    working: [
      '/** Shared shapes, described for the reader of this file. */',
      '',
      '/** Doc for the constant. */',
      'export const X = 1;',
      '',
    ].join('\n'),
  });

  const { code, out } = run(dir, 'HEAD');
  assert.doesNotMatch(out, /ORPHANED/, `file header must not be reported — got:\n${out}`);
  assert.equal(code, 0);
});

test('a `/**` inside a template literal is not a comment', () => {
  // `src/agent-config.ts` holds a 3000-character template literal of prompt
  // prose. A regex over the file matches the delimiters inside it and reports
  // the system prompt as an orphaned docstring; reading comments off real
  // tokens cannot see into a string. This is the fixture that decides between
  // those two implementations.
  // NO HEADER BLOCK, so this isolates the string behaviour and nothing else.
  // With one, removing the header exclusion also turned this test red — it was
  // passing partly for a reason it does not claim, which is the same defect as
  // a test asserting on something adjacent to the thing that ships. The single
  // block here attaches to `PROSE`, so the ONLY way to produce an orphan is to
  // match the delimiters inside the template literal.
  const dir = repoWith({
    working: [
      '/** Doc for the constant. */',
      'export const PROSE = `a prompt mentioning /** and */ inline`;',
      '',
    ].join('\n'),
  });

  const { code, out } = run(dir, 'HEAD');
  assert.doesNotMatch(out, /ORPHANED/, `string contents must not be scanned — got:\n${out}`);
  assert.equal(code, 0);
});

test('a symbol that survives and loses its docs is still reported', () => {
  // The original check, kept because the orphan check cannot see this: the
  // block is not orphaned, it is gone. Nothing is left in the file to detect,
  // so only a comparison against the base finds it.
  // NO FILE HEADER IN THIS FIXTURE, deliberately. With one, deleting `f`'s own
  // block leaves the header as the last block before `f` — so it attaches to
  // `f`, the count stays at 1, and nothing is lost. That is correct behaviour
  // and it made the first version of this test assert on a case that cannot
  // arise. A leading declaration keeps the header rule out of the way.
  const dir = repoWith({
    committed: ['export const A = 1;', '', '/** Doc for f. */', 'export function f(): void {}', ''].join('\n'),
    working: ['export const A = 1;', '', 'export function f(): void {}', ''].join('\n'),
  });

  const { code, out } = run(dir, 'HEAD');
  assert.match(out, /LOST DOCS\s+src\/a\.ts\s+f: 1 block\(s\) -> 0/, `got:\n${out}`);
  assert.equal(code, 1);
});

test('a base ref that does not resolve exits 2 rather than reporting success', () => {
  // The fail-closed precondition. Before it existed, a mistyped base printed
  // `ok — 0 changed file(s)` and exited 0: a true-looking signal about a
  // question the script could not ask.
  const dir = repoWith({ working: ['/** Header. */', 'export const X = 1;', ''].join('\n') });

  const { code, out } = run(dir, 'no-such-ref');
  assert.match(out, /base ref does not resolve/);
  assert.equal(code, 2, 'an unresolvable base must not exit 0');
});

test('the orphan half still runs when the base comparison has nothing to compare', () => {
  // THE NO-ARGUMENT FORM USED TO BE VACUOUS AFTER A COMMIT. Tree and `HEAD`
  // agree, so the comparison has nothing to do and it printed `ok`, which was
  // correct and useless. The orphan check needs no base at all, so it is the
  // half that still means something in exactly that state — here the file is
  // committed and unmodified, and the orphan is still found.
  const orphaned = [
    '/** Header. */',
    '',
    '/** Doc that lost its declaration. */',
    '/** Doc for the type. */',
    'export type T = { x: number };',
    '',
    'export function g(): void {}',
    '',
  ].join('\n');
  const dir = repoWith({ committed: orphaned, working: orphaned });

  const { code, out } = run(dir);
  assert.match(out, /ORPHANED/, `got:\n${out}`);
  // The base half is legitimately silent here — tree and HEAD agree, so it has
  // nothing to compare. Asserted as the ABSENCE of a LOST DOCS line rather than
  // by matching the `0 changed file(s)` phrasing, which only ever appears in the
  // success summary and so could never have shown up beside a finding.
  assert.doesNotMatch(out, /LOST DOCS/);
  assert.equal(code, 1);
});

test('a block left at the END of a file, its declaration deleted, is reported', () => {
  // OJ #256 round 1, finding 1. TypeScript attaches a trailing JSDoc to
  // `EndOfFileToken`, so before this it looked ATTACHED and passed — and the
  // `LOST DOCS` half cannot see it either, because the symbol is gone and that
  // takes the `removed or renamed — a different question` branch.
  //
  // A block documenting nothing at the bottom of a file is the same defect as
  // one in the middle; only the node it happened to land on differed.
  const dir = repoWith({
    working: [
      '/** Header. */',
      '',
      'export const before = 1;',
      '',
      '/** Doc for a function somebody deleted. */',
      '',
    ].join('\n'),
  });

  const { code, out } = run(dir, 'HEAD');
  assert.match(out, /ORPHANED\s+src\/a\.ts:5/, `expected the trailing block — got:\n${out}`);
  assert.equal(code, 1);
});

test('the first block is excluded only when it is SET OFF like a header', () => {
  // OJ #256 round 1, finding 2. The rule excluded "the first block"; the header
  // and the comment both said "a file header". Those differ exactly where it
  // matters — in a file that opens straight into a documented declaration, the
  // orphan IS the first block, which is the #241 shape at the top of a NEW
  // file, and one of the two states this half exists to answer.
  //
  // A header is set off by a blank line. An orphan is butted against whatever
  // stole its declaration. That is the discriminator, and it is the shape
  // rather than the position.
  const dir = repoWith({
    working: [
      '/** Doc that WAS for TurnSettle and is now orphaned. */',
      '/** Doc for the newly inserted sdk. */',
      'export const sdk = 1;',
      '',
      'export class TurnSettle {}',
      '',
    ].join('\n'),
  });

  const { code, out } = run(dir, 'HEAD');
  assert.match(out, /ORPHANED\s+src\/a\.ts:1/, `first-block orphan must be reported — got:\n${out}`);
  assert.equal(code, 1);
});

test('a real 86-line-style header, set off by a blank line, is still not an orphan', () => {
  // The other side of the same rule, and the one that decides whether the fix
  // above is safe: `armed.ts` opens with a long header followed by a blank line
  // and then imports. Pinned here so a future tightening of the header test
  // cannot quietly start flagging every module in `src/`.
  // THE FIRST VERSION OF THIS TEST COULD NOT FAIL, and OJ found it by mutation:
  // delete the header exclusion entirely and it stayed green. Its fixture was a
  // header, a blank line, then `export const x = 1;` — and TypeScript ATTACHES a
  // header to the declaration below it when nothing sits between them, so the
  // block never reached the exclusion at all. It was passing for a reason it
  // does not claim.
  //
  // A header only becomes unattached when a SECOND documented declaration
  // follows it, which is the `types.ts` and `schedule.ts` shape. That is the
  // only arrangement where the exclusion is the thing keeping the run green,
  // and therefore the only one that pins it.
  const dir = repoWith({
    working: [
      '/**',
      ' * A long file header, of the kind every module here opens with.',
      ' *',
      ' * Several paragraphs, then a blank line, then the code.',
      ' */',
      '',
      '/** Doc for the constant, which takes the attachment. */',
      'export const x = 1;',
      '',
    ].join('\n'),
  });

  const { code, out } = run(dir, 'HEAD');
  assert.doesNotMatch(out, /ORPHANED/, `a set-off header is not an orphan — got:\n${out}`);
  assert.equal(code, 0);
});

test('the excerpt carries the block\'s first real line, not the delimiter', () => {
  // OJ #256 round 1, finding 3. Two of the three historical instances printed
  // `documents nothing — /**`, an excerpt doing no work in the common case.
  const dir = repoWith({
    working: [
      '/** Header. */',
      '',
      '/**',
      ' * What this block actually says.',
      ' */',
      '/** Doc for the type that displaced it. */',
      'export type T = { x: number };',
      '',
      'export function f(): void {}',
      '',
    ].join('\n'),
  });

  const { out } = run(dir, 'HEAD');
  assert.match(out, /What this block actually says/, `got:\n${out}`);
  assert.doesNotMatch(out, /documents nothing — \/\*\*\s*$/m, 'excerpt is the bare delimiter');
});

// ── the file set, and what `git ls-files` quietly changed about it ──────────
//
// Round 1's finding 5 was cosmetic: a generated, gitignored file made the
// headline count wobble between 26 and 27. The one-line fix for it — swapping
// `readdirSync` for `git ls-files` — brought three regressions, one of them this
// script's own named failure mode. These pin the file set itself, which nothing
// did before.

const ORPHAN_SRC = [
  '/** Header. */',
  '',
  '/** Doc that lost its declaration. */',
  '/** Doc for the type that displaced it. */',
  'export type T = { x: number };',
  '',
  'export function g(): void {}',
  '',
].join('\n');

test('a file written but not yet `git add`ed is still looked at', () => {
  // `git ls-files` reads the INDEX. A new file that has never been added is not
  // in it, so it dropped out of the sweep — and the summary counts what it
  // listed, so it read as a clean pass. That is the exact shape this script
  // exists to refuse: `ok` about a file it did not open.
  //
  // It is also the state a new file spends most of its life in, and the state
  // you are in at the moment `npm run check-docs` is documented as a pre-commit
  // check.
  const dir = repoWith({ working: ['/** Header. */', 'export const a = 1;', ''].join('\n') });
  writeFileSync(join(dir, 'src', 'brand-new.ts'), ORPHAN_SRC);

  const { code, out } = run(dir, 'HEAD');
  assert.match(out, /ORPHANED\s+src\/brand-new\.ts/, `untracked file skipped — got:\n${out}`);
  assert.equal(code, 1);
});

test('an ignored generated file is still left out', () => {
  // The other side of the same call: finding 5's fix must survive finding 1's.
  // `src/build-info.ts` is generated and gitignored, and the orphan half should
  // not be parsing generated output.
  const dir = repoWith({ working: ['/** Header. */', 'export const a = 1;', ''].join('\n') });
  writeFileSync(join(dir, '.gitignore'), 'src/generated.ts\n');
  writeFileSync(join(dir, 'src', 'generated.ts'), ORPHAN_SRC);

  const { code, out } = run(dir, 'HEAD');
  assert.doesNotMatch(out, /generated\.ts/, `ignored file was scanned — got:\n${out}`);
  assert.equal(code, 0);
});

test('a conflicted file is counted once, not once per merge stage', () => {
  // `git ls-files` prints an unmerged path once per stage, so a file whose
  // conflict is resolved in the editor but not yet staged was scanned three
  // times and every finding tripled — in the count this round set out to make
  // trustworthy.
  const dir = mkdtempSync(join(tmpdir(), 'docs-conflict-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'test');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), '/** Header. */\nexport const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'other');
  writeFileSync(join(dir, 'src', 'a.ts'), '/** Header. */\nexport const a = 2;\n');
  git('commit', '-qam', 'theirs');
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'src', 'a.ts'), '/** Header. */\nexport const a = 3;\n');
  git('commit', '-qam', 'ours');
  try {
    git('merge', 'other');
  } catch {
    /* expected: this is the conflict */
  }
  // Resolved in the editor, deliberately not staged — the ordinary state.
  writeFileSync(join(dir, 'src', 'a.ts'), ORPHAN_SRC);

  const { out } = run(dir, 'HEAD');
  const hits = [...out.matchAll(/ORPHANED/g)].length;
  assert.equal(hits, 1, `one orphan in one file, reported ${hits} times:\n${out}`);
});

test('a tracked file missing from disk is a diagnostic, not a stack trace', () => {
  // `ls-files` lists index entries whether or not the file is there, so `rm` or
  // a `mv` without `git mv` left an entry pointing at nothing. The uncaught
  // ENOENT exited 1 — which is this script's code for FINDINGS — and printed a
  // stack trace, which is a worse answer than either outcome the header
  // promises. `readdirSync` could not produce that state.
  const dir = repoWith({ working: ['/** Header. */', 'export const a = 1;', ''].join('\n') });
  rmSync(join(dir, 'src', 'a.ts'));

  const { code, out } = run(dir, 'HEAD');
  assert.doesNotMatch(out, /ENOENT|at readFileSync/, `crashed instead of reporting:\n${out}`);
  assert.match(out, /MISSING\s+src\/a\.ts/, `should name the file — got:\n${out}`);
  assert.equal(code, 0, 'nothing was found, so this is not a findings exit');
});
