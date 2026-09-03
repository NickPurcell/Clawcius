/**
 * The one failure the agent cannot report for itself: a Claude credential that
 * is gone and cannot be refreshed.
 *
 * Clawcius #369. A refresh token expired, the CLI tried to refresh anyway,
 * failed, and wrote the credential file back with both tokens blanked. Every
 * turn for the next twenty and a half hours was refused about twelve times a
 * minute and not one refusal reached Discord, because three silences stack: the
 * mail path has no channel to speak in, the first `authentication_failed` on a
 * Discord turn is deliberately left to the respawn, and `announceOutage` is
 * reached from a session event — so announcing needs the model that just died.
 *
 * The daemon is the thing that is still alive and still holds `DISCORD_TOKEN`.
 * So everything here is the daemon speaking: the verdict is read off disk, the
 * message goes out through the gateway client, and no model turn is involved at
 * any point. The same is true of `!auth`, which is why the way back in is a
 * waker command beside `!stop` and `!reset` rather than something the agent
 * does — the agent is what is broken.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnSummary } from './types.js';

/**
 * How long a dead credential goes unmentioned after it has been mentioned once.
 *
 * Twelve refusals a minute for twenty hours is fourteen thousand events and the
 * channel needed one message. Four hours is "still broken, still nobody has
 * fixed it" without being a thing people learn to scroll past. A human who
 * actually typed something bypasses this — see `AuthOutage.announce`.
 */
const REPEAT_MS = 4 * 60 * 60 * 1000;

/**
 * How long a started login is held waiting for its code.
 *
 * The OAuth `state` and PKCE challenge in the URL expire on Anthropic's side
 * anyway, so a child held longer than this is a process nobody is coming back
 * to. Fifteen minutes is long enough to notice the message on a phone.
 */
const LOGIN_IDLE_MS = 15 * 60 * 1000;

/** How long to wait for the login to print its URL before giving up on it. */
const URL_WAIT_MS = 60_000;

/** How long to wait for the exchange after a code goes in. */
const EXCHANGE_MS = 120_000;

/** Floor between two `!auth` invocations that would each start a login. */
const START_FLOOR_MS = 60_000;

const CREDENTIAL_FILE = '.credentials.json';

/**
 * Where this instance's Claude login lives.
 *
 * `docker/run-container.sh` bind-mounts `<stateDir>/agent-home` in as the
 * container's `CLAUDE_CONFIG_DIR`, and a crew with no container has the same
 * path in its unit. `src/agent-config.ts` already derives it once for the
 * containment check; this is the same derivation and there is no config key for
 * it on purpose, because a second copy is a thing that drifts.
 */
export function agentHome(stateDir: string): string {
  return join(stateDir, 'agent-home');
}

/**
 * Whether the credential on disk is one a retry or a respawn could ever fix.
 *
 * This is the discriminator #369 asks for, and it is the whole reason the
 * transient case stays quiet. A stale access token with a live refresh token is
 * `refreshable`: the running process is holding a token the file has already
 * replaced, and dropping the session picks up the new one — that is #266's gate
 * doing its job and it must not be announced. Everything else is terminal: no
 * amount of respawning invents a refresh token that has expired.
 *
 * Anything unreadable or unparseable counts as terminal too, and the `why` says
 * which. That is a deliberate lean: the only caller has already established
 * that the API refused to authenticate and the retry ladder is spent, so a
 * credential file the daemon cannot make sense of is not a reason to say
 * nothing — saying nothing is the defect being fixed.
 */
export type CredentialVerdict = { terminal: false } | { terminal: true; why: string };

