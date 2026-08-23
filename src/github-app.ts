/**
 * GitHub App installation tokens, and why the daemon needs a *provider* rather
 * than a token.
 *
 * The WAKER polls GitHub as the App instead of as the account whose personal
 * access token the crew holds.
 *
 * BE PRECISE ABOUT WHAT THAT DOES AND DOES NOT BUY, because the first version
 * of this comment claimed the second and was wrong. The credential minted here
 * is consumed by exactly one object — `GitHubClient` — and that client is
 * read-only: `getPullRequest`, `listReviews`, `listComments`, one `#get` and no
 * other request path. It never opens a pull request, never pushes, never
 * approves.
 *
 * So this does NOT change who authors pull requests, and does NOT make a
 * required-approval ruleset satisfiable.
 *
 * WHAT AUTHORSHIP DOES COME FROM CHANGED, and this paragraph is where a reader
 * comes to find out, so it says so rather than being left to go stale: agents
 * now read their credential from a file `token-file.ts` keeps current, so a
 * `git push` carries the INSTALLATION token where it used to carry the PAT.
 * That means the App needs `Contents: write`. The mechanism lives in
 * `token-file.ts` and not here, because the two consumers have different
 * lifetimes and mixing them would make neither reviewable. What it buys is
 * that the waker's own reads carry an
 * identity separable from the crew's, and that the credential it carries can be
 * rotated without touching the agent.
 *
 * ── The part that is not a drop-in ──────────────────────────────────────────
 *
 * A PAT does not expire. An installation token expires in **one hour**, and
 * this repository has two consumers of `config.github.token` with different
 * lifetimes:
 *
 *   1. Every agent session, through `--env-file` at `docker exec`. Fixed for
 *      the life of the `claude` process.
 *   2. THIS process's own `GitHubClient`, built once at startup
 *      (`daemon.ts`) and used by every `watchPr` poll for as long as the
 *      daemon runs — days.
 *
 * The second is the dangerous one and it is why this file exists. A `watchPr`
 * poll that throws is not retried: `ArmedWaker` calls `store.disarm()` and
 * mails the owner once. So a token that expires under a long-running daemon
 * does not degrade — an hour after startup, EVERY armed watch in the crew dies
 * on its next tick, permanently, and the crew loses the mechanism it learns
 * through. That is a cliff, not a slope, and it is invisible until it has
 * already happened.
 *
 * The fix is that the client never holds a token. It holds a function, and
 * asks for one per request; this module is what answers.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * Nothing about the agent's session environment. That is the other consumer,
 * and it lives in `token-file.ts`: the token reaches a container through a
 * mechanism this file cannot see, and mixing the two would make neither
 * reviewable.
 *
 * ── Logging ─────────────────────────────────────────────────────────────────
 *
 * The PEM, the JWT and the installation token are never logged, and neither is
 * the PEM's PATH. `ops/src/host-agent.ts` names the trap this guards against: a
 * variable whose NAME is innocent and whose VALUE carries a credential. A path
 * is the same trap wearing different clothes — it names the file, and the file
 * is the key.
 */

import { createSign } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';

const { R_OK } = fsConstants;

/** Answers with a token that is valid *now*. */
export type TokenProvider = () => Promise<string>;

/**
 * Refresh this long before expiry.
 *
 * An installation token lasts an hour. Five minutes is enough to cover a slow
 * request that started just before the boundary, and small enough that the
 * extra mints are negligible — one every 55 minutes rather than every 60.
 */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** JWTs are rejected if `exp` is more than 10 minutes out. Stay well inside. */
const JWT_LIFETIME_S = 9 * 60;

/**
 * Clock skew allowance on `iat`.
 *
 * GitHub rejects a JWT whose `iat` is in the future by its clock. Backdating by
 * a minute is what their own documentation recommends, and costs nothing.
 */
const JWT_BACKDATE_S = 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * A short-lived JWT proving control of the App's private key.
 *
 * This authenticates as the APP, which can enumerate installations and mint
 * installation tokens — and can do nothing else. It is not a repository
 * credential.
 */
