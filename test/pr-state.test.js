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
  refPatternMatches,
  whyStale,
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

// ── findings are identified structurally, never by who said something ──────

test('the acknowledgement comment is not findings', () => {
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
  const state = roundState([label('labeled', '2026-08-23T20:47:08Z', 'hamachi-bot[bot]')], []);
  assert.equal(state.state, 'QUEUED');
});

test('picked up with no findings since is RUNNING, even with an ack posted', () => {
  // An ack present must not promote RUNNING to FINISHED.
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
  // An unrelated label must not register as a review request.
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
  assert.equal(got[0].coverage, 'stale');

  assert.equal(approvalsFor(reviews, 'old11111')[0].coverage, 'current');
});

// ── what main() reports: findings, declines, approvals, merge state ─────────

test('findings are matched by their footer, not by how the comment opens', () => {
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
  // A refusal unlabels exactly like a pickup and posts no footer, so it must
  // not fall through to RUNNING.
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
  assert.equal(twice[0].coverage, 'current', 'and it is the latest one that counts');

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
  const ruleset = { name: 'OJ1', required: 1, dismissStaleOnPush: false, bypass: 0 };
  const one = [{ by: 'nick', at: 't', sha: 'x', coverage: 'current' }];

  assert.match(explainMergeState('blocked', [], ruleset), /needs 1 approval\(s\), has 0/);

  const satisfied = explainMergeState('blocked', one, ruleset);
  assert.match(satisfied, /NOT the approval count \(1 of 1\)/);
  assert.match(satisfied, /require_extra_approval_for_unattributed_changes/);
  assert.doesNotMatch(satisfied, /needs 1 approval\(s\), has 1/);

  // And more approvals than required is the same case, not a different one.
  assert.match(
    explainMergeState('blocked', [...one, { by: 'b', at: 't', sha: 'x', coverage: 'current' }], ruleset),
    /NOT the approval count \(2 of 1\)/,
  );

  for (const unknown of [{ name: '(unreadable)', required: null }, undefined, null]) {
    const said = explainMergeState('blocked', [], unknown);
    assert.match(said, /could not be read/);
    assert.match(said, /UNKNOWN/);
    assert.doesNotMatch(said, /NOT the approval count/);
  }

  // The other states say what they mean rather than echoing the field.
  assert.equal(explainMergeState('clean', [], ruleset), 'nothing blocking');
  assert.equal(explainMergeState('dirty', [], ruleset), 'merge conflicts');
  assert.match(explainMergeState('unstable', [], ruleset), /required check/);
  assert.equal(explainMergeState('weird-new-state', [], ruleset), 'weird-new-state');
});

test('a stale approval is named on the "can it merge" line, not only beside the approval', () => {
  const fresh = [{ by: 'oj', at: 't', sha: 'head1234', coverage: 'current' }];
  const stale = [{ by: 'oj', at: 't', sha: 'old12345', coverage: 'stale' }];

  assert.equal(explainMergeState('clean', fresh, { required: 1 }), 'nothing blocking');

  const said = explainMergeState('clean', stale, { required: 1 });
  assert.match(said, /STALE/);
  assert.doesNotMatch(said, /^nothing blocking$/);

  const mixed = explainMergeState(
    'clean',
    [
      { by: 'a', at: 't', sha: 'old12345', coverage: 'stale' },
      { by: 'b', at: 't', sha: 'head1234', coverage: 'current' },
    ],
    { required: 1, dismissStaleOnPush: false },
  );
  assert.match(mixed, /1 STALE/);
  assert.match(mixed, /1 DOES cover this head/, 'a covering approval must be named when one exists');

  const both = explainMergeState(
    'clean',
    [
      { by: 'a', at: 't', sha: 'old12345', coverage: 'stale' },
      { by: 'b', at: 't', sha: null, coverage: 'unknown' },
    ],
    { required: 1, dismissStaleOnPush: false },
  );
  assert.match(both, /1 STALE/);
  assert.match(both, /1 with no commit_id/, 'the unknown one must not go unmentioned');
  assert.match(both, /None is KNOWN to cover this head/);
  assert.match(both, /cannot be settled from here/);
  assert.doesNotMatch(
    both,
    /no review has read/i,
    'an UNKNOWN approval may have read this head; asserting otherwise is the collapse this branch removes',
  );

  // Unknown ALONE — the same claim with nothing stale to lend it cover.
  const unknownOnly = explainMergeState(
    'clean',
    [{ by: 'b', at: 't', sha: null, coverage: 'unknown' }],
    { required: 1, dismissStaleOnPush: false },
  );
  assert.match(unknownOnly, /1 with no commit_id/);
  assert.doesNotMatch(unknownOnly, /no review has read/i);

  // Stale ALONE is the state where the strong claim is TRUE and must survive:
  // every approval names a commit, and none of them names this one.
  const staleOnly = explainMergeState(
    'clean',
    [{ by: 'a', at: 't', sha: 'old12345', coverage: 'stale' }],
    { required: 1, dismissStaleOnPush: false },
  );
  assert.match(staleOnly, /merging now merges code no review has read/i);
  assert.match(staleOnly, /still counts it\)/, 'one stale approval is "it"');

  const twoStale = explainMergeState(
    'clean',
    [
      { by: 'a', at: 't', sha: 'old11111', coverage: 'stale' },
      { by: 'b', at: 't', sha: 'old22222', coverage: 'stale' },
    ],
    { required: 1, dismissStaleOnPush: false },
  );
  assert.match(twoStale, /2 STALE/);
  assert.match(twoStale, /still counts them\)/, 'two stale approvals are "them"');

  assert.doesNotMatch(mixed, /merges code no review has read/i);

  // `current` is COUNTED, not inferred by subtraction: an unrecognised coverage
  // value must not be reported as covering the head, since that is the one claim
  // a reader acts on by merging.
  const odd = explainMergeState(
    'clean',
    [
      { by: 'a', at: 't', sha: 'old12345', coverage: 'stale' },
      { by: 'b', at: 't', sha: 'x', coverage: undefined },
    ],
    { required: 1, dismissStaleOnPush: false },
  );
  assert.doesNotMatch(odd, /DOES cover this head/);
});

