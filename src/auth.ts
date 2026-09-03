/**
 * Detecting a Claude credential that cannot be refreshed, saying so in Discord,
 * and logging back in.
 *
 * Everything here runs in the daemon rather than in a session: the credential
 * being dead is exactly the state in which no agent turn can run, so nothing
 * that depends on one can report it or repair it.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { authorizeUrl, ptyArgv } from './pty.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnSummary } from './types.js';

/** Gap between repeat announcements while a credential stays dead. */
const REPEAT_MS = 4 * 60 * 60 * 1000;

/** How long a started login is held waiting for its code before it is killed. */
const LOGIN_IDLE_MS = 15 * 60 * 1000;

/** How long to wait for the login to print its URL. */
const URL_WAIT_MS = 60_000;

/** How long to wait for the login to exit after a code goes in. */
const EXCHANGE_MS = 120_000;

/** Gap below which `begin` refuses to spawn a second login. */
const START_FLOOR_MS = 60_000;

/** How long to wait for `auth status`. */
const STATUS_MS = 30_000;

const CREDENTIAL_FILE = '.credentials.json';

/**
 * Whether the credential on disk is one a retry or a respawn could fix.
 *
 * `terminal` is anything no running process can recover from: a blank refresh
 * token, a refresh token past its expiry, or a file that is absent, unparseable
 * or the wrong shape. A stale access token behind a live refresh token is not
 * terminal — dropping the session picks up the refreshed one.
 */
export type CredentialVerdict = { terminal: false } | { terminal: true; why: string };

