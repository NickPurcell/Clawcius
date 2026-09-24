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
      // is under test; they exist so the class can be constructed at all.
      prompts: {
        protocol: 'protocol',
        roleNotice: 'you are {{id}}',
        roleNoticeUnknown: 'you are {{id}}',
        mailWake: '{{mail}}',
        messageWake: '{{messages}}',
        messageLine: '{{author}}: {{content}}',
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

function drive({ resumeSessionId = undefined, resume = undefined } = {}) {
  installConfig();

  let emit = null;
  const pushed = [];
  const queries = [];
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
  sdk.query = ({ prompt, options }) => {
    queries.push(options);
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

  const session = new AgentSession(
    AGENT,
    tempDir('ws-'),
    resumeSessionId,
    events,
    null,
    undefined,
    { id: AGENT, crew: CREW, role: 'engineer' },
    resume,
  );

  return {
    session,
    pushed,
    /** The options every `sdk.query` was started with. */
    queries,
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

test('a dead credential still reaches onNeedsRespawn', async (t) => {
  // The auth-failure check runs after `onDone`.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = drive();
  try {
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    await h.send(refusal('authentication_failed'));
    await h.send(RESULT);

    const first = h.events.find((e) => e.kind === 'done');
    assert.equal(first.retryScheduled, true, 'the first auth failure is retried');
    assert.equal(h.session.turnPending, true, 'and its mail is deliberately unsettled');

    // The retry backoff is the only timer the session holds.
    t.mock.timers.tick(60_000);
    assert.equal(h.session.busy, true, 'the backoff rewoke the session');

    await h.send(refusal('authentication_failed'));
    await h.send(RESULT);

    assert.ok(
      h.events.some((e) => e.kind === 'respawn'),
      'an exhausted auth failure must ask for a respawn',
    );
  } finally {
    h.restore();
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

test('a turn on a CLOSED session is reported as drained (#264)', async () => {
  // close() does not stop a session: PromptQueue checks #closed once per BATCH,
  // so the batch in hand keeps yielding and every queued turn completes. The
  // session reports rather than suppresses — handlers.test.js pins the gate.
  const h = drive();
  try {
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    void h.session.close();

    await h.send(RESULT);

    const done = h.events.find((e) => e.kind === 'done');
    assert.ok(done, 'the journal keeps its completion line — this is #241 s line');
    assert.equal(done.drained, true);
  } finally {
    h.restore();
  }
});

test('a turn on a LIVE session is not — the control (#264)', async () => {
  const h = drive();
  try {
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    await h.send(RESULT);
    assert.equal(h.events.find((e) => e.kind === 'done')?.drained, false);
  } finally {
    h.restore();
  }
});

test('a closed session still SETTLES, because that is how the mail survives (#264)', async () => {
  // Why nothing skips #handle wholesale: skipping would leave a mail turn
  // unsettled, safe today only because the sweep re-offers unread rows.
  const h = drive();
  try {
    const settles = [];
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, (ran, why) =>
      settles.push({ ran, why }),
    );
    void h.session.close();

    await h.send(RESULT);

    assert.equal(settles.length, 1, 'a closed session must still account for its mail');
    assert.equal(settles[0].ran, true, 'the turn did run — it simply did not announce itself');
  } finally {
    h.restore();
  }
});

// ── safety classifier stops ──────────────────────────────────────────────────

const PARENT = '0b3f4d1e-1111-4222-8333-444455556666';
const FORK = '7c1a2b3d-2222-4333-8444-555566667777';

/** A top-level assistant message that ended cleanly: a chain entry a fork can be taken at. */
const said = (uuid) => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'ok' }] },
});

/** The classifier's stop as the CLI reports it: an error frame whose stop_reason is `refusal`. */
const classifierStop = (parent = null) => ({
  type: 'assistant',
  uuid: 'refused-frame',
  parent_tool_use_id: parent,
  error: 'invalid_request',
  message: {
    role: 'assistant',
    stop_reason: 'refusal',
    content: [{ type: 'text', text: 'API Error: Claude Code is unable to respond to this request' }],
  },
});

const flagged = {
  kind: 'messages',
  channelId: AGENT,
  messages: [
    { messageId: '1', authorId: '42', authorTag: 'someone', content: 'THE FLAGGED CONTENT', at: 1_700_000_000_000 },
  ],
};

test('a classifier stop is not retried, settles TRUE, and says it was a safety stop', async () => {
  const h = drive();
  try {
    const settles = [];
    h.session.wake(flagged, (ran, why) => settles.push({ ran, why }));
    await h.send(classifierStop());
    await h.send(RESULT);

    const done = h.events.find((e) => e.kind === 'done');
    assert.equal(done.retryScheduled, false, 'the same context would trip it again');
    assert.equal(done.noRetryReason, 'safety-stop');
    // TRUE, so a mail wake marks its mail read rather than offering it again.
    assert.equal(settles.length, 1);
    assert.equal(settles[0].ran, true);
    assert.deepEqual(h.session.safetyStop, { kind: 'messages', from: ['someone'], at: 1_700_000_000_000 });
    assert.equal(h.pushed.length, 1, 'nothing re-sent');
  } finally {
    h.restore();
  }
});

test('the structured no-fallback notice alone is a classifier stop too', async () => {
  const h = drive();
  try {
    h.session.wake(flagged, () => {});
    await h.send({ type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'm', request_id: null, content: '' });
    await h.send(RESULT);

    const done = h.events.find((e) => e.kind === 'done');
    assert.equal(done.noRetryReason, 'safety-stop');
    assert.ok(done.apiError, 'a stop with no error frame still fails the turn');
  } finally {
    h.restore();
  }
});

test("a subagent's refusal does not end the main turn", async () => {
  const h = drive();
  try {
    h.session.wake(flagged, () => {});
    await h.send({ ...classifierStop('toolu_1'), error: undefined });
    await h.send(RESULT);

    const done = h.events.find((e) => e.kind === 'done');
    assert.equal(done.apiError, null);
    assert.equal(h.session.safetyStop, null);
  } finally {
    h.restore();
  }
});

test('a mail stop names the senders and the time, never the content', async () => {
  const h = drive();
  try {
    h.session.wake(
      {
        kind: 'mail',
        channelId: AGENT,
        count: 2,
        mail: 'the mail',
        senders: [
          { author: 'clawcius-coordinator', at: 10 },
          { author: 'clawcius-coordinator', at: 20 },
        ],
      },
      () => {},
    );
    await h.send(classifierStop());
    await h.send(RESULT);

    assert.deepEqual(h.session.safetyStop, { kind: 'mail', from: ['clawcius-coordinator'], at: 20 });
  } finally {
    h.restore();
  }
});

test('the fork point is the last clean turn, not the one the classifier stopped', async () => {
  const h = drive({ resumeSessionId: PARENT, resume: { resumeAt: 'from-the-row', safetyNotice: null } });
  try {
    assert.deepEqual(h.session.resumePoint, { sessionId: PARENT, resumeAt: 'from-the-row' });

    h.session.wake(flagged, () => {});
    await h.send({ type: 'system', subtype: 'init', session_id: PARENT });
    await h.send(said('good-1'));
    await h.send({ type: 'user', uuid: 'good-2', parent_tool_use_id: null, message: { role: 'user', content: [] } });
    await h.send(said('good-3'));
    await h.send(RESULT);
    assert.deepEqual(h.session.resumePoint, { sessionId: PARENT, resumeAt: 'good-3' });

    h.session.wake(flagged, () => {});
    await h.send(said('bad-1'));
    await h.send(classifierStop());
    await h.send(RESULT);
    assert.deepEqual(
      h.session.resumePoint,
      { sessionId: PARENT, resumeAt: 'good-3' },
      'the stopped turn must not move the fork point',
    );
  } finally {
    h.restore();
  }
});

test('after a stop the session forks at the fork point, and the next turn opens with the notice once', async () => {
  const notice = 'SYSTEM: your previous turn was stopped';
  const h = drive({ resumeSessionId: PARENT, resume: { resumeAt: 'good-3', safetyNotice: notice } });
  try {
    assert.equal(h.queries.length, 1);
    assert.equal(h.queries[0].resume, PARENT);
    assert.equal(h.queries[0].resumeSessionAt, 'good-3');
    assert.equal(h.queries[0].forkSession, true);

    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1, mail: 'next', senders: [] }, () => {});
    await h.send({ type: 'system', subtype: 'init', session_id: FORK });
    await h.send(said('fork-1'));
    await h.send(RESULT);
    await new Promise((r) => setImmediate(r));
    assert.ok(h.pushed[0].message.content.startsWith(notice), 'the agent is told first');
    assert.match(h.pushed[0].message.content, /next/, 'followed by the wake itself');
    assert.deepEqual(h.session.resumePoint, { sessionId: FORK, resumeAt: 'fork-1' });

    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1, mail: 'after', senders: [] }, () => {});
    await new Promise((r) => setImmediate(r));
    assert.match(h.pushed[1].message.content, /after/);
    assert.ok(!h.pushed[1].message.content.startsWith(notice), 'told once, not every turn');
  } finally {
    h.restore();
  }
});

