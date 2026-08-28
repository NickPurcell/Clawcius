import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { parse, stringify } from 'yaml';

import { loadAgentConfig } from '../dist/agent-config.js';
import { setConfig } from '../dist/config.js';
import { buildSystemPrompt, buildWakeMessage } from '../dist/prompt.js';
import { buildArmedTools } from '../dist/armed-tool.js';

function writeConfigRaw(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-'));
  const path = join(dir, 'agent-config.yaml');
  const declared = lines.some((l) => l.startsWith('extends:') || l.startsWith('standalone:'));
  writeFileSync(path, [...(declared ? [] : ['standalone: true']), ...lines, ''].join('\n'));
  return path;
}

function writeConfig(lines) {
  return writeConfigRaw(['crew: x', 'container:', ...lines]);
}

function writeUndeclared(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-undeclared-'));
  const path = join(dir, 'agent-config.yaml');
  writeFileSync(path, [...lines, ''].join('\n'));
  return path;
}

/** Absolute, because a fixture in a tmpdir cannot resolve a relative base. */
const BASE = resolve('agent-config.base.yaml');

test('a status file inside the container mount is refused, not just one inside a spool', () => {
  assert.throws(
    () =>
      loadAgentConfig(
        writeConfig([
          '  execEnvDir: /var/lib/x-env',
          'status:',
          '  file: /var/lib/x/run/waker-status.json',
        ]),
      ),
    /status\.file .* is inside .* bind-mounted read-write/,
  );

  assert.throws(
    () =>
      loadAgentConfig(
        writeConfig([
          '  execEnvDir: /var/lib/x-env',
          'status:',
          '  file: /var/lib/x/run/wake/waker-status.json',
        ]),
      ),
    /status\.file .* is inside .* bind-mounted read-write/,
  );
});

test('the default layout loads: every trusted path is a sibling of the mount', () => {
  const config = loadAgentConfig(
    writeConfig([
      '  execEnvDir: /var/lib/x/exec-env',
      'sessions:',
      '  workspaceRoot: /var/lib/x/workspaces',
      'status:',
      '  file: /var/lib/x/waker-status.json',
    ]),
  );
  assert.equal(config.container.stateDir, '/var/lib/x');
  assert.equal(config.status.file, '/var/lib/x/waker-status.json');
});

test('an explicit container.stateDir must still be absolute', () => {

  // Relative: resolves against the WAKER'S cwd, so isInside() compares against a
  // directory that does not exist and everything passes.
  assert.throws(
    () =>
      loadAgentConfig(
        writeConfigRaw(['crew: x', 'container:', '  stateDir: var/lib/x', '  execEnvDir: /var/lib/x-env']),
      ),
    /container\.stateDir .* must be an absolute path/,
  );

  // Empty: same, and it is what a half-finished edit leaves behind.
  assert.throws(
    () =>
      loadAgentConfig(writeConfigRaw(['crew: x', 'container:', '  stateDir: ""', '  execEnvDir: /x-env'])),
    /container\.stateDir is required/,
  );
});

test('crew is required, has no default, and is what every instance path derives from', () => {
  assert.throws(
    () => loadAgentConfig(writeConfigRaw(['container:', '  execEnvDir: /var/lib/x-env'])),
    /crew is required and has no default/,
  );

  // And the nine values that come off it.
  const config = loadAgentConfig(writeConfigRaw(['crew: newcrew']));
  assert.equal(config.container.name, 'newcrew-agent');
  assert.equal(config.container.stateDir, '/var/lib/newcrew');
  assert.equal(config.container.execEnvDir, '/var/lib/newcrew/exec-env');
  assert.equal(config.container.githubTokenDir, '/var/lib/newcrew/github-token');
  assert.equal(config.sessions.workspaceRoot, '/var/lib/newcrew/workspaces');
  assert.equal(config.status.file, '/var/lib/newcrew/waker-status.json');
  assert.equal(config.status.instance, 'newcrew');
  assert.equal(config.git.userName, 'Newcrew');
  assert.equal(config.git.userEmail, 'newcrew@users.noreply.github.com');

  assert.notEqual(config.container.name, 'clawcius-agent');
});

