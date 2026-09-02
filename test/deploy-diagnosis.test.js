import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEPLOY_SH = 'deploy/deploy.sh';

// The helpers are lifted out of deploy.sh between its two markers; awk exits non-zero if it
// never reached the end marker, so an extraction that overran the block fails the run.
const PRELUDE = `
block=$(awk '/^# --- health check helpers/{f=1} /^# --- end health check helpers/{e=1; exit} f {print} END{exit !e}' "$DEPLOY_SH") || exit 90
eval "$block"
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

// Records which unit it was asked for, so a test can assert both that the capture is scoped
// and that healthy() never reaches for the journal at all.
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
  '[ -f "$d/hang" ] && sleep 30',
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
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEPLOY_SH, STUBDIR: dir,
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
  return { ...r,
    why: /^WHY=(.*)$/m.exec(r.out)[1],
    units: /^UNITS=(.*)$/m.exec(r.out)[1].trim(),
    healthy: r.out.includes('HEALTHY=yes') };
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

test('a crew that is not reporting is queued for a journal, even with its unit healthy', () => {
  // The unit tuple says nothing in this case — an active, unrestarted waker that never
  // writes its status file — so the journal is the only thing that would explain it.
  const r = health({ crews: 'no-such-crew-exists' });
  assert.equal(r.units, 'no-such-crew-exists');
});

test('a crew whose own unit also failed is queued once, not twice', () => {
  // Crew and unit share a name, so both loops reach for the same journal. The name has to
  // be a unit as well as a crew for this to be exercised at all — with a crew that is not
  // a unit there is nothing to collide with, and the test would pass without the guard.
  const r = health({
    units: 'clawcius-status clawcius no-such-crew-exists',
    crews: 'no-such-crew-exists',
    files: { 'state.no-such-crew-exists': 'failed\n' },
  });
  assert.equal(r.units.split(/\s+/).filter((u) => u === 'no-such-crew-exists').length, 1);
});

test('the verdict kept is one poll, not every poll accumulated', () => {
  const r = health({ files: { 'state.hamachi': 'failed\n' } });
  assert.equal(r.why.match(/hamachi\(/g).length, 1);
});

// ------------------------------------------------------------------------ redact(), shapes

const redact = (input) => shell('redact "$(cat "$STUBDIR/input")"', { files: { input } }).out;

test('redaction removes URL userinfo, keeping the scheme and host readable', () => {
  const out = redact('fatal: could not read from https://x-access-token:ghp_AAAABBBBCCCCDDDD@github.com/o/r.git');
  assert.doesNotMatch(out, /ghp_AAAABBBBCCCCDDDD/);
  assert.match(out, /\[redacted-userinfo\]@github\.com/);
});

test('redaction removes the value of a secret-shaped assignment, keeping the key', () => {
  const out = redact('env: DISCORD_TOKEN=abc.def.ghi ANTHROPIC_API_KEY=short API_SECRET:zzz');
  assert.doesNotMatch(out, /abc\.def\.ghi/);
  assert.doesNotMatch(out, /zzz/);
  assert.match(out, /DISCORD_TOKEN=\[redacted\]/);
  assert.match(out, /ANTHROPIC_API_KEY=\[redacted\]/);   // API_KEY, which APIKEY alone missed
});

test('redaction removes any long opaque run, even one no vendor rule would match', () => {
  const out = redact('Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzX0FBQUFBQUFBQQ==');
  assert.doesNotMatch(out, /eC1hY2Nlc3M/);
  assert.match(out, /\[redacted-opaque\]/);
});

test('redaction leaves paths intact — for ENOENT the path IS the diagnostic line', () => {
  const out = redact([
    "Error: Cannot find module '/srv/clawcius/current/dist/index.js'",
    "open '/srv/clawcius/releases/abc/agent-config.base.yaml'",
    'HOME=/var/lib/hamachi',
  ].join('\n'));
  assert.match(out, /'\/srv\/clawcius\/current\/dist\/index\.js'/);
  assert.match(out, /agent-config\.base\.yaml/);
  assert.match(out, /HOME=\/var\/lib\/hamachi/);
  assert.doesNotMatch(out, /redacted/);
});

test('redaction leaves ordinary multi-line diagnostic text intact', () => {
  const out = redact('Error: Preflight failed:\n  - the agent container "clawcius-agent" is exited.\n    Fix:  docker/up.sh');
  assert.match(out, /Preflight failed:/);
  assert.match(out, /"clawcius-agent" is exited\./);
  assert.match(out, /Fix: {2}docker\/up\.sh/);
  assert.doesNotMatch(out, /redacted/);
});

// ----------------------------------------------------------------------- capture(), bounds

test('capture quotes every line behind a marker so it cannot merge into the mail', () => {
  const r = shell('capture clawcius 100', {
    files: { 'journal.clawcius': 'Error: Preflight failed:\nFix:  docker/up.sh\n' },
  });
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
  const content = 'ordinary log line\n'.repeat(200).slice(0, -1);
  const r = shell('echo "CAP=$JOURNAL_MAX_BYTES"; capture clawcius 100',
                  { files: { 'journal.clawcius': content } });
  const cap = Number(/^CAP=(\d+)$/m.exec(r.out)[1]);
  const kept = r.out.split('\n').filter((l) => l.startsWith('    | ')).map((l) => l.slice(6)).join('\n');
  assert.equal(kept.length, cap);
  assert.equal(Number(/(\d+) earlier bytes dropped/.exec(r.out)[1]), content.length - cap);
});

test('capture keeps the END of the journal, where the failure is', () => {
  // A unit that logs startup noise and then fails puts the reason past a 2000-byte cap.
  const content = `${'noise line\n'.repeat(400)}THE ACTUAL FAILURE\n`;
  const r = shell('capture clawcius 100', { files: { 'journal.clawcius': content } });
  assert.match(r.out, /\| THE ACTUAL FAILURE/);
  assert.doesNotMatch(r.out, /\| noise line\n\| noise line[\s\S]*THE ACTUAL/);
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
  const r = shell('JOURNAL_TIMEOUT=2; capture clawcius 100', {
    files: { 'journal.clawcius': 'partial line before the hang\n', hang: '' },
  });
  assert.match(r.out, /\| partial line before the hang/);
  assert.match(r.out, /the read was cut off after 2s so the journal may continue/);
});

test('a journal past the read bound keeps the END and says the earliest were never read', () => {
  // The bound that neither counter can see: bytes dropped before anything was measured.
  // JOURNAL_READ_MAX is overridden to keep the fixture small; the mechanism is the point.
  const content = `${'noise line\n'.repeat(200)}THE ACTUAL FAILURE\n`;
  const r = shell('JOURNAL_READ_MAX=500; capture clawcius 100', { files: { 'journal.clawcius': content } });
  assert.match(r.out, /\| THE ACTUAL FAILURE/);
  assert.match(r.out, /logged more than 500 bytes so the earliest were never read/);
});

test('a journal inside the read bound says nothing about it', () => {
  const r = shell('capture clawcius 100', { files: { 'journal.clawcius': 'small\n' } });
  assert.doesNotMatch(r.out, /never read/);
});

test('a journal that completes says nothing about being cut off', () => {
  const r = shell('capture clawcius 100', { files: { 'journal.clawcius': 'all of it\n' } });
  assert.match(r.out, /bytes dropped/);
  assert.doesNotMatch(r.out, /cut off after/);
});

// --------------------------------------------------- the boundary between trusted and not

test('healthy() never reads the journal, so untrusted text cannot reach HEALTH_WHY', () => {
  const r = health({
    files: { 'state.clawcius': 'failed\n', 'journal.clawcius': 'INJECTED-JOURNAL-TEXT\n' },
  });
  assert.equal(r.healthy, false);
  assert.doesNotMatch(r.why, /INJECTED-JOURNAL-TEXT/);
  assert.match(r.why, /^[\sA-Za-z0-9()=;_.-]*$/);   // enums, integers, names, nothing else
  assert.deepEqual(r.calls, []);                    // and it never asked the journal at all
});