test('ruleset ref patterns match the way GitHub writes them', () => {
  assert.equal(refPatternMatches('refs/heads/*', 'main'), true);
  assert.equal(refPatternMatches('refs/heads/main', 'main'), true);
  assert.equal(refPatternMatches('main', 'main'), true);
  assert.equal(refPatternMatches('refs/heads/feature/*', 'feature/x'), true);
  assert.equal(refPatternMatches('refs/heads/rel-?', 'rel-1'), true);
  assert.equal(refPatternMatches('refs/heads/other', 'main'), false);
  assert.equal(refPatternMatches('refs/heads/feat*', 'main'), false);
  // A pattern with regex metacharacters must be treated as a glob, not a regex.
  assert.equal(refPatternMatches('refs/heads/a.b', 'aXb'), false);
  assert.equal(refPatternMatches('refs/heads/a.b', 'a.b'), true);
});

test('the stale-approval warning does not assert what it has not established', () => {
  const OJ1 = { name: 'OJ1', required: 1, dismissStaleOnPush: false, bypass: 0 };
  const absent = explainMergeState('clean', [{ by: 'n', at: 't', sha: null, coverage: 'unknown' }], OJ1);
  assert.doesNotMatch(absent, /STALE/, 'an absent commit_id is unknown, not stale');
  // The dismissal footnote is about a STALE approval keeping its count, so it
  // must not appear when nothing is stale.
  assert.doesNotMatch(absent, /dismiss_stale_reviews_on_push/);
  assert.match(absent, /coverage is UNKNOWN/);

  const stale = [{ by: 'n', at: 't', sha: 'old12345', coverage: 'stale' }];
  assert.match(explainMergeState('clean', stale, OJ1), /is false, so GitHub still counts it/);
  assert.match(
    explainMergeState('clean', stale, { ...OJ1, dismissStaleOnPush: true }),
    /is TRUE, so check why GitHub still counts it/,
  );
  assert.match(
    explainMergeState('clean', stale, { name: '(unreadable)', required: null }),
    /could not be read/,
  );
  assert.doesNotMatch(
    explainMergeState('clean', stale, { name: '(unreadable)', required: null }),
    /is false/,
  );
});

test('a ruleset read successfully with no approval rule means zero, not unknown', () => {
  const said = explainMergeState('blocked', [], { name: 'checks-only', required: 0 });
  assert.match(said, /NOT the approval count \(0 of 0\)/);
  assert.doesNotMatch(said, /could not be read/);

  // And the genuinely unknown case still says so.
  assert.match(explainMergeState('blocked', [], { name: '(unreadable)', required: null }), /could not be read/);
});

test('coverage is three states, because commit_id can be absent', () => {
  const [current] = approvalsFor(
    [{ state: 'APPROVED', user: { login: 'n' }, submitted_at: 't', commit_id: 'head1234' }],
    'head1234',
  );
  const [stale] = approvalsFor(
    [{ state: 'APPROVED', user: { login: 'n' }, submitted_at: 't', commit_id: 'old12345' }],
    'head1234',
  );
  const [unknown] = approvalsFor(
    [{ state: 'APPROVED', user: { login: 'n' }, submitted_at: 't', commit_id: null }],
    'head1234',
  );
  assert.equal(current.coverage, 'current');
  assert.equal(stale.coverage, 'stale');
  assert.equal(unknown.coverage, 'unknown', 'absent is not the same as superseded');

  assert.equal('stale' in unknown, false);

  // The headline must not call an absent commit superseded, nor round it to "nothing blocking".
  const said = explainMergeState('clean', [unknown], { name: 'OJ1', required: 1, dismissStaleOnPush: false });
  assert.doesNotMatch(said, /STALE/);
  assert.match(said, /coverage is UNKNOWN/);

  // An empty-string commit_id is not a sha; it belongs in the unknown bucket.
  const [empty] = approvalsFor(
    [{ state: 'APPROVED', user: { login: 'n' }, submitted_at: 't', commit_id: '' }],
    'head1234',
  );
  assert.equal(empty.coverage, 'unknown');
});

