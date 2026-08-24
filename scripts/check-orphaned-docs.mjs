/**
 * Two checks over the same defect: a JSDoc block that documents something other
 * than what it was written for.
 *
 * THE DEFECT HAS NOW HAPPENED SIX TIMES, in five files, across two authors.
 * These modules are long runs of exported declarations each carrying a block
 * comment separated by a blank line, so inserting a declaration lands *inside*
 * the run — and if it lands between an existing docstring and the thing that
 * docstring describes, the doc silently reattaches to the newcomer. Two block
 * comments in a row has the same effect: the last one wins.
 *
 * Nothing about it is visible in a diff. The prose is still there, still
 * correct, still in the same file, and it now documents something else — so
 * review reads it as untouched. OJ said so itself on #234: "I reviewed that hunk
 * twice without noticing." The lines are unchanged; the DISTANCE between them is
 * the defect.
 *
 * ── The two halves, and what each one alone cannot see ──────────────────────
 *
 *   ORPHANED   a `/** ... *\/` in this file that is attached to no node at all.
 *              Needs no base ref, so it also answers on a file that is new, and
 *              on a tree with nothing uncommitted. Not limited to exports.
 *
 *   LOST DOCS  an EXPORTED declaration that had documentation in the base ref
 *              and has less of it now. Needs the base ref, because nothing is
 *              left in the file to detect: the block is not orphaned, it is gone.
 *
 * NEITHER WOULD HAVE CAUGHT #241's TWO INSTANCES BEFORE THIS CHANGE, which is
 * why the first half exists. When the doc block and the declaration that stole
 * it are BOTH NEW on the branch, no symbol lost anything relative to the base,
 * there is nothing to compare, and the comparison passes.
 *
 * VERIFIED BY WATCHING IT FIRE ON THE REAL COMMITS, not by reasoning about it:
 * `c239a48` (`composeWatchErrorMail`), `d62f438` (`buildSystemPrompt`),
 * `59289d9`/`642db2e` (`agent.ts`, #241), `bdd83d8`/`c875d08` (`mail-wake.ts`,
 * #241), and `ff87752` in #202's history. Run it against those trees and it
 * reports each one.
 *
 * ── What it still does not catch, said out loud ─────────────────────────────
 *
 * A BLOCK ATTACHED TO THE WRONG DECLARATION. That block *is* attached, just to
 * the wrong thing, and nothing mechanical distinguishes it from a correct one —
 * it needs a reader. "No orphans" is not "no docstring is misplaced", and the
 * two read identically in a green run.
 *
 * AND ORPHANED CAN RAISE A FALSE ALARM, WHICH LOST DOCS NEVER COULD. This
 * matters because the older half's failure mode was silence, and a reader who
 * carries that expectation across will trust a hit further than it deserves.
 * TypeScript attaches a JSDoc only to a declaration, so a block a human plainly
 * meant as documentation is reported when it sits on something that is not one:
 *
 *   - a documented member of a union type: a doc block sitting on `'a'` inside
 *     `type X = 'a' | 'b'`, which is a normal way to write one in `types.ts`
 *   - a `default:` clause (a documented `case` is fine; only `default` trips)
 *   - an element of an array literal
 *
 * Nothing in `src/` does any of these today, and this script is not wired into
 * `npm test` or CI, so the cost is a reader's moment rather than a red build. If
 * one of them ever becomes common the answer is to exclude that position
 * explicitly, not to loosen the check.
 *
 * LOST DOCS remains exported-only, deliberately. Widening it means arguing that
 * every module-private const deserves a docstring, which would flood the output
 * until someone switched the whole thing off. ORPHANED has no such limit, so
 * between them the non-exported case is covered in one direction and not the
 * other.
 *
 * A FILE-HEADER BLOCK IS EXCLUDED, exactly one block wide — the first block in
 * the file when it precedes the first statement. Several modules open with a
 * one-line summary, a blank line, then a documented declaration; TypeScript
 * attaches only the last block before a statement, so the header attaches to
 * nothing and would be reported. `armed.ts` shows why the rule is positional
 * rather than shape-based: its 86-line header IS attached, to the import below
 * it, purely because nothing sits between them.
 *
 *   npm run check-docs                              # working tree vs HEAD
 *   node scripts/check-orphaned-docs.mjs <baseref>  # working tree vs <baseref>
 *
 * IT COMPARES THE WORKING TREE, NEVER TWO COMMITS. The no-argument form is
 * therefore a PRE-COMMIT check *for the LOST DOCS half only*: once the change is
 * committed, tree and `HEAD` agree and that half has nothing to compare, so it
 * reports `0 changed file(s)`. **To check committed work for lost docs, pass the
 * merge base** — `node scripts/check-orphaned-docs.mjs origin/main`. The
 * ORPHANED half needs no base and answers in every form, which is what stops the
 * no-argument run being the vacuous check this header used to describe.
 *
 * Runs correctly from any directory in the repository: paths are anchored to
 * the toplevel rather than to cwd.
 *
 * ONLY GIT-TRACKED FILES ARE EXAMINED. `src/build-info.ts` is generated by
 * `scripts/build-info.mjs` and gitignored, so a plain directory read makes the
 * headline count 26 on a fresh clone and 27 after a build — and that count is
 * the one number in a line whose whole job is to say what was checked. It also
 * meant the orphan half was parsing generated output.
 *
 * Exits 1 if any block documents nothing or any exported symbol lost its docs,
 * 2 if the base ref does not resolve. It never exits 0 on a question it could
 * not ask — and `test/check-orphaned-docs.test.js` drives this script as a
 * subprocess to prove it, because a guard whose only risk is silent success
 * cannot be reviewed by reading it.
 */

