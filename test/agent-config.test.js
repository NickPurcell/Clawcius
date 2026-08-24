/**
 * A file a privileged process trusts must not sit where the agent can write it.
 *
 * Two files are in that class. `status.file` is read by the ops executor, which
 * used to recreate containers on the strength of it; `container.execEnvDir`
 * holds this instance's Discord and GitHub tokens in plain text, and two of the
 * container's mounts are shared by BOTH deployments.
 *
 * The check for the first was wrong by exactly one directory level until
 * 2026-08-16 (Clawcius #55). It compared against `wake.spoolDir`, which was
 * `<stateDir>/run/wake`, while what `docker/run-container.sh` bind-mounts is its
 * PARENT, `<stateDir>/run`:
 *
 *     CLAWCIUS_STATE=${CLAWCIUS_STATE_DIR:-/var/lib/clawcius}
 *     -v "$CLAWCIUS_STATE/run:$CLAWCIUS_STATE/run:rw"
 *
 * So `<stateDir>/run/waker-status.json` passed every check in both loaders and
 * was writable by the agent — the precise file the comment above the check
 * describes as the one that must not be. Retiring the wake spool removed the key
 * the derivation came from, so `container.stateDir` now names the mount
 * directly.
 *
 * These drive the real loader against a real file, because the thing under test
 * is what a boot does with an operator's YAML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { parse, stringify } from 'yaml';

import { loadAgentConfig } from '../dist/agent-config.js';

/**
 * Exactly the lines given, for tests about the container block itself.
 *
 * `standalone: true` is prepended unless the caller supplies `extends:`, because
 * since #221 a config must DECLARE which mode it is in rather than have it
 * inferred from silence. Almost every fixture here is standalone, and this is
 * the one place that has to say so — the two helpers were the whole cost of that
 * change on the test side, which is why it was worth doing.
 */
function writeConfigRaw(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-'));
  const path = join(dir, 'agent-config.yaml');
  const declared = lines.some((l) => l.startsWith('extends:') || l.startsWith('standalone:'));
  writeFileSync(path, [...(declared ? [] : ['standalone: true']), ...lines, ''].join('\n'));
  return path;
}

/**
 * A config with just enough in it to load, plus whatever is under test.
 *
 * `crew: x` is the whole preamble since #203, and it is what the two lines it
 * replaced used to say the long way: `container.stateDir` derives to
 * `/var/lib/x` from it, so every path assertion below reads exactly as before.
 * The lines callers pass still open inside `container:`.
 */
function writeConfig(lines) {
  return writeConfigRaw(['crew: x', 'container:', ...lines]);
}

/**
 * Exactly the lines given and NOTHING prepended — for the tests that assert an
 * undeclared mode is refused.
 *
 * It exists because `writeConfigRaw` adds `standalone: true`, which is correct
 * for every other fixture and silently defeats these two: the first version of
 * this test passed the undeclared case through the helper and got a declared
 * file back, so it asserted a throw that could not happen.
 */
function writeUndeclared(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-undeclared-'));
  const path = join(dir, 'agent-config.yaml');
  writeFileSync(path, [...lines, ''].join('\n'));
  return path;
}

/** Absolute, because a fixture in a tmpdir cannot resolve a relative base. */
const BASE = resolve('agent-config.base.yaml');

