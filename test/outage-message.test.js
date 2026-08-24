/**
 * What a human is told when a turn was refused and nothing is coming.
 *
 * THE DEFECT THESE PIN IS NOT A CRASH. It is a sentence. The operator met this,
 * twice, on 2026-08-23 at 23:07 and 23:10 PDT, against Anthropic 529s:
 *
 *     ⚠️ I could not run that turn — the API refused it (`server_error`).
 *        Retries are exhausted or would not help, so this needs a look at the host.
 *
 * Every clause of it failed them. `needs a look at the host` sent them to our
 * machine for a fault that was entirely upstream. `server_error` is the SDK's
 * token where the API's own words — "529 Overloaded … try again in a moment" —
 * were sitting unused on the same object. And `exhausted OR would not help`
 * covers both cases, so it states neither, and the two want opposite actions.
 *
 * So these assert on PROSE, deliberately, and against the three facts the
 * message has to carry rather than against its exact wording: whose fault it
 * is, whether they were heard, and what to do. Wording should be free to
 * improve; a branch that stops saying whose fault it is should not be.
 *
 * The negative assertions are the load-bearing half. It is easy to write a
 * message that says the right thing AND the wrong thing, and a reader acts on
 * whichever they read first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { outageMessage, noRetryJournalReason } from '../dist/daemon.js';

/** The 529 the operator actually hit, as the SDK reports it. */
const OVERLOADED =
  '529 Overloaded — the API is temporarily unable to take new requests. ' +
  'This is usually temporary — try again in a moment.';

const summary = (over) => ({
  apiErrorKind: 'server_error',
  apiError: OVERLOADED,
  ...over,
});

test('an exhausted transient blames upstream, and never sends them to the host', () => {
  const text = outageMessage(summary({ noRetryReason: 'exhausted' }));

  assert.match(text, /Anthropic/, 'must name whose side the fault is on');
  assert.match(text, /their side, not ours/);
  assert.match(text, /529 Overloaded/, "must carry the API's own words, not the SDK's token");
  assert.match(text, /did not reach me/, 'must say whether they were heard');
  assert.match(text, /try again in a few minutes/i, 'must say what to do');

  // THE ORIGINAL DEFECT, asserted as an absence. This is the clause that sent a
  // human to inspect our machine while Anthropic was overloaded.
  assert.doesNotMatch(text, /look at the host/, 'a 529 is not a host problem');
  assert.doesNotMatch(text, /server_error/, 'the SDK token is not a fact anyone can act on');
});

test('an abandoned retry says the session was cleared, not that anything is broken', () => {
  // Rungs were left and something on THIS side took them away — `!reset`,
  // `!stop`, or a session dropped because its child process died. Confirmed as
  // real from the host traces: two of nine refusals on 2026-08-24 took this
  // exit, one of them within seconds of a `!reset`.
  const text = outageMessage(summary({ noRetryReason: 'abandoned' }));

  assert.match(text, /session was cleared/, 'must name what actually happened');
  assert.match(text, /did not reach me/);
  assert.match(text, /[Ss]end it again/, 'the action here is re-send, not wait');

  assert.doesNotMatch(text, /look at the host/, 'nothing on the host is wrong in this case');
  assert.doesNotMatch(
    text,
    /standing condition|does not clear on its own/,
    'the error was transient — it was the retry that went away, not the error',
  );
});

test('a standing condition is the ONE branch that keeps the host sentence', () => {
  // The sentence was never wrong. It was wrong unconditionally. `billing_error`
  // and its kin reproduce exactly on a retry, and a human going to look is
  // precisely the right response.
  const text = outageMessage({
    apiErrorKind: 'billing_error',
    apiError: 'Your credit balance is too low.',
    noRetryReason: 'not-retryable',
  });

  assert.match(text, /look at the host/, 'this is the case that genuinely needs one');
  assert.match(text, /standing condition/);
  assert.match(text, /billing_error/, 'the machine-readable kind belongs HERE, to be looked up');
  assert.match(text, /did not reach me/);

  assert.doesNotMatch(text, /try again/i, 'retrying reproduces the same answer');
});

test('every branch tells them whether they were heard', () => {
  // The operator's second complaint, and the one easiest to lose while fixing
  // the first: their message was silently eaten. Whatever else a branch says,
  // it must answer that.
  for (const reason of ['exhausted', 'abandoned', 'not-retryable']) {
    assert.match(
      outageMessage(summary({ noRetryReason: reason })),
      /did not reach me/,
      `the ${reason} branch does not say whether the message was heard`,
    );
  }
});

test('a missing apiError does not produce a dangling sentence', () => {
  // `apiError` is the API's own text and there is no guarantee it arrives.
  // Every branch has to read as a whole sentence without it — which is why the
  // action lives in our half of the message rather than being borrowed from
  // theirs.
  for (const reason of ['exhausted', 'abandoned', 'not-retryable']) {
    const text = outageMessage({ apiErrorKind: 'server_error', apiError: null, noRetryReason: reason });
    assert.doesNotMatch(text, /: *\n/, `${reason}: colon with nothing after it`);
    assert.doesNotMatch(text, /—\s*\n/, `${reason}: dash with nothing after it`);
    assert.match(text, /did not reach me/, `${reason}: lost the heard-you line`);
  }
});

