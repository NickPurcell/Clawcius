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
 * Usage:  node scripts/pr-state.mjs <pr> [--repo owner/name] [--json]
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
  return reviews
    .filter((r) => r.state === 'APPROVED')
    .map((r) => ({ by: r.user?.login, at: r.submitted_at, sha: r.commit_id, stale: r.commit_id !== head }));
}

function api(path, repo) {
  const url = path.startsWith('http')
    ? path
    : `https://api.github.com/repos/${repo}${path}`;
  const out = execFileSync('curl', ['-sS', '-H', 'Accept: application/vnd.github+json', url], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed) && parsed?.message && parsed?.status) {
    throw new Error(`GitHub said ${parsed.status}: ${parsed.message} (${url})`);
  }
  return parsed;
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
export function roundState(timeline, findings) {
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
  return {
    state: 'RUNNING',
    since: lastPickup,
    detail: 'picked up; no findings posted since — the ack comment is not findings',
  };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const repoAt = argv.indexOf('--repo');
  const repo = repoAt >= 0 ? argv[repoAt + 1] : DEFAULT_REPO;
  const number = argv.find((a) => /^\d+$/.test(a));
  if (!number) {
    console.error('usage: node scripts/pr-state.mjs <pr> [--repo owner/name] [--json]');
    process.exit(2);
  }

  let pr = api(`/pulls/${number}`, repo);
  // `mergeable` is computed asynchronously and is null on a cold read. Ask once
  // more rather than reporting "unknown" for a value that arrives in a second.
  if (pr.mergeable === null && !pr.merged) {
    execFileSync('sleep', ['2']);
    pr = api(`/pulls/${number}`, repo);
  }
  const head = pr.head.sha;

  const comments = api(`/issues/${number}/comments?per_page=100`, repo);
  const timeline = api(`/issues/${number}/timeline?per_page=100`, repo);
  const reviews = api(`/pulls/${number}/reviews?per_page=100`, repo);

  // STRUCTURAL, not "a comment by OJ exists": findings carry the footer, the
  // acknowledgement does not. That distinction is the whole point — the ack is
  // posted about one second after pickup and is 151 characters long.
  const findings = parseFindings(comments);

  const round = roundState(timeline, findings);
  const latest = findings[findings.length - 1] ?? null;

  const approvals = approvalsFor(reviews, head);

  let ruleset = null;
  try {
    const list = api(`/rulesets`, repo);
    const active = Array.isArray(list) ? list.find((r) => r.enforcement === 'active') : null;
    if (active) {
      const full = api(`/rulesets/${active.id}`, repo);
      const rule = (full.rules ?? []).find((r) => r.type === 'pull_request');
      ruleset = {
        name: full.name,
        required: rule?.parameters?.required_approving_review_count ?? 0,
        dismissStaleOnPush: rule?.parameters?.dismiss_stale_reviews_on_push ?? false,
        bypass: (full.bypass_actors ?? []).length,
      };
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
    reviewSawThisCode: latest
      ? { round: latest.round, sha: latest.sha, verdict: classifyReviewedSha(latest.sha, head, isAncestor) }
      : null,
    merge: { mergeable: pr.mergeable, mergeable_state: pr.mergeable_state },
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
    const verdict = {
      EXACT: 'YES — reviewed this exact commit',
      ANCESTOR: 'PARTLY — reviewed an ancestor; commits since it are unreviewed',
      VOID: 'NO — VOID. The reviewed commit is not in this head\'s history.',
      UNKNOWN: 'UNKNOWN — that sha is not in this clone (git fetch first)',
    }[classifyReviewedSha(latest.sha, head, isAncestor)];
    say(`review saw this code?`, `${verdict}\n${' '.repeat(34)}round ${latest.round} read ${latest.sha}`);
  }

  const why =
    pr.mergeable_state === 'clean'
      ? 'nothing blocking'
      : pr.mergeable_state === 'blocked'
        ? `branch protection${ruleset?.required ? ` — needs ${ruleset.required} approval(s), has ${approvals.length}` : ''}`
        : pr.mergeable_state === 'dirty'
          ? 'merge conflicts'
          : pr.mergeable_state === 'behind'
            ? 'branch is behind the base'
            : pr.mergeable_state === 'unstable'
              ? 'a required check is failing or pending'
              : pr.mergeable_state;
  say('can it merge?', `${pr.mergeable_state} — ${why}`);
  say('', `(mergeable: ${pr.mergeable} — only says git can combine the trees; not the question)`);

  if (approvals.length === 0) {
    say('approvals', `none${ruleset?.required ? ` of ${ruleset.required} required` : ''}`);
  } else {
    for (const a of approvals) {
      say(
        'approval',
        `${a.by} at ${a.at} — ${a.stale ? `STALE: approved ${a.sha.slice(0, 8)}, head is ${head.slice(0, 8)}` : 'for this exact head'}`,
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
