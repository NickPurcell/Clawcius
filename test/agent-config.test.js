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
import { setConfig } from '../dist/config.js';
import { buildSystemPrompt, buildWakeMessage } from '../dist/prompt.js';
import { buildArmedTools } from '../dist/armed-tool.js';

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

    // `sessions` IS SHARED POLICY, and until #249 that was a convention nothing
    // enforced. `DERIVED_KEYS` refuses `sessions.workspaceRoot` in an instance
    // file but says nothing about `maxConcurrent` or `idleTimeoutMinutes`, so
    // an instance could have opted one crew out of a memory policy and every
    // test would still have passed.
    //
    // #203's line is that instance files carry FACTS — crew, displayName,
    // channel lists — and everything else stays shared, precisely so a policy
    // cannot be true of one crew and false of the other with no drift check
    // left to catch it. This is that check.
    //
    // IF THIS FAILS, IT IS NOT NECESSARILY WRONG. A crew that genuinely needs a
    // different `maxConcurrent` is a legitimate thing to want; what must not
    // happen is it arriving silently. Deleting this assertion is a fine answer
    // — taken deliberately, which is the whole point of it being here.
    assert.equal(
      raw.sessions,
      undefined,
      `${file} must not override shared session policy — see the comment above`,
    );
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
    // `standalone` is deliberately NOT in this list. It is refused in a base
    // too, but beside the chain check rather than here, because this list's one
    // shared rule sentence is false of a mode key — see BASE_FORBIDDEN's note.
  ];
  for (const lines of forbidden) {
    // `writeUndeclared`, not `writeConfigRaw`: the helper prepends
    // `standalone: true` to anything without a mode key, which is right for an
    // instance fixture and WRONG for a base — a base may not declare a mode at
    // all, so the fixture would trip that refusal before reaching this one. The
    // same helper defeated the #221 test the same way; it is a good default with
    // exactly one exception, and a base file is it.
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
  // The error names both ways out — but NOT as equals. An operator reads it
  // having just been refused, in a hurry, and `standalone: true` is the shorter
  // line; taking it reproduces #221 exactly, blessed by the message that offered
  // it. So the message must rank them and say what the second one costs.
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

  // NO assertion here that the mode keys are absent from the resolved config.
  // There was one, and mutating the `delete` calls away did not fail it: the
  // config object is built key by key, so an unhandled root key cannot reach it
  // in the first place. The assertion could not fail, which makes it worse than
  // no assertion — it reads as coverage of a delete that is only belt and
  // braces. Removed rather than rewritten, because there is nothing to check.
});

