/**
 * That importing this package does not require a deployment underneath it.
 *
 * This is the test the rest of `test/sessions.test.js` and `test/handlers.test.js`
 * rest on, and it is worth having on its own because it is the property that
 * keeps getting lost. `config.ts` used to build its object in the module body,
 * so the environment was read and `agent-config.yaml` was opened at IMPORT time.
 * Every module that imported it transitively — `agent.ts`, holding the session
 * pool, and `index.ts`, holding the Discord handler — could not be loaded by a
 * test at all. Three defects and three fixes went through that area in Clawcius
 * #128 with nothing able to reach any of them; #130 is the argument.
 *
 * That was half the coupling. The other half was `index.ts` itself: its module
 * body was the program and ended in `await client.login(...)`, so importing it
 * started a Discord bot however clean the environment was. #131 moved the body
 * into `main()` in `daemon.ts`, which is why `dist/daemon.js` is asserted here
 * alongside `dist/agent.js`.
 *
 * So there are two halves here and they pull against each other:
 *
 *   - `dist/agent.js` and `dist/daemon.js` import with an empty environment, and
 *   - `loadConfig()` still refuses a missing variable, and `dist/index.js` still
 *     dies on it.
 *
 * Satisfying the check instead of removing the coupling — a `DISCORD_TOKEN=test`
 * in the harness — would pass the first and quietly give up the second. The last
 * two tests below are what stop that being a way to make this file green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config, loadConfig, setConfig } from '../dist/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Import a module in a fresh process with a named environment.
 *
 * A child rather than a dynamic import, because the module registry of THIS
 * process already holds `dist/config.js` — imported at the top of this file
 * with the ambient environment present — and an import that finds a loaded
 * module proves nothing about what loading it does.
 */
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
  // The #131 half. `daemon.js` holds `main()` AND every Discord handler, so if
  // this regresses, `test/handlers.test.js` cannot exist: the announce-once
  // rule, the replay rule and the channel gates all go back to being reasoned
  // about. A module that starts a gateway connection on import would either hang
  // this child or fail it — either way, not `LOADED`.
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
  // `dist/index.js` is the entry point. It must NOT have become loadable — the
  // point was never that nothing throws, it is that the throw belongs to the
  // entry point rather than to `import`, and #131 did not change that: index.js
  // calls `main()` unconditionally, so importing it is running the daemon.
  //
  // This is also the assertion that stops #131 being "cured" by deleting the
  // `await main()` from index.ts. That would make every test in this repository
  // pass and ship a service that starts, prints a banner and does nothing.
  let failed = false;
  try {
    importIn('./dist/index.js', { PATH: process.env['PATH'] });
  } catch (error) {
    failed = true;
    // The build banner is printed by an import that runs before any of this,
    // and it must keep coming out of a process that is about to fail — that is
    // the whole of Clawcius #89.
    const printed = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assert.match(printed, /\[clawcius\] build /);
    assert.match(printed, /Missing required environment variable: DISCORD_TOKEN/);
  }
  assert.equal(failed, true, 'dist/index.js loaded without a Discord token');
});

test('config() before load is a loud error, not a second read of the environment', () => {
  // A fresh process because `loaded` is module state: whether this assertion
  // holds should not depend on where in the file it sits, or on what an earlier
  // test in it happened to install.
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

test('setConfig installs exactly what it was given', () => {
  const stub = { discord: { token: 't', guildId: 'g' }, github: { token: '' }, agent: { model: 'x' } };
  setConfig(stub);
  assert.equal(config(), stub);
  assert.equal(config().agent.model, 'x');
});
