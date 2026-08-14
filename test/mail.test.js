/**
 * Mail policy and delivery.
 *
 * The feed's write restriction is the one rule that has to be right on the
 * first commit — it is far harder to add to a board that has already had five
 * writers than to start with — so most of this file is about who is refused.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';

function board() {
  const path = join(mkdtempSync(join(tmpdir(), 'clawsky-mail-')), 'clawcius.db');
  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);

  const add = (id, role, crew = 'hamachi') =>
    registry.ensure(id, { crew, role, workspacePath: `/w/${id}` });

  add('hamachi-coordinator', 'coordinator');
  add('hamachi-engineer1', 'engineer');
  add('hamachi-poster', 'poster');
  add('clawcius-engineer1', 'engineer', 'clawcius');

  return { registry, mail, add };
}

const note = (author, recipient, body = 'hello') => ({
  author,
  recipient,
  subject: 's',
  body,
});

test('a DM reaches its recipient and nobody else', () => {
  const { mail } = board();
  assert.equal(mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1')).accepted, true);

  assert.equal(mail.unread('hamachi-engineer1').length, 1);
  assert.equal(mail.unread('hamachi-poster').length, 0);
  assert.equal(
    mail.unread('hamachi-coordinator').length,
    0,
    'the sender already has it in its own transcript',
  );
});

test('only a poster may write to the feed', () => {
  const { mail } = board();

  for (const sender of ['hamachi-coordinator', 'hamachi-engineer1']) {
    const result = mail.deliver(note(sender, '*'));
    assert.equal(result.accepted, false);
    assert.match(result.detail, /only a poster/);
  }

  assert.equal(mail.deliver(note('hamachi-poster', '*')).accepted, true);
});

test('a feed post reaches every agent except its author', () => {
  const { mail } = board();
  mail.deliver(note('hamachi-poster', '*'));

  assert.equal(mail.unread('hamachi-coordinator').length, 1);
  assert.equal(mail.unread('hamachi-engineer1').length, 1);
  assert.equal(
    mail.unread('hamachi-poster').length,
    0,
    'a poster reading back its own broadcast is noise, not mail',
  );
});

test('an agent does not inherit the feed from before it existed', async () => {
  const { mail, add } = board();
  mail.deliver(note('hamachi-poster', '*', 'old news'));
  // spawnedAt is milliseconds; without a gap the post and the agent share one.
  await new Promise((resolve) => setTimeout(resolve, 5));
  add('hamachi-researcher0', 'researcher');

  assert.equal(mail.unread('hamachi-researcher0').length, 0);
  mail.deliver(note('hamachi-poster', '*', 'new news'));
  assert.equal(mail.unread('hamachi-researcher0').length, 1);
});

test('a DM from an agent to itself is delivered — that is what a wake will be', () => {
  const { mail } = board();
  mail.deliver(note('hamachi-engineer1', 'hamachi-engineer1', 'remember the release'));

  const inbox = mail.unread('hamachi-engineer1');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].body, 'remember the release');
});

test('unknown senders and recipients are refused', () => {
  const { mail } = board();

  assert.match(mail.deliver(note('nobody', 'hamachi-engineer1')).detail, /unknown sender/);
  assert.match(mail.deliver(note('hamachi-engineer1', 'nobody')).detail, /unknown recipient/);
  assert.match(mail.deliver(note('hamachi-engineer1', '', 'x')).detail, /unknown recipient/);
});

test('a DM does not cross a crew boundary', () => {
  const { mail } = board();
  const result = mail.deliver(note('hamachi-engineer1', 'clawcius-engineer1'));

  assert.equal(result.accepted, false);
  assert.match(result.detail, /crews talk on the feed/);
});

test('an empty body is not a message', () => {
  const { mail } = board();
  assert.equal(mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', '   ')).accepted, false);
});

test('collect delivers everything at once and marks it read', () => {
  const { mail } = board();
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'one'));
  mail.deliver(note('hamachi-poster', '*', 'two'));
  mail.deliver(note('hamachi-coordinator', 'hamachi-engineer1', 'three'));

  const first = mail.collect('hamachi-engineer1');
  assert.deepEqual(
    first.map((m) => m.body),
    ['one', 'two', 'three'],
    'oldest first, no paging, no priority ordering',
  );

  assert.equal(mail.collect('hamachi-engineer1').length, 0);
  assert.equal(
    mail.unread('hamachi-coordinator').length,
    1,
    'one agent reading the feed must not mark it read for another',
  );
});

test('reading is per agent, so mail survives an unrelated reader', () => {
  const { mail } = board();
  mail.deliver(note('hamachi-poster', '*', 'board news'));

  mail.collect('hamachi-coordinator');
  assert.equal(mail.unread('hamachi-engineer1').length, 1);
});
