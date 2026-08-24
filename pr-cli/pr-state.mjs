#!/usr/bin/env node
/**
 * Answer the questions agents actually have about a pull request, rather than
 * the fields that resemble them.
 *
 * ── Why this is a script and not a table ─────────────────────────────────
 *
 * On 2026-08-23 four agents read five different fields that were TRUE, that
 * they read CORRECTLY, and that answered a question adjacent to the one they
 * had (Clawcius #216). Between them: ~2h investigating an intruder that was the
 * author's own tooling, one wasted review round, one nearly-published set of
 * fixes for things that were not broken, and one unnecessary chase.
 *
 * A reference table would have helped with those five. The sixth field will
 * mislead the same way, and nobody consults a table before reading a value that
 * has already given them a confident answer. A document that only works if you
 * doubt yourself first does not work.
 *
 * SO THE HEURISTIC IS HERE, WHERE SOMEBODY EDITING THIS IS STANDING:
 *
 *   A field that could NOT answer your question would have returned nothing and
 *   sent you looking. The dangerous ones are the ones that DO answer —
 *   plausibly, right type, right shape — because a confident answer terminates
 *   the search. "I got a clean answer" is the moment to be suspicious, not the
 *   moment to stop.
 *
 * The difference between a rule and an intention is whether you can rerun it in
 * seconds. That is why this is executable.
 *
 * ── The four questions, and the fields that look like them ───────────────
 *
 *   is a round running / queued / finished
 *       NOT "an OJ comment exists" — the acknowledgement is a comment, posted
 *       ~1s after pickup. Findings are identified structurally, by their footer.
 *       NOT `labels: []` either — OJ consumes `oj:review` at pickup, so absence
 *       means queued-and-taken OR running, never "nobody asked".
 *
 *   did the review see THIS code
 *       The footer sha is the only place a round names the commit it read, and
 *       it is ~150 chars from the end of the comment — outside the 1200-char
 *       window watchPr mail truncates at, in 4 of 4 rounds measured (OJ#23).
 *       Read from the API, never from the mail.
 *
 *   can this merge, and if not, why
 *       NOT `mergeable`, which only says git can combine the trees. It was
 *       `true` on #207 for the entire time the PR was `blocked`. The field that
 *       answers the question is `mergeable_state`.
 *
 *   is an approval still valid
 *       `dismiss_stale_reviews_on_push` is FALSE on ruleset OJ1, so GitHub keeps
 *       counting an approval after the branch moves. An approval can therefore
 *       be satisfied and be for code nobody approved.
 *
 * ── Two things that will look like mistakes in this file, and are not ────
 *
 * 1. IT READS `/rulesets`, NOT `/branches/{branch}/protection`. The obvious
 *    endpoint for "what is blocking this pull request" answers **403 —
 *    `Resource not accessible by integration`** — for THIS App, because it does
 *    not hold `Administration: read`. That is a property of the App's
 *    permissions and not of the endpoint, and the distinction is load-bearing:
 *    a future crew whose App does hold that scope will find the note "wrong",
 *    and if it reads as a fact about the endpoint they will drop this whole
 *    warning with it. `/rulesets` needs no such scope and is the reason this
 *    works today. So the natural call is the one WE cannot make, and anyone who
 *    "simplifies" back to it gets a permission error and concludes something
 *    about permissions rather than about endpoints.
 *
 *    That is #216 reappearing inside the API surface itself, which is why the
 *    warning is here rather than in a commit message nobody will read.
 *
 * 2. THERE ARE TWO IDENTITIES ON ONE PULL REQUEST, and they are not a bug.
 *    Commits are authored by the user `hamachi`; the pull request is opened by
 *    `hamachi-bot[bot]`, the App. The self-approval rule keys on the PULL
 *    REQUEST author, which is why the App cannot approve its own PR (422) and
 *    why an approval has to come from outside the crew entirely.
 *
 *    Related and NOT the same thing: ruleset OJ1 sets
 *    `require_extra_approval_for_unattributed_changes: true`. It should not
 *    fire — a `users.noreply.github.com` address resolves to a real login, so
 *    GitHub returns an `author` object rather than `null`, and unattributed
 *    means no linked account. That is verified for the commits and NOT verified
 *    against GitHub's exact predicate for the rule. **If an approval lands and
 *    the PR stays blocked, this is the first thing to check.**
 *
 * Usage:  pr-cli/pr-state <pr> [--repo owner/name] [--json]
 *
 * From inside an agent container, where this directory is mounted read-only:
 *     /home/npurcell/clawcius/pr-cli/pr-state <pr>
 *
 * Reads through bare `curl`, which the daemon has already authenticated via
 * netrc. Do NOT add an Authorization header: an explicit one REPLACES the
 * netrc credential and authenticates as the account rather than as the App.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO = 'NickPurcell/Clawcius';
const OJ_BOT = 'osmosis-jones-agent[bot]';
const REVIEW_LABEL = 'oj:review';

/** OJ's findings footer — the only place a round names the commit it read. */
export const FOOTER = /<sub>OJ\s*·\s*round\s*(\d+)\s*·\s*head\s*`([0-9a-f]+)`/;

