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


// ── checkAppConfig ──────────────────────────────────────────────────────────
//
// These exist because the lines this function replaced were wrong in three
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
  // The two used to share a branch, so a bad id suppressed the key check and
  // the operator needed two restarts to learn two things knowable at the first.
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
  // THE ROUND-3 DEFECT, in its third costume. With no PAT the daemon prints, on
  // the very next line, that watchPr will refuse to arm anything — so an
  // unconditional "watches will arm and poll" was refuted by the sentence
  // directly beneath it. A warning the reader watches get disproved is a
  // warning they learn to skip.
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

// ── the half-configured App, which used to say nothing at all ───────────────

test('a half-configured App names the variable that is missing', () => {
  // The shortest route to a broken App is typing the VARIABLE NAME wrong rather
  // than its value, and it was the one route that produced complete silence —
  // not even "authenticating as GitHub App", which sits behind the same guard.
  const noPath = checkAppConfig(cfg({ privateKeyPath: '' }), accessOk);
  assert.equal(noPath.usable, false);
  assert.match(noPath.warning, /GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY_PATH is not/);

  const noId = checkAppConfig(cfg({ appId: '' }), accessOk);
  assert.equal(noId.usable, false);
  assert.match(noId.warning, /GITHUB_APP_PRIVATE_KEY_PATH is set but GITHUB_APP_ID is not/);
});

test('an unset key path is never described as unreadable', () => {
  // `access('')` answers ENOENT, which would have produced "GITHUB_APP_PRIVATE_
  // KEY_PATH is set but the key is not readable" about a variable that is not
  // set — the first four words false, which is the whole defect class this
  // function was extracted to end.
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
  // Every case above injects `access`, so `accessSync(path, R_OK)` — the only
  // version that runs in production — would otherwise be asserted nowhere. A
  // later change from R_OK to F_OK would pass the whole suite while making the
  // boot check laxer than the read that follows it, which is exactly the drift
  // `isInstallationIdValid` was extracted to prevent.
  const real = pemOnDisk();
  assert.equal(checkAppConfig(cfg({ privateKeyPath: real })).warning, null);
  assert.equal(checkAppConfig(cfg({ privateKeyPath: real })).usable, true);

  const missing = join(mkdtempSync(join(tmpdir(), 'clawsky-app-')), 'absent.pem');
  const { usable, warning } = checkAppConfig(cfg({ privateKeyPath: missing }));
  assert.equal(usable, false);
  assert.match(warning, /not readable \(ENOENT\)/);
  assert.doesNotMatch(warning, /absent\.pem/);
});

// ── invisible characters, the class the three variables share ───────────────

test('an App id with a stray character is caught at boot, not at the first mint', () => {
  // `appId` was checked for PRESENCE and never for SHAPE, then went straight
  // into the JWT as `iss`. A trailing \r does not fail here — it fails at the
  // first mint with a 401, inside the poll's try, whose catch disarms the row.
  // That is the permanent sweep the whole boot check exists to prevent, through
  // the one variable of the three nothing was checking.
  for (const bad of ['99\r', '99\n', ' 99', '99 ', '99\t']) {
    const { usable, warning } = checkAppConfig(cfg({ appId: bad }), accessOk);
    assert.equal(usable, false, JSON.stringify(bad));
    assert.match(warning, /GITHUB_APP_ID contains an invisible character/);
  }
});

test('a client id is still a valid App id', () => {
  // GitHub accepts the numeric App ID *or* a client ID as `iss`. Narrowing to
  // digits would refuse a valid deployment, so this checks the failure mode
  // rather than guessing GitHub's identifier alphabet — including the older
  // form, which contains a dot.
  for (const good of ['123456', 'Iv23liAbCdEfGhIjKl', 'Iv1.8a61f9b3a7aba766']) {
    const { usable, warning } = checkAppConfig(cfg({ appId: good }), accessOk);
    assert.equal(usable, true, good);
    assert.equal(warning, null, good);
  }
});

