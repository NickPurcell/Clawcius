import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { parse, stringify } from 'yaml';

import { loadAgentConfig } from '../dist/agent-config.js';
import { setConfig } from '../dist/config.js';
import { buildSystemPrompt, buildWakeMessage } from '../dist/prompt.js';

const BASE = resolve('agent-config.base.yaml');

const CHANNEL = ['discord:', "  allowedChannelIds: ['1']"];

/** An instance file in a tmpdir. `extends:` the shipped base unless the lines say otherwise. */
function writeInstance(lines, name = 'agent-config.yaml') {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-'));
  const path = join(dir, name);
  const declared = lines.some((l) => l.startsWith('extends:'));
  writeFileSync(path, [...(declared ? [] : [`extends: ${BASE}`]), ...withChannel(lines), ''].join('\n'));
  return path;
}

/** Every instance needs an allowed channel; add one unless the lines already say. */
function withChannel(lines) {
  if (lines.some((l) => l.includes('allowedChannelIds'))) return lines;
  const at = lines.indexOf('discord:');
  if (at < 0) return [...CHANNEL, ...lines];
  return [...lines.slice(0, at + 1), CHANNEL[1], ...lines.slice(at + 1)];
}

/** The shipped base with `mutate` applied, and an instance beside it extending it. */
function writeLayered(mutate, instanceLines = ['crew: x']) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-base-'));
  const base = parse(readFileSync(BASE, 'utf8'));
  mutate(base);
  writeFileSync(join(dir, 'base.yaml'), stringify(base));
  writeFileSync(join(dir, 'inst.yaml'), ['extends: base.yaml', ...withChannel(instanceLines), ''].join('\n'));
  return join(dir, 'inst.yaml');
}

test('every instance path and identity derives from crew', () => {
  const config = loadAgentConfig(writeInstance(['crew: newcrew']));
  assert.equal(config.container.name, 'newcrew-agent');
  assert.equal(config.container.stateDir, '/var/lib/newcrew');
  assert.equal(config.container.execEnvDir, '/var/lib/newcrew/exec-env');
  assert.equal(config.container.githubTokenDir, '/var/lib/newcrew/github-token');
  assert.equal(config.sessions.workspaceRoot, '/var/lib/newcrew/workspaces');
  assert.equal(config.status.file, '/var/lib/newcrew/waker-status.json');
  assert.equal(config.status.instance, 'newcrew');
  assert.equal(config.git.userName, 'Newcrew');
  assert.equal(config.git.userEmail, 'newcrew@users.noreply.github.com');
  assert.equal(config.clawsky.crew, 'newcrew');
});

test('an instance must name at least one allowed channel', () => {
  assert.throws(() => loadAgentConfig(writeInstance(['crew: x', 'discord:', '  allowedChannelIds: []'])), /allowedChannelIds/);
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-nochannel-'));
  writeFileSync(join(dir, 'inst.yaml'), `extends: ${BASE}\ncrew: x\n`);
  assert.throws(() => loadAgentConfig(join(dir, 'inst.yaml')), /discord/, 'no discord block at all');
  writeFileSync(join(dir, 'inst.yaml'), `extends: ${BASE}\ncrew: x\ndiscord:\n  followUpChannelIds: []\n`);
  assert.throws(() => loadAgentConfig(join(dir, 'inst.yaml')), /allowedChannelIds/, 'a discord block without the key');
});

test('crew is required and must be a short lowercase identifier', () => {
  assert.throws(() => loadAgentConfig(writeInstance(['displayName: X'])), /crew/);
  assert.throws(() => loadAgentConfig(writeInstance(['crew: Not Valid'])), /crew/);
});

