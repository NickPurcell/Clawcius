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
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

import { setConfig } from '../dist/config.js';
import { gitEnv } from '../dist/agent.js';
import { tokenFilePath, writeCurlConfig, netrcPath } from '../dist/token-file.js';

function configure({ token = '', appId = '', githubTokenDir, armed = true }) {
  setConfig({
    discord: { token: 'unused', guildId: 'unused' },
    github: { token, appId },
    storage: { dbPath: 'unused' },
    agent: {
      clawsky: { crew: 'hamachi', wakeOnMail: true, enabled: true },
      armed: { enabled: armed },
      model: 'm',
      modelByRole: {},
      git: { userName: 'a', userEmail: 'a@b.c' },
      container: { githubTokenDir },
      sessions: { maxConcurrent: 10, idleTimeoutMinutes: 0 },
    },
  });
}

/** The helper as git runs it: strip the leading `!` and execute under `sh`. */
function runHelper(env, extraEnv) {
  // The container receives CLAWSKY_GITHUB_TOKEN_FILE alongside the git config,
  // so a test that omitted it would be exercising a helper no agent ever runs.
  const key = Object.keys(env)
    .filter((k) => k.startsWith('GIT_CONFIG_KEY_'))
    .find((k) => env[k] === 'credential.https://github.com.helper');
  assert.ok(key, 'no github credential helper was configured');
  const body = env[`GIT_CONFIG_VALUE_${key.split('_').pop()}`].replace(/^!/, '');
  return execFileSync('sh', ['-c', body], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAWSKY_GITHUB_TOKEN_FILE: env['CLAWSKY_GITHUB_TOKEN_FILE'] ?? '',
      ...extraEnv,
    },
  });
}

test('the credential comes from the file when the daemon has written one', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawsky-cred-'));
  configure({ token: 'ghp_the_pat', appId: '123', githubTokenDir: root });
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
  configure({ token: 'ghp_the_pat', appId: '123', githubTokenDir: root });
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
  configure({ token: 'ghp_the_pat', appId: '123', githubTokenDir: root });
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
  configure({ token: 'ghp_clawcius', appId: '', githubTokenDir: root });

  const out = runHelper(gitEnv(), { GITHUB_TOKEN: 'ghp_clawcius' });
  assert.match(out, /^password=ghp_clawcius$/m);
});

test('no credential helper at all when there is no credential to serve', () => {
  const root = mkdtempSync(join(tmpdir(), 'clawsky-cred-'));
  configure({ token: '', appId: '', githubTokenDir: root });
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
  configure({ token: 'ghp_the_pat', appId: '123', githubTokenDir: root });
  writeFileSync(tokenFilePath(root), 'ghs_installation_token');

  const serialised = JSON.stringify(gitEnv());
  assert.doesNotMatch(serialised, /ghs_installation_token/, 'the minted token must stay on disk');
});

test('no helper when the App is configured but nothing will write the file', () => {
  // FINDING 18, raised three rounds running. `gitEnv` emitted the file-first
  // helper whenever `github.appId` was set, but the file is only written under
  // `armedStore && app && appTokenOk` — and `armedStore` also needs
  // `clawsky.enabled && armed.enabled`. So this deployment wrote no file, started
  // no refresher (hence not even its "no usable credential" line), and with no PAT
  // the helper handed git an EMPTY password.
  //
  // Empty is the less nameable failure of the two: git reports an auth failure
  // against a credential it was given, where no helper at all makes it say it
  // could not read a username.
  const root = mkdtempSync(join(tmpdir(), 'clawsky-cred-'));
  configure({ token: '', appId: '123', githubTokenDir: root, armed: false });
  const keys = Object.keys(gitEnv())
    .filter((k) => k.startsWith('GIT_CONFIG_KEY_'))
    .map((k) => gitEnv()[k]);
  assert.ok(
    !keys.includes('credential.https://github.com.helper'),
    'no writer means no helper — the two conditions must describe one deployment',
  );

  // …and with armed watching ON, the file will be written, so the helper belongs.
  configure({ token: '', appId: '123', githubTokenDir: root, armed: true });
  const on = Object.keys(gitEnv())
    .filter((k) => k.startsWith('GIT_CONFIG_KEY_'))
    .map((k) => gitEnv()[k]);
  assert.ok(on.includes('credential.https://github.com.helper'));
});

