import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function pgrep(...args) {
  try {
    return execFileSync('pgrep', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch { return []; }
}

// The bot is the `sleep 1000` child of a restart loop started for this test's run dir.
function botPids(dir) {
  const loops = pgrep('-f', `bot-loop ${dir}/run/`);
  return loops.length ? pgrep('-P', loops.join(','), '-f', '^sleep 1000$') : [];
}

async function until(cond, what) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const v = cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('HUP restarts each bot exactly once and TERM leaves nothing behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'supervise-'));
  cpSync('bots/supervise.sh', join(dir, 'supervise.sh'));
  writeFileSync(join(dir, 'manifest'), 'dummy|test|exec sleep 1000\nother|nope|exec sleep 1000\n');
  const sup = spawn('sh', [join(dir, 'supervise.sh')], {
    env: { ...process.env, CREW: 'test', BOTS_DIR: dir, BOTS_RUN: join(dir, 'run') },
    stdio: 'ignore',
  });
  try {
    const [first] = await until(() => { const p = botPids(dir); return p.length === 1 && p; }, 'one bot');
    sup.kill('SIGHUP');
    const [second] = await until(() => { const p = botPids(dir); return p.length === 1 && p[0] !== first && p; }, 'one new bot after HUP');
    assert.notEqual(first, second);
    sup.kill('SIGTERM');
    await until(() => botPids(dir).length === 0 && sup.exitCode !== null, 'no bots after TERM');
  } finally {
    sup.kill('SIGKILL');
    for (const pid of pgrep('-f', `bot-loop ${dir}/run/`)) try { process.kill(-Number(pid), 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