test('the journal names the mechanism, and stops claiming a transient is permanent', () => {
  // `not retrying — this one does not clear on its own` was printed for EVERY
  // refusal with no retry queued. For a transient kind it is false by all three
  // exits from `willRetry`: ladder spent, session closed, context cleared. A
  // 529 clears on its own by definition — that is what puts it in
  // `TRANSIENT_ERRORS` at all.
  assert.match(noRetryJournalReason({ noRetryReason: 'exhausted' }), /every retry was spent/);
  assert.match(noRetryJournalReason({ noRetryReason: 'abandoned' }), /retries left/);
  assert.match(
    noRetryJournalReason({ noRetryReason: 'not-retryable' }),
    /does not clear on its own/,
    'the original line survives where it is true',
  );

  for (const reason of ['exhausted', 'abandoned']) {
    assert.doesNotMatch(
      noRetryJournalReason({ noRetryReason: reason }),
      /does not clear on its own/,
      `${reason} is transient — it clears on its own by definition`,
    );
  }
});

test('an unknown reason falls back to the standing-condition wording, not to silence', () => {
  // `noRetryReason` is optional on the type and older summaries will not carry
  // it. The default branch has to be the conservative one: telling somebody to
  // look when they need not is recoverable, and telling them to wait forever on
  // a dead credential is not.
  const text = outageMessage({ apiErrorKind: 'whatever', apiError: null, noRetryReason: undefined });
  assert.match(text, /look at the host/);
  assert.match(text, /did not reach me/);
});

// ── the classifier that decides which of the three a human is shown ─────────
//
// EXTRACTED BECAUSE IT WAS UNTESTABLE AND THEREFORE UNTESTED. Mutating it inside
// `AgentSession` to answer `not-retryable` for everything passed the entire
// suite — 437 green while every 529 would have been reported as a standing
// condition needing a look at the host. The messages above were covered; the
// thing that decides which message fires was not.
//
// That is the day's shape once more: the unit under test was smaller than the
// unit that had to be correct.

import { classifyRetry } from '../dist/agent.js';

const state = (over) => ({
  errorKind: 'server_error',
  failed: true,
  retriesSpent: 0,
  closed: false,
  hasContext: true,
  ...over,
});

test('a transient with rungs left retries, and has no reason to report', () => {
  const { willRetry, noRetryReason } = classifyRetry(state());
  assert.equal(willRetry, true);
  assert.equal(noRetryReason, null, 'a queued retry is not yet news');
});

test('a transient that spent every rung is `exhausted`, not `not-retryable`', () => {
  // TRANSIENT_RETRY_DELAYS_MS has three rungs, so index 3 is past the end.
  const { willRetry, noRetryReason } = classifyRetry(state({ retriesSpent: 3 }));
  assert.equal(willRetry, false);
  assert.equal(noRetryReason, 'exhausted');
});

test('a closed session abandons a ladder that still had rungs', () => {
  // The `!reset` case, confirmed from the host traces: `release()` closes the
  // session, and a retry pending on it is dropped with rungs left. Correct
  // behaviour — the human asked for a fresh session — but it is NOT exhaustion
  // and must not be reported as one.
  const { willRetry, noRetryReason } = classifyRetry(state({ closed: true }));
  assert.equal(willRetry, false);
  assert.equal(noRetryReason, 'abandoned', 'rungs were left; something took them away');
});

test('a cleared context abandons the ladder too — the `!stop` exit', () => {
  // `interrupt()` sets `#lastContext` to null. Distinct from `closed`, same
  // answer, and both are `abandoned` rather than `exhausted`.
  const { noRetryReason } = classifyRetry(state({ hasContext: false }));
  assert.equal(noRetryReason, 'abandoned');
});

test('a standing condition is `not-retryable` however many rungs are notionally left', () => {
  for (const kind of ['billing_error', 'invalid_request', 'model_not_found']) {
    const { willRetry, noRetryReason } = classifyRetry(state({ errorKind: kind }));
    assert.equal(willRetry, false, `${kind} must not retry`);
    assert.equal(noRetryReason, 'not-retryable', kind);
  }
});

test('a turn that did not fail has no reason at all', () => {
  // Guards the field's meaning: `noRetryReason` is about a REFUSED turn. A
  // successful turn carrying "not-retryable" would be true-looking nonsense on
  // every summary the daemon logs.
  const { noRetryReason } = classifyRetry(state({ failed: false, errorKind: null }));
  assert.equal(noRetryReason, null);
});

test('exhaustion and abandonment are distinguished at the boundary rung', () => {
  // The two states differ by ONE input and produce opposite advice — wait,
  // versus send it again. Pinned adjacently so the pair cannot drift apart.
  assert.equal(classifyRetry(state({ retriesSpent: 3 })).noRetryReason, 'exhausted');
  assert.equal(classifyRetry(state({ retriesSpent: 2, closed: true })).noRetryReason, 'abandoned');
  assert.equal(classifyRetry(state({ retriesSpent: 2 })).willRetry, true);
});
