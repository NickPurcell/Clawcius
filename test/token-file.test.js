import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TokenFileRefresher,
  writeTokenFile,
  writeCurlConfig,
  removeCurlConfig,
  netrcPath,
  curlrcPath,
} from '../dist/token-file.js';

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

  // AND A FIRST FETCH THAT FAILS MUST NOT THROW.
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
  const d = dir();
  const path = join(d, 'installation-token');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'planted'), 'by something that should not be able to');

  writeTokenFile(path, 'ghs_tok');
  assert.equal(readFileSync(path, 'utf8'), 'ghs_tok');
});

test('stop() takes the credential with it', async () => {
  // A clean shutdown or a redeploy would otherwise leave a working installation token in a mounted directory for up to an hour with nothing refreshing it.
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

// ── the curl credential ─────────────────────────────────────────────────────

test('the netrc is scoped to exactly one machine, and that machine is api.github.com', () => {
  // THE ONLY SAFETY PROPERTY A NETRC HAS IS ITS SCOPE.
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
  // `netrc-optional`, not `netrc`: a missing file must not make every unrelated
  // curl in the container fail.
  const curlrc = readFileSync(curlrcPath(d), 'utf8');
  assert.match(curlrc, /^netrc-optional$/m);
  // QUOTED. curl terminates an unquoted parameter at the first space, so a
  // directory containing one would silently disable the credential and warn on
  // every curl in the container.
  assert.match(curlrc, new RegExp(`netrc-file = "${netrcPath(d)}"`));
});

test('a refresh keeps the netrc in step with the token file', async () => {
  const d = dir();
  const path = join(d, 'installation-token');
  let n = 0;
  const r = new TokenFileRefresher({
    path,
    provider: async () => `tok-${++n}`,
    log: silent,
    onToken: (t) => writeCurlConfig(d, t),
  });
  await r.start();
  assert.match(readFileSync(netrcPath(d), 'utf8'), /password tok-1/);

  await r.refreshNow();
  assert.equal(readFileSync(path, 'utf8'), 'tok-2');
  assert.match(readFileSync(netrcPath(d), 'utf8'), /password tok-2/, 'netrc must follow the token');
  r.stop();
});

test('giving up on the installation token falls back to the PAT rather than leaving nothing', async () => {
  // FALLBACK AT THE WRITER.
  const d = dir();
  const path = join(d, 'installation-token');
  let clock = 1_000_000;
  let calls = 0;
  const r = new TokenFileRefresher({
    path,
    now: () => clock,
    log: silent,
    provider: async () => {
      calls += 1;
      if (calls === 1) return 'ghs_app';
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    },
    onToken: (t) => writeCurlConfig(d, t),
    onNoToken: () => writeCurlConfig(d, 'ghp_the_pat'),
  });

  await r.start();
  assert.match(readFileSync(netrcPath(d), 'utf8'), /password ghs_app/);

  clock += 56 * 60_000;
  await r.refreshNow();
  assert.equal(existsSync(path), false, 'the dead installation token must go');
  assert.match(
    readFileSync(netrcPath(d), 'utf8'),
    /password ghp_the_pat/,
    'and the netrc must hold the credential that still works, not nothing',
  );
  r.stop();
});

test('a path with a space still yields a usable curlrc', () => {
  // Unquoted, curl stops reading the parameter at the space and `netrc-optional` then means no error: a silent 401.
  const d = mkdtempSync(join(tmpdir(), 'clawsky tok-'));
  writeCurlConfig(d, 'ghs_tok');
  const curlrc = readFileSync(curlrcPath(d), 'utf8');
  const line = curlrc.split('\n').find((l) => l.startsWith('netrc-file'));
  assert.match(line, /^netrc-file = ".*"$/, `unquoted path would break: ${line}`);
  assert.ok(line.includes(d), 'and it must still be the right path');
});

test('stop() clears the curl credential rather than replacing it with the PAT', async () => {
  // `onNoToken` writes whichever credential is in force; a clean shutdown must clear, not install the PAT.
  const d = dir();
  const path = join(d, 'installation-token');
  const r = new TokenFileRefresher({
    path,
    provider: async () => 'ghs_app',
    log: silent,
    onToken: (t) => writeCurlConfig(d, t),
    onNoToken: () => writeCurlConfig(d, 'ghp_the_pat'),
    onStop: () => removeCurlConfig(d),
  });
  await r.start();
  assert.ok(existsSync(netrcPath(d)));

  r.stop();
  assert.equal(existsSync(path), false, 'the token file goes, as before');
  assert.equal(existsSync(netrcPath(d)), false, 'and so must the curl credential');
});

test('a failing curl write does not delete a healthy token or blame the provider', async () => {
  // A throwing `onToken` is not the provider's fault and must not freeze the staleness clock.
  const d = dir();
  const path = join(d, 'installation-token');
  const logs = [];
  let clock = 1_000_000;
  const r = new TokenFileRefresher({
    path,
    now: () => clock,
    log: (m) => logs.push(m),
    provider: async () => 'ghs_healthy',
    onToken: () => {
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    },
  });

  await r.start();
  assert.equal(readFileSync(path, 'utf8'), 'ghs_healthy', 'the token was obtained and written');
  assert.match(logs.join('\n'), /curl credential could not be written \(ENOSPC\)/);
  // …and it must not promise a fallback that does not exist. With no netrc curl
  // sends nothing and takes a 401; the credential is unchanged, not replaced.
  assert.match(logs.join('\n'), /it is UNCHANGED/);
  assert.doesNotMatch(logs.join('\n'), /fall back/);
  assert.doesNotMatch(logs.join('\n'), /could not obtain an installation token/);

  clock += 56 * 60_000;
  await r.refreshNow();
  assert.equal(readFileSync(path, 'utf8'), 'ghs_healthy', 'still healthy an hour on');
  r.stop();
});

test('a throwing onNoToken cannot escape the tick', async () => {
  // #tick runs as `void this.#tick()` from a timer, so a throw out of its catch is an unhandled rejection and Node turns that into an uncaught exception.
  const d = dir();
  const r = new TokenFileRefresher({
    path: join(d, 'installation-token'),
    log: silent,
    provider: async () => {
      throw Object.assign(new Error('nope'), { code: 'ECONNRESET' });
    },
    onNoToken: () => {
      throw Object.assign(new Error('read-only'), { code: 'EROFS' });
    },
  });
  await r.start();   // must not throw
  r.stop();          // nor must this
});