test('displayName defaults to the crew capitalised, and is what the prompt says', () => {
  assert.equal(loadAgentConfig(writeConfigRaw(['crew: x'])).displayName, 'X');
  assert.equal(
    loadAgentConfig(writeConfigRaw(['crew: x', 'displayName: Xylophone'])).displayName,
    'Xylophone',
  );
  // It reaches two places and only two: the prompt, and the commit identity.
  const config = loadAgentConfig(
    writeConfigRaw([
      'crew: x',
      'displayName: Xylophone',
      'systemPrompt:',
      '  append: You are {{Crew}}.',
    ]),
  );
  assert.equal(config.systemPrompt.append, 'You are Xylophone.');
  assert.equal(config.git.userName, 'Xylophone');
  // …while `crew` stays lowercase, because it is compared as an exact string by
  // the ops allowlist and prefixes every agent id.
  assert.equal(config.crew, 'x');
  assert.equal(config.git.userEmail, 'x@users.noreply.github.com');
});

test('both shipped agent configs resolve container.stateDir to their own', () => {
  const clawcius = loadAgentConfig('agent-config.yaml');
  const hamachi = loadAgentConfig('agent-config.hamachi.yaml');
  assert.equal(clawcius.container.stateDir, '/var/lib/clawcius');
  assert.equal(hamachi.container.stateDir, '/var/lib/hamachi');
  assert.notEqual(clawcius.container.stateDir, hamachi.container.stateDir);
});

test('all three read-write mounts are checked, not just the one the spools lived in', () => {
  for (const child of ['run', 'workspaces', 'agent-home']) {
    assert.throws(
      () =>
        loadAgentConfig(
          writeConfig([
            '  execEnvDir: /var/lib/x-env',
            'status:',
            `  file: /var/lib/x/${child}/waker-status.json`,
          ]),
        ),
      /status\.file .* is inside .* which docker\/run-container\.sh bind-mounts/,
      `a status file under ${child}/ must be refused`,
    );
    assert.throws(
      () => loadAgentConfig(writeConfig([`  execEnvDir: /var/lib/x/${child}/exec-env`])),
      /container\.execEnvDir .* is inside/,
      `an exec env directory under ${child}/ must be refused`,
    );
  }
});

test('the exec env directory is refused inside the container mount too', () => {
  // Same list, same rule: both files share one answer to "where can the agent write".
  assert.throws(
    () => loadAgentConfig(writeConfig(['  execEnvDir: /var/lib/x/run/exec-env'])),
    /container\.execEnvDir .* is inside/,
  );
});

test('a near-miss prefix is not containment', () => {
  // /var/lib/x-ops is not inside /var/lib/x, and a naive startsWith says it is.
  const config = loadAgentConfig(
    writeConfig(['  execEnvDir: /var/lib/x-ops/exec-env', 'status:', '  file: /var/lib/x-run/s.json']),
  );
  assert.equal(config.container.execEnvDir, '/var/lib/x-ops/exec-env');
});

// ── Layering: one shared base, one small file per instance ──────────────────

test('the shipped instance files extend the shared base rather than copying it', () => {
  for (const file of ['agent-config.yaml', 'agent-config.hamachi.yaml']) {
    const raw = parse(readFileSync(file, 'utf8'));
    assert.equal(raw.extends, 'agent-config.base.yaml', `${file} must extend the base`);
    assert.ok(raw.crew, `${file} must name its crew`);

    assert.equal(
      raw.sessions,
      undefined,
      `${file} must not override shared session policy — see the comment above`,
    );
  }
});