export function credentialVerdict(home: string, now = Date.now()): CredentialVerdict {
  const path = join(home, CREDENTIAL_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { terminal: true, why: `there is no ${CREDENTIAL_FILE} in ${home}` };
    return { terminal: true, why: `${path} could not be read (${code ?? 'unknown error'})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { terminal: true, why: `${CREDENTIAL_FILE} is not valid JSON` };
  }

  const oauth = (parsed as { claudeAiOauth?: unknown })?.claudeAiOauth;
  if (typeof oauth !== 'object' || oauth === null) {
    return { terminal: true, why: `${CREDENTIAL_FILE} has no claudeAiOauth block` };
  }
  const { accessToken, refreshToken, refreshTokenExpiresAt } = oauth as {
    accessToken?: unknown;
    refreshToken?: unknown;
    refreshTokenExpiresAt?: unknown;
  };

  // A failed refresh blanks the tokens in place rather than removing them.
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    return { terminal: true, why: 'the refresh token is blank — there is nothing left to refresh' };
  }
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { terminal: true, why: 'the access token is blank' };
  }
  // Absent and 0 both mean unstated, which is not the same as expired.
  if (typeof refreshTokenExpiresAt === 'number' && refreshTokenExpiresAt > 0) {
    if (refreshTokenExpiresAt <= now) {
      return {
        terminal: true,
        why: `the refresh token expired at ${new Date(refreshTokenExpiresAt).toISOString()}`,
      };
    }
  }

  return { terminal: false };
}

/** Where a login has to run so that it writes the credential the agent reads. */
export type AuthTarget = {
  /** True when sessions run through `docker exec`. */
  containerEnabled: boolean;
  containerName: string;
  /** In-container path to the claude binary, used when `containerEnabled`. */
  claudePath: string;
  /** Host claude CLI for a crew with no container. A bare name resolves on PATH. */
  hostClaudePath: string;
  /** The agent home, passed as CLAUDE_CONFIG_DIR on the host path. */
  home: string;
  /**
   * The subcommand that mints a credential — `['setup-token']`, or
   * `['auth', 'login', '--claudeai']`. Both print an authorize URL and then wait
   * on stdin; they differ in what they leave behind and how long it lasts.
   */
  loginCommand: readonly string[];
};

/** The command that reaches the same `claude` the agent authenticates as. */
export function authArgv(
  target: AuthTarget,
  sub: readonly string[],
  tty = false,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (target.containerEnabled) {
    // The container carries CLAUDE_CONFIG_DIR from `docker run`.
    //
    // `-t` is what puts a terminal on the far side of the exec. Wrapping the
    // whole thing in `script` gives the local process one, and without `-t` the
    // command inside the container still reads a pipe and stays silent.
    return {
      file: 'docker',
      args: ['exec', tty ? '-it' : '-i', target.containerName, target.claudePath, ...sub],
      env: process.env,
    };
  }
  return {
    file: target.hostClaudePath,
    args: [...sub],
    env: { ...process.env, CLAUDE_CONFIG_DIR: target.home },
  };
}

const AUTH_CODE = /^[A-Za-z0-9._~#/+=-]{8,512}$/;

/**
 * Why a string cannot be a paste code, or null.
 *
 * Refused rather than trimmed: a value containing a newline would send its first
 * line as the code and leave the rest in the stream.
 */
export function authCodeProblem(code: string): string | null {
  if (code === '') return 'no code followed the command';
  if (/\s/.test(code)) return 'that has whitespace in it — paste the code as one word';
  if (!AUTH_CODE.test(code)) {
    return 'that does not look like a paste code (8–512 characters of letters, digits and `._~#/+=-`)';
  }
  return null;
}

/** Both forms the CLI prints its authorize URL in. */
const URL_PATTERNS: readonly RegExp[] = [
  /(https:\/\/\S*oauth\/authorize\S*)/,
  /visit:\s*(https:\/\/\S+)/,
];

function findUrl(text: string): string | null {
  for (const pattern of URL_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** The part of `ChildProcess` this uses, so a test can substitute one. */
export type LoginProcess = {
  stdout: { on: (event: 'data', listener: (chunk: unknown) => void) => unknown } | null;
  stderr: { on: (event: 'data', listener: (chunk: unknown) => void) => unknown } | null;
  stdin: { write: (chunk: string) => unknown } | null;
  once: (event: string, listener: (...args: never[]) => void) => unknown;
  kill: (signal?: NodeJS.Signals) => unknown;
};

export type Spawner = (
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => LoginProcess;

const defaultSpawner: Spawner = (file, args, env) =>
  nodeSpawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env }) as unknown as LoginProcess;

/** A timer that must never hold the process open. */
function detachedTimer(fn: () => void, ms: number): NodeJS.Timeout {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return timer;
}

/** What came of handing a code to a waiting login. */
export type SubmitOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'bad-code' | 'none-waiting' | 'no-stdin' | 'write-failed' | 'not-taken' | 'unreadable';
      detail: string;
    };

type Pending = {
  child: LoginProcess;
  url: string;
  idle: NodeJS.Timeout;
  exited: boolean;
};

/**
 * At most one `claude auth login` at a time, held open waiting for its code.
 *
 * The headless flow prints a URL and then blocks on stdin, so the process must
 * outlive the call that started it.
 */
export class AuthLogin {
  readonly #target: AuthTarget;
  readonly #spawn: Spawner;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #exchangeMs: number;
  #pending: Pending | null = null;
  #lastStart = 0;

  constructor(opts: {
    target: AuthTarget;
    log: (line: string) => void;
    spawn?: Spawner;
    now?: () => number;
    exchangeMs?: number;
  }) {
    this.#target = opts.target;
    this.#spawn = opts.spawn ?? defaultSpawner;
    this.#log = opts.log;
    this.#now = opts.now ?? Date.now;
    this.#exchangeMs = opts.exchangeMs ?? EXCHANGE_MS;
  }

  /** The URL of a login that is waiting, if one is. */
  get pendingUrl(): string | null {
    return this.#pending && !this.#pending.exited ? this.#pending.url : null;
  }

  /**
   * Start a login and read back the URL it prints, or reuse one already waiting.
   *
   * A login whose idle timer has fired leaves no pending state, so it is
   * indistinguishable here from never having existed and this mints a fresh one.
   * The start floor is the only thing that refuses.
   */
  async begin(): Promise<{ url: string } | { error: string }> {
    const waiting = this.pendingUrl;
    if (waiting !== null) return { url: waiting };

    const since = this.#now() - this.#lastStart;
    if (this.#lastStart > 0 && since < START_FLOOR_MS) {
      return { error: `a login was started ${Math.round(since / 1000)}s ago — give it a moment` };
    }
    this.#lastStart = this.#now();
    this.stop();

    const inner = authArgv(this.#target, this.#target.loginCommand, true);
    const { file, args } = ptyArgv([inner.file, ...inner.args]);
    const env = inner.env;
    let child: LoginProcess;
    try {
      child = this.#spawn(file, args, env);
    } catch (error) {
      return { error: `could not start \`${file}\`: ${String(error)}` };
    }

    return new Promise<{ url: string } | { error: string }>((resolve) => {
      let settled = false;
      let seen = '';
      const settle = (result: { url: string } | { error: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      const read = (chunk: unknown): void => {
        // Capped, and from the end: a full-screen interface redraws, so the
        // hyperlink arrives after however much cursor movement it took to get
        // there.
        seen = (seen + String(chunk)).slice(-32768);
        const url = authorizeUrl(seen) ?? findUrl(seen);
        if (url === null) return;
        this.#pending = {
          child,
          url,
          idle: detachedTimer(() => {
            this.#log('login expired unused — killing it');
            this.stop();
          }, LOGIN_IDLE_MS),
          exited: false,
        };
        settle({ url });
      };

      child.stdout?.on('data', read);
      child.stderr?.on('data', read);

      child.once('exit', () => {
        if (this.#pending?.child === child) this.#pending.exited = true;
        settle({ error: 'the login exited before it printed a URL' });
      });
      child.once('error', (...args: never[]) => {
        settle({ error: `the login could not run: ${String(args[0])}` });
      });

      const timeout = detachedTimer(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
        settle({ error: `no URL after ${URL_WAIT_MS / 1000}s — the login is not talking` });
      }, URL_WAIT_MS);
    });
  }

  /**
   * Hand a code to the waiting login and report what came of it.
   *
   * The code goes in on stdin and never on a command line, which is world
   * readable through `/proc`. The outcome comes from `auth status` rather than
   * from the exit code, which can be 0 with nothing usable written.
   */
  async submit(code: string): Promise<SubmitOutcome> {
    const problem = authCodeProblem(code);
    if (problem !== null) return { ok: false, reason: 'bad-code', detail: problem };

    const pending = this.#pending;
    if (pending === null || pending.exited) {
      return { ok: false, reason: 'none-waiting', detail: 'no login is waiting' };
    }
    if (pending.child.stdin === null) {
      return { ok: false, reason: 'no-stdin', detail: 'the login has no stdin' };
    }

    // Length only: an unspent code is a credential.
    this.#log(`code submitted (${code.length} chars) — waiting for the exchange`);
    clearTimeout(pending.idle);
    try {
      pending.child.stdin.write(`${code}\n`);
    } catch (error) {
      return { ok: false, reason: 'write-failed', detail: String(error) };
    }

    const exited = await new Promise<boolean>((resolve) => {
      const timeout = detachedTimer(() => resolve(false), this.#exchangeMs);
      pending.child.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    pending.exited = exited;
    // The idle timer was cleared above, so a login still running here would be
    // held with nothing left to reap it.
    if (exited) this.#pending = null;
    else this.stop();

    const status = await this.status();
    if (status.loggedIn === true) return { ok: true };
    if (status.loggedIn === false) {
      return { ok: false, reason: 'not-taken', detail: status.detail };
    }
    return { ok: false, reason: 'unreadable', detail: status.detail };
  }

  /** `claude auth status`, as yes, no, or could not tell. */
  async status(): Promise<{ loggedIn: boolean | null; detail: string }> {
    const { file, args, env } = authArgv(this.#target, ['auth', 'status']);
    let child: LoginProcess;
    try {
      child = this.#spawn(file, args, env);
    } catch (error) {
      return { loggedIn: null, detail: `could not run \`${file}\`: ${String(error)}` };
    }

    const output = await new Promise<string | null>((resolve) => {
      let seen = '';
      const settle = (value: string | null): void => {
        clearTimeout(timeout);
        resolve(value);
      };
      child.stdout?.on('data', (chunk) => {
        seen = (seen + String(chunk)).slice(0, 8192);
      });
      child.once('exit', () => settle(seen));
      child.once('error', () => settle(null));
      const timeout = detachedTimer(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
        settle(null);
      }, STATUS_MS);
    });

    if (output === null) return { loggedIn: null, detail: 'the status command did not run' };
    return { loggedIn: readLoggedIn(output), detail: output.replace(/\s+/g, ' ').trim().slice(0, 200) };
  }

  /** Kill whatever is waiting. */
  stop(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (pending === null || pending.exited) return;
    clearTimeout(pending.idle);
    try {
      pending.child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Read `loggedIn` out of `auth status` output.
 *
 * JSON is what it emits; the prose fallback keeps an output change from turning
 * into a confident wrong answer rather than into "could not tell".
 */
export function readLoggedIn(output: string): boolean | null {
  try {
    const parsed = JSON.parse(output) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn;
  } catch {
    // Not JSON. Fall through.
  }
  if (/\bnot\s+logged\s+in\b|\blogged\s+out\b/i.test(output)) return false;
  if (/\blogged\s+in\b/i.test(output)) return true;
  return null;
}

/** A credential that no respawn will fix, as `owns` reports it. */
export type DeadCredential = { why: string };

/**
 * Announces a dead credential in Discord, at most once per `repeatMs` unless
 * somebody is waiting on an answer.
 *
 * `owns` is separate from `announce` and synchronous because the callers are
 * session completion handlers that decide whether the ordinary outage message
 * applies before they can await anything.
 */
export class AuthOutage {
  readonly #home: string;
  readonly #mainChannelId: string;
  readonly #crew: string;
  readonly #send: (channelId: string, text: string) => Promise<void>;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #repeatMs: number;
  #lastAnnounced = 0;

  constructor(opts: {
    home: string;
    /** Where an outage nobody is waiting on is announced. */
    mainChannelId: string;
    crew: string;
    send: (channelId: string, text: string) => Promise<void>;
    log: (line: string) => void;
    now?: () => number;
    repeatMs?: number;
  }) {
    this.#home = opts.home;
    this.#mainChannelId = opts.mainChannelId;
    this.#crew = opts.crew;
    this.#send = opts.send;
    this.#log = opts.log;
    this.#now = opts.now ?? Date.now;
    this.#repeatMs = opts.repeatMs ?? REPEAT_MS;
  }

  /**
   * The dead credential behind this refusal, or null.
   *
   * `credential-dead` alone does not mean the file is finished: the retry ladder
   * reports it for a token that is only stale in a live process, which a respawn
   * clears. The disk separates the two, and is read only once the two cheap
   * fields match.
   */
  owns(summary: TurnSummary): DeadCredential | null {
    if (summary.apiErrorKind !== 'authentication_failed') return null;
    if (summary.noRetryReason !== 'credential-dead') return null;
    const verdict = credentialVerdict(this.#home, this.#now());
    if (!verdict.terminal) {
      this.#log('auth failure with a refreshable credential — leaving it to the respawn');
      return null;
    }
    return { why: verdict.why };
  }

  /**
   * Say it, unless it has been said recently and nobody is waiting.
   *
   * `channelId` is the channel a person typed in, or null for a wake with no
   * audience. A person is their own rate limit; the refusal loop is not.
   */
  async announce(dead: DeadCredential, channelId: string | null): Promise<void> {
    const since = this.#now() - this.#lastAnnounced;
    if (channelId === null && this.#lastAnnounced > 0 && since < this.#repeatMs) return;
    this.#lastAnnounced = this.#now();

    const target = channelId ?? this.#mainChannelId;
    const heard = channelId === null ? '' : ' **Your message did not reach me.**';
    this.#log(`announcing a dead credential in ${target}: ${dead.why}`);

    try {
      await this.#send(
        target,
        `🔑 **${this.#crew} cannot authenticate.** ${dead.why}, so no retry and no ` +
          `respawn will fix it — every turn is being refused.${heard}\n` +
          `The credential is \`${this.#home}\` on the host. This one needs a person; ` +
          'nothing about it clears on its own.',
      );
    } catch (error) {
      this.#log(`could not announce the dead credential: ${String(error)}`);
    }
  }
}
