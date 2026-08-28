import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TokenFileRefresher,
  writeSecretFile,
  writeCurlConfig,
  tokenFilePath,
  netrcPath,
  curlrcPath,
} from '../dist/token-file.js';

const dir = () => mkdtempSync(join(tmpdir(), 'clawsky-token-'));
const silent = () => {};
const failing = (code) => Object.assign(new Error(code), { code });

test('a secret file is written 0600 and readable back', () => {
  const path = join(dir(), '.github-token');
  writeSecretFile(path, 'ghs_installationtoken');
  assert.equal(readFileSync(path, 'utf8'), 'ghs_installationtoken');
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a rewrite replaces the whole file', () => {
  const path = join(dir(), '.github-token');
  writeSecretFile(path, 'first');
  writeSecretFile(path, 'second-and-much-longer-than-the-first');
  assert.equal(readFileSync(path, 'utf8'), 'second-and-much-longer-than-the-first');
});

test('a directory that does not exist yet is created', () => {
  const path = join(dir(), 'nested', 'deeper', '.github-token');
  writeSecretFile(path, 'tok');
  assert.equal(readFileSync(path, 'utf8'), 'tok');
});

test('a non-file at the destination is cleared rather than thrown over', () => {
  const path = join(dir(), 'installation-token');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'planted'), 'by something that should not be able to');

  writeSecretFile(path, 'ghs_tok');
  assert.equal(readFileSync(path, 'utf8'), 'ghs_tok');
});

test('start() writes the token file and the netrc, and a first-fetch failure does not stop startup', async () => {
  const d = dir();
  const ok = new TokenFileRefresher({ dir: d, provider: async () => 'tok-1', log: silent });
  assert.equal(await ok.start(), true, 'start() must report the file it wrote');
  assert.equal(readFileSync(tokenFilePath(d), 'utf8'), 'tok-1');
  assert.match(readFileSync(netrcPath(d), 'utf8'), /password tok-1/);
  assert.ok(existsSync(curlrcPath(d)));
  ok.stop();

  const e = dir();
  const bad = new TokenFileRefresher({
    dir: e,
    provider: async () => {
      throw failing('HTTP_403');
    },
    log: silent,
  });
  assert.equal(await bad.start(), false, 'start() must report that no file was written');
  bad.stop();
  assert.equal(existsSync(tokenFilePath(e)), false);
  assert.equal(existsSync(netrcPath(e)), false);
});

test('a transient refresh failure keeps the token and the netrc', async () => {
  const d = dir();
  let calls = 0;
  let clock = 1_000_000;
  const r = new TokenFileRefresher({
    dir: d,
    now: () => clock,
    log: silent,
    provider: async () => {
      calls += 1;
      if (calls === 1) return 'tok-good';
      throw failing('ENOENT');
    },
  });

  await r.start();
  clock += 10 * 60_000;
  await r.refreshNow();

  assert.equal(readFileSync(tokenFilePath(d), 'utf8'), 'tok-good', 'the working token must survive');
  assert.match(readFileSync(netrcPath(d), 'utf8'), /password tok-good/);
  r.stop();
});

test('a failure past the token life removes the token file and the netrc', async () => {
  const d = dir();
  let calls = 0;
  let clock = 1_000_000;
  const r = new TokenFileRefresher({
    dir: d,
    now: () => clock,
    log: silent,
    provider: async () => {
      calls += 1;
      if (calls === 1) return 'tok-good';
      throw failing('EACCES');
    },
  });

  await r.start();
  assert.ok(existsSync(tokenFilePath(d)));
  clock += 56 * 60_000;
  await r.refreshNow();

  assert.equal(existsSync(tokenFilePath(d)), false, 'an unusable token must not be left on disk');
  assert.equal(existsSync(netrcPath(d)), false, 'nor in the netrc');
  assert.ok(existsSync(curlrcPath(d)), 'the curlrc stays; netrc-optional makes it harmless');
  r.stop();
});