test('the base prompt renders to each crew, and rendering is the only difference', () => {
  const base = parse(readFileSync('agent-config.base.yaml', 'utf8'));
  const template = base.systemPrompt.append;

  for (const file of ['agent-config.yaml', 'agent-config.hamachi.yaml']) {
    const config = loadAgentConfig(file);
    assert.equal(
      config.systemPrompt.append,
      template.split('{{Crew}}').join(config.displayName),
      `${file}'s prompt must be the shared base with only its own name substituted`,
    );
    assert.doesNotMatch(config.systemPrompt.append, /\{\{/, 'nothing unsubstituted reaches an agent');
  }

});

test('an instance file may not carry prompt content — refused, not ignored', () => {
  for (const [lines, pattern] of [
    [['systemPrompt:', '  append: You are something else.'], /systemPrompt\.append/],
    [['prompts:', '  roleNotice: something else'], /prompts/],
  ]) {
    assert.throws(
      () => loadAgentConfig(writeConfigRaw(['crew: x', `extends: ${BASE}`, ...lines])),
      pattern,
    );
    assert.throws(
      () => loadAgentConfig(writeConfigRaw(['crew: x', `extends: ${BASE}`, ...lines])),
      /does not belong in this file|do not belong in this file/,
    );
  }

  // A non-prompt key in an instance file is fine — that is what instance files
  // are for, and the refusal must be about content rather than about overriding.
  const config = loadAgentConfig(
    writeConfigRaw(['crew: x', `extends: ${BASE}`, 'maxTurns: 7']),
  );
  assert.equal(config.maxTurns, 7);
  assert.match(config.systemPrompt.append, /You are X: a crew of agents/);
});

test('the shared base may not carry instance identity — the inheritance bug, closed', () => {
  const forbidden = [
    ['container:', '  name: someone-elses-agent'],
    ['container:', '  stateDir: /var/lib/someoneelse'],
    ['container:', '  execEnvDir: /var/lib/someoneelse/exec-env'],
    ['container:', '  githubTokenDir: /var/lib/someoneelse/github-token'],
    ['sessions:', '  workspaceRoot: /var/lib/someoneelse/workspaces'],
    ['status:', '  file: /var/lib/someoneelse/waker-status.json'],
    ['status:', '  instance: someoneelse'],
    ['git:', '  userName: SomeoneElse'],
    ['git:', '  userEmail: someoneelse@users.noreply.github.com'],
    ['discord:', "  allowedChannelIds: ['1']"],
    ['discord:', "  followUpChannelIds: ['1']"],
    ['discord:', "  alwaysOnChannelIds: ['1']"],
    ['crew: someoneelse'],
    ['displayName: SomeoneElse'],
    // `standalone` is deliberately NOT in this list: it is refused in a base
    // too, but beside the chain check, with its own message.
  ];
  for (const lines of forbidden) {
    const fakeBase = writeUndeclared(['model: some-model', ...lines]);
    const instance = writeConfigRaw(['crew: x', `extends: ${fakeBase}`]);
    assert.throws(
      () => loadAgentConfig(instance),
      /does not belong in this file|do not belong in this file/,
      `a base carrying ${lines.join(' ')} must be refused`,
    );
  }
});

test('clawsky.crew is refused wherever it appears, because the key moved', () => {
  // A key left working under its old name is a second place to write the crew name.
  assert.throws(
    () => loadAgentConfig(writeConfigRaw(['crew: x', 'clawsky:', '  crew: y'])),
    /clawsky\.crew moved to the top level as `crew`/,
  );
});

test('extends resolves against the instance file, and chains are refused', () => {
  // Against the INSTANCE FILE's directory, not the process's cwd: systemd hands the waker a WorkingDirectory it did not choose.
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-layer-'));
  writeFileSync(join(dir, 'shared.yaml'), 'model: from-the-base\n');
  writeFileSync(join(dir, 'instance.yaml'), 'crew: x\nextends: shared.yaml\n');
  assert.equal(loadAgentConfig(join(dir, 'instance.yaml')).model, 'from-the-base');

  // A missing base names the path rather than falling back to defaults, which
  // would be a crew booting on somebody's idea of a sensible prompt.
  writeFileSync(join(dir, 'broken.yaml'), 'crew: x\nextends: nope.yaml\n');
  assert.throws(() => loadAgentConfig(join(dir, 'broken.yaml')), /Base config named by `extends` not found/);

  writeFileSync(join(dir, 'middle.yaml'), 'extends: shared.yaml\nmodel: m\n');
  writeFileSync(join(dir, 'chained.yaml'), 'crew: x\nextends: middle.yaml\n');
  assert.throws(() => loadAgentConfig(join(dir, 'chained.yaml')), /chains are not supported/);

  writeFileSync(join(dir, 'self.yaml'), 'crew: x\nextends: self.yaml\n');
  assert.throws(() => loadAgentConfig(join(dir, 'self.yaml')), /cannot point at the file itself/);
});

test('an unknown {{placeholder}} fails the boot instead of reaching an agent', () => {
  // The same bargain `prompts.*` templates already make, and for the same
  // reason: a literal `{{crew}}` shipped into 24kB of prose is a sentence that
  // reads as broken to every agent that gets it, with nothing said at boot.
  assert.throws(
    () =>
      loadAgentConfig(
        writeConfigRaw(['crew: x', 'systemPrompt:', '  append: You are {{crew}}.']),
      ),
    /systemPrompt\.append uses unknown placeholder \{\{crew\}\}/,
  );

  // Single braces are prose and are left entirely alone — no validation, no
  // substitution. This is the whole reason the delimiter is doubled.
  const config = loadAgentConfig(
    writeConfigRaw(['crew: x', 'systemPrompt:', '  append: "POST /repos/{owner}/{repo}/issues/{n}/labels"']),
  );
  assert.equal(config.systemPrompt.append, 'POST /repos/{owner}/{repo}/issues/{n}/labels');
});

// ── What the mechanism CLAIMS versus what it does ───────────────────────────

test('a derived key is refused in an instance file, not just in the base', () => {
  for (const [lines, key] of [
    [['container:', '  name: clawcius-agent'], 'container\\.name'],
    [['container:', '  stateDir: /var/lib/clawcius'], 'container\\.stateDir'],
    [['status:', '  file: /var/lib/clawcius/waker-status.json'], 'status\\.file'],
    [['git:', '  userName: Clawcius'], 'git\\.userName'],
  ]) {
    assert.throws(
      () => loadAgentConfig(writeConfigRaw(['crew: third', `extends: ${BASE}`, ...lines])),
      new RegExp(`${key} does not belong in this file`),
      `${key} restated in an instance file must be refused`,
    );
  }

  // And the refusal must say the right thing: `container.name` is not prompt content.
  assert.throws(
    () =>
      loadAgentConfig(
        writeConfigRaw(['crew: third', `extends: ${BASE}`, 'container:', '  name: clawcius-agent']),
      ),
    /derives from `crew`/,
  );

  // A STANDALONE file is deliberately unaffected: no shared file, nothing to
  // inherit through, and the containment guards need explicit paths to bite.
  assert.equal(
    loadAgentConfig(writeConfig(['  execEnvDir: /var/lib/x-env'])).container.execEnvDir,
    '/var/lib/x-env',
  );
});

test('a config must DECLARE its mode; silence is an error (#221)', () => {
  assert.throws(
    () => loadAgentConfig(writeUndeclared(['crew: clawcius'])),
    /has no `extends:` and does not declare itself standalone/,
  );
  assert.throws(
    () => loadAgentConfig(writeUndeclared(['crew: clawcius'])),
    /Almost certainly you want:\s+extends: agent-config\.base\.yaml/,
  );
  assert.throws(
    () => loadAgentConfig(writeUndeclared(['crew: clawcius'])),
    /Only if this file really is the whole config:\s+standalone: true/,
  );
  assert.throws(
    () => loadAgentConfig(writeUndeclared(['crew: clawcius'])),
    /NO SYSTEM PROMPT AT ALL[\s\S]*do not take this option to\n\s+make the error go away/,
  );

  // Declaring standalone is the opt-in, and it still works.
  assert.equal(loadAgentConfig(writeConfigRaw(['standalone: true', 'crew: x'])).crew, 'x');

  // Claiming both modes says nothing about which is meant, so it is refused
  // rather than resolved by precedence — a precedence rule here would be a
  // silent choice, which is the whole thing this key exists to stop.
  assert.throws(
    () => loadAgentConfig(writeConfigRaw(['standalone: true', `extends: ${BASE}`, 'crew: x'])),
    /standalone cannot be true in a file that also has `extends:`/,
  );

});

test('every shipped config, minus its extends line, is refused (#221)', () => {
  for (const file of ['agent-config.yaml', 'agent-config.hamachi.yaml']) {
    const real = readFileSync(file, 'utf8');
    assert.match(real, /^extends: /m, `precondition: ${file} uses extends`);

    const dir = mkdtempSync(join(tmpdir(), 'agent-config-221-'));
    const path = join(dir, 'agent-config.yaml');
    writeFileSync(path, real.split('\n').filter((l) => !l.startsWith('extends:')).join('\n'));

    assert.throws(
      () => loadAgentConfig(path),
      /has no `extends:` and does not declare itself standalone/,
      `${file}: deleting one line must not silently produce a crew with no system prompt`,
    );
  }
});

test('a base file may not claim a mode either (#228 note 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-basemode-'));
  writeFileSync(join(dir, 'base.yaml'), 'standalone: true\nmodel: from-the-base\n');
  writeFileSync(join(dir, 'inst.yaml'), 'extends: base.yaml\ncrew: x\n');

  assert.throws(() => loadAgentConfig(join(dir, 'inst.yaml')), /has `standalone:`/);

  const said = (() => {
    try {
      loadAgentConfig(join(dir, 'inst.yaml'));
      return '';
    } catch (e) {
      return e.message;
    }
  })();
  assert.doesNotMatch(said, /inherited/i);
  assert.doesNotMatch(said, /other crew's identity/i);
  assert.doesNotMatch(said, /derive from `crew`/);
  assert.match(said, /Delete the line/);
});