import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] ?? 'HEAD';

// FAIL CLOSED. `git show <ref>:<file>` throwing is caught below and read as
// "new file, nothing to have lost", which is true for one cause and false for
// every other -- a typo'd ref, a wrong cwd, no git. Without this, a mistyped
// base printed a clean pass and exited 0:
//
//     $ node scripts/check-orphaned-docs.mjs mian
//       ok -- 0 changed file(s), no exported symbol lost its documentation
//
// A guard reporting success against a ref that does not exist is the exact
// defect this repository is currently fixing elsewhere: a true-looking signal
// about the wrong subject. The `0 changed file(s)` was the only tell and it is
// worded as success.
try {
  execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
} catch {
  console.error(`  base ref does not resolve to a commit: ${base}`);
  process.exit(2);
}

// ANCHOR BOTH SIDES TO THE REPOSITORY ROOT, or they can disagree about which
// file they mean. `readdirSync('src')` is cwd-relative; `git show <ref>:src/x.ts`
// resolves against the root. Those agree only when cwd IS the root, and this
// repository has a second TypeScript package -- `ops/`, with three filenames in
// common with this one. Run from there, the old version read `ops/src/config.ts`
// off disk, fetched the ROOT `src/config.ts` out of git, compared the exported
// symbols of one file against those of an unrelated one, and reported:
//
//     ok -- 3 changed file(s), no exported symbol lost its documentation
//
// A clean pass on a comparison it never made -- the same failure as the bad-ref
// case above, which is why the fix belongs beside it rather than in the loop.
// This file's own promise is that it never exits 0 on a question it could not
// ask, and asking the question of the wrong files is a way of not asking it.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** Every exported declaration in `source`, mapped to how many JSDoc blocks it has. */
function documentedSymbols(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const found = new Map();

  const record = (name, node) => {
    if (!name) return;
    // getJSDocCommentsAndTags is what actually decides hover text, which is the
    // thing that broke. Counting `/**` in the file would have reported no change.
    const docs = ts.getJSDocCommentsAndTags(node).filter((d) => ts.isJSDoc(d));
    found.set(name, docs.length);
  };

  const isExported = (node) =>
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

  ts.forEachChild(sf, (node) => {
    if (!isExported(node)) return;
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      record(node.name?.getText(), node);
    } else if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      record(node.name.getText(), node);
    } else if (ts.isVariableStatement(node)) {
      // The doc attaches to the statement, not the declaration inside it.
      for (const decl of node.declarationList.declarations) {
        record(decl.name.getText(), node);
      }
    }
  });
  return found;
}