export function appJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - JWT_BACKDATE_S;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

/**
 * One predicate, two callers, deliberately.
 *
 * The boot check (`checkAppConfig`) and the runtime throw (`mint`) answer the
 * same question about the same value at two different moments. Written twice
 * they can drift, and the direction of drift is the bad one: the operator is
 * told the boot line is where they learn what happened, so a boot check that
 * had quietly grown laxer than the runtime one would clear a value that later
 * disarms every watch in the crew.
 *
 * The MESSAGES stay separate — one is a warning with a remedy, the other is a
 * throw — because it is the condition that must not diverge, not the prose.
 */
export function isInstallationIdValid(id: string | undefined): boolean {
  return id === undefined || id === '' || /^\d+$/.test(id);
}

/**
 * A character the operator cannot see, in a value the operator typed.
 *
 * THE FAILURE THESE THREE VARIABLES SHARE is not a wrong value, it is an
 * invisible one: a `\r` from a Windows paste, a trailing newline in a systemd
 * `EnvironmentFile`, a space picked up by a shell heredoc. The value looks
 * right in the file and in every journal line that echoes it, and it is wrong.
 *
 * Checked against the FAILURE MODE rather than against a format, deliberately.
 * `iss` accepts either the numeric App ID or a client ID (`Iv23li…`, and older
 * ones contain a dot), so a positive pattern would be this module guessing at
 * GitHub's identifier alphabet and would reject a valid deployment the first
 * time that alphabet changed. Nothing legitimate in any of the three carries any
 * character named below, and that is knowable without guessing.
 *
 * EXACTLY THREE GROUPS, and this list is the whole of the claim:
 *
 *   C0 controls and DEL   \u0000-\u001F, \u007F   -- \r, \n, \t
 *   Unicode format chars  \p{Cf}                  -- ZWSP, soft hyphen, word
 *                                                    joiner, BOM, ZWJ/ZWNJ
 *   whitespace            \s                      -- ALL of it for the App ID;
 *                                                    for the path, all of it
 *                                                    EXCEPT U+0020
 *
 * `\p{Cf}` is here because it is the WORST case, not an exotic one. A trailing
 * space can be found by moving a cursor; a zero-width space cannot be found at
 * all, and web UIs insert them into long identifiers to allow line breaking --
 * so "I copied the App ID off the page" is exactly how one arrives. The
 * consequence is the one this check exists to prevent, a 401 at first mint
 * inside the catch that disarms every armed row, reached through the single
 * input an operator has no way to inspect. The more invisible the character,
 * the more a boot check is the ONLY thing that can catch it.
 *
 * It is also free to be right about: `\p{Cf}` is a NEGATIVE pattern, so the
 * objection to positive ones above -- that they guess at someone else's
 * alphabet and expire when it changes -- does not apply to it.
 *
 * U+0020 IS THE ONLY CHARACTER THE TWO DIFFER ON, and that is the whole of the
 * difference: a filesystem path may legitimately contain a space, and an App ID
 * may not. Nobody types NBSP, a figure space or an ideographic space into a path
 * on purpose either, and letting them through delivered the ENOENT message this
 * function suppresses for `\r` -- true, unhelpful, and pointing at the visible
 * half of a value whose problem is the invisible half.
 *
 * Written `[^\S ]` -- whitespace that is not a space -- so the exception stays
 * one character wide and cannot quietly grow into "whitespace is allowed here".
 */
const INVISIBLE = /[^\S ]|[\u0000-\u001F\u007F\p{Cf}]/u;
const INVISIBLE_OR_SPACE = /[\s\u0000-\u001F\u007F\p{Cf}]/u;

type Minted = { token: string; expiresAtMs: number };

/**
 * Ask GitHub for a token, as the App.
 *
 * `installationId` is optional because an App installed on exactly one account
 * — which is this deployment — can discover it. An operator who installs it
 * more widely should pin the id in configuration rather than have the daemon
 * guess which installation it meant.
 */