test('a bare `extends:` is an error, not a silent standalone file', () => {
  for (const line of ['extends:', 'extends: ""']) {
    assert.throws(
      () => loadAgentConfig(writeConfigRaw([line, 'crew: clawcius'])),
      /extends must be a path to the shared base config/,
    );
  }
  // Absent entirely is still a legitimate standalone config.
  assert.equal(loadAgentConfig(writeConfigRaw(['crew: x'])).crew, 'x');
});

test('an explicit null in an instance file inherits the base, not the code default', () => {
  const shipped = loadAgentConfig('agent-config.yaml');
  const nulled = loadAgentConfig(
    writeConfigRaw(['crew: clawcius', `extends: ${BASE}`, 'model:', 'sessions:', '  maxConcurrent:']),
  );
  assert.equal(nulled.model, shipped.model);
  assert.match(nulled.model, /\[1m\]/, 'the 1M-context suffix must survive a nulled key');
  assert.equal(nulled.sessions.maxConcurrent, shipped.sessions.maxConcurrent);
  assert.equal(nulled.sessions.maxConcurrent, 10);

  assert.deepEqual(
    loadAgentConfig(
      writeConfigRaw(['crew: x', `extends: ${BASE}`, 'discord:', '  alwaysOnChannelIds: []']),
    ).discord.alwaysOnChannelIds,
    [],
  );
});

