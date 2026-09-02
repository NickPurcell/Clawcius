import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry } from '../dist/store.js';
import { MailStore } from '../dist/mail.js';
import { MailWaker } from '../dist/mail-wake.js';

/** A hamachi board with two coordinators (one dead), an engineer, and a spool root with both crews' boxes. */
function board() {
  const dir = mkdtempSync(join(tmpdir(), 'clawsky-alias-'));
  const registry = new AgentRegistry(join(dir, 'hamachi.db'), { crew: 'hamachi' });
  const spoolRoot = join(dir, 'spool');
  mkdirSync(join(spoolRoot, 'hamachi'), { recursive: true });
  mkdirSync(join(spoolRoot, 'clawcius'), { recursive: true });
  const mail = new MailStore(registry, { spoolRoot });
  const add = (id, role, extra = {}) =>
    registry.ensure(id, { crew: 'hamachi', role, workspacePath: `/w/${id}`, ...extra });
  add('111', 'coordinator');
  add('222', 'coordinator');
  add('hamachi-engineer1', 'engineer', { spawnedBy: '111' });
  add('hamachi-coordinator-old', 'coordinator');
  registry.setStatus('hamachi-coordinator-old', 'dead');
  return { registry, mail, spoolRoot };
}

test('<crew>-coordinator for your own crew reaches every live coordinator and nobody else', () => {
  const { registry, mail } = board();
  const result = mail.deliver({ author: 'hamachi-engineer1', recipient: 'hamachi-coordinator', subject: 's', body: 'b' });
  assert.equal(result.accepted, true, result.detail);
  assert.equal(mail.unread('111').length, 1);
  assert.equal(mail.unread('222').length, 1);
  assert.equal(mail.unread('hamachi-coordinator-old').length, 0);
  assert.equal(mail.unread('hamachi-engineer1').length, 0);
  registry.close();
});

test('a crew with no live coordinator refuses the alias', () => {
  const { registry, mail } = board();
  registry.setStatus('111', 'dead');
  registry.setStatus('222', 'dead');
  const result = mail.deliver({ author: 'hamachi-engineer1', recipient: 'hamachi-coordinator', subject: 's', body: 'b' });
  assert.equal(result.accepted, false);
  registry.close();
});

test("another crew's coordinator is a file in that crew's spool, from a coordinator only", () => {
  const { registry, mail, spoolRoot } = board();
  const refused = mail.deliver({ author: 'hamachi-engineer1', recipient: 'clawcius-coordinator', subject: 's', body: 'b' });
  assert.equal(refused.accepted, false);
  assert.deepEqual(readdirSync(join(spoolRoot, 'clawcius')), []);

  const result = mail.deliver({ author: '111', recipient: 'clawcius-coordinator', subject: 'please', body: 'restart x' });
  assert.equal(result.accepted, true, result.detail);
  const [name] = readdirSync(join(spoolRoot, 'clawcius'));
  const record = JSON.parse(readFileSync(join(spoolRoot, 'clawcius', name), 'utf8'));
  assert.equal(record.author, 'hamachi-coordinator', 'the reply address is the alias, not a channel id');
  assert.equal(record.body, 'restart x');

  const nowhere = mail.deliver({ author: '111', recipient: 'nosuch-coordinator', subject: 's', body: 'b' });
  assert.equal(nowhere.accepted, false);
  registry.close();
});

test('the sweep imports the spool: one copy per live coordinator, file removed, turn started; junk is dropped', () => {
  const { registry, mail, spoolRoot } = board();
  const own = join(spoolRoot, 'hamachi');
  writeFileSync(join(own, '1-a.json'), JSON.stringify({ author: 'clawcius-coordinator', subject: 'hi', body: 'from next door', sentAt: 5 }));
  writeFileSync(join(own, '2-b.json'), 'not json');
  const started = [];
  const waker = new MailWaker({
    crew: 'hamachi',
    registry,
    mail,
    busy: () => false,
    start: (agent) => started.push(agent.id),
    log: () => {},
  });
  mail.onDelivered = (m) => waker.onDelivered(m.recipient);

  waker.sweep();
  assert.equal(readdirSync(own).length, 0, 'both files are gone');
  assert.equal(mail.unread('111')[0].author, 'clawcius-coordinator');
  assert.equal(mail.unread('222')[0].body, 'from next door');
  assert.deepEqual(started.sort(), ['111', '222']);
  assert.equal(existsSync(join(own, '2-b.json')), false);
  registry.close();
});
