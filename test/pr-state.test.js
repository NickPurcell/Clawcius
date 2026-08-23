/**
 * A checker that misreports is worse than no checker.
 *
 * `scripts/pr-state.mjs` exists because five fields were read correctly and
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
  classifyReviewedSha,
  approvalsFor,
  roundState,
} from '../scripts/pr-state.mjs';

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