test('an error names the file the key actually came from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-prov-'));
  const shared = readFileSync('agent-config.base.yaml', 'utf8');
  const write = (baseText, instanceLines) => {
    writeFileSync(join(dir, 'base.yaml'), baseText);
    writeFileSync(join(dir, 'inst.yaml'), ['extends: base.yaml', 'crew: third', ...instanceLines, ''].join('\n'));
    return join(dir, 'inst.yaml');
  };

  for (const [mutate, key] of [
    [(t) => t.replace('maxTurns: 0', 'maxTurns: nope'), /base\.yaml: maxTurns/],
    [(t) => t.replace('You are {{Crew}}: a crew', 'You are {{crew}}: a crew'), /base\.yaml: systemPrompt\.append/],
    [(t) => t.replace(/^  roleNotice: .*$/m, '  roleNotice: "{nope}"'), /base\.yaml: prompts\.roleNotice/],
  ]) {
    assert.throws(() => loadAgentConfig(write(mutate(shared), [])), key);
  }

  // Same key, different file, different name.
  assert.throws(() => loadAgentConfig(write(shared, ['maxTurns: nope'])), /inst\.yaml: maxTurns/);
});

test('an indexed key names its own file, and so do the guards (OJ round 2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-idx-'));
  const write = (baseLines, instanceLines) => {
    writeFileSync(join(dir, 'base.yaml'), [...baseLines, ''].join('\n'));
    writeFileSync(join(dir, 'inst.yaml'), ['extends: base.yaml', 'crew: third', ...instanceLines, ''].join('\n'));
    return join(dir, 'inst.yaml');
  };

  assert.throws(
    () =>
      loadAgentConfig(
        write(['discord:', '  followUpWindowSeconds: 300'], ['discord:', '  allowedChannelIds: [12345]']),
      ),
    /inst\.yaml: discord\.allowedChannelIds\[0\]/,
  );

  // Same shape one level deeper, through a list of mappings.
  assert.throws(
    () =>
      loadAgentConfig(
        write(
          ['clawsky:', '  enabled: true'],
          ['clawsky:', '  agents:', '    - id: wrongprefix', '      role: engineer'],
        ),
      ),
    /inst\.yaml: clawsky\.agents\[0\]\.id/,
  );

  // Both keys live in the base and are refused nowhere, so the message must not
  // name the instance file.
  assert.throws(
    () =>
      loadAgentConfig(
        write(['discord:', '  bundleDebounceMs: 1500', '  bundleMaxWaitMs: 100'], []),
      ),
    /base\.yaml: discord\.bundleMaxWaitMs must be >=/,
  );

  // And the containment guards name the file holding the MOUNT, because that is
  // the half an operator can edit — `status.file` is derived and cannot move.
  assert.throws(
    () => loadAgentConfig(write(['paths:', '  skillsDir: /var/lib/third'], [])),
    /base\.yaml: status\.file .* is inside paths\.skillsDir/,
  );
});