async function mint(
  opts: GitHubAppOptions,
  jwt: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<Minted> {
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'clawsky-github-app',
  };
  const base = opts.apiBase.replace(/\/+$/, '');

  let id = opts.installationId;
  // Operator-controlled, and it is interpolated into a path. `github.ts`
  // validates every value it interpolates (`requireRepo`, `requirePr`,
  // `encodePath`) so a bad one fails with a name instead of a puzzling status,
  // and a trailing newline in a systemd EnvironmentFile is an ordinary typo.
  // Here it matters more than style: the failure lands as a permanent disarm.
  if (!isInstallationIdValid(id)) {
    throw new Error('GITHUB_APP_INSTALLATION_ID must be digits only');
  }
  if (!id) {
    const res = await fetchImpl(`${base}/app/installations`, { headers });
    if (!res.ok) throw new Error(`listing installations: GitHub answered ${res.status}`);
    const list = (await res.json()) as Array<{ id: number }>;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('the App has no installations — install it on the account first');
    }
    if (list.length > 1) {
      // Guessing would pick a repository set nobody chose. Name the fix.
      throw new Error(
        `the App has ${list.length} installations; set GITHUB_APP_INSTALLATION_ID ` +
        'to choose one',
      );
    }
    id = String(list[0]!.id);
  }

  const res = await fetchImpl(`${base}/app/installations/${id}/access_tokens`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) {
    // No body: a 4xx here can echo the request, and the request carries the JWT.
    throw new Error(`minting an installation token: GitHub answered ${res.status}`);
  }
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new Error('GitHub returned no token');
  // `Date.parse` answers NaN on anything it cannot read, and NaN is never
  // greater than anything — so a malformed field would make the cache check
  // false forever and mint a token per request. That is not a slow cache: it is
  // a POST per poll per watch, and the rate limit it reaches throws, and a mint
  // that throws is the permanent disarm this whole file exists to prevent. A
  // field this code does not control must not be able to do that.
  const parsed = body.expires_at ? Date.parse(body.expires_at) : NaN;
  const expiresAtMs = Number.isFinite(parsed) ? parsed : now() + 3_600_000;
  return { token: body.token, expiresAtMs };
}

export type GitHubAppOptions = {
  appId: string;
  privateKeyPath: string;
  installationId?: string;
  apiBase: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
};

/**
 * A provider that mints on demand and reuses until the token is nearly spent.
 *
 * The PEM is read per mint rather than held in memory for the daemon's life, so
 * rotating the key on disk takes effect at the next refresh instead of at the
 * next restart. It is read at most once every ~55 minutes, so the cost is not
 * worth optimising away.
 *
 * In-flight mints are shared. Without that, a burst of watches ticking together
 * on a cold cache would each mint their own token — correct, but several
 * needless round trips against a rate limit, and every one of them a credential.
 */
export function appTokenProvider(opts: GitHubAppOptions): TokenProvider {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let cached: Minted | null = null;
  let inFlight: Promise<Minted> | null = null;

  return async () => {
    if (cached && cached.expiresAtMs - now() > REFRESH_MARGIN_MS) return cached.token;
    if (!inFlight) {
      inFlight = (async () => {
        const pem = readFileSync(opts.privateKeyPath, 'utf8');
        const minted = await mint(opts, appJwt(opts.appId, pem, now()), fetchImpl, now);
        cached = minted;
        return minted;
      })().finally(() => {
        inFlight = null;
      });
    }
    return (await inFlight).token;
  };
}

/** The PAT path, unchanged in behaviour: the same string, forever. */
export function staticTokenProvider(token: string): TokenProvider {
  return async () => token;
}

/** What a given character will actually cause. Worst last; see the docstring. */
type Outcome = 'tolerated' | 'rejected' | 'throws';

