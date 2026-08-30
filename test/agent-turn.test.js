import { mock, test } from 'node:test';
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
      // is under test; they exist so the class can be constructed at all.
      prompts: {
        protocol: 'protocol',
        roleNotice: 'you are {{id}}',
        roleNoticeUnknown: 'you are {{id}}',
        mailWake: '{{mail}}',
        discord: '{{text}}',
        armed: '{{note}}',
      },
      paths: { discordCli: '/bin/true' },
      systemPrompt: { append: '', useClaudeCodeDefault: false },
      // `githubTokenDir` is DERIVED from `stateDir` by the loader, which is what stops one crew writing its token into another's directory.
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

  const session = new AgentSession(AGENT, tempDir('ws-'), undefined, events, null, undefined, {
    id: AGENT,
    crew: CREW,
    role: 'engineer',
  });

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

/** An API-level refusal, which arrives as an ordinary assistant message. */
const refusal = (kind) => ({
  type: 'assistant',
  // The flag lives on the SDK wrapper and IS the kind — see `#handle`'s
  // `case 'assistant'`. The detail is read out of the content blocks.
  error: kind,
  message: { role: 'assistant', content: [{ type: 'text', text: `API Error: ${kind}` }] },
});

// ── the settle comes before the busy flip ────────────────────────────────────

test('a successful turn settles TRUE, and settles its OWN turn', async () => {
  const h = drive();
  try {
    const settles = [];
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, (ran, why) =>
      settles.push({ ran, why }),
    );
    assert.equal(h.session.busy, true, 'the turn is in flight');

    await h.send(RESULT);

    // With `busy = false` published before the settle, the sweep fires into the gap and re-offers the same mail.
    assert.deepEqual(settles, [{ ran: true, why: 'turn completed' }]);
  } finally {
    h.restore();
  }
});

test('the turn is settled BEFORE `busy` is published, because busy is a broadcast', async () => {
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

// ── the sentry kill path ─────────────────────────────────────────────────────

test('a turn that dies asynchronously settles FALSE and says so', async () => {
  // The gVisor sentry kill arrives through `#consume`'s catch.
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

test('!stop actually stops: interrupt settles TRUE, before the flip', async () => {
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

// ── the flip must come after everything that reads the turn ──────────────────

test('onDone still sees the turn s error after a non-retryable refusal', async () => {
  const h = drive();
  try {
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    await h.send(refusal('billing_error'));
    await h.send(RESULT);

    const done = h.events.find((e) => e.kind === 'done');
    assert.ok(done, 'the turn must report');
    assert.equal(done.apiErrorKind, 'billing_error', 'the refusal must survive to onDone');
    assert.ok(done.apiError, 'and carry its message, which is what the journal quotes');
  } finally {
    h.restore();
  }
});

test('a dead credential still reaches onNeedsRespawn', async () => {
  // The auth-failure check runs after `onDone`.
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = drive();
  try {
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    await h.send(refusal('authentication_failed'));
    await h.send(RESULT);

    const first = h.events.find((e) => e.kind === 'done');
    assert.equal(first.retryScheduled, true, 'the first auth failure is retried');
    assert.equal(h.session.turnPending, true, 'and its mail is deliberately unsettled');

    // The retry backoff is the only timer the session holds; fire it and let the rewake start.
    mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));

    await h.send(refusal('authentication_failed'));
    await h.send(RESULT);

    assert.ok(
      h.events.some((e) => e.kind === 'respawn'),
      'an exhausted auth failure must ask for a respawn',
    );
  } finally {
    h.restore();
    mock.timers.reset();
  }
});

test('!stop during a retry BACKOFF settles, or the agent goes deaf forever', async () => {
  const h = drive();
  try {
    const settles = [];
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, (ran, why) =>
      settles.push({ ran, why }),
    );
    await h.send(refusal('server_error'));
    await h.send(RESULT);

    // A retryable refusal leaves the turn deliberately unsettled and the session
    // idle for the backoff — the state the early return exists for.
    assert.equal(h.session.busy, false, 'a backoff is idle');
    assert.equal(h.session.turnPending, true, 'and its turn is deliberately unsettled');

    await h.session.interrupt();

    assert.equal(h.session.turnPending, false, 'interrupt must clear the pending turn');

    assert.equal(settles.length, 1);
    assert.equal(settles[0].ran, false, 'mail nobody has seen is not mail that was read');
    assert.match(settles[0].why, /never ran/);
  } finally {
    h.restore();
  }
});