test('an explicit stateDir is followed by every derived path or by none', () => {
  const config = loadAgentConfig(
    writeConfigRaw(['crew: third', 'container:', '  stateDir: /srv/third']),
  );
  assert.equal(config.container.stateDir, '/srv/third');
  assert.equal(config.container.execEnvDir, '/srv/third/exec-env');
  assert.equal(config.container.githubTokenDir, '/srv/third/github-token');
  assert.equal(config.sessions.workspaceRoot, '/srv/third/workspaces');
  assert.equal(config.status.file, '/srv/third/waker-status.json');
});

// ── modelByRole ─────────────────────────────────────────────────────────────

test('modelByRole defaults to empty, so every role runs on `model`', () => {
  const config = loadAgentConfig(writeConfig(['  execEnvDir: /var/lib/x-env']));
  assert.deepEqual(config.modelByRole, {});
});

test('modelByRole accepts a role and refuses one that is not', () => {
  const config = loadAgentConfig(
    writeConfig(['  execEnvDir: /var/lib/x-env', 'modelByRole:', '  updater: some-model']),
  );
  assert.equal(config.modelByRole.updater, 'some-model');

  // The likelier mistake by far, and silent without this: a key that matches no
  // role never applies, and the agent stays on `model` with nothing said.
  assert.throws(
    () =>
      loadAgentConfig(
        writeConfig(['  execEnvDir: /var/lib/x-env', 'modelByRole:', '  updaters: some-model']),
      ),
    /modelByRole\.updaters is not a role — one of: .*updater/,
  );
});