/**
 * Names for the characters that actually arrive, so the operator does not have
 * to look up a codepoint to find out what to delete.
 *
 * Not a general Unicode name table and not trying to be: anything absent falls
 * back to the bare `U+XXXX`, which is still a specific claim about a specific
 * position. These are the ones with a known route into a token -- a paste from
 * a browser, a shell heredoc, a Windows line ending.
 */
const CHARACTER_NAMES: Record<number, string> = {
  0x0000: '(a NUL)',
  0x0009: '(a tab)',
  0x000a: '(a newline)',
  0x000d: '(a carriage return, as a Windows line ending leaves)',
  0x0020: '(a space)',
  0x00a0: '(a non-breaking space)',
  0x00ad: '(a soft hyphen)',
  0x200b: '(a zero-width space, which web pages insert into long identifiers)',
  0x200c: '(a zero-width non-joiner)',
  0x200d: '(a zero-width joiner)',
  0x2060: '(a word joiner)',
  0xfeff: '(a byte-order mark, as a UTF-8 BOM leaves at the front of a file)',
  // What a word processor or a web page substitutes as you type. These are
  // the paste-from-a-document artifacts, and they are the half this table
  // used to be silent about -- not invisible, but nobody reads an opaque
  // forty-character credential closely enough to see one.
  0x2018: "(a curly left single quote, as a document substitutes for ')",
  0x2019: "(a curly right single quote, as a document substitutes for ')",
  0x201c: '(a curly left double quote, as a document substitutes for ")',
  0x201d: '(a curly right double quote, as a document substitutes for ")',
  0x2013: '(an en dash, as a document substitutes for -)',
  0x2014: '(an em dash, as a document substitutes for --)',
  0x2026: '(an ellipsis, as a document substitutes for ...)',
};