test('every shipped config, minus its extends line, is refused (#221)', () => {
  // THE REPRODUCTION FROM THE ISSUE, against the files that actually ship rather
  // than a fixture — because a fixture is what I would have got right.
  //
  // BOTH files, not just Clawcius's. The first version hardcoded
  // `agent-config.yaml` while carrying a PR description claiming both were
  // refused; Hamachi's has the byte-identical warning, is edited by the same
  // operator on the same host, and was not a thing that ran (OJ round 1 on #228,
  // note 3). The list is the same one the render test uses, so a third crew is
  // covered by adding a filename in one place.
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
  // `extends` in a base was already refused; `standalone` was silently ignored,
  // which is the same silence one file over.
  const dir = mkdtempSync(join(tmpdir(), 'agent-config-basemode-'));
  writeFileSync(join(dir, 'base.yaml'), 'standalone: true\nmodel: from-the-base\n');
  writeFileSync(join(dir, 'inst.yaml'), 'extends: base.yaml\ncrew: x\n');

  assert.throws(() => loadAgentConfig(join(dir, 'inst.yaml')), /has `standalone:`/);

  // AND THE MESSAGE MUST BE TRUE OF A MODE KEY. Putting it in BASE_FORBIDDEN
  // attached that list's shared rule sentence, which says the value is INHERITED
  // by instances that do not override it, that it is another crew's identity,
  // and that the fix is to move it to the instance file or let it derive from
  // `crew`. All three are false here: it is read from the instance only, it is
  // not an identity, moving it there is the both-modes refusal, and a mode key
  // derives from nothing. OJ round 2 on #228.
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

test('pointing AGENT_CONFIG_PATH at the base says so, rather than telling it to extend itself', () => {
  // OJ round 3 on #228, new item 2. The base has neither mode key, so it took the
  // generic error — which offers `extends: agent-config.base.yaml` as the likely
  // fix. That is the shared base being told to name itself, read by an operator
  // in the state where the hedge four lines down is what gets skipped.
  //
  // Detected by content rather than filename: a file carrying prompt content is a
  // base by construction, since an instance file is refused for those keys.
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

  // AND THE `crew` HALF IS LOAD-BEARING. This fixture used to carry `crew: x` and
  // was asserted to be the shared base — which it cannot be, since a base
  // carrying `crew` is refused for that key. The assertion pinned a detector that
  // over-fired on two files that are not bases, and OJ round 4 named both states.
  //
  // 1. An instance setting `systemPrompt.useClaudeCodeDefault` — documented, on no
  //    refusal list, and it loads in an instance file. Delete its `extends:` line
  //    (THE #221 SCENARIO THIS CHANGE EXISTS FOR) and it was told it is the shared
  //    base and that adding `extends:` back "is not the fix". It is the fix.
  // 2. A `standalone: true` config, which carries prompt content by definition.
  //    Drop the declaration and it was told `standalone: true` is not the fix.
  //
  // Both carry `crew`. A base may not, and every loaded config must, so prompt
  // content with no `crew` is the base and nothing else is.
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
//
// What these pin: every role now gets a durable statement of its OWN role.
//
// Not "the literal was read by everyone" — it was not. It lived only in
// `messageWake`, which renders for a Discord-channel wake alone, and those
// sessions are coordinators. Spawned agents are woken by mail and had no role
// statement at all; that absence is the gap, and it is the larger one.
//
// Driven through the REAL base config rather than a hand-built stub, so these
// fail if the shipped YAML stops saying it.

function withRealPrompts() {
  // `extends: BASE` is the whole point: without it this loads DEFAULT_PROMPTS
  // out of the compiled TypeScript and the assertions below say nothing about
  // the file that actually ships. `loadAgentConfig` takes ONE argument -- a
  // second one is silently ignored, which is how the first draft of these tests
  // passed against a mutated YAML.
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
    // The specific regression: nobody but the coordinator is called the leader.
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
  // THE ASSERTION THAT MATTERS, and the one the first draft lacked: no clause
  // may tell an unrecognised role which section is "yours". The earlier version
  // decorated {role} in place, so `<sousaphonist (not a role...)>` was named as
  // the agent's section — and both patterns above matched the FIRST occurrence,
  // so neither noticed.
  assert.doesNotMatch(out, /is yours/);
  assert.doesNotMatch(out, /<sousaphonist/);
});

test('the wake carries messages, not identity', () => {
  withRealPrompts();
  const out = String(
    // The REAL shape: `types.ts:12` says `kind: 'messages'` and `authorTag`.
    // The first draft said 'message' and `author`, and reached the right branch
    // anyway because `buildWakeMessage` returns early on 'mail' and lets
    // everything else fall through — so it rendered `undefined: hi` and nothing
    // asserted on the author. A fixture that only resembles the type stops
    // exercising the right path the moment that branch becomes positive.
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
//
// #243: `DEFAULT_PROMPTS.protocol` told an agent that `schedule_wake`,
// `schedule_repeating`, `list_schedules` and `cancel_schedule` arrange for it to
// be woken. None of those four had existed anywhere in the tree since
// `ed8acb9` (#51, 14 Aug) introduced `remindMe` and the rest of `armed-tool.ts`.
// That commit rewrote the prose in both instance YAMLs and added the armed
// config keys to `agent-config.ts` -- and never touched the literal, which had
// not been edited since `b30125a` created it.
//
// AND THE SAME THING HAD HAPPENED AGAIN, still live when this was written.
// `d4c2acb` (#69, 16 Aug) added `scheduleRecurring` and touched no config file
// at all, so the shipped prose said "Two tools arm it" and never named the third
// -- `git log --all -S'scheduleRecurring'` over the three YAMLs returns nothing
// before this change. Every agent read that.
//
// Twice is a class, so this is a check rather than a correction. It is worth
// being clear about which half catches which:
//
//   the parity assertion   catches a literal drifting from what ships. That is
//                          the #243 shape exactly -- the ghost names lived in
//                          the compiled default and nowhere else.
//   the registry assertion catches the prose and the tool list disagreeing in
//                          EITHER direction: a tool nobody documented, or a
//                          documented name that is not a tool.
//
// Neither can catch a rename that updates both copies and the tool together but
// leaves a stale mention in ordinary prose elsewhere in the file. Saying so is
// the point: a green run here means these two things agree, not that every
// sentence about tools is true.
//
// Round 1 proved that limit on this change's own diff. `Both are rows on disk`
// sat four paragraphs below the corrected count, said two where `ArmedKind` has
// three, and neither assertion here could see it -- a prose sentence, not a
// block entry, and identical in both copies. It was a count that was right when
// there were two, which is #243's exact shape surviving one paragraph beneath
// the fix for it. Corrected in the same commit as this comment.
//
// And the population is two copies, not three: `SETUP.md` carries the same prose
// for an operator and has the same defect. It is deliberately out of reach here
// -- these tests compare the two things the loader can produce -- and is #247.

/** The left column of the indented tool block -- the prose's list of tools. */
function toolsNamedInProtocol(protocol) {
  const section = protocol.slice(protocol.indexOf('## Waking yourself later'));
  return new Set([...section.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]));
}

test('the protocol prompt names exactly the tools that exist, in both copies', () => {
  // A dummy store is enough: `buildArmedTools` captures it in handler closures
  // and this only reads `.name`. Using the real registry rather than a written
  // list is the whole point -- a hand-maintained list here would be a third copy
  // with its own lifetime, which is the defect being fixed.
  const real = new Set(
    buildArmedTools('hamachi-engineer1', {
      store: {},
      github: null,
      defaultRepo: 'NickPurcell/Clawcius',
      pollSeconds: 120,
    }).map((t) => t.name),
  );

  const fromDefaults = loadAgentConfig(
    writeConfigRaw(['standalone: true', 'crew: x', 'displayName: X']),
  ).prompts;
  const fromShipped = loadAgentConfig(
    writeConfigRaw([`extends: ${BASE}`, 'crew: x', 'displayName: X']),
  ).prompts;

  for (const [label, prompts] of [
    ['the compiled defaults', fromDefaults],
    ['the shipped base', fromShipped],
  ]) {
    const named = toolsNamedInProtocol(prompts.protocol);

    const undocumented = [...real].filter((n) => !named.has(n));
    assert.deepEqual(
      undocumented,
      [],
      `${label}: tool(s) exist that the prompt never names — ${undocumented.join(', ')}`,
    );

    // "not an armed tool" rather than "does not exist", because the set being
    // compared against is only what `buildArmedTools` returns. An agent also has
    // `checkMail` and `sendMail` from `mail-tool.ts`, and `checkMail` is already
    // named in this very section -- in backticks mid-sentence, where the `^ {4}`
    // match does not see it. If someone later documents a mail tool in the
    // indented block, this fires, and a message saying it does not exist would
    // send the reader hunting for a tool that was never deleted.
    const invented = [...named].filter((n) => !real.has(n));
    assert.deepEqual(
      invented,
      [],
      `${label}: the tool block names something that is not an armed tool — ` +
        `${invented.join(', ')}. If it is a real tool from another module, widen ` +
        'the set this compares against rather than deleting the line.',
    );
  }
});

test('every prompt template is byte-identical between the defaults and the shipped base', () => {
  // Six of the seven already agreed when this was written; `protocol` was the
  // one that did not, at 1249 characters against 2557 -- a whole older version
  // rather than a drifted sentence. So the invariant was real and observed and
  // enforced by nothing, which is the state that ends here.
  //
  // The duplication itself is deliberate and stays: `DEFAULT_PROMPTS` is what a
  // `standalone: true` config gets, and such a config has explicitly opted out
  // of the base file. Having the default READ the base would contradict that and
  // would break a deployment that ships without the YAML. So the fix is to make
  // the two provably equal, not to remove one.
  const fromDefaults = loadAgentConfig(
    writeConfigRaw(['standalone: true', 'crew: x', 'displayName: X']),
  ).prompts;
  const fromShipped = loadAgentConfig(
    writeConfigRaw([`extends: ${BASE}`, 'crew: x', 'displayName: X']),
  ).prompts;

  const keys = [...new Set([...Object.keys(fromDefaults), ...Object.keys(fromShipped)])].sort();
  assert.ok(keys.length >= 7, 'expected the full prompt set, got ' + keys.join(', '));

  for (const key of keys) {
    assert.equal(
      fromDefaults[key],
      fromShipped[key],
      `prompts.${key} differs between DEFAULT_PROMPTS and agent-config.base.yaml — ` +
        'update both, or the fallback ships text that no live agent has ever read',
    );
  }
});

// ── the boot refusal that another module's safety now rests on ──────────────

test('a quiet pattern that does not compile REFUSES at boot (#240)', () => {
  // This is not ordinary coverage. Round 2 of #240 removed the `try/catch` from
  // `matches()` in `src/armed-wake.ts` on the strength of this refusal running,
  // so the invariant is enforced in a DIFFERENT MODULE from the one relying on
  // it, and nothing failed if a refactor dropped it.
  //
  // What it costs if it goes: an uncompilable `suppress` reaches the waker, and
  // every tick throws before the watermark advances. The watch wedges — nothing
  // is delivered, including the human's comment in the same poll — and the row
  // stays armed and retries forever. Worse than the silent-match bug the
  // refusal replaced.
  // `suppress` is a LIST and `keep` is a SCALAR — the loader refuses the wrong
  // shape before it ever reaches the compile check, so the fixture differs.
  const cases = [
    { key: 'suppress', lines: ['      suppress:', "        - '('"] },
    { key: 'keep', lines: ["      keep: '('"] },
  ];
  for (const { key, lines } of cases) {
    assert.throws(
      () =>
        loadAgentConfig(
          writeConfigRaw([
            'standalone: true',
            'crew: x',
            'armed:',
            '  github:',
            '    quiet:',
            '      author: someone',
            ...lines,
          ]),
        ),
      (error) => {
        assert.match(error.message, /is not a valid regular expression/);
        assert.ok(
          error.message.includes(`armed.github.quiet.${key}`),
          `the message must name the key, or an operator cannot find it: ${error.message}`,
        );
        return true;
      },
      `an uncompilable ${key} pattern must not reach the waker`,
    );
  }
});

test('a valid quiet config still loads — or the refusal above proves nothing', () => {
  // The control. Without it, "throws" would hold just as well if the fixture
  // were malformed for some unrelated reason.
  const config = loadAgentConfig(
    writeConfigRaw([
      'standalone: true',
      'crew: x',
      'armed:',
      '  github:',
      '    quiet:',
      '      author: someone',
      '      suppress:',
      "        - '^ok'",
    ]),
  );
  assert.equal(config.armed.github.quiet.author, 'someone');
  assert.deepEqual(config.armed.github.quiet.suppress, ['^ok']);
});