test('a status file inside the container mount is refused, not just one inside a spool', () => {
  // Clawcius #55, as reported: one level above the directory the old check
  // named, and inside the one the container actually gets.
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

  // And the deeper path the old check did catch still fails, so this is wider
  // rather than different.
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
  // Two of the three values OJ put through the loader in review of #67. Each
  // makes the #55 fix pass a status.file that is inside a real bind mount, so
  // each silently undoes the thing that key was added to do.
  //
  // The THIRD case — the key absent entirely — is no longer a failure and is
  // now the normal state: it derives from `crew`. See the next test, which is
  // where that case moved rather than where it was dropped.

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
  // This is where `container.stateDir is required and has no default` went.
  // The reason it was required is intact and is now discharged one level up: a
  // DEFAULT would be `/var/lib/clawcius`, one crew's directory handed to a crew
  // that forgot to say its own. A DERIVATION from the instance's own name
  // cannot name its neighbour, which is the property the literal never had.
  assert.throws(
    () => loadAgentConfig(writeConfigRaw(['container:', '  execEnvDir: /var/lib/x-env'])),
    /crew is required and has no default/,
  );

  // And the nine values that come off it. Measured against both shipped configs
  // before the split: every one already held exactly this shape, so this test
  // asserts a convention that was being hand-maintained, not a new one.
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

  // container.name in particular, because its failure mode is the loudest and
  // the least visible. It is the `docker exec` target (src/container.ts:323),
  // so before #203 — when DEFAULTS held the literal `clawcius-agent` — a third
  // crew that set everything else and forgot this one key would not have
  // errored. It would have run its turns inside CLAWCIUS's container, with
  // Clawcius's mounts and Clawcius's read-only credential directory.
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
  // Neither file SETS it any more — the key is refused in both layered files and
  // derives from `crew`, which is the better assertion and is what this checks.
  // The title used to say "set", which was the opposite of what #203 did (OJ
  // round 1 on #207, finding 7). What it has always been for is unchanged: the
  // two shipped files must be correct AND must differ, and a copy-paste that
  // left Hamachi pointing at /var/lib/clawcius would pass every other test here.
  const clawcius = loadAgentConfig('agent-config.yaml');
  const hamachi = loadAgentConfig('agent-config.hamachi.yaml');
  assert.equal(clawcius.container.stateDir, '/var/lib/clawcius');
  assert.equal(hamachi.container.stateDir, '/var/lib/hamachi');
  assert.notEqual(clawcius.container.stateDir, hamachi.container.stateDir);
});