export function credentialVerdict(home: string, now = Date.now()): CredentialVerdict {
  let raw: string;
  try {
    raw = readFileSync(join(home, CREDENTIAL_FILE), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { terminal: true, why: `there is no ${CREDENTIAL_FILE} in ${home}` };
    }
    return { terminal: true, why: `${join(home, CREDENTIAL_FILE)} could not be read (${code ?? 'unknown error'})` };
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

  // Blanked to empty strings rather than removed — which is what a failed
  // refresh actually leaves behind, and what #369 found on disk.
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    return { terminal: true, why: 'the refresh token is blank — there is nothing left to refresh' };
  }
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { terminal: true, why: 'the access token is blank' };
  }
  // 0 and absent both mean "not stated", which is not the same as "expired".
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
  /**
   * True when sessions run through `docker exec`.
   *
   * The login follows the session, and that is not a preference.
   * `docker/run-container.sh` keeps each instance's login in the bind mount
   * with THE CONTAINER AS THE ONLY WRITER, because sharing a credential across
   * the gVisor boundary was tried twice — bind-mounted file, then
   * directory-plus-symlink — and both times the container read a stale
   * credential while the host's was current. Writing this one from the host
   * would be that again.
   */
  containerEnabled: boolean;
  containerName: string;
  /** In-container path to the claude binary; used only when `containerEnabled`. */
  claudePath: string;
  /** Host claude CLI, for a crew with no container. A bare name is a PATH lookup. */
  hostClaudePath: string;
  /** `agentHome(stateDir)` — passed as CLAUDE_CONFIG_DIR on the host path. */
  home: string;
};

/** The command that reaches the same `claude` the agent authenticates as. */
export function authArgv(
  target: AuthTarget,
  sub: readonly string[],
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (target.containerEnabled) {
    // No `-e` and no env file: the container already carries CLAUDE_CONFIG_DIR
    // from `docker run`, and nothing here needs a secret on the command line.
    return {
      file: 'docker',
      args: ['exec', '-i', target.containerName, target.claudePath, ...sub],
      env: process.env,
    };
  }
  // Explicit rather than inherited, so this does not depend on the unit having
  // remembered to set it.
  return {
    file: target.hostClaudePath,
    args: [...sub],
    env: { ...process.env, CLAUDE_CONFIG_DIR: target.home },
  };
}

/**
 * The shape of a paste code, checked before anything is written to a process.
 *
 * Refused rather than trimmed, which is the posture `renderEnvFile` takes for
 * the same reason: a value with a newline in it would submit the first half as
 * the code and leave the rest sitting in the stream, and a login that failed
 * because half a code went in is a much worse afternoon than one that was told
 * no. The code itself is never included in the message — only the complaint.
 */