test('modelByRole refuses an empty or non-string model id', () => {
  // An empty string would reach the SDK as a model id and fail per session at
  // spawn time. Failing at boot, naming the key, is the cheaper failure.
  for (const value of ['""', '[]', '{}']) {
    assert.throws(
      () =>
        loadAgentConfig(
          writeConfig(['  execEnvDir: /var/lib/x-env', 'modelByRole:', `  updater: ${value}`]),
        ),
      /modelByRole\.updater must be a non-empty model id/,
    );
  }
});

test('modelByRole refuses host, which is a role but never a session', () => {
  assert.throws(
    () =>
      loadAgentConfig(
        writeConfig(['  execEnvDir: /var/lib/x-env', 'modelByRole:', '  host: some-model']),
      ),
    /modelByRole\.host cannot take a model/,
  );

  // Every other role still loads — the refusal is about `host` specifically,
  // not about narrowing the key set to whatever is spawnable.
  const config = loadAgentConfig(
    writeConfig([
      '  execEnvDir: /var/lib/x-env',
      'modelByRole:',
      '  coordinator: a',
      '  engineer: b',
      '  researcher: c',
      '  poster: d',
      '  updater: e',
    ]),
  );
  assert.equal(Object.keys(config.modelByRole).length, 5);
});

test('both shipped configs put the updater on Haiku, and agree with each other', () => {
  const clawcius = loadAgentConfig('agent-config.yaml');
  const hamachi = loadAgentConfig('agent-config.hamachi.yaml');

  assert.deepEqual(clawcius.modelByRole, hamachi.modelByRole);
  assert.equal(clawcius.modelByRole.updater, 'claude-haiku-4-5');

  // The `[1m]` suffix is parsed by the SDK and is ungated — any id containing it is assumed to have a 1M window.
  assert.doesNotMatch(clawcius.modelByRole.updater, /\[1m\]/);
  assert.match(clawcius.model, /\[1m\]/, 'the default model still carries the suffix');
});

test('githubTokenDir is derived per instance, not defaulted to one of them', () => {
  const clawcius = loadAgentConfig('agent-config.yaml');
  const hamachi = loadAgentConfig('agent-config.hamachi.yaml');

  assert.equal(clawcius.container.githubTokenDir, join(clawcius.container.stateDir, 'github-token'));
  assert.equal(hamachi.container.githubTokenDir, join(hamachi.container.stateDir, 'github-token'));
  assert.notEqual(
    clawcius.container.githubTokenDir,
    hamachi.container.githubTokenDir,
    'two instances must never share a credential directory',
  );
});

test('githubTokenDir is refused inside OR equal to any other bind mount', () => {
  const base = parse(readFileSync('agent-config.yaml', 'utf8'));
  base.extends = BASE;
  const refused = [
    '/var/lib/clawcius/workspaces', // equal to a read-write mount
    '/var/lib/clawcius/run',
    '/var/lib/clawcius/agent-home',
    '/srv/clawcius/current/.claude', // equal to a read-only mount BOTH crews share
    '/var/lib/clawcius/workspaces/tok', // inside one
  ];
  for (const dir of refused) {
    const y = structuredClone(base);
    y.container = { ...(y.container ?? {}), githubTokenDir: dir };
    const path = join(mkdtempSync(join(tmpdir(), 'clawsky-cfg-')), 'agent-config.yaml');
    writeFileSync(path, stringify(y));
    assert.throws(
      () => loadAgentConfig(path),
      /githubTokenDir/,
      `${dir} must be refused — the sandbox can reach it`,
    );
  }
});

