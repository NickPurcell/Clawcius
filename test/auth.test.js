/**
 * A dead credential: telling the difference, saying so, and getting back in.
 *
 * Clawcius #369. Two of these are worth more than the rest. `credentialVerdict`
 * is the discriminator the whole fix rests on — get it wrong in one direction
 * and the twenty-hour silence comes back, wrong in the other and every stale
 * token a respawn would have fixed cries outage. And `authCodeProblem` is the
 * only thing standing between a pasted string and a process's stdin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuthLogin,
  AuthOutage,
  agentHome,
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

const HEALTHY = {
  accessToken: 'sk-ant-oat-live',
  refreshToken: 'sk-ant-ort-live',
  expiresAt: NOW + 3_600_000,
  refreshTokenExpiresAt: NOW + 30 * 86_400_000,
};

test('the credential file from the incident reads as terminal', () => {
  // Verbatim from #369: both tokens blanked, expiresAt zeroed, and a
  // refreshTokenExpiresAt that had already passed when the CLI rewrote it.
  const dir = credentialDir({
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    refreshTokenExpiresAt: 1_788_356_689_216,
  });
  try {
    const verdict = credentialVerdict(dir, NOW);
    assert.equal(verdict.terminal, true);
    assert.match(verdict.why, /refresh token is blank/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired refresh token is terminal and the message names when', () => {
  const dir = credentialDir({ ...HEALTHY, refreshTokenExpiresAt: NOW - 1 });
  try {
    const verdict = credentialVerdict(dir, NOW);
    assert.equal(verdict.terminal, true);
    assert.match(verdict.why, /expired at 2026-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale access token with a live refresh token stays quiet', () => {
  // THE case that must not announce: the running process is holding a token the
  // file has already replaced, and dropping the session picks the new one up.
  // #266's respawn gate owns this and a message here would undo it.
  const dir = credentialDir({ ...HEALTHY, expiresAt: NOW - 60_000 });
  try {
    assert.equal(credentialVerdict(dir, NOW).terminal, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a healthy credential is not terminal', () => {
  const dir = credentialDir(HEALTHY);
  try {
    assert.equal(credentialVerdict(dir, NOW).terminal, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refresh expiry of 0 or absent means unstated, not expired', () => {
  for (const oauth of [
    { ...HEALTHY, refreshTokenExpiresAt: 0 },
    { accessToken: 'a-token', refreshToken: 'a-refresh' },
  ]) {
    const dir = credentialDir(oauth);
    try {
      assert.equal(credentialVerdict(dir, NOW).terminal, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('missing, unparseable and shapeless credential files are all terminal', () => {
  const cases = [
    [undefined, /no \.credentials\.json/],
    ['{not json', /not valid JSON/],
    ['{"somethingElse":{}}', /no claudeAiOauth block/],
  ];
  for (const [contents, why] of cases) {
    const dir = credentialDir(contents);
    try {
      const verdict = credentialVerdict(dir, NOW);
      assert.equal(verdict.terminal, true, `expected terminal for ${String(contents)}`);
      assert.match(verdict.why, why);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the agent home is the bind mount, derived and not configured', () => {
  assert.equal(agentHome('/var/lib/clawcius'), '/var/lib/clawcius/agent-home');
});

test('a paste code with anything odd in it is refused, not trimmed', () => {
  // Refused rather than trimmed: half a code on stdin leaves the rest in the
  // stream and the failure lands somewhere far from here.
  assert.match(authCodeProblem(''), /no code/);
  assert.match(authCodeProblem('abc def'), /whitespace/);
  assert.match(authCodeProblem('abcdefgh\nrm -rf'), /whitespace/);
  assert.match(authCodeProblem('short'), /paste code/);
  assert.match(authCodeProblem('abcdefgh; echo pwned'), /whitespace/);
  assert.match(authCodeProblem(`${'a'.repeat(513)}`), /paste code/);
  assert.match(authCodeProblem('abcdefgh$(id)'), /paste code/);
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

  // A crew with no container runs it on the host, and says which config dir
  // rather than trusting the unit to have set it.
  const onHost = authArgv({ ...target, containerEnabled: false }, ['auth', 'status']);
  assert.equal(onHost.file, 'claude');
  assert.deepEqual(onHost.args, ['auth', 'status']);
  assert.equal(onHost.env.CLAUDE_CONFIG_DIR, '/var/lib/clawcius/agent-home');
});

test('auth status is read as JSON, then as prose, then not at all', () => {
  assert.equal(readLoggedIn('{"loggedIn":true}'), true);
  assert.equal(readLoggedIn('{"loggedIn":false,"account":null}'), false);
  assert.equal(readLoggedIn('You are not logged in.'), false);
  assert.equal(readLoggedIn('Logged in as someone@example.com'), true);
  // A CLI that changes its output downgrades to "could not tell" rather than to
  // a confident wrong answer — this is the confirmation step of the only path
  // back from a dead credential.
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

const URL_LINE =
  "Opening browser to sign in…\nIf the browser didn't open, visit: " +
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=9PGDW\n' +
  'Paste code here if prompted >';

const TARGET = {
  containerEnabled: true,
  containerName: 'clawcius-agent',
  claudePath: '/usr/local/bin/claude',
  hostClaudePath: 'claude',
  home: '/var/lib/clawcius/agent-home',
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

test('begin reads the URL out of what the CLI printed', async () => {
  const { login, spawned } = loginHarness();
  const pending = login.begin();
  await Promise.resolve();
  spawned[0].child.say(URL_LINE);
  const result = await pending;
  assert.equal(result.url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=9PGDW');
  assert.deepEqual(spawned[0].args.slice(-3), ['auth', 'login', '--claudeai']);
});

test('a second begin reuses the login already waiting', async () => {
  // Two live PKCE challenges is one more than can ever be used, and the repeat
  // announcement four hours later must not orphan the first one's process.
  const { login, spawned } = loginHarness();
  const first = login.begin();
  await Promise.resolve();
  spawned[0].child.say(URL_LINE);
  const started = await first;

  const again = await login.begin();
  assert.deepEqual(again, started);
  assert.equal(spawned.length, 1);
});

test('a login that dies before printing a URL is reported, not held', async () => {
  const { login, spawned } = loginHarness();
  const pending = login.begin();
  await Promise.resolve();
  spawned[0].child.emit('exit', 1);
  const result = await pending;
  assert.match(result.error, /exited before it printed a URL/);
  assert.equal(login.pendingUrl, null);
});

test('a bad code never reaches stdin', async () => {
  const { login, spawned } = loginHarness();
  const pending = login.begin();
  await Promise.resolve();
  spawned[0].child.say(URL_LINE);
  await pending;

  const said = await login.submit('has spaces in it');
  assert.match(said, /whitespace/);
  assert.deepEqual(spawned[0].child.written, []);
  // And nothing was spawned to run `auth status` either — it never got that far.
  assert.equal(spawned.length, 1);
});

test('a good code goes in on stdin and the answer comes from auth status', async () => {
  const { login, spawned } = loginHarness();
  const pending = login.begin();
  await Promise.resolve();
  spawned[0].child.say(URL_LINE);
  await pending;

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

  assert.match(await submitting, /Authenticated/);
});

test('a code with no login waiting says how to start one', async () => {
  const { login, spawned } = loginHarness();
  assert.match(await login.submit('lJ8x-Ab_c0D3#9PGDW'), /No login is waiting/);
  assert.equal(spawned.length, 0);
});

test('an exchange that did not take is reported as not taken', async () => {
  const { login, spawned } = loginHarness();
  const pending = login.begin();
  await Promise.resolve();
  spawned[0].child.say(URL_LINE);
  await pending;

  const submitting = login.submit('lJ8x-Ab_c0D3#9PGDW');
  await Promise.resolve();
  spawned[0].child.emit('exit', 1);
  await settle();
  spawned[1].child.say('{"loggedIn":false}');
  spawned[1].child.emit('exit', 0);
  assert.match(await submitting, /did not take/);
});

test('stop kills a login that is holding a URL nobody used', async () => {
  const { login, spawned } = loginHarness();
  const pending = login.begin();
  await Promise.resolve();
  spawned[0].child.say(URL_LINE);
  await pending;

  login.stop();
  assert.deepEqual(spawned[0].child.signals, ['SIGTERM']);
  assert.equal(login.pendingUrl, null);
});

/** Let the promise chains inside `AuthLogin` settle. */
async function settle(times = 20) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const deadTurn = (overrides = {}) => ({
  apiErrorKind: 'authentication_failed',
  noRetryReason: 'credential-dead',
  ...overrides,
});