test('a key path may contain a space but not a control character', () => {
  // Spaces are legal in a path and must not be refused; a \r is not, and would
  // otherwise surface as ENOENT — true, and it sends the operator to stare at a
  // path that looks correct.
  const spaced = checkAppConfig(cfg({ privateKeyPath: '/home/my dir/key.pem' }), accessOk);
  assert.equal(spaced.usable, true, 'a space in a path is legitimate');

  const cr = checkAppConfig(cfg({ privateKeyPath: '/k.pem\r' }), accessFailing('ENOENT'));
  assert.equal(cr.usable, false);
  assert.match(cr.warning, /GITHUB_APP_PRIVATE_KEY_PATH contains an invisible character/);
  assert.doesNotMatch(cr.warning, /not readable/, 'the misleading ENOENT must be suppressed');
});

test('a zero-width character is caught too, and it is the worst case', () => {
  // A trailing space can be found by moving a cursor; U+200B cannot be found at
  // all. Web UIs insert zero-width characters into long identifiers so they can
  // line-break, so "I copied the App ID off the page" is how one arrives — and
  // the consequence is the same 401 at first mint, inside the catch that
  // disarms every armed row. The prose above the regex claims "a character the
  // operator cannot see"; these are the characters that claim is most about.
  const zeroWidth = {
    'U+200B ZERO WIDTH SPACE': '​',
    'U+00AD SOFT HYPHEN': '­',
    'U+2060 WORD JOINER': '⁠',
    'U+FEFF BYTE ORDER MARK': '﻿',
    'U+200D ZERO WIDTH JOINER': '‍',
  };
  for (const [name, ch] of Object.entries(zeroWidth)) {
    const id = checkAppConfig(cfg({ appId: `99${ch}` }), accessOk);
    assert.equal(id.usable, false, name);
    assert.match(id.warning, /GITHUB_APP_ID contains an invisible character/, name);

    const path = checkAppConfig(cfg({ privateKeyPath: `/k.pem${ch}` }), accessFailing('ENOENT'));
    assert.equal(path.usable, false, name);
    assert.match(path.warning, /GITHUB_APP_PRIVATE_KEY_PATH contains an invisible character/, name);
    assert.doesNotMatch(path.warning, /not readable/, `${name}: misleading ENOENT must be suppressed`);
  }
});

test('the invisible-character check does not refuse ordinary values', () => {
  // The regex is negative, so the risk it carries is over-rejection. These are
  // the shapes a real deployment uses: both App ID forms, the older dotted
  // client ID, and a path with a space in it.
  for (const appId of ['123456', 'Iv23liAbCdEfGhIjKl', 'Iv1.8a61f9b3a7aba766']) {
    assert.equal(checkAppConfig(cfg({ appId }), accessOk).usable, true, appId);
  }
  assert.equal(
    checkAppConfig(cfg({ privateKeyPath: '/home/my dir/app key.pem' }), accessOk).usable,
    true,
    'spaces are legal in a path and must not be refused',
  );
});

test('a key path admits U+0020 and nothing else whitespace-shaped', () => {
  // The docstring calls its list "the whole of the claim", so the path check has
  // to implement the whole of it. It excluded ALL whitespace via a comment about
  // spaces being legal — true of U+0020 and of nothing else in the group. NBSP
  // and the ideographic space fell through to "the key is not readable (ENOENT)",
  // which is the message this function suppresses for `\r` for the same reason:
  // it points at the visible half of a value whose problem is the invisible half.
  const nonSpaceWhitespace = {
    'U+00A0 NO-BREAK SPACE': ' ',
    'U+2007 FIGURE SPACE': ' ',
    'U+3000 IDEOGRAPHIC SPACE': '　',
    'U+2028 LINE SEPARATOR': ' ',
    'U+0009 TAB': '\t',
  };
  for (const [name, ch] of Object.entries(nonSpaceWhitespace)) {
    const { usable, warning } = checkAppConfig(
      cfg({ privateKeyPath: `/k.pem${ch}` }),
      accessFailing('ENOENT'),
    );
    assert.equal(usable, false, name);
    assert.match(warning, /GITHUB_APP_PRIVATE_KEY_PATH contains an invisible character/, name);
    assert.doesNotMatch(warning, /not readable/, `${name}: the misleading ENOENT must be suppressed`);
  }

  // …and the one exception stays exactly one character wide.
  assert.equal(
    checkAppConfig(cfg({ privateKeyPath: '/home/my dir/app key.pem' }), accessOk).usable,
    true,
    'U+0020 is the only whitespace a path may contain',
  );
});