test('pointing AGENT_CONFIG_PATH at the base says so, rather than telling it to extend itself', () => {
  let said = '';
  try {
    loadAgentConfig('agent-config.base.yaml');
  } catch (e) {
    said = e.message;
  }
  assert.match(said, /this looks like the SHARED BASE/);
  assert.match(said, /must name an INSTANCE file/);
  assert.doesNotMatch(said, /Almost certainly you want/, 'must not tell the base to extend itself');

  // A file with prompt content and NO `crew` is a base however it is named — the
  // suffix is a convention, not a guarantee.
  assert.throws(
    () => loadAgentConfig(writeUndeclared(['prompts:', '  roleNotice: hi'])),
    /this looks like the SHARED BASE/,
  );

  for (const notABase of [
    ['crew: x', 'systemPrompt:', '  useClaudeCodeDefault: false'],
    ['crew: x', 'prompts:', '  roleNotice: hi'],
    ['crew: x', 'systemPrompt:', '  append: hello'],
  ]) {
    assert.throws(
      () => loadAgentConfig(writeUndeclared(notABase)),
      /has no `extends:` and does not declare itself standalone/,
      `${notABase.join(' ')} names a crew, so it is an instance file and must get the ordinary error`,
    );
    assert.doesNotThrow(
      () => {
        try {
          loadAgentConfig(writeUndeclared(notABase));
        } catch (e) {
          if (/SHARED BASE/.test(e.message)) throw new Error('told an instance file it is the base');
        }
      },
      /told an instance file it is the base/,
    );
  }

  // And an ordinary instance file with neither mode key still gets the ordinary
  // error, because it carries no prompt content.
  assert.throws(
    () => loadAgentConfig(writeUndeclared(['crew: x'])),
    /has no `extends:` and does not declare itself standalone/,
  );
});

// ── identity at session initialization ──────────────────────────────────────
// Every role gets a durable statement of its OWN role.

function withRealPrompts() {
  const loaded = loadAgentConfig(writeConfigRaw(['crew: x', `extends: ${BASE}`]));
  setConfig({
    discord: { token: 'u', guildId: 'u' },
    github: { token: '', appId: '' },
    storage: { dbPath: 'u' },
    agent: loaded,
  });
}

test('each role is told its own role, not the coordinator\'s', () => {
  withRealPrompts();
  const text = (identity) => {
    const sp = buildSystemPrompt(identity);
    return typeof sp === 'string' ? sp : sp.append;
  };

  for (const role of ['coordinator', 'engineer', 'researcher', 'poster', 'updater', 'host']) {
    const out = text({ id: `hamachi-${role}1`, crew: 'hamachi', role });
    assert.match(out, new RegExp('role `' + role + '`'), `${role} not named`);
    assert.match(out, new RegExp('You are `hamachi-' + role + '1`'), `${role} id missing`);
    if (role !== 'coordinator') {
      assert.doesNotMatch(out, /team leader/, `${role} was told it leads the team`);
    }
  }
});

test('an unrecognised role is named as unrecognised, not passed off as real', () => {
  withRealPrompts();
  const sp = buildSystemPrompt({ id: 'hamachi-x1', crew: 'hamachi', role: 'sousaphonist' });
  const out = typeof sp === 'string' ? sp : sp.append;
  // Truthful beats confident: it must not read as though <roles> describes it,
  // because the agent would go looking and find nothing.
  assert.match(out, /not one this crew defines/);
  assert.match(out, /sousaphonist/);
  assert.doesNotMatch(out, /is yours/);
  assert.doesNotMatch(out, /<sousaphonist/);
});

test('the wake carries messages, not identity', () => {
  withRealPrompts();
  const out = String(
    buildWakeMessage({
      kind: 'messages',
      channelId: 'C1',
      messages: [
        { at: Date.now(), authorTag: 'nick', authorId: 'u1', messageId: 'm1', content: 'hi' },
      ],
    }),
  );
  assert.doesNotMatch(out, /team leader/);
  assert.doesNotMatch(out, /role `/);
  // The operational tail is per-wake data and stays.
  assert.match(out, /channel_id: C1/);
  assert.match(out, /latest message_id: m1/);
});

// ── the prompt against the tools that actually exist ────────────────────────

/** The left column of the indented tool block -- the prose's list of tools. */
function toolsNamedInProtocol(protocol) {
  const section = protocol.slice(protocol.indexOf('## Waking yourself later'));
  return new Set([...section.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]));
}

