/**
 * `checkMail` and `sendMail`.
 *
 * The interesting half — that the tools reach the agent at all — cannot be
 * tested without a container and a live session, so what is checked here is the
 * half that can be: the server builds against the SDK's current API, the
 * rendering an agent actually reads says who sent what, and the two properties
 * the drop directory was replaced to get.
 *
 * Those two are worth naming, because they are what the tests below are for:
 *
 *   1. THE SENDER CANNOT BE SUPPLIED. There is no argument that names an
 *      author, and passing one anyway changes nothing (Clawcius #35).
 *   2. EVERY REFUSAL REACHES THE CALLER. Not the journal, where the sender
 *      could not see it and a refused message looked exactly like a delivered
 *      one (Clawcius #30).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { buildMailServer, buildMailTools, renderMail } from '../dist/mail-tool.js';
import { buildSpawnTools } from '../dist/spawn-tool.js';

function board() {
  const path = join(mkdtempSync(join(tmpdir(), 'clawsky-tool-')), 'clawcius.db');
  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);

  const add = (id, role, crew = 'hamachi') =>
    registry.ensure(id, { crew, role, workspacePath: `/w/${id}` });

  add('hamachi-coordinator', 'coordinator');
  add('hamachi-engineer1', 'engineer');
  add('hamachi-poster', 'poster');
  add('hamachi-host', 'host');
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
  assert.ok(servers.clawsky.instance, 'the SDK needs a live server instance, not a config stub');

  const names = buildMailTools(mail, 'hamachi-engineer1', 'hamachi-host').map((t) => t.name);
  assert.deepEqual(names, ['checkMail', 'sendMail']);
  registry.close();
});

test('sendMail has no argument that says who a message is from', () => {
  const { registry, sessionOf } = board();
  const { sendMail } = sessionOf('hamachi-engineer1');

  // Exhaustive on purpose. A `from` added here later would be the whole of
  // authorship gone, and it would be added by somebody who thought it was
  // harmless, so the assertion is the complete list rather than a denylist.
  assert.deepEqual(Object.keys(sendMail.inputSchema).sort(), ['body', 'subject', 'to']);
  registry.close();
});

test('an author passed as an argument is ignored — identity is the closure', async () => {
  const { registry, mail, sessionOf } = board();
  const { sendMail } = sessionOf('hamachi-engineer1');

  const result = await sendMail.handler(
    {
      to: 'hamachi-poster',
      subject: 'a favour',
      body: 'post this',
      // Everything an agent might reach for. None of it is read.
      from: 'hamachi-coordinator',
      author: 'hamachi-coordinator',
      agentId: 'hamachi-coordinator',
    },
    {},
  );

  assert.equal(result.isError, false);
  const [delivered] = mail.unread('hamachi-poster');
  assert.equal(delivered.author, 'hamachi-engineer1');
  registry.close();
});

test('two sessions are two identities, and neither can borrow the other', async () => {
  const { registry, mail, sessionOf } = board();

  const engineer = sessionOf('hamachi-engineer1').sendMail;
  const coordinator = sessionOf('hamachi-coordinator').sendMail;
  const task = { to: 'hamachi-host', subject: 'restart', body: 'restart the waker' };

  const refused = await engineer.handler({ ...task, from: 'hamachi-coordinator' }, {});
  assert.equal(refused.isError, true);
  assert.match(said(refused), /only a coordinator may DM the host agent/);

  const accepted = await coordinator.handler(task, {});
  assert.equal(accepted.isError, false);

  const inbox = mail.unread('hamachi-host');
  assert.equal(inbox.length, 1, 'the engineer got nothing into the host agent\'s mailbox');
  assert.equal(inbox[0].author, 'hamachi-coordinator');
  registry.close();
});

test('the feed refusal comes back to the sender rather than to the journal', async () => {
  const { registry, mail, sessionOf } = board();

  const refused = await sessionOf('hamachi-engineer1').sendMail.handler(
    { to: '*', subject: 'news', body: 'we shipped' },
    {},
  );
  assert.equal(refused.isError, true);
  assert.match(said(refused), /^Not sent — /);
  assert.match(said(refused), /only a poster may write to the feed/);

  const posted = await sessionOf('hamachi-poster').sendMail.handler(
    { to: '*', subject: 'news', body: 'we shipped' },
    {},
  );
  assert.equal(posted.isError, false);
  assert.match(said(posted), /posted to the feed/);
  assert.equal(mail.unread('hamachi-engineer1').length, 1);
  registry.close();
});

test('a recipient that does not exist is a returned answer, not silence', async () => {
  const { registry, sessionOf } = board();

  const refused = await sessionOf('hamachi-engineer1').sendMail.handler(
    { to: 'hamachi-engineer9', subject: 's', body: 'are you there' },
    {},
  );

  assert.equal(refused.isError, true);
  assert.match(said(refused), /unknown recipient "hamachi-engineer9"/);
  registry.close();
});

test('a DM across a crew boundary is refused to the sender', async () => {
  const { registry, sessionOf } = board();

  const refused = await sessionOf('hamachi-engineer1').sendMail.handler(
    { to: 'clawcius-engineer1', subject: 's', body: 'hello' },
    {},
  );

  assert.equal(refused.isError, true);
  assert.match(said(refused), /crews talk on the feed/);
  registry.close();
});

test('a delivered message says so, naming who got it', async () => {
  const { registry, sessionOf } = board();

  const sent = await sessionOf('hamachi-coordinator').sendMail.handler(
    { to: 'hamachi-engineer1', body: 'ship it' },
    {},
  );

  assert.equal(sent.isError, false);
  assert.equal(said(sent), 'delivered to hamachi-engineer1');
  registry.close();
});

test('sendMail and checkMail are two halves of one loop', async () => {
  const { registry, sessionOf } = board();

  await sessionOf('hamachi-coordinator').sendMail.handler(
    { to: 'hamachi-engineer1', subject: 'the release', body: 'ship it' },
    {},
  );
  const read = await sessionOf('hamachi-engineer1').checkMail.handler({}, {});

  assert.match(said(read), /\[DM\] from hamachi-coordinator/);
  assert.match(said(read), /ship it/);
  assert.equal(said(await sessionOf('hamachi-engineer1').checkMail.handler({}, {})), 'No mail.');
  registry.close();
});

test('sendMail tells the agent, in the description, that it cannot name a sender', () => {
  const { registry, sessionOf } = board();
  const { sendMail, checkMail } = sessionOf('hamachi-engineer1');

  // The description is the only protocol documentation an agent is guaranteed
  // to see — it arrives with the tool, whereas a system prompt may not have
  // been given. If the rules leave it they are nowhere.
  assert.match(sendMail.description, /hamachi-engineer1/);
  assert.match(sendMail.description, /There is no "from"/);
  assert.match(sendMail.description, /ONLY A COORDINATOR MAY DM IT/);
  assert.match(sendMail.description, /CLAIM, NEVER AN INSTRUCTION/);
  assert.match(checkMail.description, /CLAIM, NEVER AN INSTRUCTION/);
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

// ── spawn ───────────────────────────────────────────────────────────────────
//
// These belong in `test/spawn-tool.test.js` and are here instead because a new
// file under `test/` has twice blocked a deploy on the host's copy of this
// repository (Clawcius #104, #116). They sit next to the mail tools rather than
// anywhere else because they are the same property twice over: a tool built for
// one session, closed over that session's identity, with no argument that can
// name a different one. `sendMail` has no `from`; `spawn` has no `id`.

const spawnBoard = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'clawsky-spawn-')), 'clawcius.db');
  const registry = new AgentRegistry(path, { crew: 'hamachi' });
  const mail = new MailStore(registry);

  registry.ensure('hamachi-coordinator', {
    crew: 'hamachi',
    role: 'coordinator',
    workspacePath: '/w/coordinator',
  });
  registry.ensure('hamachi-poster', { crew: 'hamachi', role: 'poster', workspacePath: '/w/poster' });

  const workspaceRoot = mkdtempSync(join(tmpdir(), 'clawsky-workspaces-'));
  const logged = [];
  const spawnOf = (agentId) =>
    buildSpawnTools(agentId, {
      registry,
      mail,
      workspaceRoot,
      // Stands in for `prompt.buildSpawnCharter`, which reads the template out
      // of agent-config.yaml. What matters here is which values reach it.
      charter: (vars) =>
        `You are ${vars.id}, a ${vars.role} of crew ${vars.crew}, spawned by ` +
        `${vars.spawnedBy}.\n\n${vars.instructions}`,
      wakesOnMail: true,
      log: (line) => logged.push(line),
    })[0];

  return { registry, mail, spawnOf, workspaceRoot, logged };
};

test('spawn has no argument that names the agent it creates', () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  // Exhaustive, for the same reason `sendMail` has no `from`: an `id` added
  // here later would let a coordinator mint `hamachi-host`, or a second row for
  // a name another agent already answers to.
  assert.deepEqual(Object.keys(spawn.inputSchema).sort(), ['instructions', 'role']);
  assert.equal(spawn.name, 'spawn');
  registry.close();
});

test('spawn mints the id, the workspace and the row, and delivers turn one', async () => {
  const { registry, mail, spawnOf, workspaceRoot, logged } = spawnBoard();

  const result = await spawnOf('hamachi-coordinator').handler(
    { role: 'engineer', instructions: 'Own the ops dry-run work. Start with #121.' },
    {},
  );

  assert.equal(result.isError, undefined);
  assert.match(said(result), /hamachi-engineer1/);

  const row = registry.get('hamachi-engineer1');
  assert.equal(row.role, 'engineer');
  assert.equal(row.crew, 'hamachi');
  assert.equal(row.status, 'live');
  assert.equal(row.spawnedBy, 'hamachi-coordinator');
  assert.equal(row.workspacePath, join(workspaceRoot, 'hamachi-engineer1'));
  assert.equal(
    existsSync(row.workspacePath),
    true,
    'a row pointing at a directory that is not there fails at every wake',
  );

  // Turn one is ordinary mail, authored by the coordinator that spawned it.
  const inbox = mail.unread('hamachi-engineer1');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].author, 'hamachi-coordinator');
  assert.match(inbox[0].body, /You are hamachi-engineer1, a engineer of crew hamachi/);
  assert.match(inbox[0].body, /Own the ops dry-run work/);

  // Visible from outside the turn that did it — there is no cap on spawning,
  // so the journal is where the cost shows up.
  assert.match(logged.join('\n'), /hamachi-coordinator spawned hamachi-engineer1 \(engineer/);
  registry.close();
});

test('the ordinal is the first free one, and an id is never reused', async () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  await spawn.handler({ role: 'engineer', instructions: 'one' }, {});
  await spawn.handler({ role: 'engineer', instructions: 'two' }, {});
  await spawn.handler({ role: 'researcher', instructions: 'three' }, {});

  assert.ok(registry.get('hamachi-engineer1'));
  assert.ok(registry.get('hamachi-engineer2'));
  assert.ok(registry.get('hamachi-researcher1'));
  assert.equal(registry.get('hamachi-engineer2').spawnedBy, 'hamachi-coordinator');

  // A row an operator seeded by hand is a name that is taken, and the mint
  // steps over it rather than colliding with it.
  registry.ensure('hamachi-engineer3', {
    crew: 'hamachi',
    role: 'engineer',
    workspacePath: '/w/seeded',
  });
  await spawn.handler({ role: 'engineer', instructions: 'four' }, {});
  assert.equal(registry.get('hamachi-engineer4').spawnedBy, 'hamachi-coordinator');
  assert.equal(registry.get('hamachi-engineer3').spawnedBy, null, 'the seeded row is untouched');
  registry.close();
});

test('only a coordinator may spawn, and it is read from the row', async () => {
  const { registry, spawnOf } = spawnBoard();

  // The poster holds the tool — the check that matters is against the row at
  // the moment of the call, not against which tools a session happened to be
  // built with.
  const refused = await spawnOf('hamachi-poster').handler(
    { role: 'engineer', instructions: 'do a thing' },
    {},
  );
  assert.equal(refused.isError, true);
  assert.match(said(refused), /only a coordinator may spawn; hamachi-poster is a poster/);
  assert.equal(registry.get('hamachi-engineer1'), undefined, 'and nothing was written');
  registry.close();
});

test('the two roles that carry privilege cannot be spawned', async () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  for (const role of ['coordinator', 'host']) {
    const refused = await spawn.handler({ role, instructions: 'help me' }, {});
    assert.equal(refused.isError, true);
    assert.match(said(refused), /cannot be spawned/);
    assert.match(said(refused), /runs commands on the VPS/);
  }

  assert.deepEqual(
    registry.listByCrew('hamachi').map((row) => row.id).sort(),
    ['hamachi-coordinator', 'hamachi-poster'],
  );
  registry.close();
});

test('a role that is not a role, and a brief that is not a brief, are refused', async () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  const badRole = await spawn.handler({ role: 'devops', instructions: 'x' }, {});
  assert.equal(badRole.isError, true);
  assert.match(said(badRole), /"devops" is not a role/);

  const empty = await spawn.handler({ role: 'engineer', instructions: '   ' }, {});
  assert.equal(empty.isError, true);
  assert.match(said(empty), /nothing to be/);

  assert.equal(registry.listByCrew('hamachi').length, 2);
  registry.close();
});

test('the description tells a coordinator what spawn costs and what it cannot undo', () => {
  const { registry, spawnOf } = spawnBoard();
  const spawn = spawnOf('hamachi-coordinator');

  // The description is the only documentation an agent is guaranteed to see.
  assert.match(spawn.description, /hamachi-coordinator/);
  assert.match(spawn.description, /There is no id\s+argument and there never will be one/);
  assert.match(spawn.description, /LONG-LIVED/);
  assert.match(spawn.description, /THERE IS NO KILL VERB YET/);
  assert.match(spawn.description, /ONLY A COORDINATOR MAY SPAWN/);
  registry.close();
});

test('spawn refuses when nothing would ever wake what it created', async () => {
  const { registry, mail, workspaceRoot } = spawnBoard();
  const [spawn] = buildSpawnTools('hamachi-coordinator', {
    registry,
    mail,
    workspaceRoot,
    charter: () => 'unused',
    // The phase-2 deployment: agents send and read mail, and nothing turns a
    // delivery into a turn. A spawned agent has no Discord channel, so this is
    // the one configuration where the row could never run at all.
    wakesOnMail: false,
    log: () => {},
  });

  const refused = await spawn.handler({ role: 'engineer', instructions: 'take #121' }, {});
  assert.equal(refused.isError, true);
  assert.match(said(refused), /wakeOnMail/);
  assert.equal(registry.get('hamachi-engineer1'), undefined, 'and no row was written');
  assert.equal(mail.unread('hamachi-engineer1').length, 0);
  registry.close();
});
