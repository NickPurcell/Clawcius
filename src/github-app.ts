/**
 * GitHub App installation tokens, and why the daemon needs a *provider* rather
 * than a token.
 *
 * Every pull request in this repository is authored by `NickPurcell`, which is
 * also the personal access token the crew holds. GitHub refuses self-approval,
 * so the operator cannot review the crew's work — and a ruleset requiring one
 * approval collapses onto OJ, whose reviews are `verdictMode: comment` and
 * cannot approve anything. A GitHub App has its own identity without being a
 * second user account, which is what makes review possible at all.
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
import { readFileSync } from 'node:fs';

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
): Promise<Minted> {
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'clawsky-github-app',
  };
  const base = opts.apiBase.replace(/\/+$/, '');

  let id = opts.installationId;
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
        `the App has ${list.length} installations; set githubApp.installationId to choose one`,
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
  const expiresAtMs = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 3_600_000;
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
        const minted = await mint(opts, appJwt(opts.appId, pem, now()), fetchImpl);
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
