/**
 * The checkMail tool.
 *
 * The interesting half — that the tool reaches the agent at all — cannot be
 * tested without a container and a live session, so what is checked here is
 * the half that can be: the server builds against the SDK's current API, and
 * the rendering an agent actually reads says who sent what.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { buildMailServer, renderMail } from '../dist/mail-tool.js';

test('the mail server builds as an in-process SDK server', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'clawsky-tool-')), 'clawcius.db');
  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);

  const servers = buildMailServer(mail, 'hamachi-engineer1', '/drop/hamachi-engineer1');

  assert.equal(servers.clawsky.type, 'sdk');
  assert.equal(servers.clawsky.name, 'clawsky');
  assert.ok(servers.clawsky.instance, 'the SDK needs a live server instance, not a config stub');
  registry.close();
});

test('an empty inbox says so rather than returning nothing', () => {
  assert.equal(renderMail([]), 'No mail.');
});

test('rendering names the sender and distinguishes a DM from the feed', () => {
  const text = renderMail([
    {
      id: 1,
      author: 'hamachi-coordinator',
      recipient: 'hamachi-engineer1',
      subject: 'the release',
      body: 'ship it',
      sentAt: Date.UTC(2026, 7, 14, 9, 30, 0),
    },
    {
      id: 2,
      author: 'clawcius-poster',
      recipient: '*',
      subject: '',
      body: 'we deployed',
      sentAt: Date.UTC(2026, 7, 14, 9, 31, 0),
    },
  ]);

  assert.match(text, /^2 messages\./);
  assert.match(text, /\[DM\] from hamachi-coordinator · 2026-08-14 09:30:00Z/);
  assert.match(text, /subject: the release/);
  assert.match(text, /\[FEED\] from clawcius-poster · 2026-08-14 09:31:00Z/);
  assert.match(text, /we deployed/);
});