/**
 * What is in `GITHUB_TOKEN` that the operator cannot see, and what it will
 * actually do -- as one sentence, or `null` if there is nothing to say.
 *
 * ── This diagnoses; it does not validate ────────────────────────────────────
 *
 * Nothing here rejects a token, refuses to start, or alters the value. The
 * standing preference is visible failure over guards, and this earns its place
 * by making a failure LEGIBLE rather than by preventing one. The cost it
 * removes is not a bad request; it is an afternoon spent on scopes and
 * permissions because the signal pointed at the wrong subject.
 *
 * Which is also why it must not cry wolf. A warning about a value that works is
 * worse than silence: it is a second thing to disbelieve, and next time the real
 * one is disbelieved too.
 *
 * ── THREE outcomes, not two, and this was measured ──────────────────────────
 *
 * #185 assumed two (throws, or a 401) and explicitly could not tell whether
 * whitespace caused its 401, because the probe token was fake. Driving the real
 * header layer settles it, and adds a third case that is the COMMONEST one:
 *
 *   TOLERATED  A run of space/tab/CR/LF at the very END. The header value is
 *              trimmed before it is sent, so `Bearer <tok>\n` goes out byte for
 *              byte identical to a clean token. It COSTS NOTHING, and saying
 *              otherwise would send someone hunting a 401 that never occurred.
 *
 *              NO CLAIM IS MADE HERE ABOUT HOW OFTEN THIS ARRIVES, and the
 *              omission is deliberate. An earlier draft called it the likeliest
 *              case and blamed a trailing newline in an `EnvironmentFile`. That
 *              is a claim about a LOADER, not about this code: systemd's
 *              `EnvironmentFile=` documents leading and trailing space, tab and
 *              CR as discarded from an unquoted value, and Docker's
 *              `--env-file` -- which is what actually carries this variable into
 *              an agent container -- is a second parser whose rules nobody here
 *              has compared with it. Both read the same `.env`, so identical
 *              bytes may not yield identical values.
 *
 *              The behaviour below is measured and stands on its own. "This is
 *              what happens if such a character reaches the value" needs no
 *              frequency claim to be useful, and a frequency claim that cannot
 *              be checked from inside a container is one nobody can maintain.
 *
 *   401        An invisible character of U+00FF or below, anywhere the trimming
 *              does not reach. The header is built and sent, so the failure is
 *              indistinguishable from a revoked or mistyped token. U+00A0 lives
 *              here: as invisible as a zero-width space, and behaving like a
 *              plain one. Note a LEADING space lands here rather than in
 *              TOLERATED -- the value is `Bearer ` plus the token, so anything
 *              at the token's front is interior to the value.
 *
 *   THROWS     Any codepoint above U+00FF, a NUL, or a CR/LF that is not in
 *              the trailing run. Nothing is sent at all: the throw happens
 *              inside the poll's try, and once the retries #193 added are used
 *              up the watch is disarmed and its owner mailed "could not reach
 *              GitHub" -- about a request that never left.
 *
 *              NOTE THE SET IS WIDER THAN `INVISIBLE_OR_SPACE`, and the filter
 *              says so explicitly. Stating this row while examining only that
 *              class is what made the sentence true of the header layer and
 *              false of this function; smart quotes and en dashes throw and
 *              were silent.
 *
 * The boundary is asserted against `Headers` itself in the tests rather than
 * restated there, because this paragraph is a claim about someone else's code
 * and that is the only way it stays true when someone else's code changes.
 *
 * DISCORD_TOKEN DELIBERATELY DOES NOT GET ONE OF THESE, and the reason is
 * recorded so that nobody completes the set later without asking. `main()` ends
 * in `await client.login(...)`, reached through `await main()` at the top level
 * of `index.ts`, so an unusable Discord token takes the process down at boot, by
 * name, every time. That is the visible failure the standing preference asks
 * for, and a check in front of it would be a guard buying nothing.
 *
 * NOT "nothing catches it" -- `daemon.ts` registers an `unhandledRejection`
 * handler four lines above that `login`, and it only writes a line. It looks
 * like it would swallow the failure and leave the daemon up. It does not: a
 * rejected TOP-LEVEL await is not an unhandled rejection, so the handler is
 * never consulted and node exits 1 with the error printed. Measured rather than
 * reasoned about, and written down because the reasonable-looking conclusion is
 * the wrong one -- someone reading the handler alone would come away believing
 * this paragraph is false.
 *
 * The variables that need this are the ones whose failure is DEFERRED and
 * QUIET. That is what makes GITHUB_TOKEN and the three GITHUB_APP_* values the
 * whole of the set rather than an arbitrary subset of it.
 *
 * ── Not App-specific, and living here anyway ────────────────────────────────
 *
 * `GITHUB_TOKEN` is not an App variable, so this module's name is narrower than
 * its contents. It is here because `INVISIBLE_OR_SPACE` is here, with the
 * paragraph arguing the class and the boundary test pinning it -- and a second
 * copy of that class somewhere better-named would be the duplication that
 * acquires an independent lifetime.
 */