/**
 * OJ comments that are FINDINGS, structurally.
 *
 * The acknowledgement is also a comment by OJ, is 151 characters long, and is
 * posted about one second after pickup. Counting it is how "a round finished"
 * gets reported for a round that has barely started — the dangerous direction,
 * because it invites acting on findings that do not exist yet.
 */
export function parseFindings(comments) {
  return comments
    .filter((c) => c.user?.login === OJ_BOT)
    .map((c) => ({ at: c.created_at, m: FOOTER.exec(c.body ?? ''), url: c.html_url }))
    .filter((c) => c.m)
    .map((c) => ({ at: c.at, round: Number(c.m[1]), sha: c.m[2], url: c.url }));
}

/**
 * OJ declining a round, which unlabels exactly like a pickup and posts no
 * footer — so without this it falls through to RUNNING and stays there forever.
 *
 * `agent-config.base.yaml`'s `<habits>` documents it: "a comment beginning
 * `OJ is not reviewing this:` … is a refusal with its reason in it, drafts and
 * forks being skipped by configuration, and no acknowledgement is coming."
 *
 * An agent reads "picked up, running" and waits for findings that were declined
 * an hour ago. That is Clawcius#88's eight-hour wait with a tool vouching for
 * it, which is worse than the wait without one. OJ round 1, finding 3.
 *
 * Searched over comments AND review bodies, for the same reason `parseFindings`
 * is: if finding 5's premise holds for findings it holds for refusals.
 */
// NOT anchored hard at `^`. OJ's other system comment — the acknowledgement —
// opens with an emoji, and `<habits>` describes it without mentioning that. If a
// refusal ever carries a prefix the same way, a hard anchor never matches and the
// round reads RUNNING forever, which is the exact bug the DECLINED state was
// added to fix. The cost of being wrong is that failure; the cost of the
// hardening is four characters. Round 2, finding 5.
const DECLINED = /^\W*OJ is not reviewing this:\s*(.*)/;

export function parseDeclines(comments) {
  return comments
    .filter((c) => c.user?.login === OJ_BOT)
    .map((c) => ({ at: c.created_at, m: DECLINED.exec((c.body ?? '').trim()) }))
    .filter((c) => c.m)
    .map((c) => ({ at: c.at, reason: c.m[1].trim() }));
}

/**
 * Did the last round read the code that is on the branch now?
 *
 * EXACT   the reviewed commit IS the head
 * ANCESTOR the head has moved on; commits since it are unreviewed
 * VOID    the reviewed commit is not in the head's history at all — a rebase,
 *         an amend, a force-push or a squash happened mid-round, and the
 *         findings describe a tree nobody has. This is the state that cost
 *         Clawcius #202 a round: four already-fixed items reported outstanding,
 *         which looks exactly like diligence from outside.
 * UNKNOWN the sha is not in this clone, so no honest claim is available.
 */