/** An announcer over a real credential directory and a fake channel. */
function outageHarness(oauth, { now = () => NOW } = {}) {
  const dir = credentialDir(oauth);
  const sent = [];
  const { login, spawned } = loginHarness({ now });
  const outage = new AuthOutage({
    home: dir,
    login,
    mainChannelId: 'C-main',
    crew: 'Clawcius',
    send: async (channelId, text) => sent.push({ channelId, text }),
    log: () => {},
    now,
  });
  return { outage, sent, spawned, dir };
}

test('owns is true only for a credential the disk says is finished', () => {
  const dead = outageHarness({ accessToken: '', refreshToken: '', refreshTokenExpiresAt: 1 });
  try {
    assert.equal(dead.outage.owns(deadTurn()), true);
    // A rate limit is not this, however terminal it is.
    assert.equal(dead.outage.owns(deadTurn({ apiErrorKind: 'rate_limit' })), false);
    // And neither is an auth failure with retries still queued.
    assert.equal(dead.outage.owns(deadTurn({ noRetryReason: null })), false);
  } finally {
    rmSync(dead.dir, { recursive: true, force: true });
  }

  // The transient case: same summary, healthy file, and the respawn keeps it.
  const alive = outageHarness(HEALTHY);
  try {
    assert.equal(alive.outage.owns(deadTurn()), false);
  } finally {
    rmSync(alive.dir, { recursive: true, force: true });
  }
});