export function describeTokenShape(token: string): string | null {
  if (!token) return null;

  const chars = [...token];
  // The maximal suffix of characters the header layer trims. Only these four;
  // U+00A0 is not HTTP whitespace and is not trimmed.
  let trailingFrom = chars.length;
  while (trailingFrom > 0 && /[\t\n\r ]/.test(chars[trailingFrom - 1]!)) trailingFrom--;

  const hits = chars
    .map((ch, i) => ({ ch, i, code: ch.codePointAt(0)! }))
    // INVISIBLE_OR_SPACE is not the whole set that matters here, and treating
    // it as though it were made the THROWS row below a claim about the header
    // layer that was false of THIS function. A smart quote, an en dash or a
    // CJK character throws exactly as U+200B does -- paste-from-a-document
    // rather than paste-from-a-web-page, same route in, same bare TypeError
    // naming a character index. Widening cannot produce a false alarm: above
    // U+00FF the header cannot be built, whatever the character means.
    .filter(({ ch, code }) => INVISIBLE_OR_SPACE.test(ch) || code > 0xff)
    .map((hit) => {
      const trailing = hit.i >= trailingFrom;
      const outcome: Outcome =
        hit.code > 0xff ? 'throws'
        : // NUL is never trimmed -- it is not in the [\t\n\r ] run undici strips --
          // and is then rejected wherever it sits, so it goes with CR/LF rather
          // than with the rest of the <= U+00FF group, and without their trailing
          // exemption. Unreachable from an environment block, which cannot carry
          // one; here because the row above presents itself as complete.
          hit.code === 0x00 ? 'throws'
        : hit.code === 0x0a || hit.code === 0x0d ? (trailing ? 'tolerated' : 'throws')
        : trailing ? 'tolerated'
        : 'rejected';
      return { ...hit, outcome };
    });
  if (hits.length === 0) return null;

  // Name the character responsible for the WORST outcome, not the first one
  // found: a token with a trailing newline and an embedded zero-width space has
  // one problem, and it is not the newline.
  const rank: Record<Outcome, number> = { tolerated: 0, rejected: 1, throws: 2 };
  const worst = hits.reduce((a, b) => (rank[b.outcome] > rank[a.outcome] ? b : a));

  const hex = `U+${worst.code.toString(16).toUpperCase().padStart(4, '0')}`;
  const name = CHARACTER_NAMES[worst.code];
  const named = name ? `${hex} ${name}` : hex;
  // 1-based, with the length beside it, so "position 40 of 40" reads as "at the
  // end" without the operator counting anything.
  const where = `position ${worst.i + 1} of ${chars.length}`;

  // How many share the worst outcome -- not how many were found. An operator who
  // deletes the character named here and hits the identical failure has repeated
  // the afternoon this exists to remove. The position of the second one moves
  // once the first is gone, so only the count is worth giving.
  const sameOutcome = hits.filter((h) => h.outcome === worst.outcome).length;
  const rest = sameOutcome > 1 ? ` ${sameOutcome} characters in the value are of this kind.` : '';

  // EVERY CLAUSE BELOW MUST HOLD IN EVERY STATE, which is why they are hedged
  // on "where this token is the credential" rather than naming the waker. Three
  // states make an unhedged version false, and #185's own text is false in the
  // second of them because it predates the fix:
  //
  //   * With a usable App, `daemon.ts` builds its client from the App's
  //     provider and the netrc holds the installation token, so the PAT may be
  //     doing nothing at all here.
  //   * A failing poll no longer disarms on the first failure -- #193 retries
  //     to a bound and only then gives up -- so "the watch is disarmed" without
  //     "eventually" is the old behaviour.
  //   * An agent's `curl` authenticates from the netrc and never touches this
  //     process's HTTP client, so nothing throws for it; it simply gets a 401.
  // THE REASON IS KEYED ON THE CAUSE, NOT THE OUTCOME, and that distinction is
  // the whole of this block. `throws` has THREE disjoint causes -- a codepoint
  // above U+00FF, an interior CR/LF, and NUL -- and `symptom` is a record keyed
  // on the outcome, so all three got the one sentence written for the first.
  //
  // The result was a message that named U+000D, told the operator it was a
  // Windows line ending, and then explained the failure with a rule U+000D does
  // not satisfy: two adjacent sentences contradicting each other, sending
  // someone to hunt a non-ASCII character they had just been told was not
  // there. That is the wrong-subject failure #185 opens with, reproduced inside
  // the tool built to remove it -- and the classification was right the whole
  // time, so only the reason was false.
  //
  // Keyed on the cause it cannot recur: a fourth cause added to the outcome
  // gets no sentence rather than the wrong one.
  const cannotBeSent =
    worst.code > 0xff
      ? 'A character above U+00FF cannot go into an HTTP header at all.'
      : 'An HTTP header value cannot contain a newline, a carriage return or a ' +
        'NUL at any position.';

  const symptom: Record<Outcome, string> = {
    tolerated:
      'Trailing whitespace is trimmed from the header before the request is sent, ' +
      'so this is NOT causing a failure and removing it will not fix one — it is ' +
      'reported only so that it can be ruled out.',
    rejected:
      'The header is still built and sent, so wherever this token is the credential ' +
      'GitHub answers 401, and the failure is indistinguishable from a revoked or ' +
      'mistyped token.',
    throws:
      `${cannotBeSent} Wherever this ` +
      'token is the credential for a request from THIS process, the request throws ' +
      'before anything is sent — so it surfaces as GitHub being unreachable rather ' +
      'than as an authentication problem, and a watch polling with it fails every ' +
      'time and is disarmed once it has used up its retries.',
  };

  return (
    `GITHUB_TOKEN contains ${named} at ${where}.${rest} ${symptom[worst.outcome]} ` +
    'The value is being used unchanged — this is a diagnosis, not a refusal.'
  );
}