test('both invisible-character messages name every group they catch', () => {
  // The path message listed "a control character or a zero-width one" after the
  // check had grown to catch non-space whitespace too, so an operator with an
  // NBSP in their path was named by neither example and could reasonably read
  // the warning as being about someone else's problem. The claim was true and
  // the examples were narrower than the behaviour — the same defect as the
  // docstring's, inverted.
  const nbsp = checkAppConfig(cfg({ privateKeyPath: '/k.pem ' }), accessOk).warning;
  assert.match(nbsp, /whitespace other than a plain space/);
  assert.match(nbsp, /control character/);
  assert.match(nbsp, /zero-width/);

  const id = checkAppConfig(cfg({ appId: '99 ' }), accessOk).warning;
  assert.match(id, /whitespace/);
  assert.match(id, /control character/);
  assert.match(id, /zero-width/);
});

test('the boundary of the invisible-character class is pinned, so widening it is loud', () => {
  // WHAT THIS DOES AND DOES NOT DO, because the pull request that added the
  // message tests claimed more than they delivered.
  //
  // The three `assert.match` checks above pin each message against being
  // NARROWED — drop "zero-width" from the sentence and they fail. They do NOT
  // pin it against the CHECK being widened: add a fourth group to `INVISIBLE`
  // tomorrow and every one of them still passes while the message is once again
  // narrower than the behaviour. That is the fifth-instance defect, one level up.
  //
  // A test cannot tie a prose sentence to a regex. What it can do is pin the
  // BOUNDARY, so that widening the class fails HERE and whoever widens it is
  // standing in this file, next to the comment telling them the message is the
  // other half of the change. That is a tripwire rather than a proof, and it is
  // the honest version of what was claimed.
  const notCaught = {
    'U+0301 COMBINING ACUTE ACCENT': '́',
    'U+FE0F VARIATION SELECTOR-16': '️',
    'U+E000 PRIVATE USE': '',
    'U+2800 BRAILLE PATTERN BLANK': '⠀',
  };
  // BOTH REGEXES. The first version of this test fed only `appId`, so it
  // guarded `INVISIBLE_OR_SPACE` while its failure message addressed someone
  // who had widened `INVISIBLE` — the path regex, and the one this whole change
  // is about. Widening `INVISIBLE` alone left the suite green. That is the
  // test's prose being wider than the test's behaviour, which is the defect
  // this file exists to catch, one level further up.
  const advice = (name) =>
    `${name} is outside the invisible-character class today. If you have just widened ` +
    'INVISIBLE or INVISIBLE_OR_SPACE to include it, that may well be right — and two ' +
    'other things then have to change with it: the warning string in checkAppConfig ' +
    'for whichever regex you widened, and the docstring above the regexes, which ' +
    'calls its list of three groups "the whole of the claim".';
  for (const [name, ch] of Object.entries(notCaught)) {
    assert.equal(checkAppConfig(cfg({ appId: `99${ch}` }), accessOk).usable, true, advice(name));
    assert.equal(
      checkAppConfig(cfg({ privateKeyPath: `/k.pem${ch}` }), accessOk).usable,
      true,
      advice(name),
    );
  }

  // U+180E is category Cf and IS caught, which is the boundary itself: the class
  // is defined by what the characters ARE, not by a hand-listed set.
  //
  // `accessOk` IS LOAD-BEARING ON BOTH LINES — do not "harmonise" either with
  // the `accessFailing('ENOENT')` that the other path tests in this file use.
  // Under a failing `access` both assertions go green for the wrong reason,
  // silently, by two different routes:
  //
  //   path:  if `INVISIBLE` stopped matching U+180E, control would fall through
  //          to the `access` branch, and a failing one yields `usable: false`
  //          — the answer this asserts, arrived at without the regex.
  //   appId: the App ID check never reaches `access` at all. What protects that
  //          line is `cfg()`'s default `privateKeyPath`, which a failing
  //          `access` would fault into `usable: false` regardless of the App ID.
  //
  // Same conclusion, different mechanism. Stated separately because a reader who
  // checks the appId line against the path's mechanism finds it does not apply,
  // and could reasonably conclude the warning is over-broad there — which is
  // exactly the edit that breaks it.
  //
  // NO DIRECTIONS. This is the third locator in this test to be written as
  // "above" or "below" and the second to point the wrong way; the file moves and
  // the direction does not move with it. Name things instead.
  assert.equal(checkAppConfig(cfg({ appId: '99᠎' }), accessOk).usable, false);
  assert.equal(checkAppConfig(cfg({ privateKeyPath: '/k.pem᠎' }), accessOk).usable, false);
});

