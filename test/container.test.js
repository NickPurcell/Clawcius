import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { containerSpawner, sweepEnvFiles } from '../dist/container.js';

const DISCORD_TOKEN = 'MTQ2NzA3MDE0NTM0.fake.discord-token-do-not-use';
const GITHUB_TOKEN = 'ghp_fakefakefakefakefakefakefakefakefake';

/** A `docker` that records what it was handed and exits. */
function fakeDocker() {
  const dir = mkdtempSync(join(tmpdir(), 'container-test-'));
  const out = join(dir, 'record');
  const bin = join(dir, 'docker');
  writeFileSync(
    bin,
    `#!/bin/sh
: > "${out}.argv"
for a in "$@"; do printf '%s\\0' "$a" >> "${out}.argv"; done
prev=
for a in "$@"; do
  if [ "$prev" = "--env-file" ]; then
    printf '%s' "$a" > "${out}.path"
    stat -c '%a' "$a" > "${out}.mode"
    cat "$a" > "${out}.envfile"
  fi
  prev=$a
done
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return { dir, out, bin };
}

/** Run the spawner with a fake docker on PATH and return what it saw. */
async function run(env, execEnvDir) {
  const { dir, out } = fakeDocker();
  const spawner = containerSpawner({
    name: 'test-agent',
    claudePath: '/usr/local/bin/claude',
    execEnvDir: execEnvDir ?? join(dir, 'exec-env'),
  });

  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  let child;
  try {
    child = spawner({ command: '/host/claude', args: ['--print'], cwd: '/w', env });
  } finally {
    process.env.PATH = previousPath;
  }

  await new Promise((resolve, reject) => {
    child.on('close', resolve);
    child.on('error', reject);
  });

  // Read back optionally, so that a build passing no --env-file at all fails
  // on the assertion that says why rather than on a missing temp file.
  const maybe = (suffix) => (existsSync(`${out}.${suffix}`) ? readFileSync(`${out}.${suffix}`, 'utf8') : '');
  return {
    argv: readFileSync(`${out}.argv`, 'utf8').split('\0').slice(0, -1),
    envFilePath: maybe('path'),
    mode: maybe('mode').trim(),
    envFile: maybe('envfile'),
    execEnvDir: join(dir, 'exec-env'),
  };
}

test('no credential appears anywhere in the exec command line', async () => {
  const { argv } = await run({
    DISCORD_TOKEN,
    GITHUB_TOKEN,
    GIT_CONFIG_VALUE_2: `!f() { echo "password=${GITHUB_TOKEN}"; }; f`,
    ANTHROPIC_API_KEY: 'sk-ant-fake',
    HTTPS_PROXY: 'http://172.31.250.2:3128',
  });

  const line = argv.join(' ');
  for (const secret of [DISCORD_TOKEN, GITHUB_TOKEN, 'sk-ant-fake']) {
    assert.equal(
      line.includes(secret),
      false,
      'a credential reached the command line, where /proc/<pid>/cmdline hands it to every ' +
        `local account on the host. Full argv: ${line}`,
    );
  }
  // The name may be visible; only the value is the problem. But nothing should
  // be carrying it in any form, so no `-e` should mention it at all.
  assert.equal(
    argv.some((arg) => arg.startsWith('DISCORD_TOKEN=') || arg.startsWith('GITHUB_TOKEN=')),
    false,
  );
});

test('the proxy stays visible in ps — this is not "move everything"', async () => {
  const { argv, envFile } = await run({
    DISCORD_TOKEN,
    HTTPS_PROXY: 'http://172.31.250.2:3128',
    NO_PROXY: 'localhost,127.0.0.1',
  });

  assert.ok(argv.includes('HTTPS_PROXY=http://172.31.250.2:3128'), argv.join(' '));
  assert.ok(argv.includes('NO_PROXY=localhost,127.0.0.1'), argv.join(' '));
  // ...and it is not ALSO in the file, which would be two sources of truth.
  assert.equal(envFile.includes('HTTPS_PROXY'), false);
});

test('the credentials arrive intact, through the file', async () => {
  const { argv, envFile, envFilePath, execEnvDir } = await run({
    DISCORD_TOKEN,
    GITHUB_TOKEN,
    DISCORD_GUILD_ID: '123',
  });

  const at = argv.indexOf('--env-file');
  assert.notEqual(at, -1, 'the exec must be given an --env-file');
  assert.equal(argv[at + 1], envFilePath);
  assert.ok(envFilePath.startsWith(`${execEnvDir}/`), envFilePath);

  const lines = envFile.split('\n').filter(Boolean);
  assert.ok(lines.includes(`DISCORD_TOKEN=${DISCORD_TOKEN}`), envFile);
  assert.ok(lines.includes(`GITHUB_TOKEN=${GITHUB_TOKEN}`), envFile);
  assert.ok(lines.includes('DISCORD_GUILD_ID=123'));
});

test('the env file is 0600 as the exec sees it, not as we meant it', async () => {
  const { mode, envFilePath } = await run({ DISCORD_TOKEN });
  assert.ok(envFilePath, 'no --env-file was passed, so the secrets went somewhere else');
  assert.equal(mode, '600');
});

test('host-only variables still reach neither the argv nor the file', async () => {
  const { argv, envFile } = await run({
    PATH: '/home/npurcell/.local/share/node/bin',
    HOME: '/home/npurcell',
    TZ: 'UTC',
    DISCORD_TOKEN,
  });

  assert.equal(argv.join(' ').includes('/home/npurcell/.local/share/node/bin'), false);
  assert.equal(envFile.includes('PATH='), false);
  assert.equal(envFile.includes('HOME='), false);
  assert.equal(envFile.includes('TZ='), false);
});

test('the file is unlinked when the exec ends', async () => {
  const { envFilePath } = await run({ DISCORD_TOKEN });
  assert.ok(envFilePath, 'no --env-file was passed, so the secrets went somewhere else');
  assert.equal(existsSync(envFilePath), false, 'a file holding both tokens outlived its turn');
});

test('a value containing a newline is refused, never truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'container-test-'));
  const execEnvDir = join(dir, 'exec-env');
  const spawner = containerSpawner({
    name: 'test-agent',
    claudePath: '/usr/local/bin/claude',
    execEnvDir,
  });

  // Docker's --env-file parser splits on newlines, so this value cannot be
  // represented. Passing the first line only would run a turn with a
  // credential silently cut in half.
  assert.throws(
    () =>
      spawner({
        command: '/host/claude',
        args: [],
        env: { GITHUB_TOKEN: 'ghp_first\nline-two-would-be-lost' },
      }),
    /newline/,
  );

  // And it left nothing behind holding the half of it that was representable.
  assert.deepEqual(existsSync(execEnvDir) ? readdirSync(execEnvDir) : [], []);
});

test('orphans from a killed waker are swept at startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'container-test-'));
  writeFileSync(join(dir, 'exec-env-99-deadbeef'), `DISCORD_TOKEN=${DISCORD_TOKEN}\n`);
  writeFileSync(join(dir, 'waker-status.json'), '{}');

  assert.equal(sweepEnvFiles(dir), 1);
  assert.deepEqual(readdirSync(dir), ['waker-status.json'], 'the sweep took something else');
  assert.equal(sweepEnvFiles(join(dir, 'never-used')), 0);
});