test('an ordinary resume does not fork', async () => {
  const h = drive({ resumeSessionId: PARENT, resume: { resumeAt: 'good-3', safetyNotice: null } });
  try {
    assert.equal(h.queries[0].resume, PARENT);
    assert.equal(h.queries[0].resumeSessionAt, undefined);
    assert.equal(h.queries[0].forkSession, undefined);
  } finally {
    h.restore();
  }
});

test('a clean turn ending in a max_output_tokens frame takes the fork point at that frame', async () => {
  const h = drive({ resumeSessionId: PARENT });
  try {
    h.session.wake(flagged, () => {});
    await h.send({ type: 'system', subtype: 'init', session_id: PARENT });
    await h.send(said('good-1'));
    await h.send({ ...said('truncated'), error: 'max_output_tokens' });
    await h.send(RESULT);
    assert.deepEqual(h.session.resumePoint, { sessionId: PARENT, resumeAt: 'truncated' });
  } finally {
    h.restore();
  }
});

test('a stop names every wake the turn took in, not only the newest', async () => {
  const h = drive();
  try {
    h.session.wake(flagged, () => {});
    h.session.wake(
      { ...flagged, messages: [{ ...flagged.messages[0], messageId: '2', authorTag: 'later', at: 1_700_000_000_500 }] },
      () => {},
    );
    await h.send(classifierStop());
    await h.send(RESULT);
    assert.deepEqual(h.session.safetyStop, {
      kind: 'messages',
      from: ['someone', 'later'],
      at: 1_700_000_000_500,
    });
  } finally {
    h.restore();
  }
});

test('a fork owes its notice until a clean turn, through a failed one', async () => {
  const notice = 'SYSTEM: your previous turn was stopped';
  const h = drive({ resumeSessionId: PARENT, resume: { resumeAt: 'good-3', safetyNotice: notice } });
  try {
    assert.equal(h.session.forkPending, true);
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1, mail: 'next', senders: [] }, () => {});
    await h.send(refusal('billing_error'));
    await h.send(RESULT);
    assert.equal(h.session.forkPending, true, 'an ordinary failure is not a clean turn');

    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1, mail: 'again', senders: [] }, () => {});
    await h.send(RESULT);
    assert.equal(h.session.forkPending, false);
  } finally {
    h.restore();
  }
});