/**
 * `describeTokenShape`: the GITHUB_TOKEN half of the boot check (#185).
 *
 * WHAT IS PINNED HERE IS A DIAGNOSIS, NOT A VALIDATION. Nothing should ever
 * assert that a token was rejected, because nothing rejects one -- the value is
 * used unchanged and this only says what is in it. A test that began asserting
 * a refusal would be pinning a behaviour the brief ruled out.
 *
 * And the sharper half: it must not cry wolf. #185 assumed a trailing newline
 * caused a 401, and said outright that it could not confirm that. It does not
 * -- the header value is trimmed, and goes out identical to a clean token. So
 * a trailing newline is a case where the correct message says "this is not your
 * problem", and `every message agrees with the real header layer` below is what
 * keeps that honest. How often it arrives is a claim about a LOADER and is
 * deliberately made nowhere -- see the docstring.
 *
 * EVERY INVISIBLE CHARACTER BELOW IS WRITTEN AS AN ESCAPE, mechanically. A
 * literal one is invisible in the file, in a diff and to a reviewer -- which is
 * precisely the defect under test, and it would be absurd to reintroduce here.
 */

// The characters with a real route into a token: a browser paste, a shell
// heredoc, a Windows line ending, a BOM at the front of a file.
const SAMPLES = [
  ['tab', '\u0009'],
  ['newline', '\u000a'],
  ['carriage return', '\u000d'],
  ['space', ' '],
  ['no-break space', '\u00a0'],
  ['soft hyphen', '\u00ad'],
  ['zero-width space', '\u200b'],
  ['zero-width non-joiner', '\u200c'],
  ['word joiner', '\u2060'],
  ['byte-order mark', '\ufeff'],
  // NUL: unreachable from an environment block, and in the class, so it is
  // here to pin the one outcome the matrix used to get wrong.
  ['NUL', '\u0000'],
  // AND THE ONES OUTSIDE `INVISIBLE_OR_SPACE` ENTIRELY. Without these the
  // agreement test is exhaustive over the characters it already looks at and
  // blind to the rest -- which is how the THROWS row came to be true of the
  // header layer and false of the function under test. Paste-from-a-document
  // rather than paste-from-a-web-page: same route in, same failure.
  ['right single quote', '\u2019'],
  ['en dash', '\u2013'],
  ['CJK', '\u65e5'],
];

