import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appJwt,
  appTokenProvider,
  staticTokenProvider,
  checkAppConfig,
  describeTokenShape,
} from '../dist/github-app.js';
import { GitHubClient } from '../dist/github.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

function pemOnDisk() {
  const path = join(mkdtempSync(join(tmpdir(), 'app-key-')), 'key.pem');
  writeFileSync(path, PEM, { mode: 0o600 });
  return path;
}

const b64urlJson = (part) =>
  JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

// ── the JWT ─────────────────────────────────────────────────────────────────

test('the app JWT is RS256, signed by the key, and inside GitHub\'s 10-minute limit', () => {
  const now = 1_700_000_000_000;
  const jwt = appJwt('12345', PEM, now);
  const [h, p, sig] = jwt.split('.');

  assert.deepEqual(b64urlJson(h), { alg: 'RS256', typ: 'JWT' });

  const claims = b64urlJson(p);
  assert.equal(claims.iss, '12345');
  // Backdated: GitHub rejects a JWT whose `iat` is in the future by its clock,
  // and the two clocks are not the same clock.
  assert.equal(claims.iat, Math.floor(now / 1000) - 60);
  // GitHub refuses anything more than 600s out. Well inside, so a slow request
  // cannot push it over.
  assert.ok(claims.exp - claims.iat <= 600, `${claims.exp - claims.iat}s must be <= 600`);

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  assert.equal(
    verifier.verify(publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    true,
    'the signature must verify against the public half of the key',
  );
});

// ── caching and refresh ─────────────────────────────────────────────────────

function fakeGitHub({ expiresInMs = 3_600_000 } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).endsWith('/app/installations')) {
      return { ok: true, status: 200, json: async () => [{ id: 42 }] };
    }
    n += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        token: `ghs_token_${n}`,
        expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      }),
    };
  };
  return { calls, fetchImpl, mints: () => calls.filter((c) => c.method === 'POST').length };
}

test('a token is minted once and reused until it is nearly spent', async () => {
  const gh = fakeGitHub();
  let clock = Date.now();
  const provider = appTokenProvider({
    appId: '1', privateKeyPath: pemOnDisk(), apiBase: 'https://api.github.com',
    now: () => clock, fetchImpl: gh.fetchImpl,
  });

  assert.equal(await provider(), 'ghs_token_1');
  assert.equal(await provider(), 'ghs_token_1');
  clock += 50 * 60_000;                       // 50 minutes: still comfortably valid
  assert.equal(await provider(), 'ghs_token_1');
  assert.equal(gh.mints(), 1, 'a valid cached token must not be re-minted');
});

test('it refreshes BEFORE expiry, not at it', async () => {
  const gh = fakeGitHub();
  let clock = Date.now();
  const provider = appTokenProvider({
    appId: '1', privateKeyPath: pemOnDisk(), apiBase: 'https://api.github.com',
    now: () => clock, fetchImpl: gh.fetchImpl,
  });

  await provider();
  // 57 minutes in: still valid, but inside the margin. Refreshing at expiry
  // would hand out a token that dies during the request it was fetched for.
  clock += 57 * 60_000;
  assert.equal(await provider(), 'ghs_token_2');
  assert.equal(gh.mints(), 2);
});

test('a burst on a cold cache mints once, not once per caller', async () => {
  const gh = fakeGitHub();
  const provider = appTokenProvider({
    appId: '1', privateKeyPath: pemOnDisk(), apiBase: 'https://api.github.com',
    fetchImpl: gh.fetchImpl,
  });

  // The real shape: several armed watches ticking together after a restart.
  const tokens = await Promise.all([provider(), provider(), provider(), provider()]);
  assert.deepEqual(new Set(tokens), new Set(['ghs_token_1']));
  assert.equal(gh.mints(), 1, 'concurrent callers must share one mint');
});

test('more than one installation is refused rather than guessed', async () => {
  const fetchImpl = async (url) =>
    String(url).endsWith('/app/installations')
      ? { ok: true, status: 200, json: async () => [{ id: 1 }, { id: 2 }] }
      : { ok: true, status: 200, json: async () => ({ token: 't' }) };
  const provider = appTokenProvider({
    appId: '1', privateKeyPath: pemOnDisk(), apiBase: 'https://api.github.com', fetchImpl,
  });
  // Picking one would silently choose a repository set nobody chose.
  await assert.rejects(provider(), /set GITHUB_APP_INSTALLATION_ID to choose one/);
});