test('displayName defaults to the crew capitalised and reaches the prompt and the commit identity', () => {
  assert.equal(loadAgentConfig(writeInstance(['crew: x'])).displayName, 'X');

  const config = loadAgentConfig(writeInstance(['crew: x', 'displayName: Xylophone']));
  const template = parse(readFileSync(BASE, 'utf8')).systemPrompt.append;
  assert.equal(config.systemPrompt.append, template.split('{{Crew}}').join('Xylophone'));
  assert.doesNotMatch(config.systemPrompt.append, /\{\{/);
  assert.equal(config.git.userName, 'Xylophone');
  assert.equal(config.crew, 'x');
});

test('both shipped instance files load, each onto its own state directory', () => {
  const clawcius = loadAgentConfig('agent-config.yaml');
  const hamachi = loadAgentConfig('agent-config.hamachi.yaml');
  assert.equal(clawcius.container.stateDir, '/var/lib/clawcius');
  assert.equal(hamachi.container.stateDir, '/var/lib/hamachi');
  assert.notEqual(clawcius.container.githubTokenDir, hamachi.container.githubTokenDir);
  assert.equal(clawcius.model, hamachi.model);
  assert.deepEqual(clawcius.modelByRole, hamachi.modelByRole);
});

test('an instance file may carry container.enabled, and it defaults to true', () => {
  assert.equal(loadAgentConfig(writeInstance(['crew: x'])).container.enabled, true);
  assert.equal(
    loadAgentConfig(writeInstance(['crew: x', 'container:', '  enabled: false'])).container.enabled,
    false,
  );
  assert.throws(
    () => loadAgentConfig(writeInstance(['crew: x', 'container:', '  enabled: no'])),
    /container\.enabled/,
  );
});

test('an instance file may carry nothing but extends, crew, displayName, discord channels and container.enabled', () => {
  const config = loadAgentConfig(
    writeInstance([
      'crew: x',
      'displayName: Ex',
      'discord:',
      "  allowedChannelIds: ['1']",
      "  followUpChannelIds: ['1', '2']",
      '  alwaysOnChannelIds: []',
      'container:',
      '  enabled: false',
    ]),
  );
  assert.deepEqual(config.discord.allowedChannelIds, ['1']);
  assert.deepEqual(config.discord.followUpChannelIds, ['1', '2']);
  assert.deepEqual(config.discord.alwaysOnChannelIds, []);
  assert.equal(config.discord.followUpWindowSeconds, 300);

  for (const [lines, key] of [
    [['maxTurns: 7'], /maxTurns/],
    [['systemPrompt:', '  append: You are something else.'], /systemPrompt/],
    [['prompts:', '  roleNotice: something else'], /prompts/],
    [['container:', '  name: clawcius-agent'], /container\.name/],
    [['container:', '  stateDir: /srv/x'], /container\.stateDir/],
    [['status:', '  file: /var/lib/x/waker-status.json'], /status/],
    [['git:', '  userName: Someone'], /git/],
    [['discord:', '  followUpWindowSeconds: 1'], /discord\.followUpWindowSeconds/],
    [['sessions:', '  maxConcurrent: 1'], /sessions/],
  ]) {
    const path = writeInstance(['crew: x', ...lines]);
    assert.throws(() => loadAgentConfig(path), key, lines.join(' '));
    assert.throws(() => loadAgentConfig(path), new RegExp(path.replaceAll('/', '\\/')), 'names the file');
  }
});

test('the base may not carry instance identity', () => {
  for (const mutate of [
    (b) => (b.crew = 'someoneelse'),
    (b) => (b.displayName = 'SomeoneElse'),
    (b) => (b.discord.allowedChannelIds = ['1']),
    (b) => (b.container.name = 'someoneelse-agent'),
    (b) => (b.container.stateDir = '/var/lib/someoneelse'),
    (b) => (b.sessions.workspaceRoot = '/var/lib/someoneelse/workspaces'),
    (b) => (b.status.file = '/var/lib/someoneelse/waker-status.json'),
    (b) => (b.git = { userName: 'SomeoneElse' }),
  ]) {
    assert.throws(() => loadAgentConfig(writeLayered(mutate)), /base\.yaml/);
  }
});

test('an instance file must extend the base', () => {
  for (const lines of [['crew: x'], ['extends:', 'crew: x'], ['extends: ""', 'crew: x']]) {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-noext-'));
    const path = join(dir, 'agent-config.yaml');
    writeFileSync(path, [...lines, ''].join('\n'));
    assert.throws(() => loadAgentConfig(path), /instance files must extend the base/);
  }
  assert.throws(() => loadAgentConfig('agent-config.base.yaml'), /instance files must extend the base/);
});

test('extends resolves against the instance file, and a base that itself extends is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-layer-'));
  const base = parse(readFileSync(BASE, 'utf8'));
  base.model = 'from-the-base';
  writeFileSync(join(dir, 'shared.yaml'), stringify(base));
  writeFileSync(join(dir, 'instance.yaml'), `crew: x\nextends: shared.yaml\n${CHANNEL.join('\n')}\n`);
  assert.equal(loadAgentConfig(join(dir, 'instance.yaml')).model, 'from-the-base');

  writeFileSync(join(dir, 'broken.yaml'), `crew: x\nextends: nope.yaml\n${CHANNEL.join('\n')}\n`);
  assert.throws(() => loadAgentConfig(join(dir, 'broken.yaml')), /nope\.yaml/);

  writeFileSync(join(dir, 'middle.yaml'), 'extends: shared.yaml\nmodel: m\n');
  writeFileSync(join(dir, 'chained.yaml'), `crew: x\nextends: middle.yaml\n${CHANNEL.join('\n')}\n`);
  assert.throws(() => loadAgentConfig(join(dir, 'chained.yaml')), /middle\.yaml/);
});

