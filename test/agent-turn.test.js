/**
 * A REAL `AgentSession`, driven by SDK messages a test controls.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Everything reachable only through `wake`, `#push`, `#handle` or `#consume`
 * had no coverage at all, because `AgentSession`'s constructor stood up a
 * containerised `claude` and no test could construct one. The suite was green
 * and said nothing about any of it.
 *
 * Two independent proofs of that, both from #241:
 *
 *  1. Five mutations of the turn-settle logic — never clearing the callback,
 *     deleting the supersede, ignoring the callback `wake` is handed, deleting
 *     the push catch's settle, settling TRUE through an API refusal — passed
 *     the full suite. 391 green, five times. Two of the five lose mail.
 *
 *  2. OJ round 2 found that the settle firing at the end of turn N belonged to
 *     turn N+1, so every successful mail wake ran its turn TWICE and logged the
 *     one that completed as dead. No test could have caught it: the pieces were
 *     only ever tested apart.
 *
 * So the tests below run the actual objects — `AgentSession`, `SessionManager`,
 * `MailWaker`, `MailStore` and the daemon's wiring — with the SDK's `query`
 * replaced. That is the whole stub. Clawcius #242 tracks the rest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSession, sdk } from '../dist/agent.js';
import { setConfig } from '../dist/config.js';

const CREW = 'hamachi';
const AGENT = 'hamachi-engineer1';

const tempDir = (p) => mkdtempSync(join(tmpdir(), p));

function installConfig() {
  setConfig({
    discord: { token: 'unused', guildId: 'unused' },
    github: { token: '' },
    storage: { dbPath: 'unused' },
    agent: {
      clawsky: { crew: CREW, wakeOnMail: true },
      model: 'model',
      modelByRole: {},
      maxTurns: 0,
      // The prompt builders and the container spawner read these. Nothing here
      // is under test — they exist so the class can be constructed at all,
      // which is the whole reason this file could not be written before.
      prompts: { protocol: 'protocol', mailWake: '{{mail}}', discord: '{{text}}', armed: '{{note}}' },
      paths: { discordCli: '/bin/true' },
      systemPrompt: { append: '', useClaudeCodeDefault: false },
      // `githubTokenDir` is DERIVED from `stateDir` by the loader — that
      // derivation is what stops one crew writing its token into another's
      // directory, and it stays in the loader. This is `setConfig`, which is
      // below it, so the value is supplied here the way the loader would have.
      container: {
        image: 'none',
        execEnvDir: tempDir('env-'),
        stateDir: tempDir('state-'),
        githubTokenDir: tempDir('tok-'),
      },
      git: { userName: 'test', userEmail: 'test@example.invalid' },
      sessions: { maxConcurrent: 4, idleTimeoutMinutes: 0, workspaceRoot: tempDir('wsroot-') },
    },
  });
}

/**
 * A session whose turns end when the test says so.
 *
 * `query` returns the object `#consume` iterates, so pushing a message here is
 * exactly what the SDK does to a real session — `#handle` runs the shipped code
 * path, including the `busy` broadcast whose ordering is what round 2 was about.
 */
function drive() {
  installConfig();

  let emit = null;
  const pushed = [];
  const messages = [];

  const stream = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = await new Promise((resolve) => {
          emit = resolve;
        });
        if (next === null) return;
        // How the sentry kill actually arrives: the SDK's iterator throws, and
        // `#consume`'s catch is the only thing that sees it.
        if (next && next.__throw) throw next.__throw;
        yield next;
      }
    },
    interrupt: async () => {},
  };

  const real = sdk.query;
  sdk.query = ({ prompt }) => {
    // Drain the prompt queue in the background so `#push` behaves as it does in
    // production — the session believes its turn was handed over.
    (async () => {
      for await (const m of prompt) pushed.push(m);
    })().catch(() => {});
    return stream;
  };

  const events = {
    onToolUse: () => {},
    onCliFailure: () => {},
    onDone: (d) => messages.push({ kind: 'done', ...d }),
    onError: (e) => messages.push({ kind: 'error', message: String(e) }),
    onNeedsRespawn: () => messages.push({ kind: 'respawn' }),
  };

  const session = new AgentSession(AGENT, tempDir('ws-'), undefined, events, null, undefined);

  return {
    session,
    pushed,
    events: messages,
    /** Deliver one SDK message and let `#consume` process it. */
    async send(message) {
      const go = emit;
      emit = null;
      go(message);
      // Two macrotask hops: one for the generator to resume, one for `#handle`.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    /** Kill the stream the way a dead transport does — asynchronously. */
    async die(error) {
      const go = emit;
      emit = null;
      go({ __throw: error });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    restore: () => {
      sdk.query = real;
    },
  };
}

const RESULT = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01 };