test('a failed mint says the status and nothing else', async () => {
  const fetchImpl = async (url) =>
    String(url).endsWith('/app/installations')
      ? { ok: true, status: 200, json: async () => [{ id: 42 }] }
      : { ok: false, status: 401, json: async () => ({}) };
  const provider = appTokenProvider({
    appId: '1', privateKeyPath: pemOnDisk(), apiBase: 'https://api.github.com', fetchImpl,
  });

  await assert.rejects(provider(), (e) => {
    assert.match(e.message, /GitHub answered 401/);
    // The request carried the JWT. An error that echoes the request leaks the
    // credential into a journal.
    assert.doesNotMatch(e.message, /eyJ|BEGIN|PRIVATE KEY|ghs_/);
    return true;
  });
});

test('a malformed expires_at falls back to an hour instead of minting every call', async () => {
  let mints = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/app/installations')) {
      return { ok: true, status: 200, json: async () => [{ id: 42 }] };
    }
    mints += 1;
    return { ok: true, status: 200, json: async () => ({ token: 't', expires_at: 'not-a-date' }) };
  };
  let clock = 1_700_000_000_000;
  const provider = appTokenProvider({
    appId: '1', privateKeyPath: pemOnDisk(), apiBase: 'https://api.github.com',
    now: () => clock, fetchImpl,
  });

  for (let i = 0; i < 5; i += 1) await provider();
  assert.equal(mints, 1, 'an unreadable expires_at must not defeat the cache');

  clock += 56 * 60_000;
  await provider();
  assert.equal(mints, 2, 'the one-hour fallback must still expire');
});

test('an installation id that is not digits is refused before it reaches a URL', async () => {
  // Operator-controlled and interpolated into a path. An invisible character in
  // an operator-typed value is an ordinary typo, and `github.ts` validates every
  // value it interpolates so a bad one fails with a name.
  for (const bad of ['42\n', ' 42', '42/../../meta', 'abc']) {
    const provider = appTokenProvider({
      appId: '1', privateKeyPath: pemOnDisk(), installationId: bad,
      apiBase: 'https://api.github.com',
      fetchImpl: async () => { throw new Error('must not reach the network'); },
    });
    await assert.rejects(provider(), /GITHUB_APP_INSTALLATION_ID must be digits only/, bad);
  }
});

// ── the token is asked for per request ──────────────────────────────────────

test('GitHubClient asks the provider on EVERY request', async () => {
  let handed = 0;
  const provider = async () => `token_${++handed}`;
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.Authorization);
    return { ok: true, status: 200, text: async () => '{}', headers: { get: () => '' } };
  };
  try {
    const client = new GitHubClient(provider, 'https://api.github.com');
    await client.getPullRequest('o/r', 1);
    await client.getPullRequest('o/r', 1);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Holding the string is what made the daemon carry a credential that expired
  // while nothing looked at it. Two requests, two asks.
  assert.deepEqual(seen, ['Bearer token_1', 'Bearer token_2']);
});

test('a plain string still works, so the PAT path is unchanged', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.Authorization);
    return { ok: true, status: 200, text: async () => '{}', headers: { get: () => '' } };
  };
  try {
    await new GitHubClient('ghp_static', 'https://api.github.com').getPullRequest('o/r', 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, ['Bearer ghp_static']);
  assert.equal(await staticTokenProvider('ghp_static')(), 'ghp_static');
});


// ── checkAppConfig ──────────────────────────────────────────────────────────

/** An `access` that fails the way the real one does, with a `code`. */
const accessFailing = (code) => () => {
  const error = new Error(`${code}: opening '/etc/clawcius/secret-app-key.pem'`);
  error.code = code;
  throw error;
};
const accessOk = () => {};
const cfg = (over) => ({
  appId: '1',
  privateKeyPath: '/k.pem',
  installationId: undefined,
  hasFallbackToken: true,
  ...over,
});

