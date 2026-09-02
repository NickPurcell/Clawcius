import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// deploy.sh's healthy() is exercised on its own: the rest of the script builds releases and
// moves symlinks, which a test has no business doing. It is lifted out of the real file
// rather than duplicated here, so a change to it breaks this test instead of quietly
// leaving the test exercising a stale copy.
//
// Lifted out between explicit markers in deploy.sh rather than by counting braces. An
// earlier version of this file counted `}` lines, missed a one-line function, and so
// eval'd the whole tail of deploy.sh -- switch_to, mail_result and a prune loop containing
// `rm -rf`. It was harmless only because $ROOT happened to be unset. Hence both the markers
// and the tripwire below: a harness that runs more than it means to must fail loudly.
const EXTRACT =
  `awk '/^# --- health check helpers/{f=1} /^# --- end health check helpers/{exit} f' "$DEPLOY_SH"`;

const DRIVER = `
block=$(${EXTRACT})
case "$block" in
  *switch_to*|*mail_result*|*"rm -rf"*|*as_builder*)
    echo "EXTRACTION ESCAPED THE HELPER BLOCK" >&2; exit 90 ;;
esac
eval "$block"
sleep() { SECONDS=$((SECONDS + 5)); }   # the 90s poll, without waiting 90 seconds for it
HEALTH_WHY=""
if healthy "$SHA_IN"; then echo "HEALTHY=yes"; else echo "HEALTHY=no"; fi
echo "WHY=$HEALTH_WHY"
`;

// systemctl show -p A -p B ... <unit>.service — answers with `Name=value` lines, in the
// order asked for. The stub reads what to report from files beside itself, so no shell
// variable indirection is needed.
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

function run({ files = {}, crews = '', units = 'clawcius-status clawcius hamachi' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-diag-'));
  try {
    writeFileSync(join(dir, 'systemctl'), SYSTEMCTL);
    chmodSync(join(dir, 'systemctl'), 0o755);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);

    const out = execFileSync('bash', ['-c', DRIVER], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        // Overridable so the suite can be pointed at a deliberately broken copy, to check
        // these tests still fail when the behaviour they describe is removed.
        DEPLOY_SH: process.env.DEPLOY_SH ?? 'deploy/deploy.sh',
        SHA_IN: 'abc123',
        CREWS: crews,
        UNITS: units,
      },
    });
    return { out, why: /^WHY=(.*)$/m.exec(out)[1], healthy: out.includes('HEALTHY=yes') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('all units active and unrestarted: healthy, and nothing reported', () => {
  const r = run();
  assert.equal(r.healthy, true);
  assert.equal(r.why.trim(), '');
});

test('a unit that never becomes active is named, with the whole tuple systemd gives', () => {
  const r = run({
    files: {
      'state.clawcius': 'activating\n',
      'sub.clawcius': 'auto-restart\n',
      'nr.clawcius': '82\n',
      'result.clawcius': 'exit-code\n',
    },
  });
  assert.equal(r.healthy, false);
  assert.match(r.why, /clawcius\(ActiveState=activating SubState=auto-restart NRestarts=82 Result=exit-code\)/);
});

test('a restart count alone fails the check, and reports the unit as active', () => {
  // The unit is up; it is the restarting that fails it. The tuple has to show both.
  const r = run({ files: { 'nr.hamachi': '3\n' } });
  assert.equal(r.healthy, false);
  assert.match(r.why, /hamachi\(ActiveState=active SubState=running NRestarts=3 Result=success\)/);
});

test('only the failing unit is reported, not the ones that were fine', () => {
  const r = run({ files: { 'state.clawcius': 'failed\n' } });
  assert.match(r.why, /clawcius\(/);
  assert.doesNotMatch(r.why, /hamachi\(/);
  assert.doesNotMatch(r.why, /clawcius-status\(/);
});

test('properties are read by name, so the order systemd prints them in does not matter', () => {
  // A systemctl that answers in a fixed, different order than it was asked in.
  const dir = mkdtempSync(join(tmpdir(), 'deploy-order-'));
  try {
    writeFileSync(join(dir, 'systemctl'), [
      '#!/bin/sh',
      'echo "Result=timeout"',
      'echo "NRestarts=7"',
      'echo "SubState=dead"',
      'echo "ActiveState=failed"',
    ].join('\n'));
    chmodSync(join(dir, 'systemctl'), 0o755);
    const out = execFileSync('bash', ['-c', DRIVER], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
             DEPLOY_SH: process.env.DEPLOY_SH ?? 'deploy/deploy.sh',
             SHA_IN: 'abc123', CREWS: '', UNITS: 'clawcius' },
    });
    assert.match(out, /clawcius\(ActiveState=failed SubState=dead NRestarts=7 Result=timeout\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a systemctl that answers nothing degrades to unknown rather than to an empty tuple', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-silent-'));
  try {
    writeFileSync(join(dir, 'systemctl'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, 'systemctl'), 0o755);
    const out = execFileSync('bash', ['-c', DRIVER], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
             DEPLOY_SH: process.env.DEPLOY_SH ?? 'deploy/deploy.sh',
             SHA_IN: 'abc123', CREWS: '', UNITS: 'clawcius' },
    });
    assert.match(out, /HEALTHY=no/);
    assert.match(out, /clawcius\(ActiveState=unknown SubState=unknown NRestarts=unknown Result=unknown\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the crew status-file conditions name the crew and say which of the two failed', () => {
  // A crew whose /var/lib path cannot exist, so both conditions fire the same way anywhere.
  const r = run({ crews: 'no-such-crew-exists' });
  assert.equal(r.healthy, false);
  assert.match(r.why, /no-such-crew-exists is not reporting abc123/);
  assert.match(r.why, /no-such-crew-exists status file is \d+s stale/);
});

test('the verdict kept is one poll, not every poll accumulated', () => {
  const r = run({ files: { 'state.hamachi': 'failed\n' } });
  assert.equal(r.why.match(/hamachi\(/g).length, 1);
});
