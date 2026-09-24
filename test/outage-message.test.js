import { test } from 'node:test';
import assert from 'node:assert/strict';

import { outageMessage, noRetryJournalReason } from '../dist/daemon.js';

/** A 529, as the SDK reports it. */
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

  assert.doesNotMatch(text, /look at the host/, 'a 529 is not a host problem');
  assert.doesNotMatch(text, /server_error/, 'the SDK token is not a fact anyone can act on');
});

test('an abandoned retry says the session was cleared, not that anything is broken', () => {
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
  // Whatever else a branch says, it must say the message did not get through.
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
  for (const reason of ['exhausted', 'abandoned', 'not-retryable']) {
    const text = outageMessage({ apiErrorKind: 'server_error', apiError: null, noRetryReason: reason });
    assert.doesNotMatch(text, /: *\n/, `${reason}: colon with nothing after it`);
    assert.doesNotMatch(text, /—\s*\n/, `${reason}: dash with nothing after it`);
    assert.match(text, /did not reach me/, `${reason}: lost the heard-you line`);
  }
});

test('the journal names the mechanism, and stops claiming a transient is permanent', () => {
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
  // `noRetryReason` is optional on the type and older summaries will not carry it.
  const text = outageMessage({ apiErrorKind: 'whatever', apiError: null, noRetryReason: undefined });
  assert.match(text, /look at the host/);
  assert.match(text, /did not reach me/);
});

// ── the classifier that decides which of the three a human is shown ─────────

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
  // The `!reset` case: `release()` closes the session, and a retry pending on it is dropped with rungs left.
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

test('a spent AUTH ladder is a dead credential, not a transient that ran out of time', () => {
  const spent = classifyRetry(
    state({ errorKind: 'authentication_failed', retriesSpent: 1 }),
  );
  assert.equal(spent.willRetry, false, 'the auth ladder has one rung');
  assert.equal(spent.noRetryReason, 'credential-dead');

  const text = outageMessage({
    apiErrorKind: 'authentication_failed',
    apiError: 'OAuth token revoked',
    noRetryReason: 'credential-dead',
  });
  assert.match(text, /did not reach me/);
  assert.doesNotMatch(text, /Anthropic's API/, 'the fault is ours, not upstream');
  assert.doesNotMatch(text, /try again in a few minutes/i, 'waiting never fixes a dead token');
});

test('the auth ladder still retries on its one rung before it is called dead', () => {
  const first = classifyRetry(state({ errorKind: 'authentication_failed', retriesSpent: 0 }));
  assert.equal(first.willRetry, true);
  assert.equal(first.noRetryReason, null);
});

test('classifyRetry returns the delay the session uses, so there is only one copy', () => {
  assert.equal(classifyRetry(state({ retriesSpent: 0 })).delayMs, 5_000);
  assert.equal(classifyRetry(state({ retriesSpent: 2 })).delayMs, 45_000);
  assert.equal(classifyRetry(state({ retriesSpent: 3 })).delayMs, undefined);
  assert.equal(
    classifyRetry(state({ errorKind: 'authentication_failed', retriesSpent: 0 })).delayMs,
    2_000,
    'the auth ladder has its own, shorter rung',
  );
});

test('the abandoned branch does not guarantee a resend will work', () => {
  const text = outageMessage(summary({ noRetryReason: 'abandoned' }));
  assert.match(text, /Send it again\./, 'the action stands');
  assert.doesNotMatch(text, /will go through/, 'the guarantee does not');
});

test('a very long apiError is cut at a word boundary, not mid-word', () => {
  const long = `Overloaded ${'diagnostic '.repeat(60)}end`;
  const text = outageMessage(summary({ apiError: long, noRetryReason: 'exhausted' }));
  assert.match(text, /…/, 'truncation should be visible');
  assert.doesNotMatch(text, /diagnosti…/, 'must not stop mid-word');
  assert.match(text, /did not reach me/, 'the rest of the message survives');
});

test('the abandoned branch characterises no error kind, because it cannot', () => {
  for (const kind of ['server_error', 'authentication_failed', 'rate_limit']) {
    const text = outageMessage({ apiErrorKind: kind, apiError: 'x', noRetryReason: 'abandoned' });
    assert.doesNotMatch(text, /temporary/i, `${kind}: claims the error was temporary`);
    assert.doesNotMatch(text, /transient/i, `${kind}: claims the error was transient`);
    assert.match(text, /session was cleared/, `${kind}: lost what actually happened`);
    assert.match(text, /Send it again\./, `${kind}: lost the action`);

    const journal = noRetryJournalReason({ noRetryReason: 'abandoned' });
    assert.doesNotMatch(journal, /transient/i, 'the journal made the same claim');
    assert.match(journal, /retries left/);
  }
});

test('an auth failure racing a !reset really does reach the abandoned exit', () => {
  const { willRetry, noRetryReason } = classifyRetry({
    errorKind: 'authentication_failed',
    failed: true,
    retriesSpent: 0,
    closed: true,
    hasContext: true,
  });
  assert.equal(willRetry, false);
  assert.equal(noRetryReason, 'abandoned', 'a plan existed and a rung was left');
});