export function classifyReviewedSha(sha, head, isAncestorFn) {
  if (!sha) return 'NONE';
  if (head === sha || head.startsWith(sha) || sha.startsWith(head)) return 'EXACT';
  const anc = isAncestorFn(sha, head);
  if (anc === null) return 'UNKNOWN';
  return anc ? 'ANCESTOR' : 'VOID';
}

/**
 * Approvals, each flagged with whether it is for the code on the branch now.
 *
 * `dismiss_stale_reviews_on_push` is FALSE on ruleset OJ1, so GitHub keeps
 * counting an approval after the branch moves. "Approved" and "somebody
 * approved this code" are therefore different claims, and only the first is a
 * field.
 */
export function approvalsFor(reviews, head) {
  // ONE PER REVIEWER, FROM THEIR LATEST REVIEW, which is how GitHub counts.
  // Filtering `state === 'APPROVED'` across all reviews miscounts in both
  // directions (OJ round 1, finding 4): approve-then-request-changes reported 1
  // where GitHub counts 0 — overstating in the direction of "ready" — and
  // approving twice after a push reported 2 where GitHub counts 1, printing two
  // lines for one person, one stale and one not.
  //
  // Re-approving after a push is ordinary here, not an edge case: it is what a
  // human does when the branch moves under their review.
  const latest = new Map();
  for (const r of reviews) {
    // Reviews arrive oldest-first, and only these states supersede: a COMMENTED
    // review does not retract an approval, which is why it cannot simply be the
    // last review of any kind.
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && r.state !== 'DISMISSED') continue;
    if (r.user?.login) latest.set(r.user.login, r);
  }
  return [...latest.values()]
    .filter((r) => r.state === 'APPROVED')
    .map((r) => ({ by: r.user?.login, at: r.submitted_at, sha: r.commit_id, stale: r.commit_id !== head }));
}

/**
 * Does a ruleset ref pattern match this branch?
 *
 * `conditions.ref_name.include` and `.exclude` hold fnmatch patterns against the
 * FULL ref, so `refs/heads/*` is the ordinary way to say "every branch" and a
 * literal comparison misses it entirely.
 */
export function refPatternMatches(pattern, branch) {
  if (!pattern || !branch) return false;
  const full = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  const rx = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  return rx.test(full) || rx.test(branch);
}

/**
 * Why a pull request cannot merge, in words, from `mergeable_state`.
 *
 * FINDING 1 OF OJ ROUND 1, and the sharpest thing said about this tool. The
 * approval clause used to be gated on `ruleset.required` being TRUTHY, never on
 * whether approvals were actually short — so every `blocked` PR in a repo with a
 * ruleset got "needs N, has M" as its EXPLANATION, including when M >= N, which
 * is exactly when approvals are NOT the reason.
 *
 * `blocked` also covers a failing required check, CODEOWNERS, a second rule, and
 * `require_extra_approval_for_unattributed_changes` — the one this file's own
 * header flags as unverified and says to check first. So the tool pointed at the
 * SATISFIED condition and away from the flagged one: a confident, wrong,
 * adjacent answer on the line answering question three of four, which is #216
 * committed by the instrument built to prevent it.
 *
 * Extracted from `main()` rather than fixed in place, because OJ's structural
 * point outlives this bug: every misreport it found was in `main()`, the part
 * with no tests, printing the sentences a reader acts on. A fix that stayed
 * there would have been untested for the same reason the bug was.
 */