/**
 * Whether the App is usable, and what to tell the operator if it is not.
 *
 * TWO QUESTIONS, TWO FIELDS, because they are not the same question and an
 * earlier version answered both with one `null`. "Nothing to warn about" and
 * "safe to authenticate as the App" diverge on the ordinary deployment that
 * configures no App at all — `{ usable: false, warning: null }` — and a caller
 * that inferred the second from the first would have been right only because a
 * guard outside this function happened to exclude that case.
 *
 * TOTAL over its input. Every combination of set and unset is defined here,
 * including the ones the daemon's guard currently makes unreachable, so that
 * widening the guard cannot produce a false sentence.
 *
 * ── Why this is a function and not four lines inside `main()` ───────────────
 *
 * Because those four lines have been wrong in three consecutive reviews, and
 * each time the fix was invisible to the test suite. `main()` builds a Discord
 * client and a session pool; nothing was going to grow a test around it for the
 * sake of a warning string, so the warning string was the one thing in this
 * repository changed repeatedly and never asserted on. It is pure and it takes
 * its filesystem as an argument for exactly that reason.
 *
 * ── Two checks, both reported ──────────────────────────────────────────────
 *
 * They used to share a branch, so a bad installation id skipped the key check
 * entirely: an operator with both wrong fixed one, restarted, and only then
 * learned about the other. Two facts that were both knowable at the first boot
 * should cost one boot.
 *
 * ── The consequence clause is conditional, and stops short when it must ─────
 *
 * Saying "FALLING BACK TO GITHUB_TOKEN … watches will arm and poll" is true
 * only when there IS a token. Without one the daemon prints, on the very next
 * line, that nothing will arm at all — so the unconditional version was
 * refuted by the sentence beneath it, which is worse than saying nothing: a
 * warning the reader watches get disproved is a warning they learn to skip.
 *
 * The fix is subtraction. With no PAT this says only what it knows — the App
 * is not in use — and leaves the consequence to the branch that actually
 * decides it, which already states it correctly and with the remedy attached.
 */
