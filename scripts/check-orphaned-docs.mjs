/**
 * Find exported declarations whose JSDoc block was orphaned.
 *
 * THE DEFECT THIS CATCHES has happened twice, in two files, from the same cause.
 * The second is citable rather than remembered, because this script found it:
 * `c239a48` ("Classify a failed poll before deciding the watch is dead") orphaned
 * `composeWatchErrorMail` in `armed-wake.ts` the same way. That one was repaired
 * before it merged and is NOT live on `main` -- run this against history and it
 * reappears, which is the point of saying which commit.
 *
 * These modules are long runs of exported declarations each carrying a
 * block comment separated by a blank line, so inserting a new declaration lands
 * *inside* the run — and if it lands between an existing docstring and the thing
 * that docstring describes, the doc silently reattaches to the newcomer. Two
 * block comments in a row has the same effect: the last one wins.
 *
 * Nothing about it is visible in a diff. The prose is still there, still correct,
 * still in the same file, and it now documents something else — so review reads
 * it as untouched. Clawcius #202 round 1 found `checkAppConfig` had gone from one
 * JSDoc block to zero this way, and it took the compiler API to see it.
 *
 * So this asks the compiler rather than the reader. It is deliberately narrow:
 * it reports an exported declaration that HAD documentation and lost it, which is
 * a regression, and stays quiet about things that never had any, which is a
 * style question and not this script's business.
 *
 * NARROWER THAN THE DEFECT, DELIBERATELY, AND A GREEN RUN SAYS SO. Only
 * `export`ed declarations are examined. The insertion that prompted this
 * orphaned two docstrings and only one of them was exported, so a pass means
 * "no exported symbol lost documentation" and not "no documentation was
 * orphaned" -- which is why the success line says `exported` rather than
 * dropping the word for brevity. Widening it would mean arguing that every
 * module-private const deserves a docstring, which is a different argument and
 * would flood this with noise until someone switched it off.
 *
 *   npm run check-docs                              # working tree vs HEAD
 *   node scripts/check-orphaned-docs.mjs <baseref>  # working tree vs <baseref>
 *
 * IT COMPARES THE WORKING TREE, NEVER TWO COMMITS. So the no-argument form is a
 * PRE-COMMIT check: once the change is committed, tree and `HEAD` agree and it
 * has nothing to compare -- it reports `0 changed file(s)` and passes, which is
 * correct and useless. **To check work you have already committed, pass the
 * merge base explicitly**, e.g. `node scripts/check-orphaned-docs.mjs origin/main`.
 *
 * Exits 1 if any exported symbol lost its docs, 2 if the base ref does not
 * resolve. It never exits 0 on a question it could not ask.
 */

import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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

const files = readdirSync('src')
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join('src', f));

let regressions = 0;
let checked = 0;

for (const file of files) {
  let before;
  try {
    before = execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    continue; // new file in this diff — nothing to have lost
  }
  const after = readFileSync(file, 'utf8');
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

console.log(
  regressions === 0
    ? `  ok — ${checked} changed file(s), no exported symbol lost its documentation`
    : `\n  ${regressions} exported symbol(s) lost documentation`,
);
process.exit(regressions > 0 ? 1 : 0);
