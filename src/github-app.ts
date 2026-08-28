import { createSign } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';

const { R_OK } = fsConstants;

/** Answers with a token that is valid *now*. */
export type TokenProvider = () => Promise<string>;

/** Refresh this long before expiry. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** JWTs are rejected if `exp` is more than 10 minutes out. Stay well inside. */
const JWT_LIFETIME_S = 9 * 60;

/** Clock skew allowance on `iat`. */
const JWT_BACKDATE_S = 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A short-lived JWT proving control of the App's private key. */
export function appJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - JWT_BACKDATE_S;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

/** One predicate, two callers, deliberately. */
export function isInstallationIdValid(id: string | undefined): boolean {
  return id === undefined || id === '' || /^\d+$/.test(id);
}

/** Anything an HTTP header or a JWT claim cannot carry as typed. */
const NOT_PRINTABLE_ASCII = /[^\x21-\x7e]/;

/** Whitespace other than a plain space, a control character, or a format character such as U+200B. */
const INVISIBLE_IN_PATH = /[^\S ]|\p{Cc}|\p{Cf}/u;

/** 1-based position of the first character `stray` matches, or 0 when none does. Counted by codepoint. */
function strayAt(value: string, stray: RegExp): number {
  return [...value].findIndex((ch) => stray.test(ch)) + 1;
}

type Minted = { token: string; expiresAtMs: number };

/** Ask GitHub for a token, as the App. */
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
  // Operator-controlled, and it is interpolated into a path.
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
  // `Date.parse` answers NaN on anything it cannot read; a malformed `expires_at` gets an hour rather than a cache check that is false forever.
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

/** Mints an installation token, caches it, and re-mints inside `REFRESH_MARGIN_MS` of expiry; concurrent callers share one mint. */
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

/** Names the position of the first character a token cannot contain, or null when it is clean. Never quotes the token. */
export function describeTokenShape(token: string): string | null {
  const at = strayAt(token, NOT_PRINTABLE_ASCII);
  if (at === 0) return null;
  const kind = /\s/.test([...token][at - 1]!) ? 'whitespace' : 'a non-printable or non-ASCII character';
  return `GITHUB_TOKEN has ${kind} at position ${at} of ${[...token].length}; it is used unchanged.`;
}

/** Whether the App configuration is usable, with the warning to print when it is not. */
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
  // NEITHER SET IS NOT A FAULT.
  if (!input.appId && !input.privateKeyPath) return { usable: false, warning: null };

  const faults: string[] = [];

  if (!input.privateKeyPath) {
    faults.push(
      'GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY_PATH is not — the App needs both',
    );
  } else if (!input.appId) {
    faults.push(
      'GITHUB_APP_PRIVATE_KEY_PATH is set but GITHUB_APP_ID is not — the App needs both',
    );
  }

  const idStray = strayAt(input.appId, NOT_PRINTABLE_ASCII);
  if (idStray > 0) faults.push(`GITHUB_APP_ID has a stray character at position ${idStray}`);

  const pathStray = strayAt(input.privateKeyPath, INVISIBLE_IN_PATH);
  if (pathStray > 0) {
    faults.push(`GITHUB_APP_PRIVATE_KEY_PATH has a stray character at position ${pathStray}`);
  }

  if (!isInstallationIdValid(input.installationId)) {
    faults.push(
      'GITHUB_APP_INSTALLATION_ID must be digits only — it is interpolated into a URL, ' +
        'and the character that is not a digit need not be visible in the value',
    );
  }

  if (input.privateKeyPath && pathStray === 0) {
    try {
      access(input.privateKeyPath);
    } catch (error) {
      // `error.code` rather than the message.
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
