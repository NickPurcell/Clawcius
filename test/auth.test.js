import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuthLogin,
  AuthOutage,
  authArgv,
  authCodeProblem,
  credentialVerdict,
  readLoggedIn,
} from '../dist/auth.js';

const NOW = 1_788_400_000_000;

/** A credential directory holding exactly what `.credentials.json` is given. */
function credentialDir(oauth) {
  const dir = mkdtempSync(join(tmpdir(), 'clawcius-auth-'));
  if (oauth !== undefined) {
    writeFileSync(
      join(dir, '.credentials.json'),
      typeof oauth === 'string' ? oauth : JSON.stringify({ claudeAiOauth: oauth }),
    );
  }
  return dir;
}

/** Run `body` against a credential directory and clean it up. */
function withCredential(oauth, body) {
  const dir = credentialDir(oauth);
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEALTHY = {
  accessToken: 'sk-ant-oat-live',
  refreshToken: 'sk-ant-ort-live',
  expiresAt: NOW + 3_600_000,
  refreshTokenExpiresAt: NOW + 30 * 86_400_000,
};

test('a credential blanked by a failed refresh is terminal', () => {
  withCredential(
    { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: 1_788_356_689_216 },
    (dir) => assert.equal(credentialVerdict(dir, NOW).terminal, true),
  );
});

test('a refresh token past its expiry is terminal', () => {
  withCredential({ ...HEALTHY, refreshTokenExpiresAt: NOW - 1 }, (dir) =>
    assert.equal(credentialVerdict(dir, NOW).terminal, true),
  );
});

test('a stale access token with a live refresh token is not terminal', () => {
  // The case a respawn clears. Announcing it would undo the respawn gate.
  withCredential({ ...HEALTHY, expiresAt: NOW - 60_000 }, (dir) =>
    assert.equal(credentialVerdict(dir, NOW).terminal, false),
  );
});

test('a healthy credential is not terminal', () => {
  withCredential(HEALTHY, (dir) => assert.equal(credentialVerdict(dir, NOW).terminal, false));
});

test('a refresh expiry of 0 or absent is unstated, not expired', () => {
  for (const oauth of [
    { ...HEALTHY, refreshTokenExpiresAt: 0 },
    { accessToken: 'a-token', refreshToken: 'a-refresh' },
  ]) {
    withCredential(oauth, (dir) => assert.equal(credentialVerdict(dir, NOW).terminal, false));
  }
});

test('missing, unparseable and shapeless credential files are terminal', () => {
  for (const contents of [undefined, '{not json', '{"somethingElse":{}}']) {
    withCredential(contents, (dir) =>
      assert.equal(credentialVerdict(dir, NOW).terminal, true, `for ${String(contents)}`),
    );
  }
});

test('a paste code with anything odd in it is refused, not trimmed', () => {
  for (const bad of [
    '',
    'abc def',
    'abcdefgh\nrm -rf',
    'short',
    'abcdefgh; echo pwned',
    'a'.repeat(513),
    'abcdefgh$(id)',
  ]) {
    assert.notEqual(authCodeProblem(bad), null, `expected a problem for ${JSON.stringify(bad)}`);
  }
});

test('a real-shaped paste code is accepted', () => {
  assert.equal(authCodeProblem('lJ8x-Ab_c0D3#9PGDW9STnr2y-E03bMd02mgJPoLGM6j2pM78wGXyEYY'), null);
});

test('the login runs where the credential is written', () => {
  const target = {
    containerEnabled: true,
    containerName: 'clawcius-agent',
    claudePath: '/usr/local/bin/claude',
    hostClaudePath: 'claude',
    home: '/var/lib/clawcius/agent-home',
    loginCommand: ['setup-token'],
  };
  const inContainer = authArgv(target, ['auth', 'login', '--claudeai']);
  assert.equal(inContainer.file, 'docker');
  assert.deepEqual(inContainer.args, [
    'exec',
    '-i',
    'clawcius-agent',
    '/usr/local/bin/claude',
    'auth',
    'login',
    '--claudeai',
  ]);

  const onHost = authArgv({ ...target, containerEnabled: false }, ['auth', 'status']);
  assert.equal(onHost.file, 'claude');
  assert.deepEqual(onHost.args, ['auth', 'status']);
  assert.equal(onHost.env.CLAUDE_CONFIG_DIR, '/var/lib/clawcius/agent-home');
});

test('auth status is read as JSON, then as prose, then not at all', () => {
  // The JSON form is what the CLI emits: {"loggedIn": false, "authMethod": "none", …}
  assert.equal(readLoggedIn('{"loggedIn":true}'), true);
  assert.equal(readLoggedIn('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'), false);
  assert.equal(readLoggedIn('You are not logged in.'), false);
  assert.equal(readLoggedIn('Logged in as someone@example.com'), true);
  assert.equal(readLoggedIn('¯\\_(ツ)_/¯'), null);
});

/** A child process, as much of one as `AuthLogin` touches. */
function fakeChild() {
  const listeners = new Map();
  const streams = { stdout: [], stderr: [] };
  const child = {
    written: [],
    signals: [],
    stdout: { on: (_event, cb) => streams.stdout.push(cb) },
    stderr: { on: (_event, cb) => streams.stderr.push(cb) },
    stdin: {
      write: (chunk) => {
        child.written.push(chunk);
        return true;
      },
    },
    once: (event, cb) => {
      const existing = listeners.get(event) ?? [];
      existing.push(cb);
      listeners.set(event, existing);
    },
    kill: (signal) => child.signals.push(signal ?? 'SIGTERM'),
    say: (text, stream = 'stdout') => {
      for (const cb of streams[stream]) cb(Buffer.from(text));
    },
    emit: (event, ...args) => {
      const cbs = listeners.get(event) ?? [];
      listeners.set(event, []);
      for (const cb of cbs) cb(...args);
    },
  };
  return child;
}

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=9PGDW';
/** As `setup-token` draws it: the visible text wrapped, the whole URL in the hyperlink. */
const URL_LINE =
  'Browser didn\u2019t open? Use the url below to sign in\r\n' +
  `\u001b]8;id=1;${URL}\u0007https://claude.com/cai/oauth/authorize?code=true&client_i\u001b]8;;\u0007\r\n` +
  'Paste code here if prompted >';

const TARGET = {
  containerEnabled: true,
  containerName: 'clawcius-agent',
  claudePath: '/usr/local/bin/claude',
  hostClaudePath: 'claude',
  home: '/var/lib/clawcius/agent-home',
  loginCommand: ['setup-token'],
};

/** An `AuthLogin` whose children are handed back for the test to drive. */
function loginHarness({ now = () => NOW } = {}) {
  const spawned = [];
  const login = new AuthLogin({
    target: TARGET,
    log: () => {},
    now,
    spawn: (file, args) => {
      const child = fakeChild();
      spawned.push({ file, args: [...args], child });
      return child;
    },
  });
  return { login, spawned };
}

/** Let the promise chains inside `AuthLogin` settle. */
async function settle(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** Start a login and give it the URL line. */
async function started(login, spawned) {
  const pending = login.begin();
  await Promise.resolve();
  spawned[spawned.length - 1].child.say(URL_LINE);
  return pending;
}

test('begin reads the URL out of what the CLI printed', async () => {
  const { login, spawned } = loginHarness();
  const result = await started(login, spawned);
  assert.equal(result.url, URL);
  assert.equal(spawned[0].file, 'script');
  assert.ok(spawned[0].args[1].endsWith("'clawcius-agent' '/usr/local/bin/claude' 'setup-token'"));
  assert.ok(spawned[0].args[1].startsWith("'docker' 'exec' '-it'"));
});

test('a second begin reuses the login already waiting', async () => {
  const { login, spawned } = loginHarness();
  const first = await started(login, spawned);
  assert.deepEqual(await login.begin(), first);
  assert.equal(spawned.length, 1);
});

test('a login that dies before printing a URL is reported, not held', async () => {
  const { login, spawned } = loginHarness();
  const pending = login.begin();
  await Promise.resolve();
  spawned[0].child.emit('exit', 1);
  assert.ok('error' in (await pending));
  assert.equal(login.pendingUrl, null);
});

test('an expired login mints a fresh one rather than refusing', async () => {
  let clock = NOW;
  const { login, spawned } = loginHarness({ now: () => clock });
  await started(login, spawned);

  login.stop(); // what the idle timer does when nobody came back
  clock += 3 * 60 * 60 * 1000;

  assert.equal((await started(login, spawned)).url, URL);
  assert.equal(spawned.length, 2);
});

test('two begins a moment apart do not start two logins', async () => {
  const { login, spawned } = loginHarness();
  await started(login, spawned);
  login.stop();

  const immediate = await login.begin();
  assert.ok('error' in immediate);
  assert.equal(spawned.length, 1);
});

test('a bad code never reaches stdin', async () => {
  const { login, spawned } = loginHarness();
  await started(login, spawned);

  const outcome = await login.submit('has spaces in it');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'bad-code');
  assert.deepEqual(spawned[0].child.written, []);
  assert.equal(spawned.length, 1, 'auth status was never reached');
});

test('a good code goes in on stdin and the answer comes from auth status', async () => {
  const { login, spawned } = loginHarness();
  await started(login, spawned);

  const submitting = login.submit('lJ8x-Ab_c0D3#9PGDW');
  await Promise.resolve();
  assert.deepEqual(spawned[0].child.written, ['lJ8x-Ab_c0D3#9PGDW\n']);
  // Never on a command line: /proc/<pid>/cmdline is world-readable.
  assert.equal(
    spawned.some(({ args }) => args.some((arg) => arg.includes('lJ8x'))),
    false,
  );

  spawned[0].child.emit('exit', 0);
  await settle();
  const statusRun = spawned[1];
  assert.deepEqual(statusRun.args.slice(-2), ['auth', 'status']);
  statusRun.child.say('{"loggedIn":true}');
  statusRun.child.emit('exit', 0);

  assert.deepEqual(await submitting, { ok: true });
});

test('a code with no login waiting is refused before anything is spawned', async () => {
  const { login, spawned } = loginHarness();
  const outcome = await login.submit('lJ8x-Ab_c0D3#9PGDW');
  assert.equal(outcome.reason, 'none-waiting');
  assert.equal(spawned.length, 0);
});

test('an exchange that did not take is reported as not taken', async () => {
  const { login, spawned } = loginHarness();
  await started(login, spawned);

  const submitting = login.submit('lJ8x-Ab_c0D3#9PGDW');
  await Promise.resolve();
  spawned[0].child.emit('exit', 1);
  await settle();
  spawned[1].child.say('{"loggedIn":false}');
  spawned[1].child.emit('exit', 0);
  assert.equal((await submitting).reason, 'not-taken');
});

test('a login still running when the exchange window closes is killed, not left holding', async () => {
  // Its idle timer is cleared when the code goes in, so nothing else reaps it.
  const spawned = [];
  const login = new AuthLogin({
    target: TARGET,
    log: () => {},
    now: () => NOW,
    exchangeMs: 0,
    spawn: (file, args) => {
      const child = fakeChild();
      spawned.push({ file, args: [...args], child });
      return child;
    },
  });
  await started(login, spawned);

  const submitting = login.submit('lJ8x-Ab_c0D3#9PGDW');
  await new Promise((resolve) => setImmediate(resolve));
  await settle();

  assert.deepEqual(spawned[0].child.signals, ['SIGTERM'], 'the login that never exited was killed');
  assert.equal(login.pendingUrl, null);

  spawned[1].child.say('{"loggedIn":false}');
  spawned[1].child.emit('exit', 0);
  assert.equal((await submitting).ok, false);
});

test('stop kills a login that is holding a URL nobody used', async () => {
  const { login, spawned } = loginHarness();
  await started(login, spawned);

  login.stop();
  assert.deepEqual(spawned[0].child.signals, ['SIGTERM']);
  assert.equal(login.pendingUrl, null);
});

const deadTurn = (overrides = {}) => ({
  apiErrorKind: 'authentication_failed',
  noRetryReason: 'credential-dead',
  ...overrides,
});

/** An announcer over a real credential directory and a fake channel. */
function outageHarness(oauth, { now = () => NOW } = {}) {
  const dir = credentialDir(oauth);
  const sent = [];
  const outage = new AuthOutage({
    home: dir,
    mainChannelId: 'C-main',
    crew: 'Clawcius',
    loginPageUrl: 'https://box.example.ts.net/login',
    send: async (channelId, text) => sent.push({ channelId, text }),
    log: () => {},
    now,
  });
  return { outage, sent, dir };
}

const DEAD = { accessToken: '', refreshToken: '' };

test('owns answers only for a credential the disk says is finished', () => {
  const dead = outageHarness(DEAD);
  try {
    assert.notEqual(dead.outage.owns(deadTurn()), null);
    assert.equal(dead.outage.owns(deadTurn({ apiErrorKind: 'rate_limit' })), null);
    assert.equal(dead.outage.owns(deadTurn({ noRetryReason: null })), null);
  } finally {
    rmSync(dead.dir, { recursive: true, force: true });
  }

  const alive = outageHarness(HEALTHY);
  try {
    assert.equal(alive.outage.owns(deadTurn()), null);
  } finally {
    rmSync(alive.dir, { recursive: true, force: true });
  }
});

test('the announcement goes to the main channel and points at the page', async () => {
  const { outage, sent, dir } = outageHarness(DEAD);
  try {
    await outage.announce(outage.owns(deadTurn()), null);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].channelId, 'C-main');
    assert.ok(sent[0].text.includes('https://box.example.ts.net/login'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the refusal loop is announced once; a person who typed always gets an answer', async () => {
  let clock = NOW;
  const { outage, sent, dir } = outageHarness(DEAD, { now: () => clock });
  try {
    const dead = outage.owns(deadTurn());
    await outage.announce(dead, null);
    assert.equal(sent.length, 1);

    for (let i = 0; i < 50; i += 1) {
      clock += 5_000;
      await outage.announce(dead, null);
    }
    assert.equal(sent.length, 1, 'the refusal loop does not repeat inside the cooldown');

    await outage.announce(dead, 'C-thread');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].channelId, 'C-thread');

    clock += 4 * 60 * 60 * 1000 + 1;
    await outage.announce(dead, null);
    assert.equal(sent.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a send that throws does not escape the announcer', async () => {
  const dir = credentialDir(DEAD);
  const outage = new AuthOutage({
    home: dir,
    mainChannelId: 'C-main',
    crew: 'Clawcius',
    loginPageUrl: 'https://box.example.ts.net/login',
    send: async () => {
      throw new Error('Unknown Channel');
    },
    log: () => {},
    now: () => NOW,
  });
  try {
    await outage.announce({ why: 'the refresh token is blank' }, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
