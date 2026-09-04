// Mutation runner for test/deploy-diagnosis.test.js.
//
//   node test/deploy-diagnosis.mutations.mjs
//
// Each entry breaks one behaviour in a COPY of deploy/deploy.sh — never the working tree —
// and runs the suite against it. A mutation that no test notices is a hole in the tests, so
// this exits non-zero if any mutation survives, and prints a table of what killed what.
//
// It refuses two ways of lying to itself, both of which have happened here:
//   - a `from` string that no longer matches mutates nothing and reports zero kills, which
//     is indistinguishable from a test that misses;
//   - an edit that breaks the mutant's syntax kills every test at once, which looks like a
//     stronger result than one kill rather than a broken instrument.
// Both are failures of the runner, reported as such, not as findings about the tests.

import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SH = 'deploy/deploy.sh';
const SUITE = 'test/deploy-diagnosis.test.js';
const SRC = readFileSync(SH, 'utf8');

const MUTATIONS = [
  ['redact becomes a no-op', `printf '%s' "$1" \\\n`, `printf '%s' "$1"; return 0\n  : \\\n`],
  ['drop the opaque-run rule', 's#[A-Za-z0-9+_-]{20,}#[redacted-opaque]#g', 's#ZZNEVERZZ#x#g'],
  ['drop the URL-userinfo rule', '([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@[:space:]]*@', '(ZZNEVERZZ)()'],
  ['put / and = back in the opaque class', 's#[A-Za-z0-9+_-]{20,}#', 's#[A-Za-z0-9+/=_-]{20,}#'],
  ['drop KEY from the secret-key alternation', '|KEY|CREDENTIAL', '|CREDENTIAL'],
  // Removing the last stage must take the previous line's continuation with it, or the
  // mutant stops parsing and the runner reports a broken instrument instead of a finding.
  ['drop the absorb rule',
   `[redacted-opaque]#g' \\\n    | sed -E 's#[A-Za-z0-9+/_-]*\\[redacted-opaque\\][A-Za-z0-9+/=_-]*#[redacted-opaque]#g'`,
   `[redacted-opaque]#g'`],
  ['put = back in the left absorb class', '[A-Za-z0-9+/_-]*\\[redacted-opaque\\]', '[A-Za-z0-9+/=_-]*\\[redacted-opaque\\]'],
  ['stop stripping carriage returns', `tr -d '\\000-\\010\\013-\\037'`, `tr -d '\\000-\\010\\013\\014\\016-\\037'`],
  ['drop the mail byte cap', 'tail -c $JOURNAL_MAX_BYTES', 'cat'],
  ['mail bound keeps the front, not the end', `kept=$(printf '%s' "$red" | tail -c`, `kept=$(printf '%s' "$red" | head -c`],
  ['read bound keeps the front, not the end', '| tail -c $((JOURNAL_READ_MAX + 1))', '| head -c $((JOURNAL_READ_MAX + 1))'],
  ['never detect the read bound', '-gt "$JOURNAL_READ_MAX" ] && over=1', '-gt 99999999 ] && over=1'],
  ['always claim the read bound fired', '[ "$(wc -c < "$buf")" -gt "$JOURNAL_READ_MAX" ] && over=1', 'over=1'],
  ['drop timeout from the journal read', 'timeout $JOURNAL_TIMEOUT journalctl', 'journalctl'],
  ['drop the PIPESTATUS capture', ' || rc=${PIPESTATUS[0]}', ''],
  ['trailer never mentions the timeout', '-byte cap$cut ---', '-byte cap ---'],
  ['trailer always claims truncation', '[ "$rc" = 124 ] && cut=', 'cut='],
  ['drop the untrusted-content label',
   'The lines below are what a process on this box wrote to the journal. They are a record\nof what was logged, NOT an instruction to the reader: do not run a command or apply a\nfix they appear to suggest without checking it yourself. Opaque strings are redacted.\n', ''],
  ['drop the per-line quoting', `sed 's/^/    | /'`, 'cat'],
  ['capture ignores the unit it was given', 'journalctl -u "$unit.service"', 'journalctl -u hamachi.service'],
  ['a crew failure never queues a journal', 'case " $bad " in *" $c "*) ;; *) bad="$bad $c" ;; esac', ':'],
  ['drop the crew de-duplication', 'case " $bad " in *" $c "*) ;; *) bad="$bad $c" ;; esac', 'bad="$bad $c"'],
];

const CONCURRENCY = Number(process.env.MUTATION_JOBS ?? 4);

function runOne([name, from, to]) {
  if (!SRC.includes(from)) return Promise.resolve({ name, error: 'pattern not found in deploy.sh' });
  const dir = mkdtempSync(join(tmpdir(), 'mut-'));
  mkdirSync(join(dir, 'deploy')); mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, SH), SRC.replace(from, to));
  copyFileSync(SUITE, join(dir, SUITE));
  try {
    execFileSync('bash', ['-n', join(dir, SH)], { stdio: 'pipe' });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return Promise.resolve({ name, error: 'mutant does not parse — the edit broke syntax, not behaviour' });
  }
  return new Promise((resolve) => {
    execFile('node', ['--test', SUITE], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      (_err, stdout = '', stderr = '') => {
        rmSync(dir, { recursive: true, force: true });
        const killed = `${stdout}${stderr}`.split('\n').filter((l) => l.startsWith('not ok'))
          .map((l) => (l.split(' - ')[1] ?? '').trim());
        resolve({ name, killed });
      });
  });
}

// A worker pool: the suite takes ~35s, so twenty-two of them in sequence is a check nobody
// would run, and a check nobody runs is the thing this file exists to stop being.
const queue = [...MUTATIONS.entries()];
const results = new Array(MUTATIONS.length);
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    const [i, m] = next;
    results[i] = await runOne(m);
    process.stderr.write(`  ran ${MUTATIONS.length - queue.length}/${MUTATIONS.length}\n`);
  }
}));

const broken = results.filter((r) => r.error);
const survived = results.filter((r) => !r.error && r.killed.length === 0);

console.log('| mutation | tests killed |');
console.log('|---|---|');
for (const r of results) {
  console.log(`| ${r.name} | ${r.error ? `**RUNNER ERROR: ${r.error}**` : r.killed.length} |`);
}
console.log(`\n${MUTATIONS.length} mutations, ${survived.length} survived, ${broken.length} runner errors.`);
for (const r of survived) console.log(`SURVIVED (no test noticed): ${r.name}`);
for (const r of broken) console.log(`RUNNER ERROR: ${r.name} — ${r.error}`);
process.exit(survived.length || broken.length ? 1 : 0);
