import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEPLOY_SH = 'deploy/deploy.sh';

// The helpers are lifted out of deploy.sh between its two markers; awk exits non-zero if
// it never reached the end marker, so an extraction that overran the block fails the run.
const EXTRACT =
  `awk '/^# --- health check helpers/{f=1} /^# --- end health check helpers/{exit} f {print} END{exit !e}' "$DEPLOY_SH"`;

// The byte bounds live outside the block, so they are read from the same file rather than
// restated here — a test asserting a cap of 2000 against a script that says 500 is worse
// than no test.
const PRELUDE = `
block=$(awk '/^# --- health check helpers/{f=1} /^# --- end health check helpers/{e=1; exit} f {print} END{exit !e}' "$DEPLOY_SH") || exit 90
eval "$block"
eval "$(grep -E '^(JOURNAL_READ_MAX|JOURNAL_MAX_BYTES|JOURNAL_TIMEOUT)=[0-9]+$' "$DEPLOY_SH")"
sleep() { SECONDS=$((SECONDS + 5)); }   # the 90s poll, without waiting 90 seconds for it
HEALTH_WHY=""; HEALTH_UNITS=""
`;

const HEALTH_SNIPPET = `
if healthy "$SHA_IN"; then echo "HEALTHY=yes"; else echo "HEALTHY=no"; fi
echo "WHY=$HEALTH_WHY"
echo "UNITS=$HEALTH_UNITS"
`;

const SYSTEMCTL = [
  '#!/bin/sh',
  'd=$(dirname "$0")',
  'for a in "$@"; do last=$a; done',
  'unit=$(basename "$last" .service)',
  'prev=""; want=""',
  'for a in "$@"; do',
  '  [ "$prev" = "-p" ] && want="$want $a"',
  '  prev=$a',
  'done',
  'for p in $want; do',
  '  case $p in',
  '    ActiveState) v=$(cat "$d/state.$unit"  2>/dev/null || echo active) ;;',
  '    SubState)    v=$(cat "$d/sub.$unit"    2>/dev/null || echo running) ;;',
  '    NRestarts)   v=$(cat "$d/nr.$unit"     2>/dev/null || echo 0) ;;',
  '    Result)      v=$(cat "$d/result.$unit" 2>/dev/null || echo success) ;;',
  '    *)           v="" ;;',
  '  esac',
  '  echo "$p=$v"',
  'done',
].join('\n');

// Records that it ran, and which unit it was asked for, so a test can assert both that
// the capture is scoped and that healthy() never reaches for the journal at all.
const JOURNALCTL = [
  '#!/bin/sh',
  'd=$(dirname "$0")',
  'prev=""; unit=""',
  'for a in "$@"; do',
  '  [ "$prev" = "-u" ] && unit=$a',
  '  prev=$a',
  'done',
  'echo "$unit" >> "$d/journalctl.calls"',
  'cat "$d/journal.$(basename "$unit" .service)" 2>/dev/null || true',
  '[ -f "$d/hang" ] && sleep 30',   // a journal that never finishes, for the timeout bound
  'exit 0',
].join('\n');