test('a base error names the base file and the key', () => {
  for (const [mutate, key] of [
    [(b) => (b.maxTurns = 'nope'), /base\.yaml: maxTurns/],
    [(b) => delete b.model, /base\.yaml: model/],
    [(b) => (b.discord.bundleMaxWaitMs = b.discord.bundleDebounceMs - 1), /base\.yaml: discord\.bundleMaxWaitMs/],
    [(b) => (b.armed.github.repo = 'not-a-repo'), /base\.yaml: armed\.github\.repo/],
    [(b) => (b.clawsky.agents = [{ id: 'wrongprefix', role: 'engineer' }]), /base\.yaml: clawsky\.agents/],
    [(b) => (b.clawsky.agents = [{ id: 'x-thing', role: 'sousaphonist' }]), /base\.yaml: clawsky\.agents\[0\]\.role/],
  ]) {
    assert.throws(() => loadAgentConfig(writeLayered(mutate)), key);
  }
});

test('an unknown {{placeholder}} in the system prompt fails the boot; single braces are prose', () => {
  assert.throws(
    () => loadAgentConfig(writeLayered((b) => (b.systemPrompt.append = 'You are {{crew}}.'))),
    /systemPrompt\.append uses unknown placeholder \{\{crew\}\}/,
  );
  const config = loadAgentConfig(
    writeLayered((b) => (b.systemPrompt.append = 'POST /repos/{owner}/{repo}/issues/{n}/labels')),
  );
  assert.equal(config.systemPrompt.append, 'POST /repos/{owner}/{repo}/issues/{n}/labels');
});

test('an unknown {placeholder} in a prompt template fails the boot', () => {
  assert.throws(
    () => loadAgentConfig(writeLayered((b) => (b.prompts.roleNotice = 'You are {nope}'))),
    /prompts\.roleNotice uses unknown placeholder \{nope\}/,
  );
  assert.throws(
    () => loadAgentConfig(writeLayered((b) => (b.prompts.messageWake = '{count} {plural} for {id}'))),
    /prompts\.messageWake uses unknown placeholder \{id\}/,
  );
  assert.equal(
    loadAgentConfig(writeLayered((b) => (b.prompts.roleNotice = 'You are {id} of {crew}'))).prompts.roleNotice,
    'You are {id} of {crew}',
  );
});

