/**
 * A checker that misreports is worse than no checker.
 *
 * `pr-cli/pr-state.mjs` exists because five fields were read correctly and
 * answered the wrong question (Clawcius #216). If its own answers can be wrong
 * in the same quiet way, it has joined the problem rather than solved it — and
 * the two mistakes the coordinator made in the ad-hoc bash this replaces are
 * both in here as tests: RUNNING reported for a finished round, and FINISHED
 * reported for a live one. The second is the dangerous direction, because it
 * invites acting on findings that have not been written.
 *
 * Everything under test is pure. The two impure edges — `curl` and
 * `git merge-base` — are injected or left out, so these run offline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOOTER,
  parseFindings,
  parseDeclines,
  classifyReviewedSha,
  approvalsFor,
  roundState,
  explainMergeState,
} from '../pr-cli/pr-state.mjs';

const OJ = { login: 'osmosis-jones-agent[bot]' };
const ACK =
  '🧬 OJ is reviewing this pull request. I will post findings here when the sweep ' +
  'finishes — if nothing appears within the hour, something broke on my end.';
const findings = (round, sha) =>
  `## Round ${round}\n\nthings\n\n<sub>OJ · round ${round} · head \`${sha}\` · ` +
  '`verdictMode: comment` — this review cannot approve or block</sub>';

const label = (event, at, actor) => ({
  event,
  created_at: at,
  actor: { login: actor },
  label: { name: 'oj:review' },
});

// ── findings are identified structurally, never by "OJ said something" ──────

test('the acknowledgement comment is not findings', () => {
  // THE FAILURE THIS PREVENTS. The ack is a comment, by OJ, posted about one
  // second after pickup. Counting it reports a finished round for one that has
  // barely started, which is how you come to act on findings nobody has written.
  const comments = [
    { user: OJ, created_at: '2026-08-23T20:18:26Z', body: ACK },
    { user: OJ, created_at: '2026-08-23T20:54:13Z', body: ACK },
  ];
  assert.deepEqual(parseFindings(comments), []);
});

test('findings are parsed with their round and the sha they read', () => {
  const comments = [
    { user: OJ, created_at: '2026-08-23T20:18:26Z', body: ACK },
    { user: OJ, created_at: '2026-08-23T20:28:57Z', body: findings(1, 'a3f418fb') },
    { user: { login: 'someone' }, created_at: '2026-08-23T20:47:07Z', body: findings(9, 'deadbeef') },
    { user: OJ, created_at: '2026-08-23T20:58:31Z', body: findings(2, 'bbe011c2') },
  ];
  assert.deepEqual(
    parseFindings(comments).map((f) => [f.round, f.sha]),
    [
      [1, 'a3f418fb'],
      [2, 'bbe011c2'],
    ],
    'a human quoting the footer is not OJ posting it',
  );
});

test('the footer regex matches the real footer, including the round number', () => {
  const real =
    '<sub>OJ · round 4 · head `0a3f95f4` · `verdictMode: comment` — this review ' +
    'cannot approve or block · instructions read from the base branch only</sub>';
  const m = FOOTER.exec(real);
  assert.equal(m?.[1], '4');
  assert.equal(m?.[2], '0a3f95f4');
});

// ── round state comes from the timeline, never from the label's presence ────

test('a label with no pickup is QUEUED, not "nobody asked"', () => {
  // `labels: []` says nothing: OJ consumes the label at pickup. And a label
  // sitting there means the request has not been taken yet — the opposite.
  const state = roundState([label('labeled', '2026-08-23T20:47:08Z', 'hamachi-bot[bot]')], []);
  assert.equal(state.state, 'QUEUED');
});

test('picked up with no findings since is RUNNING, even with an ack posted', () => {
  // The coordinator's first ad-hoc mistake, inverted: an ack present must not
  // promote RUNNING to FINISHED.
  const timeline = [
    label('labeled', '2026-08-23T20:47:08Z', 'hamachi-bot[bot]'),
    label('unlabeled', '2026-08-23T20:54:13Z', 'osmosis-jones-agent[bot]'),
  ];
  const state = roundState(timeline, parseFindings([
    { user: OJ, created_at: '2026-08-23T20:54:13Z', body: ACK },
  ]));
  assert.equal(state.state, 'RUNNING');
});

test('findings after the pickup is FINISHED', () => {
  const timeline = [
    label('labeled', '2026-08-23T20:47:08Z', 'hamachi-bot[bot]'),
    label('unlabeled', '2026-08-23T20:54:13Z', 'osmosis-jones-agent[bot]'),
  ];
  const state = roundState(timeline, parseFindings([
    { user: OJ, created_at: '2026-08-23T20:58:31Z', body: findings(2, 'bbe011c2') },
  ]));
  assert.equal(state.state, 'FINISHED');
});

test('findings from the PREVIOUS round do not finish the current one', () => {
  // The coordinator's second ad-hoc mistake, and the dangerous direction:
  // reporting FINISHED for a live round because an older round's findings are
  // sitting on the page. Every re-label after the first is a new round.
  const timeline = [
    label('labeled', '2026-08-23T20:47:08Z', 'hamachi-bot[bot]'),
    label('unlabeled', '2026-08-23T20:54:13Z', 'osmosis-jones-agent[bot]'),
    label('labeled', '2026-08-23T21:11:59Z', 'hamachi-bot[bot]'),
    label('unlabeled', '2026-08-23T21:13:15Z', 'osmosis-jones-agent[bot]'),
  ];
  const old = parseFindings([{ user: OJ, created_at: '2026-08-23T20:58:31Z', body: findings(2, 'bbe011c2') }]);
  assert.equal(roundState(timeline, old).state, 'RUNNING');
});

test('a PR nobody ever labelled is NEVER REQUESTED, not QUEUED', () => {
  assert.equal(roundState([], []).state, 'NEVER REQUESTED');
  // And an unrelated label must not register as a review request.
  const other = [{ event: 'labeled', created_at: 'x', actor: { login: 'a' }, label: { name: 'bug' } }];
  assert.equal(roundState(other, []).state, 'NEVER REQUESTED');
});

// ── did the review see this code ────────────────────────────────────────────

test('the reviewed sha is classified against the head, abbreviations included', () => {
  const never = () => {
    throw new Error('must not consult git when the shas already match');
  };
  assert.equal(classifyReviewedSha('0a3f95f4', '0a3f95f44eadc699bf44ce3ab9cc4b57a2c3c180', never), 'EXACT');
  assert.equal(classifyReviewedSha('aaaa1111', 'bbbb2222', () => true), 'ANCESTOR');
  assert.equal(classifyReviewedSha('aaaa1111', 'bbbb2222', () => false), 'VOID');
  assert.equal(classifyReviewedSha('aaaa1111', 'bbbb2222', () => null), 'UNKNOWN');
  assert.equal(classifyReviewedSha(null, 'bbbb2222', never), 'NONE');
});

test('VOID is the #202 case: a round that read a commit no longer in the history', () => {
  // 20:12:36 label applied at 31873395 · 20:13:33 OJ fetches it · ~20:14 the
  // branch is force-pushed to 772a9d89, whose parent is a sibling commit rather
  // than 31873395 · 20:18:07 findings post naming head `31873395`.
  //
  // Four of that round's "still outstanding" items were already fixed. Findings
  // about a tree nobody has look exactly like findings that apply, which is why
  // this must be a state the tool NAMES rather than something a reader spots.
  assert.equal(classifyReviewedSha('31873395', '772a9d89', () => false), 'VOID');
});

// ── is an approval still valid ──────────────────────────────────────────────

test('an approval is flagged stale when the branch has moved under it', () => {
  // `dismiss_stale_reviews_on_push` is FALSE on ruleset OJ1, so GitHub keeps
  // counting this one. "Approved" and "somebody approved this code" are
  // different claims and only the first is a field.
  const reviews = [
    { state: 'APPROVED', user: { login: 'NickPurcell' }, submitted_at: 't1', commit_id: 'old11111' },
    { state: 'COMMENTED', user: { login: 'x' }, submitted_at: 't2', commit_id: 'new22222' },
    { state: 'CHANGES_REQUESTED', user: { login: 'y' }, submitted_at: 't3', commit_id: 'new22222' },
  ];
  const got = approvalsFor(reviews, 'new22222');
  assert.equal(got.length, 1, 'only APPROVED counts as an approval');
  assert.equal(got[0].stale, true);

  assert.equal(approvalsFor(reviews, 'old11111')[0].stale, false);
});

// ── OJ round 1 on #218: the misreports were all in the untested part ────────
//
// "The premise of this PR is that a checker that misreports is worse than none,
// and the misreports I found are all in main() — the part with no tests,
// printing the sentences a reader actually acts on." Every fix below is now
// reachable from a test, which is the actual remedy.

test('findings are matched by their footer, not by how the comment opens', () => {
  // THE 02:30 INCIDENT, and it is not in OJ's findings list — it happened to the
  // coordinator's own probe, which classified findings by `body.startsWith('##')`
  // and reported RUNNING on a finished round for 63 minutes.
  //
  // Neither OJ comment on #218 starts with `##`: the ack opens with an emoji and
  // round 1 opens "Non-blocking. The 11 tests pass here…". So a positional marker
  // has no discriminating power in EITHER direction on a real PR.
  //
  // The existing test above covers "the ack is not findings" and would have
  // passed all night. This is the same property from the direction that bit.
  const prose = {
    user: OJ,
    created_at: '2026-08-24T01:26:55Z',
    body: 'Non-blocking. The 11 tests pass here, and three claims check out.\n\n' +
      '## 1. Something\n\ndetail\n\n' +
      '<sub>OJ · round 1 · head `8884594c` · `verdictMode: comment`</sub>',
  };
  assert.deepEqual(
    parseFindings([prose]).map((f) => [f.round, f.sha]),
    [[1, '8884594c']],
    'a findings comment that does not open with ## is still findings',
  );
});

test('a round OJ declined is DECLINED, not RUNNING forever', () => {
  // FINDING 3. A refusal unlabels exactly like a pickup and posts no footer, so
  // it fell through to RUNNING and stayed there. An agent reads "picked up,
  // running" and waits for findings declined an hour ago.
  const timeline = [
    label('labeled', '2026-08-23T20:00:00Z', 'hamachi-bot[bot]'),
    label('unlabeled', '2026-08-23T20:01:00Z', 'osmosis-jones-agent[bot]'),
  ];
  const comments = [
    { user: OJ, created_at: '2026-08-23T20:01:30Z', body: 'OJ is not reviewing this: it is a draft.' },
  ];
  const state = roundState(timeline, parseFindings(comments), parseDeclines(comments));
  assert.equal(state.state, 'DECLINED');
  assert.match(state.detail, /draft/, 'the reason is in the refusal and must be carried');

  // A refusal from an EARLIER round must not decline the current one.
  const later = [...timeline, label('labeled', '2026-08-23T21:00:00Z', 'hamachi-bot[bot]')];
  assert.equal(roundState(later, [], parseDeclines(comments)).state, 'QUEUED');
});

test('approvals are counted per reviewer, from their latest review', () => {
  // FINDING 4, both directions, probed against the real function by OJ:
  //   approve then request changes -> reported 1, GitHub counts 0
  //   approve twice after a push   -> reported 2, GitHub counts 1
  const changed = approvalsFor(
    [
      { state: 'APPROVED', user: { login: 'nick' }, submitted_at: 't1', commit_id: 'aaa' },
      { state: 'CHANGES_REQUESTED', user: { login: 'nick' }, submitted_at: 't2', commit_id: 'bbb' },
    ],
    'bbb',
  );
  assert.deepEqual(changed, [], 'a later CHANGES_REQUESTED retracts the approval');

  const twice = approvalsFor(
    [
      { state: 'APPROVED', user: { login: 'nick' }, submitted_at: 't1', commit_id: 'aaa' },
      { state: 'APPROVED', user: { login: 'nick' }, submitted_at: 't2', commit_id: 'bbb' },
    ],
    'bbb',
  );
  assert.equal(twice.length, 1, 're-approving after a push is one approval, not two');
  assert.equal(twice[0].stale, false, 'and it is the latest one that counts');

  // A COMMENTED review does not retract an approval, so it must not supersede.
  const commented = approvalsFor(
    [
      { state: 'APPROVED', user: { login: 'nick' }, submitted_at: 't1', commit_id: 'aaa' },
      { state: 'COMMENTED', user: { login: 'nick' }, submitted_at: 't2', commit_id: 'aaa' },
    ],
    'aaa',
  );
  assert.equal(commented.length, 1);

  // Two different reviewers are two approvals.
  assert.equal(
    approvalsFor(
      [
        { state: 'APPROVED', user: { login: 'a' }, submitted_at: 't1', commit_id: 'x' },
        { state: 'APPROVED', user: { login: 'b' }, submitted_at: 't2', commit_id: 'x' },
      ],
      'x',
    ).length,
    2,
  );
});

test('`blocked` is only blamed on approvals when approvals are actually short', () => {
  // FINDING 1. The case that matters is the one this tool's own header predicts:
  // if require_extra_approval_for_unattributed_changes ever fires, the approval
  // count is SATISFIED and the tool used to print "needs 1, has 1" as the
  // explanation — pointing at the met condition and away from the flagged one.
  const ruleset = { name: 'OJ1', required: 1, dismissStaleOnPush: false, bypass: 0 };
  const one = [{ by: 'nick', at: 't', sha: 'x', stale: false }];

  assert.match(explainMergeState('blocked', [], ruleset), /needs 1 approval\(s\), has 0/);

  const satisfied = explainMergeState('blocked', one, ruleset);
  assert.match(satisfied, /NOT the approval count \(1 of 1\)/);
  assert.match(satisfied, /require_extra_approval_for_unattributed_changes/);
  assert.doesNotMatch(satisfied, /needs 1 approval\(s\), has 1/);

  // And more approvals than required is the same case, not a different one.
  assert.match(
    explainMergeState('blocked', [...one, { by: 'b', at: 't', sha: 'x', stale: false }], ruleset),
    /NOT the approval count \(2 of 1\)/,
  );

  // An unreadable ruleset must not become a claim about approvals either.
  assert.match(
    explainMergeState('blocked', [], { name: '(unreadable)', required: null }),
    /NOT the approval count\. Look at the rest/,
  );

  // The other states say what they mean rather than echoing the field.
  assert.equal(explainMergeState('clean', [], ruleset), 'nothing blocking');
  assert.equal(explainMergeState('dirty', [], ruleset), 'merge conflicts');
  assert.match(explainMergeState('unstable', [], ruleset), /required check/);
  assert.equal(explainMergeState('weird-new-state', [], ruleset), 'weird-new-state');
});
