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
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
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

test('start() writes immediately, and a first-write failure stops startup', async () => {
  const path = join(dir(), '.github-token');
  const ok = new TokenFileRefresher({
    path,
    provider: async () => 'tok-1',
    log: silent,
  });
  await ok.start();
  ok.stop();
  assert.equal(readFileSync(path, 'utf8'), 'tok-1');

  // A daemon that comes up without this file has agents whose every push fails,
  // discovered one agent at a time. Boot is the right place to find out.
  const bad = new TokenFileRefresher({
    path: join(dir(), '.github-token'),
    provider: async () => {
      throw new Error('no installations');
    },
    log: silent,
  });
  await assert.rejects(bad.start(), /no installations/);
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
  r.stop();

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
  assert.match(logs.join('\n'), /REMOVED/);
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
  r.stop();
  assert.equal(readFileSync(path, 'utf8'), 'tok-3', 'the crew must recover without a restart');
});