// ── why a stale approval went stale ─────────────────────────────────────────

// AUTHOR date, because that is what `whyStale` splits on and what a rebase
// preserves. `committed` is supplied separately where a test needs the two to
// disagree, which is exactly the rebase case.
const commit = (login, date, committed = date) => ({
  author: { login },
  commit: { author: { date }, committer: { date: committed } },
});

test('an approval the author spent by their own pushes is SPENT, not overtaken', () => {
  const commits = [commit('hamachi', 't1'), commit('hamachi', 't3')];
  assert.equal(whyStale({ at: 't2' }, commits), 'spent');
});

test('somebody ELSE pushing under a reviewer is OVERTAKEN', () => {
  // Opposite response: the question is what changed and by whom, not "please
  // look again".
  const commits = [commit('hamachi', 't1'), commit('someone-else', 't3')];
  assert.equal(whyStale({ at: 't2' }, commits), 'overtaken');
});

test('the PR author is NOT the commit author here, and comparing them was wrong', () => {
  assert.equal(whyStale.length, 2, 'whyStale(approval, commits) — no author parameter to get wrong');

  const commits = [commit('hamachi', 't1'), commit('hamachi', 't3')];
  assert.equal(whyStale({ at: 't2' }, commits), 'spent', 'the App never authors; only the user does');
});

test('whyStale gives up rather than guessing', () => {
  // Same reason `coverage` has an `unknown` bucket: an absent datum is not a
  // negative one, and a caller must print nothing rather than a plausible lie.
  const commits = [commit('hamachi', 't1'), commit('hamachi', 't3')];
  assert.equal(whyStale({ at: 't9' }, commits), null, 'nothing pushed after the approval');
  assert.equal(whyStale({ at: 't0' }, commits), null, 'nothing before it to say who owns the branch');
  assert.equal(whyStale(null, commits), null);
  assert.equal(
    whyStale({ at: 't2' }, [commit('hamachi', 't1'), { author: null, commit: { committer: { date: 't3' } } }]),
    null,
    'an author GitHub did not resolve to a login',
  );
});

test('a rebase after the approval still gets an answer (#252 round 1)', () => {
  const rebasedAt = '2026-08-24T12:22:00Z';
  const commits = [
    // Authored before the approval, re-committed by the rebase after it.
    commit('hamachi', '2026-08-24T11:00:00Z', rebasedAt),
    commit('hamachi', '2026-08-24T12:40:00Z', '2026-08-24T12:40:00Z'),
  ];
  assert.equal(whyStale({ at: '2026-08-24T12:30:00Z' }, commits), 'spent');

  const withStranger = [
    commit('hamachi', '2026-08-24T11:00:00Z', rebasedAt),
    commit('someone-else', '2026-08-24T12:40:00Z', '2026-08-24T12:40:00Z'),
  ];
  assert.equal(whyStale({ at: '2026-08-24T12:30:00Z' }, withStranger), 'overtaken');
});

test('real ISO-8601 stamps compare correctly, not just t1/t2/t3', () => {
  const commits = [
    commit('hamachi', '2026-08-24T09:13:38Z'),
    commit('hamachi', '2026-08-24T12:43:11Z'),
  ];
  assert.equal(whyStale({ at: '2026-08-24T11:08:24Z' }, commits), 'spent');

  // Across a month and a year boundary, where a naive comparison would slip.
  const spanning = [
    commit('hamachi', '2026-08-31T23:59:59Z'),
    commit('hamachi', '2026-09-01T00:00:01Z'),
  ];
  assert.equal(whyStale({ at: '2026-09-01T00:00:00Z' }, spanning), 'spent');
});

test("an author-date split cannot see a stranger's late-landing old commit", () => {
  const commits = [
    commit('hamachi', '2026-08-24T08:00:00Z'),
    commit('a-stranger', '2026-08-24T09:00:00Z', '2026-08-24T12:00:00Z'),
    commit('hamachi', '2026-08-24T12:30:00Z'),
  ];
  assert.equal(
    whyStale({ at: '2026-08-24T11:00:00Z' }, commits),
    'spent',
    'documented limit: an author-date split cannot see a late-landing old commit',
  );
});

test('an amend after the approval gives up rather than answering', () => {
  const commits = [commit('hamachi', '2026-08-24T10:00:00Z', '2026-08-24T12:30:00Z')];
  assert.equal(whyStale({ at: '2026-08-24T11:00:00Z' }, commits), null);
});
