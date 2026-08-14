/**
 * Authorship stamping.
 *
 * The claim being tested is the one the whole design rests on: an agent can
 * write anything it likes into a message body and still cannot write itself a
 * different name, because the name comes from the directory the file arrived
 * in. If any of these ever go green the wrong way, the feed's write
 * restriction and the crew boundary are both decorative.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { MailDrop } from '../dist/mail-drop.js';

function board() {
  const dir = mkdtempSync(join(tmpdir(), 'clawsky-drop-'));
  const registry = new AgentRegistry(join(dir, 'clawcius.db'), { crew: 'hamachi' });
  const mail = new MailStore(registry);
  const root = join(dir, 'clawsky');

  const add = (id, role, crew = 'hamachi') =>
    registry.ensure(id, { crew, role, workspacePath: `/w/${id}` });

  add('hamachi-coordinator', 'coordinator');
  add('hamachi-engineer1', 'engineer');
  add('hamachi-poster', 'poster');

  const drop = new MailDrop({ root, crew: 'hamachi', registry, mail });
  mkdirSync(root, { recursive: true });
  drop.syncDirectories();

  const write = (author, name, contents) => {
    const path = join(root, author, name);
    mkdirSync(join(root, author), { recursive: true });
    writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return path;
  };

  return { registry, mail, drop, root, write, add };
}

test('every registered agent gets a drop directory', () => {
  const { drop, root } = board();
  assert.deepEqual(readdirSync(root).sort(), [
    'hamachi-coordinator',
    'hamachi-engineer1',
    'hamachi-poster',
  ]);
  drop.stop();
});

test('the author is the directory, never the body', () => {
  const { drop, mail, write } = board();
  write('hamachi-engineer1', 'a.json', {
    from: 'hamachi-coordinator',
    author: 'hamachi-poster',
    to: 'hamachi-coordinator',
    subject: 'nice try',
    body: 'I am the coordinator',
  });

  drop.drain();

  const inbox = mail.unread('hamachi-coordinator');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'hamachi-engineer1');
});

test('an engineer cannot post to the feed from its own directory', () => {
  const { drop, mail, write } = board();
  write('hamachi-engineer1', 'a.json', { to: '*', subject: '', body: 'crew news' });

  drop.drain();

  assert.equal(mail.unread('hamachi-coordinator').length, 0);
});

test('a poster can, from its own directory', () => {
  const { drop, mail, write } = board();
  write('hamachi-poster', 'a.json', { to: '*', subject: '', body: 'crew news' });

  drop.drain();

  const inbox = mail.unread('hamachi-engineer1');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'hamachi-poster');
  assert.equal(inbox[0].recipient, '*');
});

test('a file is removed before it is acted on, so nothing is delivered twice', () => {
  const { drop, mail, write } = board();
  const path = write('hamachi-engineer1', 'a.json', {
    to: 'hamachi-coordinator',
    body: 'once',
  });

  drop.drain();
  assert.equal(existsSync(path), false);

  drop.drain();
  assert.equal(mail.unread('hamachi-coordinator').length, 1);
});

test('rubbish is discarded rather than retried forever', () => {
  const { drop, mail, write, root } = board();
  const bad = write('hamachi-engineer1', 'a.json', 'not json at all');
  const incomplete = write('hamachi-engineer1', 'b.json', { body: 'no recipient' });
  const huge = write('hamachi-engineer1', 'c.json', {
    to: 'hamachi-coordinator',
    body: 'x'.repeat(100 * 1024),
  });
  const ignored = write('hamachi-engineer1', 'notes.txt', 'not a message');

  drop.drain();

  assert.equal(existsSync(bad), false);
  assert.equal(existsSync(incomplete), false);
  assert.equal(existsSync(huge), false);
  assert.equal(existsSync(ignored), true, 'only .json files are mail');
  assert.equal(mail.unread('hamachi-coordinator').length, 0);
  assert.ok(readdirSync(join(root, 'hamachi-engineer1')).includes('notes.txt'));
});

test('a directory nobody minted sends nothing, and keeps its files', () => {
  const { drop, mail, write, root } = board();
  const path = write('hamachi-coordinator-impostor', 'a.json', {
    to: 'hamachi-coordinator',
    body: 'let me in',
  });

  drop.drain();

  assert.equal(mail.unread('hamachi-coordinator').length, 0);
  assert.equal(existsSync(path), true, 'evidence is not ours to delete');
  assert.ok(readdirSync(root).includes('hamachi-coordinator-impostor'));
});

test('a new agent gets a directory without a restart', () => {
  const { drop, root, add } = board();
  add('hamachi-researcher0', 'researcher');

  drop.syncDirectories();

  assert.ok(readdirSync(root).includes('hamachi-researcher0'));
});
