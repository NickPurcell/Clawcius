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
 * required-approval ruleset satisfiable. Authorship comes from the agent's
 * `GITHUB_TOKEN` inside the container, which this file deliberately does not
 * touch — see below. What it buys is that the waker's own reads carry an
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
 * Nothing about the agent's session environment. That is the other consumer and
 * a separate decision — the token reaches a container through a mechanism this
 * file cannot see, and mixing the two would make neither reviewable.
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

  if (!isInstallationIdValid(input.installationId)) {
    faults.push(
      'GITHUB_APP_INSTALLATION_ID must be digits only — it is interpolated into a URL, ' +
        'and a trailing newline in an EnvironmentFile is the usual cause',
    );
  }

  // Only when there is a path to check. Asking `access('')` would answer ENOENT
  // and produce "GITHUB_APP_PRIVATE_KEY_PATH is set but the key is not
  // readable" about a variable that is not set — the first four words false,
  // which is the exact defect this function was extracted to stop making.
  if (input.privateKeyPath) {
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