test('checkAppConfig says nothing when the App is configured correctly', () => {
  const { usable, warning } = checkAppConfig(cfg(), accessOk);
  assert.equal(warning, null, 'a good configuration must produce no warning at all');
  assert.equal(usable, true);
});

test('checkAppConfig reports BOTH faults in one boot', () => {
  const { warning } = checkAppConfig(cfg({ installationId: '42\n' }), accessFailing('ENOENT'));
  assert.match(warning, /GITHUB_APP_INSTALLATION_ID must be digits only/);
  assert.match(warning, /GITHUB_APP_PRIVATE_KEY_PATH is set but the key is not readable \(ENOENT\)/);
});

test('checkAppConfig distinguishes a wrong path from a wrong owner', () => {
  // ENOENT and EACCES are the operator's actual question, and they are the
  // reason this reports `error.code` rather than `String(error)`.
  assert.match(checkAppConfig(cfg(), accessFailing('ENOENT')).warning, /\(ENOENT\)/);
  assert.match(checkAppConfig(cfg(), accessFailing('EACCES')).warning, /\(EACCES\)/);
});

test('checkAppConfig never puts the PEM path in the warning', () => {
  // The `fs` error carries the path in `.message`; the whole point of reading
  // `.code` is that this line goes to a journal and, via `armed-wake`, near a
  // mailbox. The path names the file and the file is the key.
  for (const code of ['ENOENT', 'EACCES']) {
    const { warning } = checkAppConfig(
      cfg({ privateKeyPath: '/etc/clawcius/secret-app-key.pem' }),
      accessFailing(code),
    );
    assert.doesNotMatch(warning, /secret-app-key/, code);
    assert.doesNotMatch(warning, /etc\/clawcius/, code);
  }
});

test('checkAppConfig promises a fallback only when there is one to fall back to', () => {
  const withPat = checkAppConfig(cfg(), accessFailing('ENOENT')).warning;
  const withoutPat = checkAppConfig(cfg({ hasFallbackToken: false }), accessFailing('ENOENT'))
    .warning;
  assert.match(withPat, /watches will arm and poll as the personal access token/);
  assert.doesNotMatch(withoutPat, /will arm/);
  assert.doesNotMatch(withoutPat, /FALLING BACK/);
  assert.match(withoutPat, /The App is NOT in use\./);
});

test('an empty installation id means unset, in both callers', () => {
  // `config.github.appInstallationId || undefined` normalises it before `mint`
  // ever sees it, and the boot check skipped it too. The shared predicate makes
  // that agreement explicit rather than coincidental.
  assert.equal(checkAppConfig(cfg({ installationId: '' }), accessOk).warning, null);
});

// ── the half-configured App ─────────────────────────────────────────────────

test('a half-configured App names the variable that is missing', () => {
  // The shortest route to a broken App is typing the VARIABLE NAME wrong rather
  // than its value, and it must not be silent.
  const noPath = checkAppConfig(cfg({ privateKeyPath: '' }), accessOk);
  assert.equal(noPath.usable, false);
  assert.match(noPath.warning, /GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY_PATH is not/);

  const noId = checkAppConfig(cfg({ appId: '' }), accessOk);
  assert.equal(noId.usable, false);
  assert.match(noId.warning, /GITHUB_APP_PRIVATE_KEY_PATH is set but GITHUB_APP_ID is not/);
});

test('an unset key path is never described as unreadable', () => {
  const { warning } = checkAppConfig({
    appId: '1', privateKeyPath: '', installationId: undefined, hasFallbackToken: true,
  });
  assert.doesNotMatch(warning, /not readable/);
  assert.doesNotMatch(warning, /is set but the key/);
});

test('no App configured at all is not a fault, and is not usable either', () => {
  // The ordinary deployment — Clawcius has no App. Two questions, two fields:
  // inferring "usable" from a null warning would be right only because a guard
  // outside this function happens to exclude this case.
  const { usable, warning } = checkAppConfig({
    appId: '', privateKeyPath: '', installationId: undefined, hasFallbackToken: true,
  });
  assert.equal(warning, null);
  assert.equal(usable, false);
});