/** Where it sits, which changes the outcome for the very same character. */
const POSITIONS = [
  ['leading', (ch) => ch + 'ghp_abc'],
  ['embedded', (ch) => 'ghp_' + ch + 'abc'],
  ['trailing', (ch) => 'ghp_abc' + ch],
];

/** What the runtime ACTUALLY does with this token in an Authorization header. */
function actualOutcome(token) {
  let value;
  try {
    value = new Headers({ Authorization: `Bearer ${token}` }).get('authorization');
  } catch {
    return 'throws';
  }
  // Identical to the header a clean token produces => it cannot be the fault.
  return value === 'Bearer ghp_abc' ? 'tolerated' : 'rejected';
}

/** Which of the three the message claims. */
function claimedOutcome(out) {
  if (out.includes('throws before anything is sent')) return 'throws';
  if (out.includes('NOT causing a failure')) return 'tolerated';
  return 'rejected';
}

test('describeTokenShape says nothing about a token with nothing wrong', () => {
  assert.equal(describeTokenShape('ghp_' + 'a'.repeat(36)), null);
  assert.equal(describeTokenShape('ghs_MiXeD09AZ'), null);
  // Absent is not malformed: `GITHUB_TOKEN` unset has its own message
  // elsewhere, and a second one here would be a thing to disbelieve.
  assert.equal(describeTokenShape(''), null);
});

test('every sample character is detected, wherever it sits', () => {
  for (const [name, ch] of SAMPLES) {
    for (const [where, build] of POSITIONS) {
      const out = describeTokenShape(build(ch));
      assert.ok(out, `${where} ${name} (U+${ch.codePointAt(0).toString(16)}) went undetected`);
    }
  }
});

/**
 * THE CLAIM THIS FILE EXISTS FOR.
 *
 * The message tells the operator which of three things is about to happen, and
 * that is its whole value: one says look at the journal, one says look at
 * GitHub, one says look somewhere else entirely. Getting the third wrong is the
 * expensive direction -- it invents a fault that is not there.
 *
 * Rather than restate the boundary, which would drift the moment the runtime
 * changed, this drives the REAL header layer and asserts the message agrees
 * with it, for every sample in every position. If undici ever stops trimming a
 * trailing newline, this fails and the prose gets fixed. That is the only way a
 * docstring making a claim about someone else's code stays true.
 */
test('every message agrees with the real header layer', () => {
  const seen = new Set();
  for (const [name, ch] of SAMPLES) {
    for (const [where, build] of POSITIONS) {
      const token = build(ch);
      const actual = actualOutcome(token);
      const claimed = claimedOutcome(describeTokenShape(token));
      assert.equal(
        claimed,
        actual,
        `${where} ${name}: message says ${claimed}, runtime does ${actual}`,
      );
      seen.add(actual);
    }
  }
  // Guard against the matrix collapsing to a single outcome and the loop
  // passing vacuously -- which is how a test of this shape rots without ever
  // failing.
  assert.deepEqual([...seen].sort(), ['rejected', 'throws', 'tolerated']);
});

test('a trailing newline is reported as harmless, in those words', () => {
  // #185 assumed a trailing newline caused a 401. It does not, and a message
  // saying so would send an operator hunting a failure that is not happening.
  // No claim about how often it arrives: that depends which loader wrote the
  // variable, and this cannot be tested from inside a container.
  const out = describeTokenShape('ghp_abcdef\u000a');
  assert.match(out, /U\+000A/);
  assert.match(out, /NOT causing a failure/);
  assert.doesNotMatch(out, /401/);
  assert.doesNotMatch(out, /throws before anything is sent/);
});

test('U+00A0 is the 401 case, not the throwing case', () => {
  // The single case that makes "invisible" and "above U+00FF" different sets.
  // A regression to "is it invisible" would still pass every other sample.
  const out = describeTokenShape('ghp_abc\u00a0def');
  assert.match(out, /U\+00A0/);
  assert.match(out, /401/);
  assert.doesNotMatch(out, /throws before anything is sent/);
});