test('a trusted path inside or equal to a bind mount is refused', () => {
  // status.file, execEnvDir and githubTokenDir all live under /var/lib/x.
  for (const [mutate, what] of [
    [(b) => (b.paths.skillsDir = '/var/lib/x'), /status\.file .* is inside paths\.skillsDir/],
    [(b) => (b.paths.skillsDir = '/var/lib/x/github-token'), /container\.githubTokenDir .* is inside paths\.skillsDir/],
    [(b) => (b.paths.discordCli = '/var/lib/x/exec-env/discord'), /container\.execEnvDir .* is inside .*paths\.discordCli/],
    [(b) => (b.paths.discordCli = '/var/lib/x/discord'), /is inside/],
  ]) {
    assert.throws(() => loadAgentConfig(writeLayered(mutate)), what);
  }

  // A near-miss prefix is not containment.
  const config = loadAgentConfig(
    writeLayered((b) => {
      b.paths.skillsDir = '/var/lib/x-ops';
      b.paths.discordCli = '/var/lib/x-run/discord';
    }),
  );
  assert.equal(config.paths.skillsDir, '/var/lib/x-ops');
  assert.equal(config.container.execEnvDir, '/var/lib/x/exec-env');
});

test('modelByRole accepts the crew roles and refuses anything else', () => {
  const config = loadAgentConfig(
    writeLayered((b) => (b.modelByRole = { coordinator: 'a', engineer: 'b', researcher: 'c', poster: 'd', updater: 'e' })),
  );
  assert.equal(config.modelByRole.updater, 'e');
  assert.equal(config.modelByRole.coordinator, 'a');

  assert.deepEqual(loadAgentConfig(writeLayered((b) => (b.modelByRole = {}))).modelByRole, {});

  assert.throws(
    () => loadAgentConfig(writeLayered((b) => (b.modelByRole = { updaters: 'some-model' }))),
    /modelByRole\.updaters/,
  );
  for (const value of ['', [], {}]) {
    assert.throws(
      () => loadAgentConfig(writeLayered((b) => (b.modelByRole = { updater: value }))),
      /modelByRole\.updater/,
    );
  }
});

// ── identity at session initialization ──────────────────────────────────────

function withRealPrompts() {
  setConfig({
    discord: { token: 'u', guildId: 'u' },
    github: { token: '', appId: '' },
    storage: { dbPath: 'u' },
    agent: loadAgentConfig(writeInstance(['crew: x'])),
  });
}

test('each role is told its own role and id', () => {
  withRealPrompts();
  const text = (identity) => {
    const sp = buildSystemPrompt(identity);
    return typeof sp === 'string' ? sp : sp.append;
  };

  for (const role of ['coordinator', 'engineer', 'researcher', 'poster', 'updater']) {
    const out = text({ id: `hamachi-${role}1`, crew: 'hamachi', role });
    assert.match(out, new RegExp('`hamachi-' + role + '1`'), `${role} id missing`);
    assert.match(out, new RegExp('`' + role + '`'), `${role} not named`);
  }
});

test('an unrecognised role is named as unrecognised, not passed off as real', () => {
  withRealPrompts();
  const sp = buildSystemPrompt({ id: 'hamachi-x1', crew: 'hamachi', role: 'sousaphonist' });
  const out = typeof sp === 'string' ? sp : sp.append;
  assert.match(out, /sousaphonist/);
  assert.doesNotMatch(out, /<sousaphonist/);
});

test('the wake carries the messages, the channel and the latest message id', () => {
  withRealPrompts();
  const out = String(
    buildWakeMessage({
      kind: 'messages',
      channelId: 'C1',
      messages: [
        { at: Date.now(), authorTag: 'nick', authorId: 'u1', messageId: 'm1', content: 'hi there' },
      ],
    }),
  );
  assert.match(out, /hi there/);
  assert.match(out, /C1/);
  assert.match(out, /m1/);
});
