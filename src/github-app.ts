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

const INVISIBLE = /[^\S ]|[\u0000-\u001F\u007F\p{Cf}]/u;
const INVISIBLE_OR_SPACE = /[\s\u0000-\u001F\u007F\p{Cf}]/u;

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

/** What a given character will actually cause. Worst last. */
type Outcome = 'tolerated' | 'rejected' | 'throws';

/** Names for the characters that actually arrive, so the operator does not have to look up a codepoint to find out what to delete. */
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
  0x2018: "(a curly left single quote, as a document substitutes for ')",
  0x2019: "(a curly right single quote, as a document substitutes for ')",
  0x201c: '(a curly left double quote, as a document substitutes for ")',
  0x201d: '(a curly right double quote, as a document substitutes for ")',
  0x2013: '(an en dash, as a document substitutes for -)',
  0x2014: '(an em dash, as a document substitutes for --)',
  0x2026: '(an ellipsis, as a document substitutes for ...)',
};

/** Names the worst invisible or non-ASCII character in a token and what the header layer will do with it, or null when the token is clean. */
export function describeTokenShape(token: string): string | null {
  if (!token) return null;

  const chars = [...token];
  // The maximal suffix of characters the header layer trims. Only these four;
  // U+00A0 is not HTTP whitespace and is not trimmed.
  let trailingFrom = chars.length;
  while (trailingFrom > 0 && /[\t\n\r ]/.test(chars[trailingFrom - 1]!)) trailingFrom--;

  const hits = chars
    .map((ch, i) => ({ ch, i, code: ch.codePointAt(0)! }))
    // Anything above U+00FF is rejected by the header layer too, so it is a hit alongside INVISIBLE_OR_SPACE.
    .filter(({ ch, code }) => INVISIBLE_OR_SPACE.test(ch) || code > 0xff)
    .map((hit) => {
      const trailing = hit.i >= trailingFrom;
      const outcome: Outcome =
        hit.code > 0xff ? 'throws'
        : // NUL is never trimmed -- it is not in the [\t\n\r ] run undici strips --
          // and is rejected wherever it sits, so it gets no trailing exemption.
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

  const sameOutcome = hits.filter((h) => h.outcome === worst.outcome).length;
  const rest = sameOutcome > 1 ? ` ${sameOutcome} characters in the value are of this kind.` : '';

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

  // The app id is sent as the JWT `iss`, so its shape matters too.
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
        'than a plain space, a control character, or a zero-width one. Nothing in ' +
        'the value itself shows it',
    );
  }

  if (!isInstallationIdValid(input.installationId)) {
    faults.push(
      'GITHUB_APP_INSTALLATION_ID must be digits only — it is interpolated into a URL, ' +
        'and the character that is not a digit need not be visible in the value',
    );
  }

  if (input.privateKeyPath && !INVISIBLE.test(input.privateKeyPath)) {
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
