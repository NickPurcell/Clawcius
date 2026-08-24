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
      prompts: {
        protocol: 'protocol',
        // #234 added these two: a role the crew does not define gets a
        // different template rather than a decorated value.
        roleNotice: 'you are {{id}}',
        roleNoticeUnknown: 'you are {{id}}',
        mailWake: '{{mail}}',
        discord: '{{text}}',
        armed: '{{note}}',
      },
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

  // `identity` is REQUIRED as of #234 — deliberately, so a missing one fails the
  // build rather than rendering `crew ``, role `(not a role this crew defines)`
  // into a live model's context. Nothing here tests it; it exists so the class
  // can be constructed.
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
    /**
     * Wait until `n` prompts have been pushed, or give up loudly.
     *
     * NOT a fixed sleep. The retried push arrives at 1999–2004ms against a
     * 2_400ms sleep — ~400ms of slack, and the spread widens as the suite grows
     * and `node --test` runs files concurrently. When it trips it trips
     * `assert.equal(h.pushed.length, 2)`, which reads as a regression in the
     * retry path rather than as a slow machine. Polling is deterministic and
     * faster: these two tests were ~4.8s of the suite.
     *
     * IT WAITS FOR **AT LEAST** `n`, so it does not replace an exact-count
     * assertion — it only gates the array read that follows. Removing
     * `assert.equal(h.pushed.length, 2)` along with the sleeps cost a real
     * detection: a `#rewake()` that pushes twice was caught before the refactor
     * and not after. Both callers assert the exact count immediately after.
     */
    async waitForPushes(n, capMs = 8_000) {
      const started = Date.now();
      while (pushed.length < n) {
        if (Date.now() - started > capMs) {
          throw new Error(`only ${pushed.length} of ${n} prompts pushed within ${capMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    restore: () => {
      sdk.query = real;
    },
  };
}

const RESULT = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01 };

/** An assistant turn that called a tool — the thing a retry must not replay. */
const toolUse = (command = 'echo hi') => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }],
  },
});

/** An API-level refusal, which arrives as an ordinary assistant message. */
const refusal = (kind) => ({
  type: 'assistant',
  // The flag lives on the SDK wrapper and IS the kind — see `#handle`'s
  // `case 'assistant'`. The detail is read out of the content blocks.
  error: kind,
  message: { role: 'assistant', content: [{ type: 'text', text: `API Error: ${kind}` }] },
});

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

// ── round 3: the flip must come after everything that reads the turn ─────────

test('onDone still sees the turn s error after a non-retryable refusal (#241 round 3)', async () => {
  // Round 2 moved the settle above the flip and left `onDone` below it. `onDone`
  // reads `#apiErrorThisTurn`, `#apiErrorKindThisTurn` and `#sentThisTurn` — the
  // exact fields the re-entrant `#push` clears — so a sweep firing on the flip
  // wiped them first and the four-line `mail wake REFUSED` block never printed.
  // The Discord path lost `API REFUSED THE TURN` and `announceOutage` with it.
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

test('the busy flip is the LAST thing a finished turn does (#241 round 3)', async () => {
  // Asserted structurally rather than through one consequence, because the
  // consequence differs per path — onDone loses a refusal, the respawn branch
  // loses the only recovery from a dead credential. Anything observing the flip
  // must find a turn that is finished in every sense.
  const h = drive();
  try {
    let seenAtFlip = null;
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    h.session.onBusyChanged = () => {
      if (h.session.busy === false) seenAtFlip = h.events.map((e) => e.kind);
    };
    await h.send(refusal('billing_error'));
    await h.send(RESULT);

    assert.ok(seenAtFlip, 'the turn must publish an idle transition');
    assert.ok(
      seenAtFlip.includes('done'),
      'onDone must have already run when the flip is observed — it reads fields #push clears',
    );
  } finally {
    h.restore();
  }
});

test('a dead credential still reaches onNeedsRespawn (#241 round 3)', async () => {
  // The auth-failure check runs after `onDone`, so it sat behind the same wipe.
  // Respawn is the ONLY thing that recovers a token this process will never
  // re-read; without it the agent loops 401ing turns against a session that
  // cannot work, with nothing in stderr saying why.
  //
  // The retry must be allowed to FIRE rather than re-waking: `wake` resets
  // `#retries`, so a test that wakes again never exhausts the plan and never
  // reaches the branch under test. There is exactly one auth retry, at 2s.
  const h = drive();
  try {
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    await h.send(refusal('authentication_failed'));
    await h.send(RESULT);

    const first = h.events.find((e) => e.kind === 'done');
    assert.equal(first.retryScheduled, true, 'the first auth failure is retried');
    assert.equal(h.session.turnPending, true, 'and its mail is deliberately unsettled');

    await new Promise((r) => setTimeout(r, 2_400));

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

test('!stop during a retry BACKOFF settles, or the agent goes deaf forever (#241 round 3)', async () => {
  // The worst of round 3. `interrupt` returned early on `!this.busy` — and a
  // backoff is exactly when busy is false and a settle is pending. With `isBusy`
  // now `busy || turnPending`, that pending settle was never cleared and the
  // waker skipped the agent FOR THE LIFE OF THE PROCESS: session never released,
  // `idleTimeoutMinutes: 0` never evicts, mail piling up unread with no line
  // anywhere saying so. Reachable from a Discord `!stop`.
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

    // FALSE, not TRUE. A backoff is a turn the API REFUSED — it produced
    // nothing and nobody read the mail. `!stop` cancels the retry that was
    // going to re-run it, so marking the message read would consume it having
    // never shown it to anybody: silent loss, in the change written to end
    // silent loss. Round 4.
    assert.equal(settles.length, 1);
    assert.equal(settles[0].ran, false, 'mail nobody has seen is not mail that was read');
    assert.match(settles[0].why, /never ran/);
  } finally {
    h.restore();
  }
});

// ── #242: the behaviours a green suite said nothing about ───────────────────
//
// Measured, not assumed. Every mutation below passed the full suite before
// these tests existed — six for six, 429 green each time:
//
//   replay-vs-continuation inverted          # pass 429 # fail 0
//   a replayed mail wake marked NON-synthetic # pass 429 # fail 0
//   #actedSinceWake never set                 # pass 429 # fail 0
//   the session id from `init` dropped        # pass 429 # fail 0
//   the retry timer no longer unref'd         # pass 429 # fail 0
//   respawn fires for ANY error kind          # pass 429 # fail 0
//
// #241 installed the `sdk` seam so a real session can be driven. This is what
// that seam was for: the seam is not the fix, the coverage is.

test('a retry after a tool call CONTINUES; a retry after none REPLAYS (#242)', async () => {
  // The distinction is the whole reason `#actedSinceWake` exists. A verbatim
  // replay of a turn that already ran tools would double their effects — files
  // rewritten, a Discord message posted twice — which the continuation prompt
  // says outright: "their effects are real".
  const h = drive();
  try {
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    await h.send(toolUse());
    // `authentication_failed`, whose single backoff is 2s — the transient plan
    // starts at 5s and this test only needs the retry to fire, not which plan.
    await h.send(refusal('authentication_failed'));
    await h.send(RESULT);
    await h.waitForPushes(2);

    // EXACTLY two, not at least two. `waitForPushes` gates the array read; this
    // pins that the retry ran ONCE. Dropping it alongside the sleep cost a real
    // detection — OJ made `#rewake()` push twice and this file caught it before
    // the refactor and not after. AUTH_RETRY_DELAYS_MS has one entry, so a
    // second push here is a retry that fired twice.
    assert.equal(h.pushed.length, 2, 'the retry must run exactly once');

    const retried = String(h.pushed[1].message.content);
    assert.match(retried, /cut short by an API error/, 'a turn that acted must CONTINUE');
    assert.match(retried, /do not repeat completed work/);
  } finally {
    h.restore();
  }
});

test('a retry with no tool call replays the wake verbatim, and stays synthetic (#242)', async () => {
  // Two claims in one place because they are one decision: `#rewake` picks the
  // text AND the synthetic flag from the same field, and `synthetic` is how a
  // mail wake tells the model nobody typed it.
  const h = drive();
  try {
    h.session.wake({ kind: 'mail', channelId: AGENT, mail: 'look at #31', count: 1 }, () => {});
    await h.send(refusal('authentication_failed'));
    await h.send(RESULT);
    await h.waitForPushes(2);
    assert.equal(h.pushed.length, 2, 'the retry must run exactly once');

    const retried = String(h.pushed[1].message.content);
    assert.doesNotMatch(retried, /cut short by an API error/, 'nothing ran, so nothing to continue');
    assert.equal(
      retried,
      String(h.pushed[0].message.content),
      'a turn that did nothing is replayed verbatim',
    );
    assert.equal(h.pushed[1].isSynthetic, true, 'a replayed mail wake is still nobody typing');
  } finally {
    h.restore();
  }
});

test('the session id is taken from the SDK init message (#242)', async () => {
  // Until `init` arrives the id is a placeholder. Dropping the capture means
  // every resume starts a cold conversation — silently, since a cold session
  // answers perfectly well and only the transcript is missing.
  const h = drive();
  try {
    assert.match(h.session.sessionId, /^pending-/, 'a placeholder until the SDK says otherwise');
    await h.send({ type: 'system', subtype: 'init', session_id: 'real-session-abc' });
    assert.equal(h.session.sessionId, 'real-session-abc');
  } finally {
    h.restore();
  }
});

test('respawn is for a dead CREDENTIAL, not for any exhausted error (#242)', async () => {
  // `onNeedsRespawn` drops the session out of the pool. Firing it for an
  // ordinary refusal would throw away a working session — and the transcript
  // with it — every time the API said no.
  const h = drive();
  try {
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    await h.send(refusal('billing_error'));
    await h.send(RESULT);

    const done = h.events.find((e) => e.kind === 'done');
    assert.ok(done, 'the turn ended');

    // PIN THE PREMISE, or this test can stop testing without failing. It proves
    // its point only because `retryPlanFor('billing_error')` returns null, so
    // `willRetry` is false and the auth-failure `else if` is actually reached.
    // Add `billing_error` to TRANSIENT_ERRORS one day and `willRetry` becomes
    // true, the branch is never evaluated, and this keeps passing while no
    // longer able to catch the mutation it was written for. The `done` event
    // already carries the fact, so pinning it costs one line. OJ #255 round 2.
    assert.equal(
      done.retryScheduled,
      false,
      'the respawn branch is only reached when no retry was queued — if this ' +
        'fails, this test has stopped exercising the branch it names',
    );
    assert.equal(
      h.events.some((e) => e.kind === 'respawn'),
      false,
      'a billing error is not a dead credential',
    );
  } finally {
    h.restore();
  }
});

test('the retry timer is unref d, so a backoff cannot hold the process open (#242)', async () => {
  // "Never hold the process open for a retry: a shutdown mid-backoff should
  // exit, not linger." A missing `unref()` does not fail anything — it makes
  // the daemon hang for up to 45 seconds on shutdown, which reads as a slow
  // deploy rather than as a bug, and no test could see it because the timer is
  // private. Captured at `setTimeout` instead, which is where it is created.
  // PATCHED AFTER `drive()`, not before. The patch used to sit above it with
  // `drive()` outside the `try`, so a throw in `drive()` left
  // `globalThis.setTimeout` monkeypatched for every later test in the file. The
  // blast radius was zero only because this test happens to be last —
  // positional luck — and it inverts the debugging order: the test that broke
  // things passes and its successors fail strangely.
  const h = drive();
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  try {
    globalThis.setTimeout = (...args) => {
      const t = realSetTimeout(...args);
      timers.push(t);
      return t;
    };
    h.session.wake({ kind: 'mail', channelId: AGENT, count: 1 }, () => {});
    await h.send(refusal('authentication_failed'));
    await h.send(RESULT);

    const retryTimer = timers.find((t) => typeof t.hasRef === 'function' && !t.hasRef());
    assert.ok(retryTimer, 'the retry backoff must not keep the event loop alive');
  } finally {
    h.session.close?.();
    globalThis.setTimeout = realSetTimeout;
    h.restore();
  }
});