export function explainMergeState(state, approvals, ruleset) {
  const required = ruleset?.required;
  const stale = approvals.filter((a) => a.stale && a.sha);
  switch (state) {
    case 'clean':
      // GitHub's own verdict, plus the thing GitHub does not count as blocking.
      // `dismiss_stale_reviews_on_push` is false on OJ1, so an approval survives
      // the branch moving under it and `clean` can mean "approved, for code that
      // is no longer here". Observed on #228: green check, approval for
      // 629a41fb, head e7e2d52. Saying only "nothing blocking" there would be
      // this function's own finding-1 defect a third time.
      if (stale.length === 0) return 'nothing blocking';
      // (a) `a.sha` as well as `a.stale`. `approvalsFor` sets `stale = commit_id
      //     !== head`, which is TRUE when `commit_id` is null — so an approval
      //     whose commit is simply absent was reported as being for a superseded
      //     one. The printed approval line thirty lines down already said
      //     "commit_id absent, so whether it covers X is unknown", and this line
      //     contradicted it on the same screen from the same field.
      //
      // (b) Read `dismissStaleOnPush` instead of asserting it. The parenthetical
      //     hardcoded "is false" and never consulted the value the tool had in
      //     hand, so it said so against a ruleset that sets it true, and against
      //     a `/rulesets` read that failed and established nothing.
      //
      // Both are this file's own defect, committed twice in the branch added to
      // stop a third instance of it. The header's heuristic applies to its
      // author: a clean answer is the moment to be suspicious.
      const dismissal =
        ruleset?.dismissStaleOnPush === false
          ? ' (dismiss_stale_reviews_on_push is false, so GitHub still counts it)'
          : ruleset?.dismissStaleOnPush === true
            ? ' — though dismiss_stale_reviews_on_push is TRUE, so check why GitHub still counts it'
            : ' (whether stale reviews are dismissed could not be read)';
      return (
        `nothing GitHub blocks on — but ${stale.length === 1 ? 'the approval is' : `${stale.length} approvals are`} ` +
        `STALE, for a commit no longer at the head. Merging now merges code no review has read${dismissal}`
      );
    case 'dirty':
      return 'merge conflicts';
    case 'behind':
      return 'the branch is behind its base';
    case 'unstable':
      return 'a required check is failing or still running';
    case 'draft':
      return 'it is a draft';
    case 'blocked':
      // THREE branches, not two, and the third is round 2's finding 1. With
      // `required` unknown the two-branch version fell through to "it is NOT the
      // approval count" — asserting the negative from an absence. Zero approvals
      // on a PR needing one, which is the commonest blocked state here, reported
      // as definitely not about approvals: round 1's finding with the sign
      // flipped, and worse, because that one pointed at a condition that was met
      // while this one points away from the condition that is the whole answer.
      //
      // `required` is unknown whenever the `/rulesets` read throws, no active
      // ruleset governs this base ref, or the repo uses classic branch
      // protection and has no rulesets at all — none exotic, and the README
      // offers a cross-repo example where the last is possible.
      if (required == null) {
        return (
          'branch protection — and the required approval count could not be read, so ' +
          `whether ${approvals.length} approval(s) is enough is UNKNOWN. It may be the ` +
          'approval count, or a required check, CODEOWNERS, or ' +
          'require_extra_approval_for_unattributed_changes'
        );
      }
      if (approvals.length < required) {
        return `branch protection — needs ${required} approval(s), has ${approvals.length}`;
      }
      return (
        `branch protection, and it is NOT the approval count (${approvals.length} of ` +
        `${required}). Look at the rest of the ruleset: a required check, CODEOWNERS, ` +
        'or require_extra_approval_for_unattributed_changes'
      );
    default:
      return state ?? 'unknown';
  }
}

/**
 * One request. The body on stdout, and the one header we need appended after a
 * sentinel by curl itself.
 *
 * TWO OBVIOUS IMPLEMENTATIONS ARE WRONG IN THIS CONTAINER, both silently
 * elsewhere, which is why this note is longer than the function:
 *
 *   `-D -` and split on the first blank line.  Egress is through Squid, which
 *   emits its own block first — `HTTP/1.1 200 Connection established`, blank
 *   line, then `HTTP/2 200`. So the first boundary is the PROXY's and the body
 *   slice starts at `HTTP/2 200`. Outside a proxied network there is no such
 *   block and the same code works, so this is a bug that passes wherever it is
 *   likely to be written.
 *
 *   `-D /dev/stderr` and read the two streams apart.  curl SEGFAULTS — gVisor,
 *   status null and signal SIGSEGV, with both streams empty.
 *
 * `--write-out %header{link}` needs curl >= 7.84 (this image has 7.88) and asks
 * curl for the single value rather than reconstructing it from a transcript. No
 * boundary to find, no second stream, no temp file — which keeps the property
 * that this tool writes nothing anywhere, since it runs from a read-only mount.
 *
 * ON AN OLDER CURL IT DEGRADES SILENTLY, and that is worth knowing rather than
 * guarding: the literal `%header{link}` is emitted, the regex misses, and
 * pagination reverts to page 1 — which is the defect this whole function exists
 * to fix. Only reachable if the tool ever runs outside this image, so it is a
 * line here rather than a version check that would run on every call.
 */