// ── the defect round 2 found ─────────────────────────────────────────────────

test('a successful turn settles TRUE, and settles its OWN turn (#241 round 2)', async () => {
  const h = drive();
  try {
    const settles = [];
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, (ran, why) =>
      settles.push({ ran, why }),
    );
    assert.equal(h.session.busy, true, 'the turn is in flight');

    await h.send(RESULT);

    // THE REGRESSION: with `busy = false` published before the settle, the
    // daemon's sweep fired into the gap, re-offered the same mail, and `adopt`
    // settled this completed turn FALSE — then the settle below fired the NEXT
    // turn's callback. Every successful mail wake ran twice and reported the
    // one that succeeded as dead.
    assert.deepEqual(settles, [{ ran: true, why: 'turn completed' }]);
  } finally {
    h.restore();
  }
});

test('the turn is settled BEFORE `busy` is published, because busy is a broadcast', async () => {
  // The ordering IS the fix, so it is asserted directly rather than through its
  // consequence: the busy setter calls `onBusyChanged` synchronously, and the
  // daemon hangs `mailWaker.sweep()` off that. Anything observing the flip must
  // find the turn already accounted for.
  const h = drive();
  try {
    const seen = [];
    h.session.onBusyChanged = () => seen.push({ busy: h.session.busy, pending: h.session.turnPending });
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});

    await h.send(RESULT);

    const flip = seen.find((s) => s.busy === false);
    assert.ok(flip, 'the turn must publish an idle transition');
    assert.equal(
      flip.pending,
      false,
      'a sweep firing on this transition would re-offer mail the turn already consumed',
    );
  } finally {
    h.restore();
  }
});

// ── the path that actually bit, and was silent ───────────────────────────────

test('a turn that dies asynchronously settles FALSE and says so (#239)', async () => {
  // The gVisor sentry kill arrives through `#consume`'s catch. The mail was
  // safe here only because the daemon releases the session and the sweep
  // re-offers it — safe by the daemon's grace, with the journal line this whole
  // PR is about never printing.
  const h = drive();
  try {
    const settles = [];
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, (ran, why) =>
      settles.push({ ran, why }),
    );

    await h.die(new Error('sentry died'));

    assert.equal(settles.length, 1, 'the turn must not die silently');
    assert.equal(settles[0].ran, false, 'mail whose turn died is not mail that was read');
    assert.match(settles[0].why, /the turn died/);
  } finally {
    h.restore();
  }
});

test('!stop actually stops: interrupt settles TRUE, before the flip (#241 round 2)', async () => {
  // `interrupt` set `busy = false` without settling, and that flip broadcasts
  // into `mailWaker.sweep()` — which found the mail unread and started the same
  // turn again. `!stop` stopped nothing.
  //
  // TRUE rather than FALSE because the turn RAN. #239's rule is that mail
  // survives a turn that never ran; a turn a person cut short is not that, and
  // re-delivering the message that started it is the one outcome they ruled out.
  const h = drive();
  try {
    const settles = [];
    const seen = [];
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, (ran, why) =>
      settles.push({ ran, why }),
    );
    h.session.onBusyChanged = () => seen.push({ busy: h.session.busy, pending: h.session.turnPending });

    await h.session.interrupt();

    assert.deepEqual(settles, [{ ran: true, why: 'interrupted by !stop' }]);
    const flip = seen.find((s) => s.busy === false);
    assert.ok(flip, 'interrupt must publish an idle transition');
    assert.equal(flip.pending, false, 'a sweep on this transition would restart the turn just stopped');
  } finally {
    h.restore();
  }
});