test('a leading space is the 401 case, not the trimmed one', () => {
  // Not symmetric with trailing, and the asymmetry is easy to get wrong: the
  // value is `Bearer ` + the token, so anything at the token's front is
  // interior to the value and survives the trim.
  const out = describeTokenShape(' ghp_abcdef');
  assert.match(out, /position 1 of 11\b/);
  assert.match(out, /401/);
  assert.doesNotMatch(out, /NOT causing a failure/);
});

test('the worst outcome is named, not the first character found', () => {
  // THE MILDER CHARACTER MUST COME FIRST or this proves nothing -- with the
  // zero-width space at the front, "name the worst" and "name the first" agree
  // and the test passes against either. It did, until a mutation run caught it.
  //
  // So: an embedded space (401) at position 5, a zero-width space (throws) at
  // position 9. One of these is the fault and it is not the one found first.
  const out = describeTokenShape('ghp_ abc\u200b');
  assert.match(out, /U\+200B/);
  assert.match(out, /position 9 of 9\b/);
  assert.match(out, /throws before anything is sent/);
  assert.doesNotMatch(out, /U\+0020/);

  // And the reverse order, so neither "first" nor "last" passes by accident.
  const flipped = describeTokenShape('ghp_\u200ba c');
  assert.match(flipped, /U\+200B/);
  assert.match(flipped, /position 5 of 8\b/);
});

test('the position is 1-based, and the length is given beside it', () => {
  assert.match(describeTokenShape('ghp_\u200babc'), /position 5 of 8\b/);
  assert.match(describeTokenShape('\ufeffghp_abc'), /position 1 of 8\b/);
  // Position === length reads as "at the end" without the operator counting.
  assert.match(describeTokenShape('ghp_abc\u000a'), /position 8 of 8\b/);
});

test('counted by codepoint, not by UTF-16 unit', () => {
  // An astral character is two UTF-16 units and one position, and getting that
  // wrong moves every position after it -- the operator then counts along to a
  // character that is fine.
  //
  // This fixture used to report the SPACE, with the emoji as inert padding. Once
  // the filter widened past `INVISIBLE_OR_SPACE` the emoji became a hit in its
  // own right, outranked the space, and started reporting itself. So the
  // observable moved to the LENGTH, which is where the two countings diverge:
  // eight codepoints, nine units. Index and length are read off the same spread,
  // so pinning one pins both.
  assert.match(describeTokenShape('\u{1f600}ghp_abc'), /position 1 of 8\b/);
});

test('says how many share the outcome, so the second is not a second afternoon', () => {
  const one = describeTokenShape('ghp_abc\u200bdef');
  assert.doesNotMatch(one, /characters in the value/);
  const three = describeTokenShape('\u200bghp_\u200babc\u200b');
  assert.match(three, /3 characters in the value are of this kind/);
  assert.match(three, /position 1 of 10\b/);
  // Counted by OUTCOME, not by hit: a trailing newline alongside two zero-width
  // spaces must not be counted among them.
  const mixed = describeTokenShape('ghp_\u200ba\u200bb\u000a');
  assert.match(mixed, /2 characters in the value are of this kind/);
});

test('names the character rather than only its codepoint', () => {
  assert.match(describeTokenShape('ghp_\u200ba'), /zero-width space/);
  assert.match(describeTokenShape('ghp_\ufeffa'), /byte-order mark/);
  assert.match(describeTokenShape('ghp_\u000da'), /carriage return/);
  // Anything without an entry still gets a specific, correct claim.
  assert.match(describeTokenShape('ghp_\u2061a'), /U\+2061/);
});