const AUTH_CODE = /^[A-Za-z0-9._~#/+=-]{8,512}$/;

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

/** The part of `ChildProcess` this uses, so a test can hand over something else. */
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

/** A timer that must never be the reason this process is still alive. */
function detachedTimer(fn: () => void, ms: number): NodeJS.Timeout {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return timer;
}

type Pending = {
  child: LoginProcess;
  url: string;
  startedAt: number;
  idle: NodeJS.Timeout;
  exited: boolean;
};

/**
 * At most one `claude auth login` at a time, held open waiting for its code.
 *
 * The flow is headless, so there is no callback to catch: the CLI prints a URL
 * and then blocks on stdin for the code the browser hands back. That means the
 * process has to stay alive between the message going out and someone typing
 * `!auth <code>`, which is the whole reason this class exists rather than a
 * function.
 */
export class AuthLogin {
  readonly #target: AuthTarget;
  readonly #spawn: Spawner;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  #pending: Pending | null = null;
  #lastStart = 0;

  constructor(opts: {
    target: AuthTarget;
    log: (line: string) => void;
    spawn?: Spawner;
    now?: () => number;
  }) {
    this.#target = opts.target;
    this.#spawn = opts.spawn ?? defaultSpawner;
    this.#log = opts.log;
    this.#now = opts.now ?? Date.now;
  }

  /** The URL of a login that is already waiting, if one is. */
  get pendingUrl(): string | null {
    return this.#pending && !this.#pending.exited ? this.#pending.url : null;
  }

  /**
   * Start a login and read back the URL it prints, or reuse one already waiting.
   *
   * Reuse matters: the repeat announcement four hours later must not orphan the
   * process the first one is still holding, and two live PKCE challenges is one
   * more than can ever be used.
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

    const { file, args, env } = authArgv(this.#target, ['auth', 'login', '--claudeai']);
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
        // Capped: the URL is in the first few hundred bytes, and a CLI that
        // decides to stream something long must not grow this without bound.
        seen = (seen + String(chunk)).slice(-8192);
        const url = findUrl(seen);
        if (url === null) return;
        this.#pending = {
          child,
          url,
          startedAt: this.#now(),
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
          // Already gone. The point was to not leave it running.
        }
        settle({ error: `no URL after ${URL_WAIT_MS / 1000}s — the login is not talking` });
      }, URL_WAIT_MS);
    });
  }

  /**
   * Hand a code to the waiting login and say what came of it.
   *
   * The code goes in on STDIN and never on a command line. `/proc/<pid>/cmdline`
   * is world-readable, which is the whole argument `src/container.ts` makes for
   * passing the session environment through a file; a one-time authorization
   * code is not as valuable as a bot token but it is not free either, and there
   * is no reason to put it somewhere every local account can read.
   */
  async submit(code: string): Promise<string> {
    const problem = authCodeProblem(code);
    if (problem !== null) return `Not sending that: ${problem}.`;

    const pending = this.#pending;
    if (pending === null || pending.exited) {
      return 'No login is waiting for a code. Run `!auth` to start one and I will post the link.';
    }
    if (pending.child.stdin === null) {
      return 'The waiting login has no stdin to write to — starting a fresh one is the way out.';
    }

    // Length only. The code is a credential for as long as it is unspent.
    this.#log(`code submitted (${code.length} chars) — waiting for the exchange`);
    clearTimeout(pending.idle);
    try {
      pending.child.stdin.write(`${code}\n`);
    } catch (error) {
      return `Could not hand the code to the login: ${String(error)}`;
    }

    const exited = await new Promise<boolean>((resolve) => {
      const timeout = detachedTimer(() => resolve(false), EXCHANGE_MS);
      pending.child.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    pending.exited = exited;
    if (exited) this.#pending = null;

    // The exit code is not the answer — a CLI that exits 0 having written
    // nothing usable would read as success. Ask the credential.
    const status = await this.status();
    if (status.loggedIn === true) return '**Authenticated.** Sessions will pick the new credential up.';
    if (status.loggedIn === false) {
      return `That did not take: \`auth status\` still says logged out. ${
        exited ? 'The login has exited, so run `!auth` for a fresh link.' : 'Try the code again.'
      }`;
    }
    return `Code accepted, but I could not read \`auth status\` back: ${status.detail}`;
  }

  /** `claude auth status`, as a tri-state: yes, no, or could not tell. */
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
      }, 30_000);
    });

    if (output === null) return { loggedIn: null, detail: 'the status command did not run' };
    return { loggedIn: readLoggedIn(output), detail: output.replace(/\s+/g, ' ').trim().slice(0, 200) };
  }

  /** Kill whatever is waiting. Called by `begin` and by the daemon's shutdown. */
  stop(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (pending === null || pending.exited) return;
    clearTimeout(pending.idle);
    try {
      pending.child.kill('SIGTERM');
    } catch {
      // Already gone, which is the state this wanted.
    }
  }
}

/**
 * Read `loggedIn` out of whatever `auth status` printed.
 *
 * JSON first, because that is what it emits today and it is unambiguous. The
 * prose fallback exists because this is the confirmation step of the only path
 * back from a dead credential, and a CLI that changes its output format should
 * downgrade that to "could not tell" rather than to a confident wrong answer.
 */
export function readLoggedIn(output: string): boolean | null {
  try {
    const parsed = JSON.parse(output) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn;
  } catch {
    // Not JSON, or not only JSON. Fall through.
  }
  if (/\bnot\s+logged\s+in\b|\blogged\s+out\b/i.test(output)) return false;
  if (/\blogged\s+in\b/i.test(output)) return true;
  return null;
}

