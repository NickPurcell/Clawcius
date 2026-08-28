#!/usr/bin/env node
/**
 * Answer the questions agents have about a pull request: is a review round
 * running, queued or finished; did the last round read the code on the branch
 * now; can it merge, and if not why; and is each approval still for the head.
 *
 * Usage:  pr-cli/pr-state <pr> [--repo owner/name] [--json]
 *
 * Reads through bare `curl`, which is authenticated via netrc. Do not add an
 * Authorization header: an explicit one replaces the netrc credential and
 * authenticates as the account rather than as the App. Reads `/rulesets`, not
 * `/branches/{branch}/protection`, which is 403 for an App without
 * `Administration: read`.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO = 'NickPurcell/Clawcius';
const OJ_BOT = 'osmosis-jones-agent[bot]';
const REVIEW_LABEL = 'oj:review';

/** The findings footer, the only place a round names the commit it read. */
export const FOOTER = /<sub>OJ\s*·\s*round\s*(\d+)\s*·\s*head\s*`([0-9a-f]+)`/;

/**
 * OJ comments that are findings, structurally: the acknowledgement is also a
 * comment by OJ and carries no footer.
 */
export function parseFindings(comments) {
  return comments
    .filter((c) => c.user?.login === OJ_BOT)
    .map((c) => ({ at: c.created_at, m: FOOTER.exec(c.body ?? ''), url: c.html_url }))
    .filter((c) => c.m)
    .map((c) => ({ at: c.at, round: Number(c.m[1]), sha: c.m[2], url: c.url }));
}

/**
 * OJ declining a round: it unlabels like a pickup and posts no footer. Not
 * anchored hard at `^`, since OJ's system comments may open with an emoji.
 */
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
 * EXACT    the reviewed commit IS the head
 * ANCESTOR the head has moved on; commits since it are unreviewed
 * VOID     the reviewed commit is not in the head's history at all
 * UNKNOWN  the sha is not in this clone
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
 * GitHub keeps counting an approval after the branch moves when
 * `dismiss_stale_reviews_on_push` is false.
 */
export function approvalsFor(reviews, head) {
  // One per reviewer, from their latest review, which is how GitHub counts.
  const latest = new Map();
  for (const r of reviews) {
    // Reviews arrive oldest-first; only these states supersede — a COMMENTED
    // review does not retract an approval.
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && r.state !== 'DISMISSED') continue;
    if (r.user?.login) latest.set(r.user.login, r);
  }
  return [...latest.values()]
    .filter((r) => r.state === 'APPROVED')
    .map((r) => ({
      by: r.user?.login,
      at: r.submitted_at,
      sha: r.commit_id,
      // Three states: `unknown` when commit_id is absent (`!r.commit_id`, so an
      // empty string counts as absent).
      coverage: !r.commit_id ? 'unknown' : r.commit_id === head ? 'current' : 'stale',
    }));
}

/**
 * Why a stale approval went stale: `spent` when only authors already on the
 * branch pushed after it, `overtaken` when a new author appeared, `null` when
 * it cannot tell (no commits either side, or an author with no login).
 *
 * Authorship is the proxy for who pushed: the REST API does not report the
 * pusher, and a rebase preserves the author. Compared among commit authors,
 * not against `pr.user.login`: the pull request is opened by the App and the
 * commits are authored by the user.
 */
export function whyStale(approval, commits) {
  if (!approval?.at) return null;
  // Author date, not committer date: a rebase rewrites the committer date on
  // every commit it touches.
  const dateOf = (c) => c.commit?.author?.date ?? c.commit?.committer?.date;

  const before = commits.filter((c) => {
    const at = dateOf(c);
    return at !== undefined && at <= approval.at;
  });
  const after = commits.filter((c) => {
    const at = dateOf(c);
    return at !== undefined && at > approval.at;
  });
  if (after.length === 0 || before.length === 0) return null;

  const login = (c) => c.author?.login;
  if ([...before, ...after].some((c) => !login(c))) return null;

  // Who was already writing this branch when the approval landed.
  const owners = new Set(before.map(login));
  return after.every((c) => owners.has(login(c))) ? 'spent' : 'overtaken';
}

/**
 * Does a ruleset ref pattern match this branch? `conditions.ref_name` holds
 * fnmatch patterns against the full ref, so `refs/heads/*` means every branch.
 * `*` becomes `.*`, which crosses `/`; `**` is the same language, so any
 * narrowing of `*` must handle `**` first.
 */
export function refPatternMatches(pattern, branch) {
  if (!pattern || !branch) return false;
  const full = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  const rx = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  return rx.test(full) || rx.test(branch);
}

