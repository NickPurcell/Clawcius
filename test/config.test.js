import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config, loadConfig, setConfig } from '../dist/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Import a module in a fresh process with a named environment. */
function importIn(specifier, env) {
  return execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(specifier)}).then(() => process.stdout.write('LOADED'))`],
    { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

test('dist/agent.js loads with no Discord token, no guild and no config path', () => {
  // Not "the ambient environment minus DISCORD_TOKEN" — genuinely nothing but
  // PATH, so a variable nobody thought of cannot be what is holding it up.
  const out = importIn('./dist/agent.js', { PATH: process.env['PATH'] });
  assert.equal(out, 'LOADED');
});

test('dist/daemon.js loads with no Discord token either — importing it starts nothing', () => {
  const out = importIn('./dist/daemon.js', { PATH: process.env['PATH'] });
  assert.equal(out, 'LOADED');
});

test('the startup check survives: loadConfig() still refuses a missing DISCORD_TOKEN', () => {
  const saved = process.env['DISCORD_TOKEN'];
  delete process.env['DISCORD_TOKEN'];
  try {
    assert.throws(() => loadConfig(), /Missing required environment variable: DISCORD_TOKEN/);
  } finally {
    if (saved === undefined) delete process.env['DISCORD_TOKEN'];
    else process.env['DISCORD_TOKEN'] = saved;
  }
});

test('the entry point still dies on a missing token, and says so before it dies', () => {
  let failed = false;
  try {
    importIn('./dist/index.js', { PATH: process.env['PATH'] });
  } catch (error) {
    failed = true;
    const printed = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assert.match(printed, /\[clawcius\] build /);
    assert.match(printed, /Missing required environment variable: DISCORD_TOKEN/);
  }
  assert.equal(failed, true, 'dist/index.js loaded without a Discord token');
});

test('config() before load is a loud error, not a second read of the environment', () => {
  const script =
    `import('./dist/config.js').then(({ config }) => {` +
    `  try { config(); process.stdout.write('RETURNED'); }` +
    `  catch (e) { process.stdout.write('THREW:' + e.message); }` +
    `})`;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    // A complete, valid environment — including a real token. Even so, nothing
    // should be read: a `config()` that lazily loaded would put the startup
    // failure inside whatever code path got there first.
    env: { ...process.env, DISCORD_TOKEN: 'present', DISCORD_GUILD_ID: 'present' },
    encoding: 'utf8',
  });
  assert.match(out, /^THREW:Config has not been loaded/);
});

