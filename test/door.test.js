/**
 * The login page: what a read does, what a write does, and the line between.
 *
 * The rule the first two tests exist for: loading the page must never start a
 * login. An always-on recovery page that logs the crew out by being looked at
 * is worse than one that is only reachable during an outage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { doorHandler, doorState } from '../dist/door.js';

const NOW = 1_788_400_000_000;

function credentialDir(oauth) {
  const dir = mkdtempSync(join(tmpdir(), 'clawcius-door-'));
  if (oauth !== undefined) {
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  }
  return dir;
}

const HEALTHY = {
  accessToken: 'a-token',
  refreshToken: 'a-refresh',
  refreshTokenExpiresAt: NOW + 30 * 86_400_000,
};
const DEAD = { accessToken: '', refreshToken: '' };

/** A login that records every call, so a test can prove one did not happen. */
function fakeLogin({ url = 'https://claude.com/cai/oauth/authorize?x=1', submit } = {}) {
  const login = {
    calls: [],
    pendingUrl: null,
    begin: async () => {
      login.calls.push('begin');
      return url === null ? { error: 'docker is not running' } : { url };
    },
    submit: async (code) => {
      login.calls.push(`submit:${code}`);
      return submit ?? { ok: true };
    },
  };
  return login;
}

/** A response that records what was written to it. */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    end(text) {
      this.body = text ?? '';
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

/** A request carrying `body`, delivered on the next tick as a real one would be. */
function fakeRequest(method, url, body) {
  const listeners = {};
  const request = {
    method,
    url,
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
      if (event === 'end') {
        queueMicrotask(() => {
          if (body !== undefined) for (const cb2 of listeners['data'] ?? []) cb2(Buffer.from(body));
          for (const cb2 of listeners['end'] ?? []) cb2();
        });
      }
      return request;
    },
  };
  return request;
}

function harness(oauth, opts = {}) {
  const dir = credentialDir(oauth);
  const login = opts.login ?? fakeLogin();
  const verified = [];
  const announced = [];
  const handle = doorHandler({
    crew: 'Clawcius',
    home: dir,
    login,
    verify: async () => {
      verified.push(1);
      return opts.verification ?? { loggedIn: true, turnRan: true, detail: 'ok' };
    },
    log: () => {},
    onAuthenticated: (v) => announced.push(v),
  });
  return { dir, login, handle, verified, announced };
}

test('loading the page runs nothing', async () => {
  const { dir, login, handle } = harness(DEAD);
  try {
    for (const path of ['/', '/index.html', '/state']) {
      const response = fakeResponse();
      await handle(fakeRequest('GET', path), response);
      assert.equal(response.status, 200, path);
    }
    // The whole point of the page being always-on.
    assert.deepEqual(login.calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the state a visitor sees comes off the disk', async () => {
  const { dir, handle } = harness(DEAD);
  try {
    const response = fakeResponse();
    await handle(fakeRequest('GET', '/state'), response);
    const state = response.json();
    assert.equal(state.usable, false);
    assert.equal(state.crew, 'Clawcius');
    assert.equal(state.home, dir);
    assert.equal(state.pendingUrl, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a healthy credential reports itself healthy, with its expiry', () => {
  const dir = credentialDir(HEALTHY);
  try {
    const state = doorState({ crew: 'Clawcius', home: dir, pendingUrl: null, now: NOW });
    assert.equal(state.usable, true);
    assert.equal(state.why, null);
    assert.equal(state.refreshExpiresAt, new Date(HEALTHY.refreshTokenExpiresAt).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a credential file with no expiry says so rather than guessing', () => {
  const dir = credentialDir({ accessToken: 'a', refreshToken: 'b' });
  try {
    assert.equal(doorState({ crew: 'C', home: dir, pendingUrl: null, now: NOW }).refreshExpiresAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the button is what starts a login', async () => {
  const { dir, login, handle } = harness(DEAD);
  try {
    const response = fakeResponse();
    await handle(fakeRequest('POST', '/start'), response);
    assert.equal(response.status, 200);
    assert.equal(response.json().url, 'https://claude.com/cai/oauth/authorize?x=1');
    assert.deepEqual(login.calls, ['begin']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a login that cannot start says why instead of pretending', async () => {
  const { dir, handle } = harness(DEAD, { login: fakeLogin({ url: null }) });
  try {
    const response = fakeResponse();
    await handle(fakeRequest('POST', '/start'), response);
    assert.equal(response.status, 503);
    assert.match(response.json().error, /docker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a code that lands is verified by a real turn, not just by auth status', async () => {
  const { dir, login, handle, verified, announced } = harness(DEAD);
  try {
    const response = fakeResponse();
    await handle(fakeRequest('POST', '/code', JSON.stringify({ code: 'lJ8x-Ab_c0D3' })), response);

    assert.equal(response.status, 200);
    assert.deepEqual(login.calls, ['submit:lJ8x-Ab_c0D3']);
    assert.equal(verified.length, 1, 'the credential is exercised, not just accepted');
    assert.equal(response.json().verification.turnRan, true);
    assert.equal(announced.length, 1, 'the channel hears about it without anyone typing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a credential that authenticates but cannot run a turn is not called success', async () => {
  // `setup-token` asks for `user:inference` alone. Authenticating and being able
  // to run an agent turn are different questions and the page answers the second.
  const { dir, handle } = harness(DEAD, {
    verification: { loggedIn: true, turnRan: false, detail: 'the turn was refused' },
  });
  try {
    const response = fakeResponse();
    await handle(fakeRequest('POST', '/code', JSON.stringify({ code: 'lJ8x-Ab_c0D3' })), response);
    assert.equal(response.json().verification.turnRan, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected code is reported and nothing is verified', async () => {
  const { dir, handle, verified } = harness(DEAD, {
    login: fakeLogin({ submit: { ok: false, reason: 'bad-code', detail: 'whitespace' } }),
  });
  try {
    const response = fakeResponse();
    await handle(fakeRequest('POST', '/code', JSON.stringify({ code: 'no good' })), response);
    assert.equal(response.status, 400);
    assert.equal(response.json().reason, 'bad-code');
    assert.equal(verified.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a body too long to be a code is refused before it is parsed', async () => {
  const { dir, handle, login } = harness(DEAD);
  try {
    const response = fakeResponse();
    await handle(fakeRequest('POST', '/code', 'x'.repeat(9000)), response);
    assert.equal(response.status, 413);
    assert.deepEqual(login.calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nonsense in and nonsense at an unknown path are both answered, not thrown', async () => {
  const { dir, handle } = harness(DEAD);
  try {
    const bad = fakeResponse();
    await handle(fakeRequest('POST', '/code', 'not json'), bad);
    assert.equal(bad.status, 400);

    const missing = fakeResponse();
    await handle(fakeRequest('GET', '/wp-admin'), missing);
    assert.equal(missing.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every response refuses to be framed or sniffed', async () => {
  const { dir, handle } = harness(DEAD);
  try {
    for (const [method, path] of [['GET', '/'], ['GET', '/state']]) {
      const response = fakeResponse();
      await handle(fakeRequest(method, path), response);
      assert.equal(response.headers['x-frame-options'], 'DENY', path);
      assert.equal(response.headers['x-content-type-options'], 'nosniff', path);
      assert.equal(response.headers['cache-control'], 'no-store', path);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