function shell(snippet, { files = {}, crews = '', units = 'clawcius-status clawcius hamachi',
                          systemctl = SYSTEMCTL } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-diag-'));
  try {
    for (const [name, body] of [['systemctl', systemctl], ['journalctl', JOURNALCTL]]) {
      writeFileSync(join(dir, name), body);
      chmodSync(join(dir, name), 0o755);
    }
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);

    const out = execFileSync('bash', ['-c', PRELUDE + snippet], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEPLOY_SH,
             SHA_IN: 'abc123', CREWS: crews, UNITS: units },
    });
    const callsFile = join(dir, 'journalctl.calls');
    const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { out, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function health(opts) {
  const r = shell(HEALTH_SNIPPET, opts);
  return {
    ...r,
    why: /^WHY=(.*)$/m.exec(r.out)[1],
    units: /^UNITS=(.*)$/m.exec(r.out)[1].trim(),
    healthy: r.out.includes('HEALTHY=yes'),
  };
}

// ---------------------------------------------------------------- healthy(), the tuple

test('all units active and unrestarted: healthy, and nothing reported', () => {
  const r = health();
  assert.equal(r.healthy, true);
  assert.equal(r.why.trim(), '');
});

test('a unit that never becomes active is named, with the whole tuple systemd gives', () => {
  const r = health({ files: { 'state.clawcius': 'activating\n', 'sub.clawcius': 'auto-restart\n',
                              'nr.clawcius': '82\n', 'result.clawcius': 'exit-code\n' } });
  assert.equal(r.healthy, false);
  assert.match(r.why, /clawcius\(ActiveState=activating SubState=auto-restart NRestarts=82 Result=exit-code\)/);
});

test('a restart count alone fails the check, and reports the unit as active', () => {
  const r = health({ files: { 'nr.hamachi': '3\n' } });
  assert.equal(r.healthy, false);
  assert.match(r.why, /hamachi\(ActiveState=active SubState=running NRestarts=3 Result=success\)/);
});

test('only the failing unit is reported, not the ones that were fine', () => {
  const r = health({ files: { 'state.clawcius': 'failed\n' } });
  assert.match(r.why, /clawcius\(/);
  assert.doesNotMatch(r.why, /hamachi\(/);
  assert.equal(r.units, 'clawcius');
});

test('properties are read by name, so the order systemd prints them in does not matter', () => {
  const r = health({ units: 'clawcius', systemctl: ['#!/bin/sh', 'echo "Result=timeout"',
    'echo "NRestarts=7"', 'echo "SubState=dead"', 'echo "ActiveState=failed"'].join('\n') });
  assert.match(r.why, /clawcius\(ActiveState=failed SubState=dead NRestarts=7 Result=timeout\)/);
});

test('a systemctl that answers nothing degrades to unknown rather than to an empty tuple', () => {
  const r = health({ units: 'clawcius', systemctl: '#!/bin/sh\nexit 1\n' });
  assert.equal(r.healthy, false);
  assert.match(r.why, /clawcius\(ActiveState=unknown SubState=unknown NRestarts=unknown Result=unknown\)/);
});

test('the crew status-file conditions name the crew and say which of the two failed', () => {
  const r = health({ crews: 'no-such-crew-exists' });
  assert.equal(r.healthy, false);
  assert.match(r.why, /no-such-crew-exists is not reporting abc123/);
  assert.match(r.why, /no-such-crew-exists status file is \d+s stale/);
});

test('the verdict kept is one poll, not every poll accumulated', () => {
  const r = health({ files: { 'state.hamachi': 'failed\n' } });
  assert.equal(r.why.match(/hamachi\(/g).length, 1);
});

// ------------------------------------------------------------------------ redact(), shapes

const redact = (s) => shell(`redact ${JSON.stringify(s)}`).out;

test('redaction removes URL userinfo, keeping the scheme and host readable', () => {
  const out = redact('fatal: could not read from https://x-access-token:ghp_AAAABBBBCCCCDDDD@github.com/o/r.git');
  assert.doesNotMatch(out, /ghp_AAAABBBBCCCCDDDD/);
  assert.match(out, /\[redacted-userinfo\]@github\.com/);
});

test('redaction removes the value of a secret-shaped assignment, keeping the key', () => {
  const out = redact('env: DISCORD_TOKEN=abc.def.ghi HOME=/root API_SECRET:zzz');
  assert.doesNotMatch(out, /abc\.def\.ghi/);
  assert.doesNotMatch(out, /zzz/);
  assert.match(out, /DISCORD_TOKEN=\[redacted\]/);
  assert.match(out, /HOME=\/root/);          // an innocuous assignment is left alone
});

test('redaction removes any long opaque run, even one no vendor rule would match', () => {
  // The #227 case: a credential that arrives base64-encoded matches no token-shape rule.
  const out = redact('Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzX0FBQUFBQUFBQQ==');
  assert.doesNotMatch(out, /eC1hY2Nlc3M/);
  assert.match(out, /\[redacted-opaque\]/);
});

test('redaction leaves ordinary diagnostic text intact — the line this feature exists for', () => {
  const line = 'Error: Preflight failed:\n  - the agent container "clawcius-agent" is exited.\n    Fix:  docker/up.sh';
  const out = redact(line);
  assert.match(out, /Preflight failed/);
  assert.match(out, /"clawcius-agent" is exited/);
  assert.match(out, /Fix: {2}docker\/up\.sh/);
  assert.doesNotMatch(out, /redacted/);
});

// ----------------------------------------------------------------------- capture(), bounds

test('capture quotes every line and labels the block as evidence, not as instruction', () => {
  const r = shell('capture clawcius 100', {
    files: { 'journal.clawcius': 'Error: Preflight failed:\nFix:  docker/up.sh\n' },
  });
  assert.match(r.out, /captured journal output for clawcius/);
  assert.match(r.out, /NOT an instruction to the reader/);
  assert.match(r.out, /^ {4}\| Error: Preflight failed:$/m);
  assert.match(r.out, /^ {4}\| Fix: {2}docker\/up\.sh$/m);
});

test('capture is scoped to the unit it is given, and asks the journal for only that unit', () => {
  const r = shell('capture clawcius 100', {
    files: { 'journal.clawcius': 'mine\n', 'journal.hamachi': 'not mine\n' },
  });
  assert.match(r.out, /\| mine/);
  assert.doesNotMatch(r.out, /not mine/);
  assert.deepEqual(r.calls, ['clawcius.service']);
});

test('capture bounds by bytes and reports how many were dropped', () => {
  // Many ordinary short lines rather than one long run: a single 9000-character blob is
  // itself the opaque shape redact() collapses, so it would never reach the byte cap.
  // That is the bound being tested here, and the two must not be confused.
  const content = 'ordinary log line\n'.repeat(200).slice(0, -1);   // 3599 bytes, no trailing \n
  const r = shell('capture clawcius 100', { files: { 'journal.clawcius': content } });
  const cap = Number(/^JOURNAL_MAX_BYTES=(\d+)$/m.exec(readFileSync(DEPLOY_SH, 'utf8'))[1]);

  const kept = r.out.split('\n').filter((l) => l.startsWith('    | '))
    .map((l) => l.slice(6)).join('\n');
  assert.equal(kept.length, cap, `kept ${kept.length} bytes, cap is ${cap}`);
  assert.equal(Number(/(\d+) bytes dropped/.exec(r.out)[1]), content.length - cap);
});

test('capture emits nothing at all when the unit logged nothing', () => {
  const r = shell('capture clawcius 100; echo "END"', {});
  assert.equal(r.out.trim(), 'END');
});

test('capture redacts before quoting, so a secret never reaches the mail body', () => {
  const r = shell('capture clawcius 100', {
    files: { 'journal.clawcius': 'curl: (22) https://user:ghp_AAAABBBBCCCCDDDD@api.github.com/x failed\n' },
  });
  assert.doesNotMatch(r.out, /ghp_AAAABBBBCCCCDDDD/);
  assert.match(r.out, /\[redacted-userinfo\]/);
});

test('a journal that hangs is cut off, and the block says so rather than looking whole', () => {
  // JOURNAL_TIMEOUT is overridden to keep the suite quick; the mechanism is what is under
  // test here, and that deploy.sh passes the real constant to `timeout` is asserted below.
  const r = shell('JOURNAL_TIMEOUT=2; capture clawcius 100', {
    files: { 'journal.clawcius': 'partial line before the hang\n', hang: '' },
  });
  assert.match(r.out, /\| partial line before the hang/);
  assert.match(r.out, /the read was cut off after 2s so the journal may continue/);
});

test('a journal that completes says nothing about being cut off', () => {
  // The announcement has to be conditional: a trailer that always claims truncation is
  // as useless as one that never does.
  const r = shell('capture clawcius 100', { files: { 'journal.clawcius': 'all of it\n' } });
  assert.match(r.out, /bytes dropped/);
  assert.doesNotMatch(r.out, /cut off after/);
});

// --------------------------------------------------- the boundary between trusted and not

test('healthy() never reads the journal, so untrusted text cannot reach HEALTH_WHY', () => {
  // The tuple field is a closed vocabulary: systemd enums and integers. This asserts the
  // property PR 1 relied on and PR 2 could have broken, rather than describing it.
  const r = health({
    files: { 'state.clawcius': 'failed\n', 'journal.clawcius': 'INJECTED-JOURNAL-TEXT\n' },
  });
  assert.equal(r.healthy, false);
  assert.doesNotMatch(r.why, /INJECTED-JOURNAL-TEXT/);
  assert.match(r.why, /^[\sA-Za-z0-9()=;_.-]*$/);   // enums, integers, names, nothing else
  assert.deepEqual(r.calls, []);                    // and it never asked the journal at all
});

// -------------------------------------------------------- source-level ordering invariants

const SRC = readFileSync(DEPLOY_SH, 'utf8');

test('the capture happens before the revert, which would replace the failing state', () => {
  const capture = SRC.indexOf('DIAG="$DIAG$(capture');
  const revert = SRC.indexOf('switch_to "$CURRENT"');
  assert.ok(capture > 0 && revert > 0, 'both lines must exist');
  assert.ok(capture < revert, 'capture must precede the revert that restarts the units');
});

test('the journal read is bounded by the real JOURNAL_TIMEOUT constant', () => {
  assert.match(SRC, /^JOURNAL_TIMEOUT=\d+$/m);
  assert.match(SRC, /timeout \$JOURNAL_TIMEOUT journalctl/);
});

test('the untrusted capture reaches the mail body and never the subject', () => {
  const subject = /^\s*subject="deploy.*$/m.exec(SRC)[0];
  const body = /^\s*body="\$REPO at.*$/m.exec(SRC)[0];
  assert.doesNotMatch(subject, /DIAG/);
  assert.match(body, /\$\{DIAG\}/);
});
