import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { buildMailServer, buildMailTools, renderMail } from '../dist/mail-tool.js';

function board() {
  const path = join(mkdtempSync(join(tmpdir(), 'clawsky-tool-')), 'clawcius.db');
  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);

  const add = (id, role, crew = 'hamachi') =>
    registry.ensure(id, { crew, role, workspacePath: `/w/${id}` });

  add('hamachi-coordinator', 'coordinator');
  add('hamachi-engineer1', 'engineer');
  add('hamachi-poster', 'poster');
  add('clawcius-engineer1', 'engineer', 'clawcius');

  /** The tools one session gets, as that session's agent. */
  const sessionOf = (agentId) => {
    const tools = buildMailTools(mail, agentId, 'hamachi-host');
    return Object.fromEntries(tools.map((t) => [t.name, t]));
  };

  return { registry, mail, sessionOf };
}

/** What the model reads back out of a tool result. */
const said = (result) => result.content.map((part) => part.text).join('\n');

test('the mail server builds as an in-process SDK server carrying both tools', () => {
  const { registry, mail } = board();

  const servers = buildMailServer(mail, 'hamachi-engineer1', 'hamachi-host');

  assert.equal(servers.clawsky.type, 'sdk');
  assert.equal(servers.clawsky.name, 'clawsky');
  assert.ok(servers.clawsky.instance);

  const names = buildMailTools(mail, 'hamachi-engineer1', 'hamachi-host').map((t) => t.name);
  assert.deepEqual(names, ['checkMail', 'sendMail']);
  registry.close();
});

test('the author is the session the tool was built for, whatever the arguments say', async () => {
  const { registry, mail, sessionOf } = board();
  const { sendMail } = sessionOf('hamachi-engineer1');

  const result = await sendMail.handler(
    {
      to: 'hamachi-coordinator',
      subject: 'a favour',
      body: 'look at this',
      from: 'hamachi-poster',
      author: 'hamachi-poster',
      agentId: 'hamachi-poster',
    },
    {},
  );

  assert.equal(result.isError, false);
  const [delivered] = mail.unread('hamachi-coordinator');
  assert.equal(delivered.author, 'hamachi-engineer1');
  registry.close();
});

test('two sessions are two identities, and neither can borrow the other', async () => {
  const { registry, mail, sessionOf } = board();

  const engineer = sessionOf('hamachi-engineer1').sendMail;
  const poster = sessionOf('hamachi-poster').sendMail;
  const post = { to: '*', subject: 'news', body: 'we shipped' };

  // Only a poster may write to the feed; claiming to be one in the arguments changes nothing.
  const refused = await engineer.handler({ ...post, from: 'hamachi-poster' }, {});
  assert.equal(refused.isError, true);
  assert.equal(mail.unread('hamachi-coordinator').length, 0, 'nothing reached the feed');

  const accepted = await poster.handler(post, {});
  assert.equal(accepted.isError, false);

  const inbox = mail.unread('hamachi-engineer1');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'hamachi-poster');
  registry.close();
});

test('a refusal comes back to the sender as an error result', async () => {
  const { registry, sessionOf } = board();
  const { sendMail } = sessionOf('hamachi-engineer1');

  for (const args of [
    { to: 'hamachi-engineer9', subject: 's', body: 'are you there' },
    { to: 'clawcius-engineer1', subject: 's', body: 'hello' },
    { to: '', subject: 's', body: 'hello' },
  ]) {
    const refused = await sendMail.handler(args, {});
    assert.equal(refused.isError, true, args.to);
    assert.ok(said(refused).length > 0, 'and says why');
  }
  registry.close();
});

test('sendMail and checkMail are two halves of one loop', async () => {
  const { registry, mail, sessionOf } = board();

  const sent = await sessionOf('hamachi-coordinator').sendMail.handler(
    { to: 'hamachi-engineer1', subject: 'the release', body: 'ship it' },
    {},
  );
  assert.equal(sent.isError, false);
  assert.equal(mail.unread('hamachi-engineer1').length, 1);

  const read = await sessionOf('hamachi-engineer1').checkMail.handler({}, {});
  assert.match(said(read), /hamachi-coordinator/);
  assert.match(said(read), /the release/);
  assert.match(said(read), /ship it/);

  assert.equal(mail.unread('hamachi-engineer1').length, 0, 'reading marks it read');
  assert.equal(said(await sessionOf('hamachi-engineer1').checkMail.handler({}, {})), renderMail([]));
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
  assert.match(text, /\[DM\] from hamachi-coordinator · 2026-08-14 02:30 PDT/);
  assert.match(text, /subject: the release/);
  assert.match(text, /\[FEED\] from clawcius-poster · 2026-08-14 02:31 PDT/);
  assert.match(text, /we deployed/);
});