test('never quotes the token, at any length', () => {
  // This goes to stderr and stderr goes to the journal. Naming a position is
  // the point precisely BECAUSE it identifies the character without
  // reproducing the credential around it.
  const secret = 'ghp_' + 'S3cr3tV4lu3'.repeat(3);
  const out = describeTokenShape(secret + '\u200b');
  assert.doesNotMatch(out, /S3cr3tV4lu3/);
  assert.ok(!out.includes(secret.slice(4)), 'the message carried the token body');
});

test('a character above U+00FF is diagnosed even though it is not invisible', () => {
  // The gap round 1 found: the docstring claimed "any codepoint above U+00FF"
  // while the detector only examined INVISIBLE_OR_SPACE, so these threw and said
  // nothing -- producing the bare TypeError this whole change exists to replace.
  for (const [name, ch] of [
    ['right single quote', '\u2019'],
    ['left double quote', '\u201c'],
    ['en dash', '\u2013'],
    ['CJK', '\u65e5'],
  ]) {
    const out = describeTokenShape('ghp_ab' + ch + 'cdef');
    assert.ok(out, `${name} went undiagnosed`);
    assert.match(out, /throws before anything is sent/);
    // No name in the table, so it degrades to a bare codepoint -- still a
    // specific claim about a specific position.
    assert.match(out, new RegExp('U\\+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')));
  }
});

test('NUL throws wherever it sits, including trailing', () => {
  // It is not in the [\t\n\r ] run undici strips, so unlike CR/LF it gets no
  // trailing exemption. Unreachable in production -- an environment block cannot
  // carry one -- but the boundary sentence claims completeness.
  for (const token of ['\u0000ghp_abc', 'ghp_\u0000abc', 'ghp_abc\u0000']) {
    const out = describeTokenShape(token);
    assert.match(out, /U\+0000/);
    assert.match(out, /throws before anything is sent/);
  }
});

/**
 * The reason clause, which round 2 found false for four of the cases the suite
 * already exercised.
 *
 * `claimedOutcome` matches on "throws before anything is sent" -- a substring of
 * the SECOND sentence -- so the first sentence was asserted nowhere, and a
 * newline was being told it was a character above U+00FF. The classification was
 * right the whole time; only the reason was wrong, and no assertion looked at it.
 *
 * This looks at it, for every sample in every position, rather than pinning the
 * four cases that happened to be wrong.
 */
test('the reason given is true of the character named', () => {
  let throwing = 0;
  for (const [name, ch] of SAMPLES) {
    for (const [where, build] of POSITIONS) {
      const out = describeTokenShape(build(ch));
      if (!out.includes('throws before anything is sent')) continue;
      throwing++;
      const code = ch.codePointAt(0);
      const claimsAbove = out.includes('above U+00FF');
      assert.equal(
        claimsAbove,
        code > 0xff,
        `${where} ${name} (U+${code.toString(16)}): message ` +
          `${claimsAbove ? 'claims' : 'does not claim'} "above U+00FF", which is ` +
          `${code > 0xff ? 'true' : 'FALSE'} of it`,
      );
      // The alternative clause must actually be there rather than the sentence
      // silently going missing for the non-ASCII-range causes.
      if (!claimsAbove) {
        assert.match(out, /cannot contain a newline, a carriage return or a NUL/);
      }
    }
  }
  // Not vacuous: the loop must have found throwing cases of BOTH kinds.
  assert.ok(throwing >= 8, `only ${throwing} throwing cases exercised`);
});

test('a Windows line ending is not explained by a rule it does not satisfy', () => {
  // The case round 2 quoted: the message names U+000D, says it is a Windows line
  // ending, and then must not explain the failure with a rule about U+00FF.
  const out = describeTokenShape('ghp_\u000dabc');
  assert.match(out, /U\+000D/);
  assert.match(out, /Windows line ending/);
  assert.doesNotMatch(out, /above U\+00FF/);
  assert.match(out, /cannot contain a newline, a carriage return or a NUL/);
});