/** Why a pull request cannot merge, in words, from `mergeable_state`. */
export function explainMergeState(state, approvals, ruleset) {
  const required = ruleset?.required;
  const stale = approvals.filter((a) => a.coverage === 'stale');
  switch (state) {
    case 'clean':
      // `clean` is GitHub's verdict, and GitHub still counts an approval whose
      // branch moved when dismiss_stale_reviews_on_push is false, so every
      // coverage bucket is reported.
      const unknown = approvals.filter((a) => a.coverage === 'unknown');
      // Counted, not inferred by subtraction.
      const current = approvals.filter((a) => a.coverage === 'current').length;
      if (stale.length === 0 && unknown.length === 0) return 'nothing blocking';

      // Reads `dismissStaleOnPush` rather than asserting it; shown only when
      // something is stale.
      const them = stale.length === 1 ? 'it' : 'them';
      const dismissal =
        stale.length === 0
          ? ''
          : ruleset?.dismissStaleOnPush === false
            ? ` (dismiss_stale_reviews_on_push is false, so GitHub still counts ${them})`
            : ruleset?.dismissStaleOnPush === true
              ? ` — though dismiss_stale_reviews_on_push is TRUE, so check why GitHub still counts ${them}`
              : ' (whether stale reviews are dismissed could not be read)';

      const said = [];
      if (stale.length > 0) {
        said.push(
          `${stale.length} STALE, for a commit no longer at the head`,
        );
      }
      if (unknown.length > 0) {
        said.push(`${unknown.length} with no commit_id, so coverage is UNKNOWN`);
      }
      return (
        `nothing GitHub blocks on — but of ${approvals.length} approval(s): ` +
        `${said.join(', and ')}. ` +
        (current > 0
          ? `${current} DOES cover this head`
          : // Nothing is known to cover the head; with an UNKNOWN approval only a
            // claim about knowledge is available.
            (unknown.length > 0
              ? 'None is KNOWN to cover this head and the UNKNOWN one(s) may or may not, ' +
                'so whether this code has been reviewed cannot be settled from here'
              : 'None covers this head, so merging now merges code no review has read')) +
        dismissal
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
      // `required` is unknown when the `/rulesets` read threw, no active ruleset
      // governs the base ref, or the repo uses classic branch protection.
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
 * One request: the body, plus the `link` header appended after a sentinel by
 * curl's `--write-out %header{link}` (curl >= 7.84). `-D -` is wrong behind
 * Squid, which emits its own `200 Connection established` block first, and
 * `-D /dev/stderr` segfaults curl under gVisor. On an older curl the literal
 * `%header{link}` is emitted, the regex misses, and pagination reverts to
 * page 1.
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
 * A paginated list endpoint: page 1 plus the LAST page. These endpoints are
 * oldest-first with no `direction`, so the newest events are on the last page.
 * Middle pages are not fetched: every question is about the newest comments,
 * or the full set of reviews, which does not reach 200. Past ~200 timeline
 * events the current round's label events can sit in a skipped middle page.
 */
function apiList(path, repo) {
  return apiListSayingIfTruncated(path, repo).items;
}

/**
 * `apiList`, plus whether a middle page was skipped: `whyStale` splits commits
 * either side of a timestamp, so an incomplete list would yield a verdict
 * rather than declining.
 */
function apiListSayingIfTruncated(path, repo) {
  const url = `https://api.github.com/repos/${repo}${path}`;
  const first = curlJson(url, true);
  if (!Array.isArray(first.body)) {
    throw new Error(
      `GitHub said ${first.body?.status ?? '?'}: ${first.body?.message ?? 'unexpected'} (${url})`,
    );
  }
  const last = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(first.link);
  if (!last) return { items: first.body, truncated: false };
  const sep = url.includes('?') ? '&' : '?';
  const tail = curlJson(`${url}${sep}page=${last[1]}`, false).body;
  return {
    items: Array.isArray(tail) ? [...first.body, ...tail] : first.body,
    // Two pages IS the whole list; three or more means a middle was dropped.
    truncated: Number(last[1]) > 2,
  };
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
 * Round state from the timeline, read backwards. The label is a request queue
 * and OJ consumes it on pickup, so its presence is not the state: `labeled`
 * with no later `unlabeled` is queued; `labeled` then `unlabeled` by OJ is a
 * round that started then, and whether it finished is answered by findings.
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
    // Guarded: `sleep` is a separate binary, and it re-reads only a cosmetic field.
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

  // Findings carry the footer; the acknowledgement does not. Searched over
  // comments and review bodies both.
  const carriers = [
    ...comments,
    ...reviews.map((r) => ({ user: r.user, created_at: r.submitted_at, body: r.body, html_url: r.html_url })),
  ];
  const findings = parseFindings(carriers).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const latest = findings[findings.length - 1] ?? null;
  const round = roundState(timeline, findings, parseDeclines(carriers));
  const verdict = latest ? classifyReviewedSha(latest.sha, head, isAncestor) : 'NONE';
  const bare = approvalsFor(reviews, head);

  // Fetched only when something can display it: a live approval exists and
  // some approval is off the head. A truncated list yields no verdict.
  const needsCommits =
    bare.length > 0 &&
    reviews.some((r) => r.state === 'APPROVED' && r.commit_id && r.commit_id !== head);
  const { items: commits, truncated } = needsCommits
    ? apiListSayingIfTruncated(`/pulls/${number}/commits?per_page=100`, repo)
    : { items: [], truncated: false };
  const why0 = (a) => (truncated ? null : whyStale(a, commits));

  const approvals = bare.map((a) => (a.coverage === 'stale' ? { ...a, why: why0(a) } : a));

  // `spentApprovals` decomposes `staleApprovals`, so it counts the same
  // one-per-reviewer set; `roundsSpent` counts every approval ever cast.
  const spentApprovals = approvals.filter((a) => a.why === 'spent').length;
  const roundsSpent = truncated
    ? 0
    : reviews
        .filter((r) => r.state === 'APPROVED' && r.commit_id && r.commit_id !== head)
        .filter((r) => whyStale({ at: r.submitted_at }, commits) === 'spent').length;

  let ruleset = null;
  try {
    // Every governing ruleset, and the strictest requirement among them.
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
      // No `continue` when there is no pull_request rule: a ruleset that governs
      // the branch and has no approval rule requires zero, which is not "unread".
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
    if (ruleset && governing.length > 1) {
      ruleset.name = `${ruleset.name} (strictest of ${governing.length})`;
    }
  } catch {
    // `/branches/*/protection` is 403 for an App; `/rulesets` is not. If even
    // that fails, say so rather than implying there is no protection.
    ruleset = { name: '(unreadable)', required: null, dismissStaleOnPush: null, bypass: null };
  }

  const why = explainMergeState(pr.mergeable_state, approvals, ruleset);
  const report = {
    repo,
    number: Number(number),
    head,
    merged: pr.merged,
    round,
    reviewSawThisCode: latest ? { round: latest.round, sha: latest.sha, verdict } : null,
    // `why` and the counts are in the JSON too, so a scripted consumer reading
    // `mergeable_state` gets the annotation.
    merge: {
      mergeable: pr.mergeable,
      mergeable_state: pr.mergeable_state,
      why,
      staleApprovals: approvals.filter((a) => a.coverage === 'stale').length,
      spentApprovals,
      overtakenApprovals: approvals.filter((a) => a.why === 'overtaken').length,
      unknownCoverageApprovals: approvals.filter((a) => a.coverage === 'unknown').length,
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

  say('can it merge?', `${pr.mergeable_state} — ${why}`);
  say('', `(mergeable: ${pr.mergeable} — only says git can combine the trees; not the question)`);

  if (approvals.length === 0) {
    say('approvals', `none${ruleset?.required ? ` of ${ruleset.required} required` : ''}`);
  } else {
    // How many times this branch has been round the loop.
    const everApproved = reviews.filter((r) => r.state === 'APPROVED').length;
    if (roundsSpent > 0) {
      say(
        'approval history',
        `${everApproved} approval(s) so far; ${roundsSpent} with no new author since`,
      );
    }
    for (const a of approvals) {
      say(
        'approval',
        `${a.by} at ${a.at} — ${
          a.coverage === 'unknown'
            ? `commit_id absent, so whether it covers ${head.slice(0, 8)} is unknown`
            : a.coverage === 'stale'
              ? `STALE: approved ${a.sha.slice(0, 8)}, head is ${head.slice(0, 8)}` +
                // Why it went stale, when that is knowable.
                (a.why === 'spent'
                  ? ' — SPENT: no new author has pushed since'
                  : a.why === 'overtaken'
                    ? ' — OVERTAKEN: an author who was not on this branch has pushed since'
                    : '')
              : 'for this exact head'
        }`,
      );
    }
    const staleCount = approvals.filter((a) => a.coverage === 'stale').length;
    if (staleCount > 0 && ruleset?.dismissStaleOnPush === false) {
      say(
        '',
        `dismiss_stale_reviews_on_push is FALSE — GitHub still counts ${
          staleCount === 1 ? 'the stale one' : `all ${staleCount} stale ones`
        }`,
      );
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

// Only when this module is the entry point; launched through the `pr-state`
// shim, argv[1] is the shim and the shim calls `main()` itself.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
