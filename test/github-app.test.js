/**
 * GitHub App installation tokens: that they are minted, cached, refreshed
 * before expiry, and — the one that matters — asked for per request.
 *
 * The defect this file exists to prevent is not a wrong token. It is a token
 * that was right when the daemon started and stopped being right while nothing
 * looked at it. `GitHubClient` is constructed once and used for days;
 * `ArmedWaker` DISARMS a watch whose poll throws rather than retrying it. So an
 * expired credential does not degrade a poll — an hour after startup it
 * permanently kills every armed watch in the crew, one mail each, and the crew
 * loses the mechanism it learns through.
 *
 * That failure has no test that could catch it after the fact, because by the
 * time it shows the rows are gone. It is only catchable here, as a property:
 * the client must hold a function, and must call it every time.
 */

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
  describeAppFault,
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
  // The name must be the one an operator can grep for. It is read in the mail
  // announcing that every watch has been disarmed, which is the worst possible
  // moment to point at a key that does not exist.
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
    // credential into a journal — see ops/src/host-agent.ts on values whose
    // name is innocent.
    assert.doesNotMatch(e.message, /eyJ|BEGIN|PRIVATE KEY|ghs_/);
    return true;
  });
});

test('a malformed expires_at falls back to an hour instead of minting every call', async () => {
  // Round 2 of #178. Date.parse answers NaN on anything it cannot read, and NaN
  // is never greater than anything — so the cache check was false forever and
  // every call re-minted. Not a slow cache: a POST per poll per watch, and the
  // rate limit it reaches throws, and a mint that throws is the permanent
  // disarm this module exists to prevent. A field GitHub controls must not be
  // able to reach that.
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

  // And the fallback is measured on the INJECTED clock, so a test can reach it
  // faithfully rather than by luck.
  clock += 56 * 60_000;
  await provider();
  assert.equal(mints, 2, 'the one-hour fallback must still expire');
});

test('an installation id that is not digits is refused before it reaches a URL', async () => {
  // Operator-controlled and interpolated into a path. A trailing newline in a
  // systemd EnvironmentFile is an ordinary typo, and `github.ts` validates
  // every value it interpolates so a bad one fails with a name.
  for (const bad of ['42\n', ' 42', '42/../../meta', 'abc']) {
    const provider = appTokenProvider({
      appId: '1', privateKeyPath: pemOnDisk(), installationId: bad,
      apiBase: 'https://api.github.com',
      fetchImpl: async () => { throw new Error('must not reach the network'); },
    });
    await assert.rejects(provider(), /GITHUB_APP_INSTALLATION_ID must be digits only/, bad);
  }
});

// ── the regression that matters ─────────────────────────────────────────────

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


// ── describeAppFault ────────────────────────────────────────────────────────
//
// These exist because the four lines this function replaced were wrong in three
// consecutive reviews and no test ever noticed: they lived in `main()`, beside
// a Discord client and a session pool, where nothing was going to assert on
// them. The warning string is operator-facing output and SETUP.md tells the
// operator it is the only place they learn what happened, so it is worth the
// same scrutiny as a return value.

/** An `access` that fails the way the real one does, with a `code`. */
const accessFailing = (code) => () => {
  const error = new Error(`${code}: opening '/etc/clawcius/secret-app-key.pem'`);
  error.code = code;
  throw error;
};
const accessOk = () => {};

test('describeAppFault says nothing when the App is configured correctly', () => {
  const fault = describeAppFault(
    { privateKeyPath: '/k.pem', installationId: '42', hasFallbackToken: true },
    accessOk,
  );
  assert.equal(fault, null, 'a good configuration must produce no warning at all');
});

test('describeAppFault reports BOTH faults in one boot', () => {
  // The two used to share a branch, so a bad id suppressed the key check and
  // the operator needed two restarts to learn two things knowable at the first.
  const fault = describeAppFault(
    { privateKeyPath: '/k.pem', installationId: '42\n', hasFallbackToken: true },
    accessFailing('ENOENT'),
  );
  assert.match(fault, /GITHUB_APP_INSTALLATION_ID must be digits only/);
  assert.match(fault, /GITHUB_APP_PRIVATE_KEY_PATH is set but the key is not readable \(ENOENT\)/);
});

test('describeAppFault distinguishes a wrong path from a wrong owner', () => {
  // ENOENT and EACCES are the operator's actual question, and they are the
  // reason this reports `error.code` rather than `String(error)`.
  const missing = describeAppFault(
    { privateKeyPath: '/k.pem', installationId: undefined, hasFallbackToken: true },
    accessFailing('ENOENT'),
  );
  const denied = describeAppFault(
    { privateKeyPath: '/k.pem', installationId: undefined, hasFallbackToken: true },
    accessFailing('EACCES'),
  );
  assert.match(missing, /\(ENOENT\)/);
  assert.match(denied, /\(EACCES\)/);
});

test('describeAppFault never puts the PEM path in the warning', () => {
  // The `fs` error carries the path in `.message`; the whole point of reading
  // `.code` is that this line goes to a journal and, via `armed-wake`, to a
  // mailbox. The path names the file and the file is the key.
  for (const code of ['ENOENT', 'EACCES']) {
    const fault = describeAppFault(
      { privateKeyPath: '/etc/clawcius/secret-app-key.pem', installationId: undefined,
        hasFallbackToken: true },
      accessFailing(code),
    );
    assert.doesNotMatch(fault, /secret-app-key/, code);
    assert.doesNotMatch(fault, /etc\/clawcius/, code);
  }
});

test('describeAppFault promises a fallback only when there is one to fall back to', () => {
  // THE ROUND-3 DEFECT, in its third costume. With no PAT the daemon prints, on
  // the very next line, that watchPr will refuse to arm anything — so an
  // unconditional "watches will arm and poll" was refuted by the sentence
  // directly beneath it. A warning the reader watches get disproved is a
  // warning they learn to skip.
  const withPat = describeAppFault(
    { privateKeyPath: '/k.pem', installationId: undefined, hasFallbackToken: true },
    accessFailing('ENOENT'),
  );
  const withoutPat = describeAppFault(
    { privateKeyPath: '/k.pem', installationId: undefined, hasFallbackToken: false },
    accessFailing('ENOENT'),
  );
  assert.match(withPat, /watches will arm and poll as the personal access token/);
  assert.doesNotMatch(withoutPat, /will arm/);
  assert.doesNotMatch(withoutPat, /FALLING BACK/);
  // It still says the one thing it does know.
  assert.match(withoutPat, /The App is NOT in use\./);
});

test('an empty installation id means unset, in both callers', () => {
  // `config.github.appInstallationId || undefined` normalises it before `mint`
  // ever sees it, and the boot check skipped it too. The shared predicate makes
  // that agreement explicit rather than coincidental.
  assert.equal(
    describeAppFault(
      { privateKeyPath: '/k.pem', installationId: '', hasFallbackToken: true },
      accessOk,
    ),
    null,
  );
});