// ── the real `access`, which nothing else exercises ─────────────────────────

test('the default access check reads the real filesystem', () => {
  // Every case above injects `access`, so `accessSync(path, R_OK)` — the only version that runs in production — would otherwise be asserted nowhere.
  const real = pemOnDisk();
  assert.equal(checkAppConfig(cfg({ privateKeyPath: real })).warning, null);
  assert.equal(checkAppConfig(cfg({ privateKeyPath: real })).usable, true);

  const missing = join(mkdtempSync(join(tmpdir(), 'clawsky-app-')), 'absent.pem');
  const { usable, warning } = checkAppConfig(cfg({ privateKeyPath: missing }));
  assert.equal(usable, false);
  assert.match(warning, /not readable \(ENOENT\)/);
  assert.doesNotMatch(warning, /absent\.pem/);
});

// ── stray characters ────────────────────────────────────────────────────────

test('a stray character in GITHUB_APP_ID or the key path is refused, with its position', () => {
  for (const [bad, at] of [['99\r', 3], ['99\n', 3], [' 99', 1], ['99 ', 3], ['9\t9', 2], ['99\u200b', 3], ['9\u00ad9', 2]]) {
    const { usable, warning } = checkAppConfig(cfg({ appId: bad }), accessOk);
    assert.equal(usable, false, JSON.stringify(bad));
    assert.match(warning, new RegExp(`\\b${at}\\b`), JSON.stringify(bad));
  }
  for (const ch of ['\r', '\t', '\u00a0', '\u2007', '\u3000', '\u2028', '\u200b', '\ufeff', '\u180e']) {
    const { usable, warning } = checkAppConfig(cfg({ privateKeyPath: `/k.pem${ch}` }), accessFailing('ENOENT'));
    assert.equal(usable, false, JSON.stringify(ch));
    assert.match(warning, /\b7\b/, JSON.stringify(ch));
  }
});

test('ordinary App ids, and a path with a plain space, are accepted', () => {
  for (const appId of ['123456', 'Iv23liAbCdEfGhIjKl', 'Iv1.8a61f9b3a7aba766']) {
    const { usable, warning } = checkAppConfig(cfg({ appId }), accessOk);
    assert.equal(usable, true, appId);
    assert.equal(warning, null, appId);
  }
  assert.equal(
    checkAppConfig(cfg({ privateKeyPath: '/home/my dir/app key.pem' }), accessOk).usable,
    true,
  );
});

// ── the token's shape ───────────────────────────────────────────────────────

test('describeTokenShape says nothing about a clean token', () => {
  assert.equal(describeTokenShape('ghp_' + 'a'.repeat(36)), null);
  assert.equal(describeTokenShape('ghs_MiXeD09AZ'), null);
  assert.equal(describeTokenShape(''), null);
});

test('a stray character is reported with its position, counted by codepoint', () => {
  assert.match(describeTokenShape(' ghp_abcdef'), /\b1\b/);
  assert.match(describeTokenShape(' ghp_abcdef'), /whitespace/);
  assert.match(describeTokenShape('ghp_abc\u00a0def'), /\b8\b/);
  assert.match(describeTokenShape('ghp_abc\u00a0def'), /whitespace/);
  assert.match(describeTokenShape('ghp_\u200babc'), /\b5\b/);
  assert.match(describeTokenShape('ghp_\u200babc'), /non-printable/);
  assert.match(describeTokenShape('ghp_abc\n'), /\b8\b/);
  assert.match(describeTokenShape('\u{1f600}ghp_abc'), /\b1\b/);
  for (const ch of ['\u2019', '\u2013', '\u65e5', '\u0000', '\ufeff']) {
    assert.ok(describeTokenShape(`ghp_ab${ch}cdef`), `U+${ch.codePointAt(0).toString(16)} went undetected`);
  }
});

test('never quotes the token, at any length', () => {
  const secret = 'ghp_' + 'S3cr3tV4lu3'.repeat(3);
  const out = describeTokenShape(secret + '\u200b');
  assert.doesNotMatch(out, /S3cr3tV4lu3/);
  assert.ok(!out.includes(secret.slice(4)), 'the message carried the token body');
});