/**
 * The first line of a doc block that actually says something.
 *
 * Taking the block's first line gives the bare opening delimiter for every block
 * that is not a one-liner, which is most of them — two of the three historical
 * instances reproduced as `documents nothing — ` and then nothing useful, an
 * excerpt doing no work in the common case.
 */
function firstContentLine(block) {
  for (const raw of block.split('\n')) {
    const line = raw.replace(/^\s*\/?\*+\/?/, '').replace(/\*\/\s*$/, '').trim();
    if (line) return line;
  }
  return '(no text)';
}

/**
 * Every JSDoc block in `source` that documents nothing.
 *
 * THE QUESTION THE REST OF THIS SCRIPT CANNOT ASK. Everything above compares a
 * file against a base ref and reports a symbol that HAD documentation and lost
 * it. When the doc block and the declaration that stole it are BOTH NEW on the
 * branch, no symbol lost anything, there is nothing to compare, and the
 * comparison passes -- `hamachi-engineer2` hit that twice in one day on #241
 * (`export const sdk` inserted between `TurnSettle`'s block and its class;
 * `sweep()`'s comment left above `#offers`).
 *
 * This asks a question with no base ref in it: is there a `/** ... *\/` in this
 * file that `getJSDocCommentsAndTags` attaches to no node at all? A block
 * documenting nothing is unambiguously wrong, whether it is new or old.
 *
 * COMMENTS COME FROM THE SCANNER, NOT A REGEX. `src/agent-config.ts` holds a
 * 3000-character template literal of prompt prose; a regex for the comment
 * delimiters matches inside it and reports the prompt as an orphaned docstring.
 * Walking leading-comment ranges off real tokens cannot see into a string.
 */