/**
 * Says once, in the channel, that the credential is dead — and posts the link.
 *
 * Split into a synchronous `owns` and an async `announce` because the callers
 * are session completion handlers, which have to decide whether the ordinary
 * outage message applies before they can await anything.
 */
export class AuthOutage {
  readonly #home: string;
  readonly #login: AuthLogin;
  readonly #mainChannelId: string;
  readonly #crew: string;
  readonly #send: (channelId: string, text: string) => Promise<void>;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #repeatMs: number;
  #lastAnnounced = 0;

  constructor(opts: {
    home: string;
    login: AuthLogin;
    /** Where an outage nobody is waiting on gets announced. */
    mainChannelId: string;
    crew: string;
    send: (channelId: string, text: string) => Promise<void>;
    log: (line: string) => void;
    now?: () => number;
    repeatMs?: number;
  }) {
    this.#home = opts.home;
    this.#login = opts.login;
    this.#mainChannelId = opts.mainChannelId;
    this.#crew = opts.crew;
    this.#send = opts.send;
    this.#log = opts.log;
    this.#now = opts.now ?? Date.now;
    this.#repeatMs = opts.repeatMs ?? REPEAT_MS;
  }

  get login(): AuthLogin {
    return this.#login;
  }

  /**
   * Is this refusal a credential that no respawn will ever fix?
   *
   * `credential-dead` alone is not enough: the retry ladder reports it for a
   * token that is merely stale in a live process, which is exactly the case
   * #266's respawn gate handles and which must stay quiet. The disk is what
   * separates the two, and it is only read once the cheap checks have passed —
   * so the twelve-a-minute loop that started all this costs two comparisons.
   */
  owns(summary: TurnSummary): boolean {
    if (summary.apiErrorKind !== 'authentication_failed') return false;
    if (summary.noRetryReason !== 'credential-dead') return false;
    const verdict = credentialVerdict(this.#home, this.#now());
    if (!verdict.terminal) {
      this.#log('auth failure, but the credential on disk is refreshable — leaving it to the respawn');
      return false;
    }
    return true;
  }

  /**
   * Say it, unless it has been said recently and nobody is waiting.
   *
   * `channelId` is the channel a person actually typed in, or null when this
   * came off the mail path where there is nobody to answer. A person always
   * gets an answer — they are their own rate limit — and the loop does not.
   */
  async announce(channelId: string | null): Promise<void> {
    const verdict = credentialVerdict(this.#home, this.#now());
    if (!verdict.terminal) return;

    const since = this.#now() - this.#lastAnnounced;
    if (channelId === null && this.#lastAnnounced > 0 && since < this.#repeatMs) {
      return;
    }
    this.#lastAnnounced = this.#now();

    const target = channelId ?? this.#mainChannelId;
    if (!target) {
      this.#log('credential is dead and there is no channel to say so in');
      return;
    }

    const started = await this.#login.begin();
    const link =
      'url' in started
        ? `**Authorize here:** ${started.url}\nThen paste the code back: \`!auth <code>\` ` +
          '(with an @ so it reaches me, not the agent).'
        : `I could not start a login to give you a link: ${started.error}`;

    const heard = channelId === null ? '' : '\n**Your message did not reach me.**';
    this.#log(`announcing a dead credential in ${target}: ${verdict.why}`);

    try {
      await this.#send(
        target,
        `🔑 **${this.#crew} cannot authenticate.** ${verdict.why}, so no retry and no ` +
          `respawn will fix it — every turn is being refused until someone logs in.` +
          `${heard}\n\n${link}\n` +
          '_Anyone can do this; it can be your own Claude account rather than the operator\'s._',
      );
    } catch (error) {
      // Best effort, like every other thing here that talks to Discord. If the
      // gateway is down too then the journal is the record and there was never
      // going to be a message.
      this.#log(`could not announce the dead credential: ${String(error)}`);
    }
  }
}
