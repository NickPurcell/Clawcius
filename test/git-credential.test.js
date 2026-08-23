/**
 * Where an agent's git credential comes from.
 *
 * This is a shell snippet handed to git through `GIT_CONFIG_VALUE_n`, which
 * means it is a string that nothing type-checks and no test would notice being
 * wrong until an agent's `git push` failed. #180 is the recent lesson on that:
 * four lines of operator-facing behaviour with no test around them were wrong in
 * five consecutive reviews.
 *
 * The branch that matters is the FALLBACK. A deployment can have an App
 * configured and unusable — a typo'd key path, a rotated key, a bad
 * installation id — in which case the daemon writes no credential file and the
 * PAT is still there and still valid. If the helper committed to the file at
 * spawn, every agent push would fail for a deployment that had a working
 * credential the whole time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setConfig } from '../dist/config.js';
import { gitEnv } from '../dist/agent.js';
import { tokenFilePath } from '../dist/token-file.js';

function configure({ token = '', appId = '', workspaceRoot }) {
  setConfig({
    discord: { token: 'unused', guildId: 'unused' },
    github: { token, appId },
    storage: { dbPath: 'unused' },
    agent: {
      clawsky: { crew: 'hamachi', wakeOnMail: true },
      model: 'm',
      modelByRole: {},
      git: { userName: 'a', userEmail: 'a@b.c' },
      sessions: { maxConcurrent: 10, idleTimeoutMinutes: 0, workspaceRoot },
    },
  });
}

/** The helper as git runs it: strip the leading `!` and execute under `sh`. */
function runHelper(env, extraEnv) {
  const key = Object.keys(env)
    .filter((k) => k.startsWith('GIT_CONFIG_KEY_'))
    .find((k) => env[k] === 'credential.https://github.com.helper');
  assert.ok(key, 'no github credential helper was configured');
  const body = env[`GIT_CONFIG_VALUE_${key.split('_').pop()}`].replace(/^!/, '');
  return execFileSync('sh', ['-c', body], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

test('the credential comes from the file when the daemon has written one', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawsky-cred-'));
  configure({ token: 'ghp_the_pat', appId: '123', workspaceRoot: root });
  writeFileSync(tokenFilePath(root), 'ghs_installation_token');

  const out = runHelper(gitEnv(), { GITHUB_TOKEN: 'ghp_the_pat' });
  assert.match(out, /^username=x-access-token$/m);
  assert.match(out, /^password=ghs_installation_token$/m);
  assert.doesNotMatch(out, /ghp_the_pat/, 'the file must win while it exists');
});

test('an absent file falls back to the PAT rather than failing', () => {
  // THE BRANCH THIS TEST EXISTS FOR. A half-configured App means no file, and a
  // deployment in that state still has a working PAT. Committing to the file at
  // spawn would break every push for a crew whose credential was fine.
  const root = mkdtempSync(join(tmpdir(), 'clawsky-cred-'));
  configure({ token: 'ghp_the_pat', appId: '123', workspaceRoot: root });
  rmSync(tokenFilePath(root), { force: true });

  const out = runHelper(gitEnv(), { GITHUB_TOKEN: 'ghp_the_pat' });
  assert.match(out, /^password=ghp_the_pat$/m);
  // `cat`'s "No such file" must not reach git — it would be read as part of the
  // credential exchange. The absent file is the fallback, not an error.
  assert.doesNotMatch(out, /No such file/);
});

test('the fallback is resolved per call, not frozen at session spawn', () => {
  // A session outlives an installation token, so the helper has to see a file
  // that appears or disappears after the session started. One `gitEnv()`, two
  // different answers.
  const root = mkdtempSync(join(tmpdir(), 'clawsky-cred-'));
  configure({ token: 'ghp_the_pat', appId: '123', workspaceRoot: root });
  const env = gitEnv();

  writeFileSync(tokenFilePath(root), 'ghs_first');
  assert.match(runHelper(env, { GITHUB_TOKEN: 'ghp_the_pat' }), /password=ghs_first/);

  writeFileSync(tokenFilePath(root), 'ghs_second');
  assert.match(runHelper(env, { GITHUB_TOKEN: 'ghp_the_pat' }), /password=ghs_second/);

  rmSync(tokenFilePath(root), { force: true });
  assert.match(runHelper(env, { GITHUB_TOKEN: 'ghp_the_pat' }), /password=ghp_the_pat/);
});

test('a PAT-only deployment is byte-identical to before', () => {
  // Clawcius has no App and must keep working exactly as it did. The helper is
  // still configured, still reads at call time, and still answers with the PAT.
  const root = mkdtempSync(join(tmpdir(), 'clawsky-cred-'));
  configure({ token: 'ghp_clawcius', appId: '', workspaceRoot: root });

  const out = runHelper(gitEnv(), { GITHUB_TOKEN: 'ghp_clawcius' });
  assert.match(out, /^password=ghp_clawcius$/m);
});

test('no credential helper at all when there is no credential to serve', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawsky-cred-'));
  configure({ token: '', appId: '', workspaceRoot: root });
  const env = gitEnv();
  const keys = Object.keys(env)
    .filter((k) => k.startsWith('GIT_CONFIG_KEY_'))
    .map((k) => env[k]);
  assert.ok(!keys.includes('credential.https://github.com.helper'));
  // user.name and user.email are still set — an identity is not a credential.
  assert.ok(keys.includes('user.name'));
});

test('the token never appears in the environment handed to the container', () => {
  // The point of the helper has always been that the credential is not in a URL,
  // a remote or a reflog. With a file it is also not in `GIT_CONFIG_VALUE_n`.
  const root = mkdtempSync(join(tmpdir(), 'clawsky-cred-'));
  configure({ token: 'ghp_the_pat', appId: '123', workspaceRoot: root });
  writeFileSync(tokenFilePath(root), 'ghs_installation_token');

  const serialised = JSON.stringify(gitEnv());
  assert.doesNotMatch(serialised, /ghs_installation_token/, 'the minted token must stay on disk');
});
