import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apiBase, doorHandler, doorState } from '../dist/door.js';

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
function fakeLogin({ url = 'https://claude.com/cai/oauth/authorize?x=1', submit, verification } = {}) {
  const login = {
    calls: [],
    pendingUrl: null,
    verify: async () => {
      login.calls.push('verify');
      return verification ?? { turnRan: true, detail: 'ok' };
    },
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
    headers: { 'sec-fetch-site': 'same-origin' },
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
  const login = opts.login ?? fakeLogin({ verification: opts.verification });
  const announced = [];
  const handle = doorHandler({
    crew: 'Clawcius',
    home: dir,
    login,
    log: () => {},
    onAuthenticated: (v) => announced.push(v),
  });
  return { dir, login, handle, announced };
}

test('loading the page runs nothing', async () => {
  const { dir, login, handle } = harness(DEAD);
  try {
    for (const path of ['/', '/state']) {
      const response = fakeResponse();
      await handle(fakeRequest('GET', path), response);
      assert.equal(response.status, 200, path);
    }
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
  const { dir, login, handle, announced } = harness(DEAD);
  try {
    const response = fakeResponse();
    await handle(fakeRequest('POST', '/code', JSON.stringify({ code: 'lJ8x-Ab_c0D3' })), response);

    assert.equal(response.status, 200);
    assert.deepEqual(login.calls, ['submit:lJ8x-Ab_c0D3', 'verify'], 'exercised, not just accepted');
    assert.equal(response.json().verification.turnRan, true);
    assert.equal(announced.length, 1, 'the channel hears about it without anyone typing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a credential that authenticates but cannot run a turn is not called success', async () => {
  const { dir, handle } = harness(DEAD, {
    verification: { turnRan: false, detail: 'the turn was refused' },
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
  const { dir, login, handle } = harness(DEAD, {
    login: fakeLogin({ submit: { ok: false, reason: 'bad-code', detail: 'whitespace' } }),
  });
  try {
    const response = fakeResponse();
    await handle(fakeRequest('POST', '/code', JSON.stringify({ code: 'no good' })), response);
    assert.equal(response.status, 400);
    assert.equal(response.json().reason, 'bad-code');
    assert.equal(login.calls.includes('verify'), false);
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

test('a POST that did not come from this page is refused', async () => {
  // `tailscale serve` authenticates the node, not the request: a page the
  // operator has open elsewhere could otherwise kill a login that is waiting.
  const { dir, login, handle } = harness(DEAD);
  try {
    const request = fakeRequest('POST', '/start');
    request.headers = { 'sec-fetch-site': 'cross-site' };
    const response = fakeResponse();
    await handle(request, response);
    assert.equal(response.status, 403);
    assert.deepEqual(login.calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the page fetches inside its own mount, wherever it is published', () => {
  // Under `--set-path /login` a bare `fetch('state')` resolves against the
  // parent and lands on whatever is at `/`, which is a different service. The
  // page is served at the root of its mount, so a path with no trailing slash
  // is still a directory.
  for (const served of ['/login', '/login/', '/hamachi-login', '/hamachi-login/', '/']) {
    const resolved = new URL('state', 'https://h.ts.net' + apiBase(served)).pathname;
    assert.ok(resolved.startsWith(served.replace(/\/$/, '') + '/'), `${served} -> ${resolved}`);
    assert.ok(resolved.endsWith('/state'), resolved);
  }
});

test('the routes answer whether or not the proxy strips the mount', async () => {
  // `tailscale serve --set-path` may forward with the mount still on the front.
  const { dir, login, handle } = harness(DEAD);
  try {
    for (const path of ['/state', '/login/state', '/hamachi-login/state']) {
      const response = fakeResponse();
      await handle(fakeRequest('GET', path), response);
      assert.equal(response.status, 200, path);
      assert.equal(response.json().crew, 'Clawcius', path);
    }
    for (const path of ['/', '/login/', '/hamachi-login/']) {
      const response = fakeResponse();
      await handle(fakeRequest('GET', path), response);
      assert.equal(response.status, 200, path);
    }
    for (const path of ['/start', '/login/start']) {
      const response = fakeResponse();
      await handle(fakeRequest('POST', path), response);
      assert.equal(response.status, 200, path);
    }
    assert.deepEqual(login.calls, ['begin', 'begin']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