const SENTINEL = '\n@@pr-state-link@@';

function curlJson(url, withHeaders) {
  const args = ['-sS', '-H', 'Accept: application/vnd.github+json'];
  if (withHeaders) args.push('-w', `${SENTINEL}%header{link}`);
  const out = execFileSync('curl', [...args, url], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!withHeaders) return { body: JSON.parse(out), link: '' };
  const at = out.lastIndexOf(SENTINEL);
  if (at < 0) return { body: JSON.parse(out), link: '' };
  return { body: JSON.parse(out.slice(0, at)), link: out.slice(at + SENTINEL.length) };
}

function api(path, repo) {
  const url = path.startsWith('http') ? path : `https://api.github.com/repos/${repo}${path}`;
  const { body } = curlJson(url, false);
  if (!Array.isArray(body) && body?.message && body?.status) {
    throw new Error(`GitHub said ${body.status}: ${body.message} (${url})`);
  }
  return body;
}

/**
 * A paginated list endpoint: page 1 plus the LAST page.
 *
 * `per_page=100` fixes the default-30 trap and not the one behind it. These
 * endpoints are oldest-first with no `direction`, so on a busy pull request the
 * newest events — which is every question this tool asks — are on the last page,
 * and a bare `curl` discards the `Link` header that says so.
 *
 * The failure was silent and in the dangerous direction: with rounds 5-6 past
 * item 100, `roundState` reads an OLD pickup as current, finds that round's
 * findings after it, and reports FINISHED for a round that is running — the
 * exact mistake this file's tests name. It then checks the sha of a round from
 * four pushes ago. Both answers look completely normal.
 *
 * This is not a new rule. `agent-config.base.yaml` states it in `<habits>`
 * ("Newest last, and if the response has a rel=\"last\" link the newest are on
 * that page") and `src/github.ts` `#getAll` already implements it. This took the
 * first half of a two-part rule the repository states in two places.
 *
 * Middle pages are deliberately not fetched, and here is the whole of that
 * assumption rather than a promise that it is written down somewhere else — an
 * earlier version of this paragraph pointed at a statement "at the call site"
 * that did not exist:
 *
 *   comments and reviews  every question is about the newest, or about the full
 *                         set of reviews, which does not reach 200 on a pull
 *                         request a person is looking at.
 *
 *   the TIMELINE          the diluted one. Label events are a few per round
 *                         among commits, comment refs and cross-references, so
 *                         past ~200 events the current round's
 *                         `labeled`/`unlabeled` can sit in a skipped middle page
 *                         while the last page is full of something else, and
 *                         `roundState` falls back to an ancient round silently.
 *                         If that ever bites, `/issues/{n}/events` carries the
 *                         labellings undiluted — `<habits>` warns against it
 *                         because it omits comments, and this script already
 *                         fetches those separately, so the warning does not
 *                         apply here.
 */
function apiList(path, repo) {
  const url = `https://api.github.com/repos/${repo}${path}`;
  const first = curlJson(url, true);
  if (!Array.isArray(first.body)) {
    throw new Error(
      `GitHub said ${first.body?.status ?? '?'}: ${first.body?.message ?? 'unexpected'} (${url})`,
    );
  }
  const last = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(first.link);
  if (!last) return first.body;
  const sep = url.includes('?') ? '&' : '?';
  const tail = curlJson(`${url}${sep}page=${last[1]}`, false).body;
  return Array.isArray(tail) ? [...first.body, ...tail] : first.body;
}

