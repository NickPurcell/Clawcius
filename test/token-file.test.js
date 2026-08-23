/**
 * The agent session's credential file.
 *
 * The behaviour worth pinning is not "it writes a file" — it is what happens
 * when a refresh FAILS, because that is where this repository has been wrong
 * before. Issue #176 is the waker turning a transient credential failure into a
 * permanent one, and on 2026-08-23 a token rotation did exactly that to a live
 * watch. So the tests below are mostly about the two failure branches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TokenFileRefresher, writeTokenFile } from '../dist/token-file.js';

const dir = () => mkdtempSync(join(tmpdir(), 'clawsky-token-'));
const silent = () => {};

test('the token file is written 0600 and readable back', () => {
  const path = join(dir(), '.github-token');
  writeTokenFile(path, 'ghs_installationtoken');
  assert.equal(readFileSync(path, 'utf8'), 'ghs_installationtoken');
  // 0600 is not the protection — every process shares uid 1000 — but a future
  // change that stops sharing a uid should find the file already private.
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('writing is atomic: no reader can observe a partial token', () => {
  // `writeFileSync` to the final path truncates first, so a `git push` landing
  // in that window reads an empty credential and fails with an authentication
  // error that has nothing to do with authentication. Overwriting must be a
  // rename, so the old token is served right up to the instant the new one is.
  const path = join(dir(), '.github-token');
  writeTokenFile(path, 'first');
  writeTokenFile(path, 'second-and-much-longer-than-the-first');
  assert.equal(readFileSync(path, 'utf8'), 'second-and-much-longer-than-the-first');
});

test('a directory that does not exist yet is created', () => {
  const path = join(dir(), 'nested', 'deeper', '.github-token');
  writeTokenFile(path, 'tok');
  assert.equal(readFileSync(path, 'utf8'), 'tok');
});

test('start() writes immediately, and a first-fetch failure does NOT stop startup', async () => {
  const path = join(dir(), '.github-token');
  const ok = new TokenFileRefresher({
    path,
    provider: async () => 'tok-1',
    log: silent,
  });
  assert.equal(await ok.start(), true, 'start() must report the file it wrote');
  assert.equal(readFileSync(path, 'utf8'), 'tok-1');
  ok.stop();

  // AND A FIRST FETCH THAT FAILS MUST NOT THROW. Throwing took the whole daemon
  // down — Discord, mail, reminders — into a five-second restart loop, on a
  // network call. A misconfigured App degraded gracefully while a correct one
  // that was briefly unreachable was fatal. No file simply means agents fall
  // back to GITHUB_TOKEN.
  const logs = [];
  const bad = new TokenFileRefresher({
    path: join(dir(), 'installation-token'),
    provider: async () => {
      throw Object.assign(new Error('rate limited'), { code: 'HTTP_403' });
    },
    log: (m) => logs.push(m),
  });
  assert.equal(await bad.start(), false, 'start() must report that no file was written');
  bad.stop();
  assert.match(logs.join('\n'), /could not obtain an installation token/);
  assert.match(logs.join('\n'), /fail until a refresh succeeds/);
});

test('a transient refresh failure KEEPS the token and says so', async () => {
  // THE #176 LESSON, applied on the way in. Deleting the file the moment a
  // refresh throws converts a five-minute credential blip into an outage for
  // every agent in the crew. The waker's version of this cost a live watch on
  // 2026-08-23; a token rotation threw one 401 and the row was disarmed
  // permanently with no retry.
  const path = join(dir(), '.github-token');
  const logs = [];
  let calls = 0;
  let clock = 1_000_000;
  const r = new TokenFileRefresher({
    path,
    now: () => clock,
    log: (m) => logs.push(m),
    provider: async () => {
      calls += 1;
      if (calls === 1) return 'tok-good';
      throw Object.assign(new Error('boom'), { code: 'ENOENT' });
    },
  });

  await r.start();
  clock += 10 * 60_000; // ten minutes: well inside the token's life
  await r.refreshNow();

  assert.equal(readFileSync(path, 'utf8'), 'tok-good', 'the working token must survive');
  assert.match(logs.join('\n'), /refresh failed \(ENOENT\)/);
  assert.match(logs.join('\n'), /still in use/);
});

test('a failure past the token life REMOVES the file rather than serving a corpse', async () => {
  // A stale token is worse than an absent one. Git keeps working until the
  // moment it does not, and then fails with a 401 that names nothing. An absent
  // file fails immediately, and the helper's `cat` names the file in its error.
  const path = join(dir(), '.github-token');
  const logs = [];
  let calls = 0;
  let clock = 1_000_000;
  const r = new TokenFileRefresher({
    path,
    now: () => clock,
    log: (m) => logs.push(m),
    provider: async () => {
      calls += 1;
      if (calls === 1) return 'tok-good';
      throw Object.assign(new Error('boom'), { code: 'EACCES' });
    },
  });

  await r.start();
  assert.ok(existsSync(path));
  clock += 56 * 60_000; // past the useful life of an installation token
  await r.refreshNow();
  r.stop();

  assert.equal(existsSync(path), false, 'an unusable token must not be left on disk');
  assert.match(logs.join('\n'), /no usable credential/);
  assert.match(logs.join('\n'), /EACCES/);
});

test('neither the token nor a PEM path is ever logged', async () => {
  // `github-app.ts` states the rule and #180 pinned it on the boot path. This
  // is the same invariant on the refresh path, which is the one that runs for
  // days after the boot check has stopped being able to say anything.
  const path = join(dir(), '.github-token');
  const logs = [];
  let calls = 0;
  let clock = 1_000_000;
  const r = new TokenFileRefresher({
    path,
    now: () => clock,
    log: (m) => logs.push(m),
    provider: async () => {
      calls += 1;
      if (calls === 1) return 'ghs_supersecrettokenvalue';
      throw Object.assign(
        new Error("ENOENT: no such file or directory, open '/etc/clawcius/secret-app-key.pem'"),
        { code: 'ENOENT' },
      );
    },
  });

  await r.start();
  clock += 10 * 60_000;
  await r.refreshNow();
  clock += 60 * 60_000;
  await r.refreshNow();
  r.stop();

  const all = logs.join('\n');
  assert.doesNotMatch(all, /ghs_supersecret/, 'the token must never be logged');
  assert.doesNotMatch(all, /secret-app-key/, "the PEM's path must never be logged");
  assert.doesNotMatch(all, /etc\/clawcius/, "the PEM's path must never be logged");
  // The token FILE's path is not a secret and must be named — an operator
  // cannot fix a file they cannot identify.
  assert.match(all, /\.github-token/);
});

test('recovery: a refresh that succeeds after a removal writes the file again', async () => {
  // The removal is not terminal. If it were, this module would be issue #176
  // wearing a different hat.
  const path = join(dir(), '.github-token');
  let calls = 0;
  let clock = 1_000_000;
  const r = new TokenFileRefresher({
    path,
    now: () => clock,
    log: silent,
    provider: async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('blip'), { code: 'EAGAIN' });
      return `tok-${calls}`;
    },
  });

  await r.start();
  clock += 56 * 60_000;
  await r.refreshNow();
  assert.equal(existsSync(path), false);

  await r.refreshNow();
  assert.equal(readFileSync(path, 'utf8'), 'tok-3', 'the crew must recover without a restart');
  r.stop();
});

test('the staleness clock tracks the TOKEN, not the write — with a CACHING provider', async () => {
  // THE BUG EVERY OTHER TEST IN THIS FILE MISSED, and it missed it for one
  // reason: every other test injects a provider that mints a fresh value on
  // each call, which is the one thing the production provider never does.
  //
  // `appTokenProvider` is a cache. It returns the same token, without touching
  // the network or the PEM, until five minutes before expiry. So for the first
  // ~55 minutes of a token's life every tick rewrites identical bytes and
  // succeeds whether or not the credential source is healthy. Stamping the
  // clock on each successful write measured the age of the last provider CALL
  // — never more than one interval — so "past its useful life" was never true
  // while the token was actually dying, and the file served an expired
  // credential for about 45 minutes.
  const path = join(dir(), 'installation-token');
  const logs = [];
  let clock = 0;
  let healthy = true;

  // A provider with the real one's shape: caches, and only fails when it has to
  // go and mint.
  let cached = null;
  let cachedAtMs = 0;
  const caching = async () => {
    if (cached && clock - cachedAtMs < 55 * 60_000) return cached;
    if (!healthy) throw Object.assign(new Error('mint failed'), { code: 'ENOENT' });
    cached = `ghs_tok_${clock}`;
    cachedAtMs = clock;
    return cached;
  };

  const r = new TokenFileRefresher({ path, provider: caching, now: () => clock, log: (m) => logs.push(m) });
  await r.start();
  assert.equal(readFileSync(path, 'utf8'), 'ghs_tok_0');

  // The credential source dies five minutes in. The cache hides it for the rest
  // of the token's life, which is correct — there is nothing to do yet.
  healthy = false;
  for (const t of [5, 10, 20, 30, 40, 50]) {
    clock = t * 60_000;
    await r.refreshNow();
    assert.ok(existsSync(path), `t=${t}: a live token must keep being served`);
  }

  // Past the token's life with no successful mint since t=0: the file must go.
  clock = 56 * 60_000;
  await r.refreshNow();
  assert.equal(
    existsSync(path),
    false,
    'a token minted at t=0 is dead by t=56 — rewriting it every 5 minutes does not make it younger',
  );
  assert.match(logs.join('\n'), /no usable credential/);
});

test('a non-file at the destination is cleared rather than thrown over', async () => {
  // The sandbox should not be able to reach this path at all now — the
  // directory is refused inside any bind mount and is mounted read-only. This
  // is the second layer: `renameSync` throws EISDIR onto a path holding a
  // directory, `start()` does not catch, and `Restart=always` turned that into
  // a permanent restart loop with the bot down until a human intervened.
  const d = dir();
  const path = join(d, 'installation-token');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'planted'), 'by something that should not be able to');

  writeTokenFile(path, 'ghs_tok');
  assert.equal(readFileSync(path, 'utf8'), 'ghs_tok');
});

test('stop() takes the credential with it', async () => {
  // A clean shutdown or a redeploy would otherwise leave a working installation
  // token in a mounted directory for up to an hour with nothing refreshing it.
  // The module argues an absent file beats a stale one; that has to apply to
  // its own shutdown.
  const path = join(dir(), 'installation-token');
  const r = new TokenFileRefresher({ path, provider: async () => 'tok', log: silent });
  await r.start();
  assert.ok(existsSync(path));
  r.stop();
  assert.equal(existsSync(path), false);
});

test('a failed write leaves no temp file holding a live token', () => {
  const d = dir();
  writeTokenFile(join(d, 'installation-token'), 'ghs_live');
  const leftovers = readdirSync(d).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], `temp files survived: ${leftovers.join(', ')}`);
});

test('the failure line promises a fallback only when there is one', async () => {
  // `github-app.ts` spends a paragraph on this and #180 spent three rounds on
  // it: a warning the reader watches get disproved is a warning they learn to
  // skip. With no PAT the helper hands git an empty password, so "agents fall
  // back to GITHUB_TOKEN" would be refuted by the next thing that happens.
  const dead = async () => {
    throw Object.assign(new Error('nope'), { code: 'ECONNRESET' });
  };
  const withPat = [];
  await new TokenFileRefresher({
    path: join(dir(), 'installation-token'), provider: dead,
    hasFallbackToken: true, log: (m) => withPat.push(m),
  }).start();

  const withoutPat = [];
  await new TokenFileRefresher({
    path: join(dir(), 'installation-token'), provider: dead,
    hasFallbackToken: false, log: (m) => withoutPat.push(m),
  }).start();

  assert.match(withPat.join('\n'), /fall back to GITHUB_TOKEN/);
  assert.doesNotMatch(withoutPat.join('\n'), /fall back to/);
  assert.match(withoutPat.join('\n'), /GITHUB_TOKEN is not set either/);
});