export function checkAppConfig(
  input: {
    appId: string;
    privateKeyPath: string;
    installationId: string | undefined;
    /** Whether a PAT exists to fall back TO. Decides what may be promised. */
    hasFallbackToken: boolean;
  },
  // Injected so the tests can drive real failures without needing a real
  // unreadable file, and so this module keeps its only `node:fs` dependency in
  // one place.
  access: (path: string) => void = (path) => accessSync(path, R_OK),
): { usable: boolean; warning: string | null } {
  // NEITHER SET IS NOT A FAULT. It is the ordinary deployment — Clawcius has no
  // App — so there is nothing to warn about, and nothing usable either. These
  // are two different questions and the return type answers both, rather than
  // making the caller infer one from a `null` that also means "all well".
  if (!input.appId && !input.privateKeyPath) return { usable: false, warning: null };

  const faults: string[] = [];

  // ONE OF THE TWO SET IS THE SHORTEST ROUTE TO A BROKEN APP: an operator who
  // typos the VARIABLE NAME rather than its value. It used to produce complete
  // silence — not even the "authenticating as GitHub App" line, which lives
  // behind the same guard — while every neighbouring misconfiguration was loud.
  // Falling back is the right behaviour and is not what changed; falling back
  // QUIETLY is, because SETUP.md tells the operator to read a startup line that
  // was never printed for this case.
  if (!input.privateKeyPath) {
    faults.push(
      'GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY_PATH is not — the App needs both',
    );
  } else if (!input.appId) {
    faults.push(
      'GITHUB_APP_PRIVATE_KEY_PATH is set but GITHUB_APP_ID is not — the App needs both',
    );
  }

  // THE THIRD VARIABLE, and the one this function was checking for presence and
  // never for shape. `appId` goes straight into the JWT as `iss`
  // (`appJwt`), so a stray character does not fail here — it fails at the FIRST
  // MINT, with a 401, inside the poll's try, whose catch disarms the row. That
  // is the permanent sweep this whole boot check exists to prevent, reached
  // through the one variable of the three that was not being checked.
  //
  // Not digits-only: GitHub accepts the numeric App ID *or* a client ID as
  // `iss`, and narrowing to digits would refuse a valid deployment.
  if (input.appId && INVISIBLE_OR_SPACE.test(input.appId)) {
    faults.push(
      'GITHUB_APP_ID contains an invisible character — whitespace, a control character, ' +
        'or a zero-width one such as U+200B, which a web UI inserts into long ' +
        'identifiers and no editor shows you. It is sent as the JWT `iss`, so GitHub ' +
        'answers 401 at the first mint rather than here',
    );
  }

  // Spaces are legal in a path, so this is the narrower test of the two. A
  // trailing \r would otherwise surface as ENOENT below, which is true but
  // sends the operator to stare at a path that looks correct.
  if (input.privateKeyPath && INVISIBLE.test(input.privateKeyPath)) {
    faults.push(
      'GITHUB_APP_PRIVATE_KEY_PATH contains an invisible character — whitespace other ' +
        'than a plain space, a control character, or a zero-width one. A trailing ' +
        'newline in an EnvironmentFile is the usual cause, and nothing in the value ' +
        'itself shows it',
    );
  }

  if (!isInstallationIdValid(input.installationId)) {
    faults.push(
      'GITHUB_APP_INSTALLATION_ID must be digits only — it is interpolated into a URL, ' +
        'and a trailing newline in an EnvironmentFile is the usual cause',
    );
  }

  // Skipped in the two cases where `access` would answer ENOENT and attach a
  // false sentence to it. UNSET: "GITHUB_APP_PRIVATE_KEY_PATH is set but the
  // key is not readable" has its first four words wrong. MALFORMED: "ENOENT
  // means the path is wrong" points at the visible half of a value whose
  // problem is the invisible half. Both are the defect this function exists to
  // stop making, arrived at through its own readability check.
  if (input.privateKeyPath && !INVISIBLE.test(input.privateKeyPath)) {
    try {
      // `access` rather than a mint: it catches the two failures an operator
      // actually makes — wrong path, wrong owner — without spending a token or
      // a round trip at every boot, and without making startup depend on
      // GitHub being reachable.
      access(input.privateKeyPath);
    } catch (error) {
      // `error.code` rather than the message. `fs` errors carry the PATH in
      // `.message`, and this module's header states that the PEM's path is not
      // logged. ENOENT and EACCES also happen to be the more useful half — they
      // distinguish "wrong path" from "wrong owner", which is the operator's
      // actual question.
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
      faults.push(
        `GITHUB_APP_PRIVATE_KEY_PATH is set but the key is not readable (${code}) — ` +
          'ENOENT means the path is wrong, EACCES means the owner or mode is',
      );
    }
  }

  if (faults.length === 0) return { usable: true, warning: null };

  return {
    usable: false,
    warning:
      faults.join('. ALSO: ') +
      (input.hasFallbackToken
        ? '. FALLING BACK TO GITHUB_TOKEN: the App is NOT in use, and watches will arm ' +
          'and poll as the personal access token.'
        : '. The App is NOT in use.'),
  };
}
