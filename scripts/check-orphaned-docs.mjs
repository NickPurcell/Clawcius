import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] ?? 'HEAD';

// Fail closed: a ref that does not resolve would otherwise read below as "new file, nothing to have lost".
try {
  execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
} catch {
  console.error(`  base ref does not resolve to a commit: ${base}`);
  process.exit(2);
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** Every exported declaration in `source`, mapped to how many JSDoc blocks it has. */
function documentedSymbols(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const found = new Map();

  const record = (name, node) => {
    if (!name) return;
    // getJSDocCommentsAndTags is what decides hover text; counting `/**` in the
    // file would not see whether a block is attached.
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

const files = readdirSync(join(root, 'src'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join('src', f)); // repo-relative, as `git show` wants

let regressions = 0;
let checked = 0;

for (const file of files) {
  let before;
  try {
    before = execFileSync('git', ['-C', root, 'show', `${base}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    continue; // new file in this diff — nothing to have lost
  }
  const after = readFileSync(join(root, file), 'utf8');
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