test('the announcement carries the link and how to answer it', async () => {
  const { outage, sent, spawned, dir } = outageHarness({ accessToken: '', refreshToken: '' });
  try {
    const announcing = outage.announce(null);
    await settle();
    spawned[0].child.say(URL_LINE);
    await announcing;

    assert.equal(sent.length, 1);
    assert.equal(sent[0].channelId, 'C-main');
    assert.match(sent[0].text, /Clawcius cannot authenticate/);
    assert.match(sent[0].text, /https:\/\/claude\.com\/cai\/oauth\/authorize/);
    assert.match(sent[0].text, /!auth <code>/);
    // ⚠️ is reserved for the system's own messages about the crew.
    assert.equal(sent[0].text.includes('⚠️'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the loop is announced once; a person who typed always gets an answer', async () => {
  // Twelve refusals a minute for twenty hours is fourteen thousand events.
  let clock = NOW;
  const { outage, sent, spawned, dir } = outageHarness(
    { accessToken: '', refreshToken: '' },
    { now: () => clock },
  );
  try {
    const first = outage.announce(null);
    await settle();
    spawned[0].child.say(URL_LINE);
    await first;
    assert.equal(sent.length, 1);

    for (let i = 0; i < 50; i += 1) {
      clock += 5_000;
      await outage.announce(null);
    }
    assert.equal(sent.length, 1, 'the mail loop should not repeat inside the cooldown');

    // Somebody in the channel is not the loop. They asked; they get told.
    await outage.announce('C-thread');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].channelId, 'C-thread');
    assert.match(sent[1].text, /did not reach me/);

    // And four hours later the loop says it again.
    clock += 4 * 60 * 60 * 1000 + 1;
    await outage.announce(null);
    assert.equal(sent.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a credential that came back is not announced', async () => {
  const { outage, sent, dir } = outageHarness(HEALTHY);
  try {
    await outage.announce(null);
    assert.deepEqual(sent, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no link is still a message', async () => {
  // The container is down, or `paths.claudeCli` is not executable by this unit's
  // user. The channel still has to hear that the crew is dead.
  const dir = credentialDir({ accessToken: '', refreshToken: '' });
  const sent = [];
  const outage = new AuthOutage({
    home: dir,
    login: new AuthLogin({
      target: TARGET,
      log: () => {},
      now: () => NOW,
      spawn: () => {
        throw new Error('spawn docker ENOENT');
      },
    }),
    mainChannelId: 'C-main',
    crew: 'Clawcius',
    send: async (channelId, text) => sent.push({ channelId, text }),
    log: () => {},
    now: () => NOW,
  });
  try {
    await outage.announce(null);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /cannot authenticate/);
    assert.match(sent[0].text, /could not start a login/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