test('neither the token nor a PEM path is ever logged', async () => {
  const d = dir();
  const logs = [];
  let calls = 0;
  let clock = 1_000_000;
  const r = new TokenFileRefresher({
    dir: d,
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
  assert.ok(logs.length >= 2, 'both failures were logged');
  assert.doesNotMatch(all, /ghs_supersecret/, 'the token must never be logged');
  assert.doesNotMatch(all, /secret-app-key/, "the PEM's path must never be logged");
  assert.doesNotMatch(all, /etc\/clawcius/, "the PEM's path must never be logged");
});

test('recovery: a refresh that succeeds after a removal writes both files again', async () => {
  const d = dir();
  let calls = 0;
  let clock = 1_000_000;
  const r = new TokenFileRefresher({
    dir: d,
    now: () => clock,
    log: silent,
    provider: async () => {
      calls += 1;
      if (calls === 2) throw failing('EAGAIN');
      return `tok-${calls}`;
    },
  });

  await r.start();
  clock += 56 * 60_000;
  await r.refreshNow();
  assert.equal(existsSync(tokenFilePath(d)), false);

  await r.refreshNow();
  assert.equal(readFileSync(tokenFilePath(d), 'utf8'), 'tok-3', 'the crew must recover without a restart');
  assert.match(readFileSync(netrcPath(d), 'utf8'), /password tok-3/);
  r.stop();
});

test('the staleness clock tracks the token, not the write — with a caching provider', async () => {
  const d = dir();
  let clock = 0;
  let healthy = true;

  // The real provider's shape: caches, and only fails when it has to mint.
  let cached = null;
  let cachedAtMs = 0;
  const caching = async () => {
    if (cached && clock - cachedAtMs < 55 * 60_000) return cached;
    if (!healthy) throw failing('ENOENT');
    cached = `ghs_tok_${clock}`;
    cachedAtMs = clock;
    return cached;
  };

  const r = new TokenFileRefresher({ dir: d, provider: caching, now: () => clock, log: silent });
  await r.start();
  assert.equal(readFileSync(tokenFilePath(d), 'utf8'), 'ghs_tok_0');

  healthy = false;
  for (const t of [5, 10, 20, 30, 40, 50]) {
    clock = t * 60_000;
    await r.refreshNow();
    assert.ok(existsSync(tokenFilePath(d)), `t=${t}: a live token must keep being served`);
  }

  clock = 56 * 60_000;
  await r.refreshNow();
  assert.equal(
    existsSync(tokenFilePath(d)),
    false,
    'a token minted at t=0 is dead by t=56 — rewriting it every 5 minutes does not make it younger',
  );
  r.stop();
});

test('a refresh keeps the netrc in step with the token file', async () => {
  const d = dir();
  let n = 0;
  const r = new TokenFileRefresher({ dir: d, provider: async () => `tok-${++n}`, log: silent });
  await r.start();
  assert.match(readFileSync(netrcPath(d), 'utf8'), /password tok-1/);

  await r.refreshNow();
  assert.equal(readFileSync(tokenFilePath(d), 'utf8'), 'tok-2');
  assert.match(readFileSync(netrcPath(d), 'utf8'), /password tok-2/, 'netrc must follow the token');
  r.stop();
});

test('stop() takes the token file and the netrc with it', async () => {
  const d = dir();
  const r = new TokenFileRefresher({ dir: d, provider: async () => 'tok', log: silent });
  await r.start();
  assert.ok(existsSync(tokenFilePath(d)));
  assert.ok(existsSync(netrcPath(d)));

  r.stop();
  assert.equal(existsSync(tokenFilePath(d)), false);
  assert.equal(existsSync(netrcPath(d)), false);
});

// ── the curl credential ─────────────────────────────────────────────────────

test('the netrc is scoped to exactly one machine, and that machine is api.github.com', () => {
  const d = dir();
  writeCurlConfig(d, 'ghs_installation_token');
  const netrc = readFileSync(netrcPath(d), 'utf8');

  const machines = netrc.split('\n').filter((l) => /^\s*machine\s/.test(l));
  assert.equal(machines.length, 1, `expected exactly one machine line, got: ${machines.join(' | ')}`);
  assert.match(machines[0], /^machine api\.github\.com$/);
  assert.doesNotMatch(netrc, /^\s*default\b/m, 'a default entry would match every host');
});

test('the curl credential is 0600 and holds the token it was given', () => {
  const d = dir();
  writeCurlConfig(d, 'ghs_installation_token');
  assert.match(readFileSync(netrcPath(d), 'utf8'), /password ghs_installation_token/);
  assert.equal(statSync(netrcPath(d)).mode & 0o777, 0o600);
  const curlrc = readFileSync(curlrcPath(d), 'utf8');
  assert.match(curlrc, /^netrc-optional$/m);
  assert.match(curlrc, new RegExp(`netrc-file = "${netrcPath(d)}"`));
});

test('a path with a space still yields a usable curlrc', () => {
  const d = mkdtempSync(join(tmpdir(), 'clawsky tok-'));
  writeCurlConfig(d, 'ghs_tok');
  const curlrc = readFileSync(curlrcPath(d), 'utf8');
  const line = curlrc.split('\n').find((l) => l.startsWith('netrc-file'));
  assert.match(line, /^netrc-file = ".*"$/, `unquoted path would break: ${line}`);
  assert.ok(line.includes(d), 'and it must still be the right path');
});