function orphanedBlocks(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const text = sf.getFullText();

  // Attachment is keyed on `end` because a JSDoc node's `pos` includes leading
  // trivia and does not line up with the comment range the scanner reports.
  const attached = new Set();
  (function visit(node) {
    // THE END-OF-FILE TOKEN ABSORBS A TRAILING BLOCK, and that is the one place
    // this check would otherwise be silent about its own shape. TypeScript
    // attaches a JSDoc at the bottom of a file to `EndOfFileToken`, so a block
    // whose declaration was DELETED from the end documents nothing and looked
    // attached. `LOST DOCS` cannot cover it either — the symbol is gone, which
    // takes the `removed or renamed` branch and continues.
    if (node !== sf.endOfFileToken) {
      for (const d of ts.getJSDocCommentsAndTags(node)) if (ts.isJSDoc(d)) attached.add(d.end);
    }
    ts.forEachChild(node, visit);
  })(sf);

  // A FILE-HEADER BLOCK IS NOT AN ORPHAN, and this exclusion is exactly one
  // block wide. Several modules open with a one-line summary of the file, then a
  // blank line, then a documented declaration -- `types.ts` and `schedule.ts`
  // both do. TypeScript attaches only the LAST block before a statement, so the
  // header attaches to nothing and is reported. It documents the file, which is
  // the intent, so flagging it would be a false alarm in the two files most
  // likely to be edited by whoever is trying this script for the first time.
  //
  // `armed.ts` shows why the rule has to be positional rather than shape-based:
  // its 86-line header IS attached, to the import declaration below it, purely
  // because nothing sits between them. Whether a header attaches is an accident
  // of what follows it, so the reliable signal is that it comes first.
  //
  // Only the FIRST block in the file, and only when it precedes the first
  // statement. Everything after that is in the run of declarations where the
  // defect lives, and all five known instances are mid-file.
  const firstStatement = sf.statements[0];
  const headerLimit = firstStatement ? firstStatement.getStart(sf) : text.length;
  let headerSkipped = false;

  const seen = new Set();
  const orphans = [];
  (function walk(node) {
    for (const child of node.getChildren(sf)) {
      for (const range of ts.getLeadingCommentRanges(text, child.getFullStart()) ?? []) {
        const key = `${range.pos}:${range.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (text.slice(range.pos, range.pos + 3) !== '/**') continue;
        if (attached.has(range.end)) continue;
        if (!headerSkipped && range.pos < headerLimit) {
          headerSkipped = true;
          // A HEADER IS SET OFF; AN ORPHAN IS BUTTED AGAINST WHAT STOLE ITS
          // DECLARATION. Without the blank-line test this excluded "the first
          // block" rather than "a file header", and those differ exactly where
          // it matters: in a file that opens straight into a documented
          // declaration, the orphan IS the first block — the #241 shape at the
          // top of a NEW file, which is one of the two states this half exists
          // to answer.
          if (/^[^\S\n]*\n[^\S\n]*\n/.test(text.slice(range.end))) continue;
        }
        orphans.push({
          line: sf.getLineAndCharacterOfPosition(range.pos).line + 1,
          first: firstContentLine(text.slice(range.pos, range.end)),
        });
      }
      walk(child);
    }
  })(sf);

  return orphans.sort((a, b) => a.line - b.line);
}

const files = execFileSync('git', ['-C', root, 'ls-files', 'src/*.ts'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean); // repo-relative already, which is what `git show` wants

let regressions = 0;
let checked = 0;

let orphans = 0;

for (const file of files) {
  const after = readFileSync(join(root, file), 'utf8');

  // THE ORPHAN CHECK RUNS ON EVERY FILE, unconditionally, and deliberately
  // BEFORE the base comparison. It needs no base ref and no `before`, so it is
  // the half that still means something when `git show` throws (a file new on
  // this branch) or when tree and base agree — which is the state the
  // no-argument form is always in after a commit. Running it here is what stops
  // `npm run check-docs` being the vacuous post-commit check this file's own
  // header warns about.
  for (const { line, first } of orphanedBlocks(after, file)) {
    console.log(`  ORPHANED   ${file}:${line}  documents nothing — ${first}`);
    orphans++;
  }

  let before;
  try {
    before = execFileSync('git', ['-C', root, 'show', `${base}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    continue; // new file in this diff — nothing to have lost
  }
  if (before === after) continue;

  const was = documentedSymbols(before, file);
  const now = documentedSymbols(after, file);
  checked++;

  for (const [name, count] of was) {
    if (count === 0) continue;
    const still = now.get(name);
    if (still === undefined) continue; // removed or renamed — a different question
    if (still < count) {
      console.log(`  LOST DOCS  ${file}  ${name}: ${count} block(s) -> ${still}`);
      regressions++;
    }
  }
}

// SAY WHAT WAS CHECKED AND WHAT WAS NOT. This script's failure mode has never
// been a false alarm — it is saying `ok` about a question it did not ask, so
// the success line names both halves and the count each one covered.
if (regressions === 0 && orphans === 0) {
  console.log(
    `  ok — ${files.length} file(s): no JSDoc block documents nothing; ` +
      `${checked} changed file(s): no exported symbol lost its documentation`,
  );
} else {
  const parts = [];
  if (orphans > 0) parts.push(`${orphans} JSDoc block(s) document nothing`);
  if (regressions > 0) parts.push(`${regressions} exported symbol(s) lost documentation`);
  console.log(`\n  ${parts.join('; ')}`);
}

// NEITHER HALF CATCHES A BLOCK ATTACHED TO THE WRONG DECLARATION. That block IS
// attached, just to the wrong thing, and nothing mechanical distinguishes it
// from a correct one — it needs a reader. Said out loud rather than left to be
// inferred from a green run, because "no orphans" reads as "no docstring is
// misplaced" and it is not the same claim.
process.exit(regressions > 0 || orphans > 0 ? 1 : 0);
