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

test('a read that ends inside the escape yields nothing, not a prefix', () => {
  // The output arrives in chunks. Without requiring the terminator this returns
  // a proper prefix of the real URL — the same truncation by another route,
  // and one that looks entirely correct.
  const cut = REAL.slice(0, REAL.indexOf('\u001b]8;') + 120);
  const partial = authorizeUrl(cut);

  assert.notEqual(partial, EXPECTED, 'a half-read hyperlink is not the URL');
  assert.equal(partial, null, 'and it is withheld rather than handed over truncated');
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

test('each word is quoted, because script hands its string to a shell', () => {
  const { file, args } = ptyArgv(['docker', 'exec', '-it', 'a b;rm -rf /', 'claude']);
  assert.equal(file, 'script');
  assert.deepEqual(args, ["-qec", "'docker' 'exec' '-it' 'a b;rm -rf /' 'claude'", '/dev/null']);
});