/** Is `sha` an ancestor of `head` in the local clone? null if we cannot tell. */
function isAncestor(sha, head) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
  } catch {
    return null; // not in this clone; fetching is the caller's choice, not ours
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, head], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Round state from the TIMELINE, read backwards.
 *
 * The label is a request queue and OJ consumes it on pickup, so its presence or
 * absence is not the state. `labeled` with no later `unlabeled` is a request
 * still queued; `labeled` then `unlabeled` by OJ is a round that started at that
 * timestamp — and whether it FINISHED is a separate question answered by
 * findings, not by the acknowledgement comment.
 */
export function roundState(timeline, findings, declines = []) {
  let lastLabeled = null;
  let lastPickup = null;
  for (const e of timeline) {
    if (e.event !== 'labeled' && e.event !== 'unlabeled') continue;
    if (e.label?.name !== REVIEW_LABEL) continue;
    if (e.event === 'labeled') lastLabeled = e.created_at;
    else if (e.actor?.login === OJ_BOT) lastPickup = e.created_at;
  }

  if (!lastLabeled) return { state: 'NEVER REQUESTED', since: null };
  if (!lastPickup || lastPickup < lastLabeled) {
    return { state: 'QUEUED', since: lastLabeled, detail: 'requested, not yet picked up' };
  }
  const after = findings.filter((f) => f.at > lastPickup);
  if (after.length > 0) {
    return { state: 'FINISHED', since: after[after.length - 1].at };
  }
  const declined = declines.filter((d) => d.at > lastPickup);
  if (declined.length > 0) {
    const last = declined[declined.length - 1];
    return {
      state: 'DECLINED',
      since: last.at,
      detail: last.reason || 'no reason given — no findings are coming',
    };
  }
  return {
    state: 'RUNNING',
    since: lastPickup,
    detail: 'picked up; no findings posted since — the ack comment is not findings',
  };
}