test('all three read-write mounts are checked, not just the one the spools lived in', () => {
  // `run-container.sh` mounts workspaces/, run/ and agent-home/ read-write, all
  // derived from CLAWCIUS_STATE. Until 2026-08-16 this file checked `run/` and
  // named agent-home as a known gap, while ops/src/config.ts checked all three
  // — two halves of one change disagreeing about the completeness of one
  // enumeration. Both files check three now.
  //
  // The assertion matches the CLAIM rather than the label, and that is not
  // laxity — since #203 the `workspaces` case is caught by the
  // `sessions.workspaceRoot` entry instead of the `<container.stateDir>/…` one,
  // because workspaceRoot finally derives from stateDir and the two entries name
  // the same directory. `bindMountedPaths` lists both on purpose ("an operator
  // who moves one has not moved the mount"), so which one reports it is an
  // ordering detail; that the path is refused as a bind mount is the property.
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
  // Same list, same rule. This one has always been checked against the mount;
  // the point of asserting it here is that both files now share one answer to
  // "where can the agent write", so a fix to one cannot drift from the other.
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

// ── Layering: one shared base, one small file per instance (#203) ───────────
//
// Before this, `agent-config.yaml` and `agent-config.hamachi.yaml` were
// deliberate full copies — 937 and 972 lines, of which 111 differed and exactly
// THREE were config values. The rest was the same prose twice, hand-synced, and
// #125 is the commit that proved it drifts: it changed one copy and not the
// other, and Hamachi kept a persona the operator had asked to remove for four
// days. #152 ported it and verified byte-identity with a `node -e` in the PR
// description, which ran once and never again. These are that check, made a
// thing that runs.

test('the shipped instance files extend the shared base rather than copying it', () => {
  // The whole property in one assertion. A future instance file that stopped
  // extending would load fine and drift silently, which is the state this
  // change exists to make unreachable.
  for (const file of ['agent-config.yaml', 'agent-config.hamachi.yaml']) {
    const raw = parse(readFileSync(file, 'utf8'));
    assert.equal(raw.extends, 'agent-config.base.yaml', `${file} must extend the base`);
    assert.ok(raw.crew, `${file} must name its crew`);
  }
});

test('the base prompt renders to each crew, and rendering is the only difference', () => {
  // THE NO-OP PROOF, and the reason it is a test rather than a paragraph in a
  // pull request. It says: one 24kB prompt, three `{{Crew}}` sites, and what
  // each crew's agents read differs by the display name and nothing else.
  //
  // It scales to instance three without an edit — add a file to the list and
  // the same property is asserted of it — which is what #152's one-off could
  // never do.
  const base = parse(readFileSync('agent-config.base.yaml', 'utf8'));
  const template = base.systemPrompt.append;

  assert.equal(
    (template.match(/\{\{Crew\}\}/g) ?? []).length,
    3,
    'three identity sites: <system description> twice and <style> once',
  );

  for (const file of ['agent-config.yaml', 'agent-config.hamachi.yaml']) {
    const config = loadAgentConfig(file);
    assert.equal(
      config.systemPrompt.append,
      template.split('{{Crew}}').join(config.displayName),
      `${file}'s prompt must be the shared base with only its own name substituted`,
    );
    assert.doesNotMatch(config.systemPrompt.append, /\{\{/, 'nothing unsubstituted reaches an agent');
  }

  // There is deliberately NO third assertion comparing the two crews' prompts
  // to each other, and the absence is the result rather than a gap.
  //
  // #152 compared them under s/Clawcius/CREW/ AND s/Hamachi/CREW/, which mapped
  // "Hamachi and Clawcius" and "Clawcius and Hamachi" to the same string — so
  // it could not have seen a reordering. The obvious repair, normalising out
  // each crew's OWN name and comparing, does not work either, and fails for a
  // reason worth writing down: `<mail>` names both crews in one sentence on
  // purpose, so each crew's prompt legitimately contains the other's name. That
  // assertion was written here first; this comment is what it turned into.
  //
  // Neither is needed. Both prompts are rendered from ONE template by the loop
  // above, so there is no second copy for a reordering to happen in. The
  // property #152 was reaching for is now unreachable rather than checked, which
  // is what an include directive was always supposed to buy.
});

test('the repository name survives substitution, in every crew’s prompt', () => {
  // The hazard that made the delimiter a design decision. `Clawcius` is this
  // crew's identity AND the repository, indistinguishable by string match — so
  // a substitution keyed on the literal name would rewrite Hamachi's copy to
  // `NickPurcell/Hamachi`, a repository that does not exist, taking
  // <issue-tracking> with it. It would not fail: it would 404 the first time
  // some agent tried to file an issue.
  for (const file of ['agent-config.yaml', 'agent-config.hamachi.yaml']) {
    const { append } = loadAgentConfig(file).systemPrompt;
    assert.match(append, /Repositories: NickPurcell\/Clawcius/, `${file}: the repo is not the crew`);
    assert.match(append, /\(Clawcius #93\)/, `${file}: issue references are not the crew`);
    // And the single-brace URL templates are prose, left exactly alone. This is
    // why the placeholder is `{{Crew}}`: a `{name}` validator would fail the
    // boot on a pasted GitHub path, and a `{name}` substituter would rewrite it.
    assert.match(append, /\/repos\/\{owner\}\/\{repo\}\/issues\/\{n\}\/labels/);
  }
});

test('an instance file may not carry prompt content — refused, not ignored', () => {
  // Decision 2 of #203, made enforceable. Crews share one prompt and differ only
  // in facts interpolated into it; a crew that needs a different sentence gets a
  // sentence rewritten to be true of the MECHANISM, which is what #197 did under
  // duress and what this makes the rule.
  //
  // REFUSED rather than ignored, because ignoring it is the original defect in a
  // smaller place: an edit that does not reach the running system. An operator
  // who gets a boot error learns the rule at the moment they can act on it; one
  // who gets a working instance with a silently-dropped paragraph learns nothing.
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
  assert.match(config.systemPrompt.append, /You are X, a team of agents/);
});

test('the shared base may not carry instance identity — the inheritance bug, closed', () => {
  // Not symmetry with the test above. This one prevents a demonstrated failure:
  // a value in the SHARED file is inherited by every instance that does not
  // override it, and before #203 `DEFAULTS` did exactly that with six Clawcius
  // literals. `container.name` is the worst of them because it is the
  // `docker exec` target (src/container.ts:323) — an instance inheriting it does
  // not fail, it runs its turns inside the other crew's container.
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
  ];
  for (const lines of forbidden) {
    const fakeBase = writeConfigRaw(['model: some-model', ...lines]);
    const instance = writeConfigRaw(['crew: x', `extends: ${fakeBase}`]);
    assert.throws(
      () => loadAgentConfig(instance),
      /does not belong in this file|do not belong in this file/,
      `a base carrying ${lines.join(' ')} must be refused`,
    );
  }
});

test('clawsky.crew is refused wherever it appears, because the key moved', () => {
  // Unlike everything else here this key MOVED to the top level, and a moved key
  // left working under its old name is a second place to write the crew name.
  // The one thing the derivation cannot survive is two sources for the fact it
  // derives from, so this is refused even in a standalone file.
  assert.throws(
    () => loadAgentConfig(writeConfigRaw(['crew: x', 'clawsky:', '  crew: y'])),
    /clawsky\.crew moved to the top level as `crew`/,
  );
});

test('extends resolves against the instance file, and chains are refused', () => {
  // Against the INSTANCE FILE's directory, not the process's cwd: systemd hands
  // the waker a WorkingDirectory it did not choose, so a base found only when
  // launched from the right place is a config that works in development and
  // fails at boot.
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-layer-'));
  writeFileSync(join(dir, 'shared.yaml'), 'model: from-the-base\n');
  writeFileSync(join(dir, 'instance.yaml'), 'crew: x\nextends: shared.yaml\n');
  assert.equal(loadAgentConfig(join(dir, 'instance.yaml')).model, 'from-the-base');

  // A missing base names the path rather than falling back to defaults, which
  // would be a crew booting on somebody's idea of a sensible prompt.
  writeFileSync(join(dir, 'broken.yaml'), 'crew: x\nextends: nope.yaml\n');
  assert.throws(() => loadAgentConfig(join(dir, 'broken.yaml')), /Base config named by `extends` not found/);

  // One level. A chain makes "which file is this value from" a question you
  // answer by tracing, which is the state this change is getting out of.
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

// ── What the mechanism CLAIMS versus what it does (OJ round 1 on #207) ──────
//
// Every finding in that round was of one kind: a sentence in a header, a comment
// or an error message describing a stricter loader than the one that shipped.
// All are closed by making the loader match the sentence rather than the other
// way round, because in each case the sentence described what anyone would want.
// These keep it that way.

test('a derived key is refused in an instance file, not just in the base', () => {
  // FINDING 1, the sharpest of the round: the file whose header promised this
  // refusal was the file that accepted the key. BASE_FORBIDDEN closed the
  // INHERITANCE path — a shared value reaching an instance that did not override
  // it. It did not close RESTATEMENT, so this loaded:
  //
  //   extends: <base> / crew: third / container: { name: clawcius-agent }
  //   => container.name "clawcius-agent", stateDir "/var/lib/third"
  //
  // Crew `third` docker-exec-ing into Clawcius's container, accepted silently.
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

  // And the refusal must say the right thing. One rule sentence covered both
  // kinds of forbidden key at first, so this told an operator that
  // `container.name` was prompt content.
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
  // #207 closed the spelling that looks like a mistake and left open the one
  // that looks like a deletion:
  //
  //   extends:                     refused since #207
  //   extends: ""                  refused since #207
  //   <the line deleted entirely>  LOADED SILENTLY  <- this test
  //
  // Measured on merged main before the fix: deleting that one line from the
  // shipped agent-config.yaml gave a 0-character system prompt, `claude-opus-5`
  // instead of `claude-opus-5[1m]`, and maxConcurrent 3 instead of 10.
  assert.throws(
    () => loadAgentConfig(writeUndeclared(['crew: clawcius'])),
    /has no `extends:` and does not declare itself standalone/,
  );
  // The error names BOTH ways out, because an operator who hits it has no way to
  // know which one they meant to write.
  assert.throws(
    () => loadAgentConfig(writeUndeclared(['crew: clawcius'])),
    /`extends: agent-config\.base\.yaml`[\s\S]*`standalone: true`/,
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

  // NO assertion here that the mode keys are absent from the resolved config.
  // There was one, and mutating the `delete` calls away did not fail it: the
  // config object is built key by key, so an unhandled root key cannot reach it
  // in the first place. The assertion could not fail, which makes it worse than
  // no assertion — it reads as coverage of a delete that is only belt and
  // braces. Removed rather than rewritten, because there is nothing to check.
});

test('the real shipped config, minus its extends line, is refused (#221)', () => {
  // THE REPRODUCTION FROM THE ISSUE, against the file that actually ships rather
  // than a fixture — because the fixture is what I would have got right.
  const real = readFileSync('agent-config.yaml', 'utf8');
  assert.match(real, /^extends: /m, 'precondition: the shipped file uses extends');

  const dir = mkdtempSync(join(tmpdir(), 'agent-config-221-'));
  const path = join(dir, 'agent-config.yaml');
  writeFileSync(path, real.split('\n').filter((l) => !l.startsWith('extends:')).join('\n'));

  assert.throws(
    () => loadAgentConfig(path),
    /has no `extends:` and does not declare itself standalone/,
    'deleting one line must not silently produce a crew with no system prompt',
  );
});

test('a bare `extends:` is an error, not a silent standalone file', () => {
  // FINDING 2. `extends:` with no value parses to null, and null was treated as
  // absent — so it did not mean "extends nothing is wrong", it meant "this file
  // is standalone", and the crew booted with NO system prompt at all, on the
  // code default model instead of the base's, silently:
  //
  //   systemPrompt.append 0 chars · model claude-opus-5 (base: [1m])
  //   sessions.maxConcurrent 3 (base: 10)
  //
  // `extends: ""` was already refused. In YAML these are the same edit made two
  // ways, and the safe-looking one was the one that failed silently.
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
  // FINDING 3. `deepMerge` treated an explicit null as a value replacing the
  // base's, and every reader then treats null as absent and falls back to
  // DEFAULTS. So `key:` with nothing after it meant neither "inherit" nor
  // "error" but "reset to whatever src/agent-config.ts says" — a third semantic
  // nobody chose. Commenting out a value and leaving its key is an ordinary
  // edit; `model:` moved every agent in the crew off the 1M-context model.
  const shipped = loadAgentConfig('agent-config.yaml');
  const nulled = loadAgentConfig(
    writeConfigRaw(['crew: clawcius', `extends: ${BASE}`, 'model:', 'sessions:', '  maxConcurrent:']),
  );
  assert.equal(nulled.model, shipped.model);
  assert.match(nulled.model, /\[1m\]/, 'the 1M-context suffix must survive a nulled key');
  assert.equal(nulled.sessions.maxConcurrent, shipped.sessions.maxConcurrent);
  assert.equal(nulled.sessions.maxConcurrent, 10);

  // An explicit EMPTY value is a value and still overrides — that is what
  // `alwaysOnChannelIds: []` needs, so the fix must not swallow it.
  assert.deepEqual(
    loadAgentConfig(
      writeConfigRaw(['crew: x', `extends: ${BASE}`, 'discord:', '  alwaysOnChannelIds: []']),
    ).discord.alwaysOnChannelIds,
    [],
  );
});

test('an error names the file the key actually came from', () => {
  // FINDING 4, and it is this change's own listed fix reintroduced one layer up.
  // Every error named the instance file, but after the split almost every value
  // lives in the base — so a bad `{{crew}}` in the SHARED prompt said "fix
  // systemPrompt.append in agent-config.yaml", which is one of the two keys an
  // instance file is FORBIDDEN to contain. An operator following that error
  // writes the key, gets a second boot error telling them to move it back, and
  // the second error names the file the first one should have.
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-prov-'));
  const shared = readFileSync('agent-config.base.yaml', 'utf8');
  const write = (baseText, instanceLines) => {
    writeFileSync(join(dir, 'base.yaml'), baseText);
    writeFileSync(join(dir, 'inst.yaml'), ['extends: base.yaml', 'crew: third', ...instanceLines, ''].join('\n'));
    return join(dir, 'inst.yaml');
  };

  for (const [mutate, key] of [
    [(t) => t.replace('maxTurns: 0', 'maxTurns: nope'), /base\.yaml: maxTurns/],
    [(t) => t.replace('You are {{Crew}}, a team', 'You are {{crew}}, a team'), /base\.yaml: systemPrompt\.append/],
    [(t) => t.replace(/^  roleNotice: .*$/m, '  roleNotice: "{nope}"'), /base\.yaml: prompts\.roleNotice/],
  ]) {
    assert.throws(() => loadAgentConfig(write(mutate(shared), [])), key);
  }

  // Same key, different file, different name.
  assert.throws(() => loadAgentConfig(write(shared, ['maxTurns: nope'])), /inst\.yaml: maxTurns/);
});

test('an indexed key names its own file, and so do the guards (OJ round 2)', () => {
  // THE TAIL OF FINDING 4. `fileFor` walked up by stripping at the last `.`, so
  // a path with an `[index]` never reached its own entry: `allowedChannelIds[0]`
  // jumped straight past `discord.allowedChannelIds` to `discord`, and named
  // whichever file wrote the parent mapping.
  //
  // For this key that is ALWAYS wrong — BASE_FORBIDDEN refuses
  // `discord.allowedChannelIds` in the base, so it can only have come from an
  // instance file. An error naming the base names a file the key may not be in.
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

  // The bundling check is the clean miss: BOTH keys live in the base and are
  // refused nowhere, so naming the instance file was simply always wrong.
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
  // FINDING 5. `githubTokenDir` re-derived from an explicit stateDir while
  // execEnvDir, workspaceRoot and status.file kept computing from
  // /var/lib/{crew} — so `stateDir: /srv/third` produced a workspaceRoot outside
  // the directory run-container.sh actually mounts. Half-honoured reads as
  // coherent, which is worse than not honoured at all.
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
  // Round 1 of #163. `host` passes the is-it-a-role check and would then never
  // apply: `MailWaker.#consider` returns before `acquire` for it, and the ops
  // executor owns that mailbox from outside the container. Loading clean and
  // doing nothing is the exact silent no-op this validator exists to prevent
  // for a mistyped key, so it is refused rather than ignored.
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

  // The `[1m]` suffix is parsed by the SDK and is ungated — any id containing it
  // is assumed to have a 1M window. Haiku 4.5's is 200K, so carrying the suffix
  // across from `model` would have the harness autocompact against a limit five
  // times the real one. This is the assertion that stops a copy-paste doing it.
  assert.doesNotMatch(clawcius.modelByRole.updater, /\[1m\]/);
  assert.match(clawcius.model, /\[1m\]/, 'the default model still carries the suffix');
});

test('githubTokenDir is derived per instance, not defaulted to one of them', () => {
  // BLOCKING FINDING 11 ON #188. The key was defaulted to the literal
  // `/var/lib/clawcius/github-token`, and agent-config.hamachi.yaml — which
  // overrides stateDir, execEnvDir and workspaceRoot — had no reason to know a
  // key added later existed. So Hamachi's daemon would have written its
  // installation token into Clawcius's directory, which IS mounted read-only
  // into Clawcius's container, serving one instance's credential to the other
  // instance's crew. Meanwhile Hamachi's own agents read a path not mounted
  // into theirs and fell back to the PAT with nothing saying so.
  //
  // Both shipped configs are loaded rather than one, because a single-config
  // test cannot see this class at all.
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
  // FINDING 17 ON #188, and the reason it survived: the derivation had a test
  // and the containment guard had none, while `execEnvDir` — the guard this one
  // was copied from — has containment tests against run, workspaces and
  // agent-home. The copy did not bring them.
  //
  // The hole was that the self-skip compared resolved PATHS, so githubTokenDir
  // set exactly EQUAL to another mount matched it and was accepted. Equality
  // with a mount is the worst case, not the exempt one: `<stateDir>/workspaces`
  // is the read-write mount that is also the container's working directory,
  // which is where round 1 found the credential and why any of this exists.
  // Built from the real Clawcius instance file, so the mounts it is checked
  // against are the real ones. `extends` is rewritten to an absolute path
  // because the fixture is written to a tmpdir and `extends` resolves against
  // the instance file's own directory — which is the correct behaviour and the
  // reason a systemd-launched waker can find its base at all.
  const base = parse(readFileSync('agent-config.yaml', 'utf8'));
  base.extends = BASE;
  const refused = [
    '/var/lib/clawcius/workspaces', // equal to a read-write mount
    '/var/lib/clawcius/run',
    '/var/lib/clawcius/agent-home',
    '/home/npurcell/clawcius/.claude', // equal to a read-only mount BOTH crews share
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