// ── the CURL_HOME wiring, end to end and offline ────────────────────────────

/** Start a server that reports the Authorization header it was sent. */
async function echoAuthServer() {
  const server = createServer((req, res) => {
    res.end(JSON.stringify({ auth: req.headers['authorization'] ?? null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/**
 * ASYNC, and it has to be. `execFileSync` blocks the event loop, so a server
 * listening in THIS process can never accept the connection curl is waiting on
 * — curl waits for a reply that cannot be sent and the sync call waits for curl.
 * A deadlock rather than a slow test, and it presents as the whole file hanging
 * before a single assertion runs.
 *
 * The other tests here use `execFileSync` safely because the credential helper
 * they run talks to nothing.
 */
const curlAuth = async (port, curlHome) => {
  const { stdout } = await execFile(
    'curl',
    ['-s', '--noproxy', '*', `http://127.0.0.1:${port}/`],
    { encoding: 'utf8', env: { ...process.env, CURL_HOME: curlHome } },
  );
  return JSON.parse(stdout).auth;
};

test('CURL_HOME reaches the agent, and a bare curl carries the credential', async () => {
  // THE ONE LINK WITH NO TEST. `agent.ts` sets CURL_HOME; every other assertion
  // is about file contents and cannot see whether the environment actually
  // points at the directory. This file's header is the argument: it is a string
  // nothing type-checks, and nothing would notice it being wrong until an agent
  // got a 401 with no explanation.
  //
  // Offline, against a local server, so what is proved is that curl FOUND the
  // .curlrc, found the netrc through it, and applied it — not that GitHub
  // accepts anything.
  const root = mkdtempSync(join(tmpdir(), 'clawsky-curl-'));
  configure({ token: 'ghp_the_pat', appId: '123', githubTokenDir: root });
  writeCurlConfig(root, 'ghs_installation_token');

  const env = gitEnv();
  assert.equal(env['CURL_HOME'], root, 'the agent must be pointed at the directory');

  const { server, port } = await echoAuthServer();
  try {
    writeFileSync(
      netrcPath(root),
      'machine 127.0.0.1\n  login x-access-token\n  password ghs_installation_token\n',
    );
    const auth = await curlAuth(port, env['CURL_HOME']);
    assert.ok(auth, 'curl sent no Authorization header — the chain is broken');
    assert.match(
      Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString(),
      /^x-access-token:ghs_installation_token$/,
      'and it must be the credential the daemon wrote',
    );
  } finally {
    server.close();
  }
});

test('a directory whose name contains a space still authenticates', async () => {
  // The quoting assertion in token-file.test.js is shape-only — it proves the
  // file says the right thing, not that curl accepts it. This is the other half,
  // and it is the half the shape assertion cannot reach: curl terminates an
  // unquoted parameter at the first space, and `netrc-optional` then means the
  // failure is a silent 401 rather than an error.
  const root = mkdtempSync(join(tmpdir(), 'clawsky cred-'));
  assert.ok(root.includes(' '), 'the point of this test is the space');
  configure({ token: 'ghp_the_pat', appId: '123', githubTokenDir: root });
  writeCurlConfig(root, 'ghs_installation_token');

  const { server, port } = await echoAuthServer();
  try {
    writeFileSync(
      netrcPath(root),
      'machine 127.0.0.1\n  login x-access-token\n  password ghs_spaced\n',
    );
    const auth = await curlAuth(port, gitEnv()['CURL_HOME']);
    assert.ok(auth, 'a space in the path must not silently disable the credential');
    assert.match(
      Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString(),
      /^x-access-token:ghs_spaced$/,
    );
  } finally {
    server.close();
  }
});

test('a host not in the netrc gets nothing', async () => {
  // The scope assertion in token-file.test.js checks the file's CONTENTS; this
  // checks curl honours it. Both halves are needed — a correct file that curl
  // ignored would look identical from the file's side.
  const root = mkdtempSync(join(tmpdir(), 'clawsky-curl-'));
  configure({ token: 'ghp_the_pat', appId: '123', githubTokenDir: root });
  writeCurlConfig(root, 'ghs_installation_token');   // scoped to api.github.com

  const { server, port } = await echoAuthServer();
  try {
    assert.equal(
      await curlAuth(port, gitEnv()['CURL_HOME']),
      null,
      'the App credential must not reach a host outside the netrc',
    );
  } finally {
    server.close();
  }
});