export function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const repoAt = argv.indexOf('--repo');
  const repo = repoAt >= 0 ? argv[repoAt + 1] : DEFAULT_REPO;
  const number = argv.find((a) => /^\d+$/.test(a));
  if (!number) {
    console.error('usage: pr-state <pr> [--repo owner/name] [--json]');
    process.exit(2);
  }

  let pr = api(`/pulls/${number}`, repo);
  // `mergeable` is computed asynchronously and is null on a cold read. Ask once
  // more rather than reporting "unknown" for a value that arrives in a second.
  if (pr.mergeable === null && !pr.merged) {
    // Guarded, and it re-reads only a cosmetic field. `sleep` is a separate
    // binary and this shelled out to it unguarded: on a minimal image a missing
    // `sleep` took down the whole report AFTER the expensive reads had already
    // succeeded, to refresh one value the report can honestly print as null.
    try {
      execFileSync('sleep', ['2']);
      pr = api(`/pulls/${number}`, repo);
    } catch {
      /* keep the first read; `mergeable: null` prints as null and says so */
    }
  }
  const head = pr.head.sha;

  const comments = apiList(`/issues/${number}/comments?per_page=100`, repo);
  const timeline = apiList(`/issues/${number}/timeline?per_page=100`, repo);
  const reviews = apiList(`/pulls/${number}/reviews?per_page=100`, repo);

  // STRUCTURAL, not "a comment by OJ exists": findings carry the footer, the
  // acknowledgement does not. That distinction is the whole point — the ack is
  // posted about one second after pickup and is 151 characters long.
  // FINDING 5. `verdictMode: comment` in the footer implies other modes, and
  // `src/armed.ts` already treats OJ's REVIEWS as a carrier of its words. If a
  // round's findings ever ride a review body instead of an issue comment, a
  // comments-only search returns nothing and the round reads as RUNNING forever
  // (finding 3's failure by another route). `reviews` is already fetched for the
  // approvals, so looking there too is free.
  //
  // OJ raised this as a question rather than a defect — its posting path is not
  // in this repository and neither of us can check it. Covering both is cheaper
  // than being right about which.
  const carriers = [
    ...comments,
    ...reviews.map((r) => ({ user: r.user, created_at: r.submitted_at, body: r.body, html_url: r.html_url })),
  ];
  const findings = parseFindings(carriers).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const latest = findings[findings.length - 1] ?? null;
  const round = roundState(timeline, findings, parseDeclines(carriers));
  // Computed ONCE. Both the JSON and the text path called this, so `git` was
  // spawned twice for one answer.
  const verdict = latest ? classifyReviewedSha(latest.sha, head, isAncestor) : 'NONE';
  const approvals = approvalsFor(reviews, head);

  let ruleset = null;
  try {
    // EVERY governing ruleset, and the strictest requirement among them.
    //
    // Round 2's finding 2, and it became load-bearing because finding 1's fix
    // depends on `required` being non-null to stay honest. Three defects in the
    // first version, each silent:
    //
    //   `refs/heads/*` matched nothing. `ref_name.include` holds fnmatch
    //   patterns, not just literals and the two aliases, and a wildcard is one
    //   of the commonest ways to target a ruleset. An unmatched pattern dropped
    //   the ruleset, which lost the `ruleset` line, lost "of N required" beside
    //   the approvals, and landed in finding 1's wrong sentence.
    //
    //   `exclude` was not read, so `include: ['~ALL']` with
    //   `exclude: ['refs/heads/main']` was reported as governing main.
    //
    //   `.find()` took the first match while GitHub applies ALL of them and the
    //   effective requirement is the strictest.
    const list = api(`/rulesets?includes_parents=true`, repo);
    const base = pr.base?.ref;
    const governs = (r) => {
      const cond = r.conditions?.ref_name;
      const hit = (p) =>
        p === '~ALL' ||
        (p === '~DEFAULT_BRANCH' && base === pr.base?.repo?.default_branch) ||
        refPatternMatches(p, base);
      if ((cond?.exclude ?? []).some(hit)) return false;
      const include = cond?.include;
      if (!include || include.length === 0) return true;
      return include.some(hit);
    };
    const governing = Array.isArray(list)
      ? list.filter((r) => r.enforcement === 'active').filter(governs)
      : [];
    for (const summary of governing) {
      const full = api(`/rulesets/${summary.id}`, repo);
      // NO `continue` when there is no pull_request rule. A ruleset that enforces
      // required status checks and nothing else is an ordinary configuration: it
      // governs the branch, it was read successfully, and it requires ZERO
      // approvals. Skipping it left `ruleset` null, which the finding-1 fix then
      // reports as "the required approval count could not be read" — the one
      // thing that is not true — and drops the `ruleset` line entirely, so the
      // reader is not even told one exists. That is also the configuration where
      // `blocked` most likely DOES mean a required check.
      //
      // The distinction to keep is between "the read failed" (unknown) and "the
      // read succeeded and there is no approval rule" (zero). Round 2 had this
      // right by accident, via `?? 0` on an optional chain.
      const rule = (full.rules ?? []).find((r) => r.type === 'pull_request');
      const here = {
        name: full.name,
        required: rule?.parameters?.required_approving_review_count ?? 0,
        dismissStaleOnPush: rule?.parameters?.dismiss_stale_reviews_on_push ?? false,
        bypass: (full.bypass_actors ?? []).length,
      };
      // Strictest wins: more approvals required, and stale-dismissal on if ANY
      // governing ruleset turns it on.
      ruleset =
        ruleset == null || here.required > ruleset.required
          ? { ...here, dismissStaleOnPush: here.dismissStaleOnPush || (ruleset?.dismissStaleOnPush ?? false) }
          : { ...ruleset, dismissStaleOnPush: ruleset.dismissStaleOnPush || here.dismissStaleOnPush };
    }
    // AFTER the loop, once. Inside it, every iteration re-suffixed the name it
    // was already holding: `OJ1 (strictest of 2) (strictest of 2)`. Cosmetic, and
    // on the printed line — and the multi-ruleset path was the only new code this
    // round with no test, which is round 1 finding 1's pattern exactly.
    if (ruleset && governing.length > 1) {
      ruleset.name = `${ruleset.name} (strictest of ${governing.length})`;
    }
  } catch {
    // `/branches/*/protection` is 403 for an App; `/rulesets` is not. If even
    // that fails, say so rather than implying there is no protection.
    ruleset = { name: '(unreadable)', required: null, dismissStaleOnPush: null, bypass: null };
  }

  const report = {
    repo,
    number: Number(number),
    head,
    merged: pr.merged,
    round,
    reviewSawThisCode: latest ? { round: latest.round, sha: latest.sha, verdict } : null,
    // `why` and `staleApprovals` are in the JSON as well as the text, because a
    // scripted consumer reading `mergeable_state === 'clean'` would otherwise get
    // exactly the adjacent-answer field this tool exists to annotate, unannotated.
    merge: {
      mergeable: pr.mergeable,
      mergeable_state: pr.mergeable_state,
      why: explainMergeState(pr.mergeable_state, approvals, ruleset),
      staleApprovals: approvals.filter((a) => a.stale && a.sha).length,
    },
    approvals,
    ruleset,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const say = (q, a) => console.log(`  ${q.padEnd(30)} ${a}`);
  console.log(`\n${repo}#${number}  head ${head.slice(0, 8)}\n`);

  if (pr.merged) {
    say('merged?', `YES, ${pr.merged_at} by ${pr.merged_by?.login ?? '?'}`);
    return;
  }
  say('merged?', 'no');

  say(
    'review round',
    `${round.state}${round.since ? `  since ${round.since}` : ''}${round.detail ? `  (${round.detail})` : ''}`,
  );

  if (!latest) {
    say('review saw this code?', 'no findings yet');
  } else {
    const verdictText = {
      EXACT: 'YES — reviewed this exact commit',
      ANCESTOR: 'PARTLY — reviewed an ancestor; commits since it are unreviewed',
      VOID: 'NO — VOID. The reviewed commit is not in this head\'s history.',
      UNKNOWN:
        'UNKNOWN — that commit is not reachable from here. Run this from a clone of the ' +
        'repository if you need the answer; from an agent workspace, which is not a ' +
        'clone, this is the normal result rather than a fault.',
    }[verdict];
    say(`review saw this code?`, `${verdictText}\n${' '.repeat(33)}round ${latest.round} read ${latest.sha}`);
  }

  const why = explainMergeState(pr.mergeable_state, approvals, ruleset);
  say('can it merge?', `${pr.mergeable_state} — ${why}`);
  say('', `(mergeable: ${pr.mergeable} — only says git can combine the trees; not the question)`);

  if (approvals.length === 0) {
    say('approvals', `none${ruleset?.required ? ` of ${ruleset.required} required` : ''}`);
  } else {
    for (const a of approvals) {
      say(
        'approval',
        `${a.by} at ${a.at} — ${
          !a.sha
            ? `commit_id absent, so whether it covers ${head.slice(0, 8)} is unknown`
            : a.stale
              ? `STALE: approved ${a.sha.slice(0, 8)}, head is ${head.slice(0, 8)}`
              : 'for this exact head'
        }`,
      );
    }
    if (approvals.some((a) => a.stale) && ruleset?.dismissStaleOnPush === false) {
      say('', 'dismiss_stale_reviews_on_push is FALSE — GitHub still counts the stale one');
    }
  }

  if (ruleset) {
    say(
      'ruleset',
      `${ruleset.name}: ${ruleset.required ?? '?'} approval(s), ${ruleset.bypass ?? '?'} bypass actor(s)`,
    );
  }
  console.log('');
}

// Only when this module IS the entry point. Launched through the `pr-state`
// shim beside it, argv[1] is the shim rather than this file, so the shim calls
// `main()` itself — otherwise the tool would exit silently having done nothing,
// which is a failure mode this file exists to argue against.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
