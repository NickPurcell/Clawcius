/**
 * Reading the authorize URL out of what the login draws.
 *
 * Every assertion here runs against `test/fixtures/setup-token-real-output.ansi`,
 * which is what the command actually wrote under a pty rather than a rendering
 * of what it was expected to write. The difference is the whole test: in that
 * output the visible URL is soft-wrapped across five lines.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { authorizeUrl, hyperlinks, ptyArgv } from '../dist/pty.js';

const REAL = readFileSync(join(import.meta.dirname, 'fixtures/setup-token-real-output.ansi'), 'utf8');

const EXPECTED =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=user%3Ainference&code_challenge=8PDsTJ_j6El1oJs-gOG5ySBpIyETRctjeP3N6VyBvJc' +
  '&code_challenge_method=S256&state=AW8KAhkU0IpSVu18guvp9VU2e5-HbQ9uRMKsMFTZiyo';

test('the URL comes out of the real output whole', () => {
  assert.equal(authorizeUrl(REAL), EXPECTED);
});

test('the drawn text alone would give a truncated URL', () => {
  // This is why the hyperlink is read instead. Stripping the escapes and
  // matching the visible characters yields a prefix that ends mid-parameter and
  // is a perfectly plausible URL to hand someone.
  const visible = REAL.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][B0]|\x1b[78]/g, '');
  const naive = /https:\/\/\S*oauth\/authorize\S*/.exec(visible);

  assert.notEqual(naive, null, 'the visible text does contain something URL-shaped');
  assert.notEqual(naive[0], EXPECTED, 'and it is not the URL');
  assert.ok(EXPECTED.startsWith(naive[0]), 'it is a prefix of it — which is why it looks right');
});

test('one hyperlink, however many lines it was drawn across', () => {
  assert.deepEqual(hyperlinks(REAL), [EXPECTED]);
});

test('output with no hyperlink yet has no URL', () => {
  assert.equal(authorizeUrl(''), null);
  assert.equal(authorizeUrl('Opening browser to sign in…\r\n'), null);
});

test('the closing escape is not mistaken for a target', () => {
  // OSC 8 closes with an empty uri: ESC ] 8 ; ; BEL
  assert.deepEqual(hyperlinks('\x1b]8;;https://example.com/a\x07text\x1b]8;;\x07'), [
    'https://example.com/a',
  ]);
});

test('a non-authorize hyperlink is not offered as the authorize URL', () => {
  assert.equal(authorizeUrl('\x1b]8;;https://claude.com/settings\x07settings\x1b]8;;\x07'), null);
});

test('the command runs under a terminal it does not have', () => {
  // The daemon has no controlling terminal, so `docker exec -it` refuses on its
  // own and `script` is what supplies one.
  const { file, args } = ptyArgv(['docker', 'exec', '-it', 'clawcius-agent', '/usr/local/bin/claude', 'setup-token']);
  assert.equal(file, 'script');
  assert.deepEqual(args, [
    '-qec',
    'docker exec -it clawcius-agent /usr/local/bin/claude setup-token',
    '/dev/null',
  ]);
});
