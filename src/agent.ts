/**
 * Long-lived Claude Code sessions, one per Discord channel or thread.
 *
 * The agent is woken by mentions and replies by invoking the `discord` CLI
 * itself — nothing here pipes agent output to Discord. That inverts the usual
 * chatbot shape: this module's job is to keep a warm session alive, hand it
 * context, and watch whether it actually sent anything.
 *
 * Architecture note: we use `query()` in *streaming input* mode rather than the
 * `unstable_v2_*` session helpers, because `SDKSessionOptions` has no `cwd`,
 * `permissionMode`, `env`, or `sandbox` fields — all of which we need per
 * channel. Streaming mode also returns a `Query` exposing `interrupt()`, which
 * is what makes a `!stop` command possible.
 *
 * Keeping the session open across wakes is the main latency win: a fresh
 * process per mention discards the warm prompt cache and pays Node plus Claude
 * Code startup every time.
 */

import { query, type McpServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { tokenFilePath } from './token-file.js';
import { buildSpawnCharter, buildSystemPrompt, buildWakeMessage } from './prompt.js';
import { containerSpawner } from './container.js';
import { buildMailServer } from './mail-tool.js';
import { buildArmedTools, type ArmedToolOptions } from './armed-tool.js';
import { buildSpawnTools } from './spawn-tool.js';
import type { MailStore } from './mail.js';
import { hostAgentId, type AgentIdentity, type AgentRegistry } from './store.js';
import type { TurnSummary, WakeContext } from './types.js';

/**
 * Matches a `discord send` / `discord reply` invocation in a bash command,
 * including the absolute-path form the agent is told to use.
 * Drives the no-reply fallback — see SETUP.md if the CLI grows an alias.
 */
const DISCORD_SEND_PATTERN = /(^|[\s/])discord\s+(reply|send)\b/;

/**
 * Whether a stored id can actually be handed to `--resume`.
 *
 * Sessions start with a `pending-<channelId>` placeholder because the real id
 * only arrives in the SDK's init message. That placeholder must never reach
 * the CLI, which requires a UUID and exits 1 on anything else — nor be written
 * to SQLite, where it would poison every later wake for that channel.
 */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isResumable(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === 'string' && SESSION_UUID.test(sessionId);
}

/**
 * Retry policy for API-level refusals.
 *
 * In interactive Claude Code an API error stops the turn and the human types
 * "continue". Nothing here played that part: the failure was invisible (see the
 * detection site in #handle) so nothing ever retried, and a dead token rendered
 * as the agent quietly ignoring people. These delays are that human.
 *
 * Split by kind because the two failures want opposite pacing:
 *
 * `auth` — the credential on disk has almost certainly already been replaced by
 * the host's refresh, so waiting achieves nothing; the only question is whether
 * the running process picks the new one up. One quick attempt answers it. If
 * that fails the credential is genuinely dead and hammering it is pointless.
 *
 * `transient` — the server is asking for time. Back off properly.
 */
const AUTH_RETRY_DELAYS_MS: readonly number[] = [2_000];
const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

/** SDK error kinds that clear on their own if you wait. */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
]);

type RetryPlan = { kind: 'auth' | 'transient'; delays: readonly number[] };

/**
 * How to react to an SDK error kind, or null to give up.
 *
 * Everything unlisted — `billing_error`, `invalid_request`, `model_not_found`,
 * `oauth_org_not_allowed` — is a standing condition that a retry cannot change.
 * Retrying those burns quota to reproduce the same answer.
 */
export function retryPlanFor(errorKind: string): RetryPlan | null {
  if (errorKind === 'authentication_failed') {
    return { kind: 'auth', delays: AUTH_RETRY_DELAYS_MS };
  }
  if (TRANSIENT_ERRORS.has(errorKind)) {
    return { kind: 'transient', delays: TRANSIENT_RETRY_DELAYS_MS };
  }
  return null;
}

/**
 * Sent instead of the original message when a turn is retried after it had
 * already started doing things.
 *
 * Replaying the user's message verbatim is only safe when the turn died before
 * the agent acted — which is the common case, since an auth failure lands on
 * the first API call and spends no tokens. When work *had* started, a verbatim
 * replay invites the agent to do it twice: two commits, two Discord posts. The
 * live session still holds the full transcript, so the honest instruction is
 * "you were cut off, check what landed" rather than "here is the request again".
 */
const CONTINUATION_PROMPT = [
  'SYSTEM: your previous turn was cut short by an API error partway through.',
  'This is the waker speaking, not the user — no new request has arrived.',
  '',
  'The conversation above is intact, including tool calls you already made, and',
  'their effects are real: files you wrote are still written, commits you made',
  'are still made, and any Discord message you already sent was already sent.',
  '',
  'Check what actually landed before acting. Then finish what you were doing —',
  'do not repeat completed work, and do not re-post anything.',
].join('\n');

/**
 * Make the project's skills visible from inside the workspace.
 *
 * `settingSources: ['project']` resolves relative to `cwd`, and `cwd` is the
 * per-channel workspace — not this repo. Without the symlink the agent never
 * discovers the discord-cli skill and has no idea how to speak.
 */
function linkSkills(workspacePath: string): void {
  const target = join(workspacePath, '.claude');
  if (existsSync(target)) return;
  try {
    symlinkSync(config().agent.paths.skillsDir, target, 'dir');
  } catch (error) {
    process.stderr.write(
      `[clawcius] could not link skills into ${workspacePath}: ${String(error)}\n`,
    );
  }
}

/**
 * Git configuration for the agent, injected purely through the environment.
 *
 * `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n` is git's own mechanism for config with
 * no file behind it. That matters because the service user's own ~/.gitconfig is
 * left completely alone — the agent gets its own identity without inheriting or
 * clobbering yours — and because no credential is ever in the config itself.
 *
 * The credential helper is scoped to github.com and reads its credential at CALL
 * TIME, so the token appears in no URL, no remote, and no reflog.
 *
 * WHERE it reads from depends on which credential this deployment uses, and the
 * difference is lifetime rather than taste. A PAT does not expire, so handing it
 * over in the environment at spawn is correct forever. An INSTALLATION TOKEN
 * expires in an hour and a session outlives that, and a session's environment is
 * fixed when its process spawns — so it is read from a file the daemon keeps
 * current (`token-file.ts`), because there is no way to update an env var inside
 * a running process from outside it.
 *
 * That makes the sentence this comment used to carry — "the token never lands on
 * disk" — false in the App case, deliberately. `token-file.ts` states what that
 * costs and what bounds it; the short version is that every process in the
 * container already shares one uid and can read `/proc/1/environ`, so the file
 * adds no reader, and the real change is that a bind-mounted file outlives the
 * container where an env var does not.
 *
 * HTTPS only. The agent has no route out except the proxy bridge, and SSH is
 * not HTTP — `git@github.com` cannot leave the sandbox at all.
 */
export function gitEnv(): Record<string, string> {
  const entries: Array<[string, string]> = [
    ['user.name', config().agent.git.userName],
    ['user.email', config().agent.git.userEmail],
  ];

  // THE CONDITION MUST DESCRIBE THE SAME DEPLOYMENT AS THE WRITER'S.
  //
  // `github.appId` alone was wider: the file is only written under
  // `armedStore && app && appTokenOk`, and `armedStore` also needs
  // `clawsky.enabled && armed.enabled`. So an App-configured deployment with
  // armed watching off wrote no file and started no refresher — meaning not
  // even the refresher's "no usable credential" line — and with no PAT either
  // the helper handed git an EMPTY password. Git then fails on an empty
  // credential rather than on an absent one, which is the less nameable of the
  // two: no helper at all makes git say it could not read a username.
  const appWritesTheFile =
    Boolean(config().github.appId) &&
    config().agent.clawsky.enabled &&
    config().agent.armed.enabled;
  if (config().github.token || appWritesTheFile) {
    entries.push([
      'credential.https://github.com.helper',
      // FILE FIRST, ENVIRONMENT SECOND, resolved on every call rather than at
      // spawn. That ordering is what makes a half-configured App safe: if the
      // daemon decided the App was unusable it writes no file, `cat` fails, and
      // the agent falls through to the PAT that was working before — instead of
      // every push failing because the session was told at spawn to expect a
      // file that never appeared.
      //
      // THE PATH IS PASSED IN AN ENV VAR AND QUOTED, not interpolated. Spliced
      // in raw, a workspace path containing a space split into two `cat`
      // arguments, `2>/dev/null` swallowed the error, and the helper silently
      // served the PAT — or an empty password when there was none. Silent is
      // the part that mattered: nothing anywhere would have said why.
      //
      // `2>/dev/null` stays, because a missing file is the FALLBACK rather than
      // an error, and `cat`'s complaint would otherwise be read by git as part
      // of the credential exchange.
      '!f() { echo username=x-access-token; ' +
        'echo "password=$(cat "$CLAWSKY_GITHUB_TOKEN_FILE" 2>/dev/null ' +
        '|| printf %s "$GITHUB_TOKEN")"; }; f',
    ]);
    // Rewrite SSH remotes to HTTPS, so a repo cloned with a git@ URL — or an
    // agent reaching for the SSH form out of habit — still works instead of
    // hanging against a route that does not exist.
    entries.push(['url.https://github.com/.insteadOf', 'git@github.com:']);
  }

  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  if (config().github.token) env['GITHUB_TOKEN'] = config().github.token;
  // The path, not the token. Named so the helper can quote it; see above.
  env['CLAWSKY_GITHUB_TOKEN_FILE'] = tokenFilePath(config().agent.container.githubTokenDir);
  // CURL_HOME makes bare `curl https://api.github.com/...` authenticate without
  // a header, because curl reads `$CURL_HOME/.curlrc` and that file points at a
  // netrc the daemon keeps current. Curl re-reads it per invocation, so a
  // session that outlives an installation token picks up the replacement —
  // which is the property the credential helper has and an env var cannot.
  //
  // Scoped to api.github.com by the netrc's `machine` line, verified not to
  // follow a redirect off-host. An agent curling an arbitrary URL is not handed
  // the crew's credential.
  env['CURL_HOME'] = config().agent.container.githubTokenDir;
  return env;
}

/**
 * `acquire` had no session slot left.
 *
 * A class rather than a bare `Error` so callers can tell this apart from a
 * spawn failure or a dead transport without matching on a message string. That
 * distinction only started mattering when it became something a *user* should
 * hear about: it is the one `acquire` failure where nothing is wrong with the
 * request, the channel or the credentials, and the only remedy is on the host.
 *
 * `live` and `max` are carried because the sentence a person reads should
 * contain the numbers, and the catch site has no other way to get them.
 */
export class AtCapacityError extends Error {
  readonly live: number;
  readonly max: number;

  constructor(live: number, max: number) {
    super(`at capacity (${max} concurrent sessions, ${live} live)`);
    this.name = 'AtCapacityError';
    this.live = live;
    this.max = max;
  }
}

/**
 * The sentence a user reads when their mention was dropped for want of a slot.
 *
 * Deliberately says the message was dropped rather than "try again": a retry
 * is what a person would naturally do, and on the shipped configuration
 * (`sessions.idleTimeoutMinutes: 0`) it cannot work, because nothing frees a
 * slot in the ordinary course. Naming the remedies is the useful half — and
 * `!reset` comes first because it is the only one the reader can act on
 * themselves. A restart is the operator's and raising the cap is an edit and a
 * redeploy, so a message that named only those two told the reader to wait for
 * somebody else.
 *
 * Two things the sentence has to carry, both found in review of #146 and both
 * about the reader acting on it in the obvious way:
 *
 *   - ANOTHER channel, and it says so. `acquire` returns an existing session
 *     before it reaches the cap check, so `AtCapacityError` can only fire for a
 *     channel with no live session — the one the reader is standing in is
 *     guaranteed to be the one where `!reset` frees nothing. It is not inert
 *     there either: `release` no-ops, but `clearSession` runs regardless and
 *     spends the row's resumable id, and the reply is the same sentence a
 *     successful reset gets. Clawcius #157 is the code half of that.
 *   - WITH A MENTION. `handleCommand` is gated on `addressed && startsWith('!')`
 *     (`src/daemon.ts:332`), so outside an always-on channel a bare `!reset` is
 *     dropped or handed to the agent as chat. The mention form works in every
 *     channel, which matters when the reader has to go to a different one.
 *
 * Here, and taking the timeout as an argument, rather than reading `config()`
 * inside `announceAtCapacity` in daemon.ts. The branch is the part worth
 * getting right — "this will not clear on its own" and "say it again in a
 * minute" are opposite instructions, chosen by a number — and when this was
 * written the Discord handler was the body of index.ts, so a branch that lived
 * there could only be reasoned about. It was reasoned about, in #128, and
 * shipped unexercised (Clawcius #130). The handler became importable in #131
 * and `announceAtCapacity` is exercised now too; the split still earns itself,
 * because the sentence needs no Discord client to test. What stays in daemon.ts
 * is the plumbing around it.
 */
export function atCapacityNotice(error: AtCapacityError, idleTimeoutMinutes: number): string {
  return (
    `⚠️ No session slot free — ${error.live} of ${error.max} are in use, so I could not ` +
    `pick that up and it was not queued. ` +
    (idleTimeoutMinutes === 0
      ? 'This deployment never evicts idle sessions, so this will not clear on its own. ' +
        'Mentioning me with `!reset` in another channel that is holding a session gives ' +
        "its slot back, at the cost of that channel's transcript — but not here: this " +
        'channel has no session to free, so resetting it would spend its transcript for ' +
        'nothing. Failing that it needs a restart on the host, or a higher ' +
        '`sessions.maxConcurrent`.'
      : `A slot frees after ${idleTimeoutMinutes}m idle — say it again after that.`)
  );
}

export type AgentEvents = {
  /** Fired for each tool the agent runs — used for logging and send-detection. */
  onToolUse: (toolName: string, input: Record<string, unknown>) => void;
  onDone: (summary: TurnSummary) => void;
  onError: (error: Error) => void;
  /** A discord CLI call came back an error — the reply never landed. */
  onCliFailure: (command: string, output: string) => void;
  /**
   * This session cannot recover on its own and must be replaced.
   *
   * Raised when an auth failure survives its in-session retry, which is the
   * observed behaviour rather than a guess: `claude` reads the credential once
   * at startup and caches the access token for the life of the process, so
   * when that token expires the process 401s forever while a freshly spawned
   * one reads the very same file and works. Retrying inside it cannot win.
   *
   * `acted` reports whether the dead wake had already run tools, because it
   * decides whether replaying into the new session is safe.
   */
  onNeedsRespawn: (acted: boolean) => void;
};

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #resolve: (() => void) | null = null;
  #closed = false;

  /**
   * `synthetic` marks a turn nobody typed.
   *
   * The SDK's streaming input accepts user messages and nothing else, so a
   * mail wake cannot literally be an assistant `tool_use` block followed by
   * its result — it is the tool's output, verbatim, arriving as a user
   * message. `isSynthetic` is how that message says it did not come from a
   * person. The framing does the rest; see `prompts.mailWake`.
   */
  push(text: string, sessionId: string, synthetic = false): void {
    if (this.#closed) throw new Error('Cannot push to a closed PromptQueue');
    this.#pending.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
      ...(synthetic ? { isSynthetic: true } : {}),
    });
    this.#resolve?.();
    this.#resolve = null;
  }

  close(): void {
    this.#closed = true;
    this.#resolve?.();
    this.#resolve = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.#closed) {
      if (this.#pending.length === 0) {
        await new Promise<void>((resolve) => {
          this.#resolve = resolve;
        });
        continue;
      }
      const batch = this.#pending;
      this.#pending = [];
      for (const message of batch) yield message;
    }
  }
}

export class AgentSession {
  readonly channelId: string;
  readonly workspacePath: string;

  #queue = new PromptQueue();
  #query: Query | null = null;
  #sessionId: string;
  #events: AgentEvents;
  /**
   * In-process tools for this session — today, `checkMail`, bound to this
   * agent's id. Built per session rather than shared because the binding is
   * the identity: a tool that took the agent id as an argument would let any
   * session read any mailbox.
   */
  #mcpServers: Record<string, McpServerConfig> | null;
  /** Per-role model override; undefined means use `model` from config. */
  #model: string | undefined;
  #consuming: Promise<void> | null = null;
  #closed = false;
  /** Reset at each wake; set when a discord CLI call *succeeds*. */
  #sentThisTurn = false;
  #apiErrorThisTurn: string | null = null;
  #apiErrorKindThisTurn: string | null = null;
  /**
   * Whether the agent has run any tool since the last real wake. Decides replay
   * vs continuation on retry — see CONTINUATION_PROMPT.
   *
   * Sticky across retries, and that is the point: side effects are. If the
   * first attempt committed and posted before dying, and two further attempts
   * then died at the API before touching anything, resetting per turn would
   * have the third replay the original request and do it all again. Once
   * anything has landed, every later attempt has to continue rather than
   * replay. Cleared only by wake(), never by a retry.
   */
  #actedSinceWake = false;
  /** tool_use ids of in-flight discord CLI calls, awaiting their results. */
  #discordCalls = new Map<string, string>();
  /**
   * The wake being served, kept so a retry can re-send it. Survives across
   * retries and is only replaced by a genuinely new wake.
   */
  #lastContext: WakeContext | null = null;
  /** Retries already spent on #lastContext. Reset by wake(), not by retries. */
  #retries = 0;
  #retryTimer: NodeJS.Timeout | null = null;

  lastActiveAt = Date.now();

  #busy = false;
  /**
   * Fired on every transition of `busy`, so the waker can republish its status
   * file the moment a turn starts rather than up to an interval later.
   *
   * That latency is the whole reason this is an accessor and not a plain field:
   * the ops executor decides whether recreating this container would interrupt
   * anybody by reading that file, and the dangerous window is exactly the gap
   * between a turn starting and the file saying so.
   */
  onBusyChanged: () => void = () => {};

  get busy(): boolean {
    return this.#busy;
  }

  set busy(value: boolean) {
    if (this.#busy === value) return;
    this.#busy = value;
    this.onBusyChanged();
  }

  constructor(
    channelId: string,
    workspacePath: string,
    resumeSessionId: string | undefined,
    events: AgentEvents,
    mcpServers: Record<string, McpServerConfig> | null = null,
    /**
     * This session's model, already resolved from the agent's role by
     * `acquire`. Undefined falls back to `model` — so a caller that predates
     * `modelByRole`, and every role with no override, behaves exactly as before.
     *
     * Resolved by the caller rather than read here, because the role lives on
     * the registry row and this class deliberately knows nothing about the
     * registry.
     */
    model?: string,
  ) {
    this.channelId = channelId;
    this.workspacePath = workspacePath;
    this.#events = events;
    this.#mcpServers = mcpServers;
    this.#model = model;
    this.#sessionId = resumeSessionId ?? `pending-${channelId}`;
    mkdirSync(workspacePath, { recursive: true });
    linkSkills(workspacePath);
    this.#start(resumeSessionId);
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  #buildOptions(resumeSessionId: string | undefined): Options {
    const options: Options = {
      cwd: this.workspacePath,
      model: this.#model ?? config().agent.model,
      systemPrompt: buildSystemPrompt(),
      // Required for the discord-cli skill to load at all. The SDK defaults to
      // isolation mode, where no filesystem settings — and therefore no skills
      // — are read. Paired with the .claude symlink created above.
      settingSources: ['project'],
      // Inherits the ambient environment, so the agent authenticates the same
      // way the `claude` CLI does for whoever runs this service: an exported
      // ANTHROPIC_API_KEY if present, otherwise that user's OAuth credentials.
      // This is also where the bot token enters the sandbox — see SETUP.md.
      env: {
        ...process.env,
        DISCORD_TOKEN: config().discord.token,
        DISCORD_GUILD_ID: config().discord.guildId,
        DISCORD_CLI_HOME: join(this.workspacePath, '.discord-cli'),
        ...gitEnv(),
      },
      stderr: (data: string) => {
        process.stderr.write(`[agent ${this.channelId}] ${data}`);
      },
    };

    // The board is a SQLite file on the host and the container has no route to
    // it, so the mail tools run here, in the waker, and reach the agent over
    // the SDK's own control channel rather than through the sandbox.
    if (this.#mcpServers) {
      options.mcpServers = this.#mcpServers;
    }

    // 0 means unlimited: omit the cap entirely rather than sending a zero,
    // which the SDK would read as "no turns allowed".
    if (config().agent.maxTurns > 0) {
      options.maxTurns = config().agent.maxTurns;
    }

    if (isResumable(resumeSessionId)) {
      options.resume = resumeSessionId;
    }

    // The agent process itself lives inside gVisor, so containment is the
    // container's job. Permission prompts would only block every tool call
    // with nothing there to answer them.
    options.spawnClaudeCodeProcess = containerSpawner({
      name: config().agent.container.name,
      claudePath: config().agent.container.claudePath,
      // The env above holds both tokens, and it reaches the container through
      // a 0600 file in here rather than through the exec's argv, which is
      // world-readable. See the header of src/container.ts.
      execEnvDir: config().agent.container.execEnvDir,
    });
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;

    return options;
  }

  #start(resumeSessionId: string | undefined): void {
    this.#query = query({
      prompt: this.#queue,
      options: this.#buildOptions(resumeSessionId),
    });
    this.#consuming = this.#consume();
  }

  async #consume(): Promise<void> {
    if (!this.#query) return;
    try {
      for await (const message of this.#query as AsyncIterable<SDKMessage>) {
        this.lastActiveAt = Date.now();
        this.#handle(message);
      }
    } catch (error) {
      if (!this.#closed) {
        this.#events.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #handle(message: SDKMessage): void {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          this.#sessionId = message.session_id;
        }
        break;
      }

      case 'assistant': {
        // An API-level failure — a revoked OAuth token, a rate limit — arrives
        // as an ordinary assistant message carrying the error as text. The
        // turn then ends with subtype "success" and is_error false, so without
        // this it is logged as a successful turn that happened to say nothing.
        // That is the worst possible rendering of "your credentials are dead":
        // in Discord it looks exactly like the agent choosing not to reply.
        //
        // The cost is the tell — an auth failure spends no tokens at all — but
        // the message itself is the honest signal.
        // The flag lives on the SDK *wrapper* (`SDKAssistantMessage.error`), a
        // sibling of `message` — not inside it. Reading `message.message` here
        // instead cost a silent outage: the check was always undefined, so a
        // revoked token logged as `turn success` and looked, from Discord, like
        // the agent choosing not to answer. Prefer this typed field over the
        // untyped `isApiErrorMessage` that sits next to it.
        //
        // `max_output_tokens` is deliberately excluded: the turn ran and
        // produced output, it just hit the ceiling. The SDK has its own
        // continuation path for it, and dressing it up as a refusal would both
        // misreport it and trigger a retry that repeats work.
        if (message.error !== undefined && message.error !== 'max_output_tokens') {
          // Iterated rather than mapped: `content` is a union of array types,
          // so `.map` has no single call signature and its parameter lands as
          // an implicit any, which fails the build under noImplicitAny.
          const parts: string[] = [];
          for (const block of message.message.content) {
            if (block.type === 'text') parts.push(block.text);
          }
          const detail = parts.join(' ').trim();
          this.#apiErrorThisTurn = detail || `API error with no detail (${message.error})`;
          this.#apiErrorKindThisTurn = message.error;
        }

        for (const block of message.message.content) {
          if (block.type !== 'tool_use') continue;

          // Any tool call means the wake had side effects, so a retry must
          // continue rather than replay. Set before the call is even resolved:
          // a tool that started and was cut off mid-flight is exactly the case
          // a verbatim replay would double.
          this.#actedSinceWake = true;

          const input = (block.input ?? {}) as Record<string, unknown>;
          const command = typeof input['command'] === 'string' ? input['command'] : '';

          // Matching the command only proves the agent *invoked* the CLI —
          // `--help` matches too. Record it and wait for the tool result,
          // which is the only thing that says whether it actually worked.
          if (DISCORD_SEND_PATTERN.test(command)) {
            this.#discordCalls.set(block.id, command);
          }

          this.#events.onToolUse(block.name, input);
        }
        break;
      }

      case 'user': {
        const content = message.message.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const command = this.#discordCalls.get(block.tool_use_id);
          if (command === undefined) continue;
          this.#discordCalls.delete(block.tool_use_id);

          const text =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((c: { type: string; text?: string }) =>
                      c.type === 'text' ? (c.text ?? '') : '',
                    )
                    .join(' ')
                : '';

          // The CLI exits non-zero and prints JSON with an "error" key when a
          // send fails. Either signal means nothing reached Discord.
          const failed = block.is_error === true || /"error"\s*:/.test(text);
          if (failed) {
            this.#events.onCliFailure(command, text.slice(0, 400));
          } else {
            this.#sentThisTurn = true;
          }
        }
        break;
      }

      case 'result': {
        this.busy = false;

        const plan =
          this.#apiErrorKindThisTurn !== null
            ? retryPlanFor(this.#apiErrorKindThisTurn)
            : null;
        const delay = plan?.delays[this.#retries];
        // A closed session has no queue to push to, and a wake with no stored
        // context has nothing to re-send.
        const willRetry =
          delay !== undefined && !this.#closed && this.#lastContext !== null;

        this.#events.onDone({
          isError: message.is_error,
          costUsd: message.total_cost_usd,
          numTurns: message.num_turns,
          durationMs: message.duration_ms,
          subtype: message.subtype,
          sentMessage: this.#sentThisTurn,
          apiError: this.#apiErrorThisTurn,
          apiErrorKind: this.#apiErrorKindThisTurn,
          retryScheduled: willRetry,
          retryAttempt: willRetry ? this.#retries + 1 : 0,
        });

        if (willRetry) {
          this.#retries += 1;
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null;
            this.#rewake();
          }, delay);
          // Never hold the process open for a retry: a shutdown mid-backoff
          // should exit, not linger.
          this.#retryTimer.unref();
        } else if (this.#apiErrorKindThisTurn === 'authentication_failed' && !this.#closed) {
          // Out of retries on an auth failure. The token this process holds is
          // dead and it will never pick up the live one, so the session itself
          // is the thing that has to go. Someone above owns the session map.
          this.#events.onNeedsRespawn(this.#actedSinceWake);
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Wake the agent on new input.
   *
   * Cancels any retry still pending from the previous wake: fresh input makes
   * a replay of the old one both stale and confusing.
   */
  wake(context: WakeContext): void {
    this.#cancelRetry();
    this.#lastContext = context;
    this.#retries = 0;
    // Only a genuine wake clears this — see the field for why a retry must not.
    this.#actedSinceWake = false;
    this.#push(buildWakeMessage(context), context.kind === 'mail');
  }

  /**
   * Re-send the current wake after an API refusal.
   *
   * Replay or continuation depending on whether anything has already been done
   * for this wake — the whole point of tracking #actedSinceWake.
   */
  #rewake(): void {
    if (this.#closed || this.#lastContext === null) return;
    const text = this.#actedSinceWake
      ? CONTINUATION_PROMPT
      : buildWakeMessage(this.#lastContext);
    this.#push(text, this.#lastContext.kind === 'mail' && !this.#actedSinceWake);
  }

  /** Shared turn setup: reset per-turn state, then hand the text over. */
  #push(text: string, synthetic = false): void {
    this.lastActiveAt = Date.now();
    this.busy = true;
    this.#sentThisTurn = false;
    this.#apiErrorThisTurn = null;
    this.#apiErrorKindThisTurn = null;
    this.#discordCalls.clear();
    try {
      this.#queue.push(text, this.#sessionId, synthetic);
    } catch (error) {
      // The child transport can be dead — a failed spawn, or a process that
      // exited. Route it through onError so the caller can drop the session
      // and retry, rather than letting it surface as an unhandled rejection
      // that says nothing about which channel broke.
      this.busy = false;
      this.#events.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #cancelRetry(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  async interrupt(): Promise<void> {
    // Before the busy check, not after: during a retry backoff the session is
    // idle by design, so an early return here would leave `!stop` looking like
    // it worked while a queued retry fired seconds later.
    this.#cancelRetry();
    this.#lastContext = null;
    if (!this.#query || !this.busy) return;
    await this.#query.interrupt();
    this.busy = false;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelRetry();
    this.#queue.close();
    try {
      await this.#consuming;
    } catch {
      // Teardown errors are expected and not actionable.
    }
  }
}

/**
 * What a channel with no registry row resolves to.
 *
 * Exported because `!status` has to answer the same question `#identityFor`
 * answers, and answer it the same way: it reports the model a channel would run
 * on, which is resolved from the role, which for a channel that has not taken a
 * turn yet is this. Two copies of the constant would put `!status` back to
 * reporting one model while the next turn ran on another — the defect it was
 * just fixed for, arriving by the route the fix opened.
 */
export const DEFAULT_CHANNEL_ROLE = 'coordinator' as const;

export class SessionManager {
  #sessions = new Map<string, AgentSession>();
  #registry: AgentRegistry;
  #mail: MailStore | null;
  /**
   * What `remindMe` and `watchPr` need, or null when armed conditions are off.
   *
   * The store and the GitHub client are shared across every session — they are
   * a table and an HTTP client, neither of which is per-agent — while the tools
   * built from them are not, because the owner is the closure. Passing the
   * options rather than the tools keeps that split explicit.
   */
  #armed: ArmedToolOptions | null;
  /**
   * Where a spawn writes its line, or null when spawn is not offered at all.
   *
   * A function rather than a boolean because there is nothing else to
   * configure: spawn needs the registry and the mail store, and this class
   * already holds both. Null is the off switch, and `main()` in daemon.ts is
   * where the decision is made — spawn without a board is a row nothing can be
   * delivered to, so it is only wired when mail is.
   */
  #spawnLog: ((line: string) => void) | null;
  #sweeper: NodeJS.Timeout;

  constructor(
    registry: AgentRegistry,
    mail: MailStore | null = null,
    armed: ArmedToolOptions | null = null,
    spawnLog: ((line: string) => void) | null = null,
  ) {
    this.#registry = registry;
    this.#mail = mail;
    this.#armed = armed;
    this.#spawnLog = spawnLog;
    this.#sweeper = setInterval(() => void this.#evictIdle(), 60_000);
    this.#sweeper.unref();
  }

  /**
   * The identity to write for an agent, and where it comes from.
   *
   * The ROW WINS whenever there is one. This used to return `coordinator`
   * unconditionally, which was harmless while every row was a Discord channel
   * and `recordSession` happened never to update the role column — two
   * accidents holding each other up. It stops being harmless the moment agents
   * are spawned: `persist` runs after every turn, and the one row that would
   * be written from these defaults is a row that had gone missing, so an
   * engineer would come back as a coordinator. Coordinator is the one role
   * that may DM the host agent, so that is a privilege the waker would be
   * handing out on the way past.
   *
   * The fallback remains `coordinator`, for a channel the registry has never
   * heard of: the only agents that existed before the registry were the ones
   * Discord wakes, and Discord stays with the coordinator. The id is the
   * channel id — that is what every caller here looks a session up by, and
   * minting a prettier name would detach live sessions from their channels for
   * nothing.
   */
  #identityFor(agentId: string, workspacePath: string): AgentIdentity {
    const row = this.#registry.get(agentId);
    if (row) {
      return {
        crew: row.crew,
        role: row.role,
        workspacePath,
        spawnedBy: row.spawnedBy,
      };
    }
    return {
      crew: config().agent.clawsky.crew,
      role: DEFAULT_CHANNEL_ROLE,
      workspacePath,
      spawnedBy: null,
    };
  }

  get liveCount(): number {
    return this.#sessions.size;
  }

  /**
   * How full the session pool is, and whether anything ever empties it.
   *
   * Read by `spawn`, which has to know before it writes a row: a spawned agent
   * is woken by mail and by nothing else, so if `acquire` can never find it a
   * slot then the row can never take a turn. The two numbers are not enough on
   * their own — a full pool with eviction ON is a wait, and a full pool with
   * eviction OFF does not clear on its own — so the timeout comes with them
   * rather than the caller guessing. `spawn` is right to refuse on the second:
   * the remedies that exist there are a person's, not something the caller can
   * wait for.
   *
   * `live` is `liveCount` by another name and carries its caveat: with
   * eviction off it is a high-water mark rather than a measure of activity.
   * That is the right number HERE, where the question is only whether
   * `acquire` would throw — and the wrong one for "is anybody
   * mid-conversation", which is `busyCount` below.
   */
  get capacity(): { live: number; max: number; idleTimeoutMinutes: number } {
    return {
      live: this.#sessions.size,
      max: config().agent.sessions.maxConcurrent,
      idleTimeoutMinutes: config().agent.sessions.idleTimeoutMinutes,
    };
  }

  /**
   * Sessions with a turn actually in flight.
   *
   * Distinct from `liveCount` and the distinction is load-bearing for the ops
   * executor. With the shipped `sessions.idleTimeoutMinutes: 0` a session is
   * never evicted, so `liveCount` is a high-water mark: after the first mention
   * it never returns to zero for the life of the process. An executor that
   * waited for `liveCount === 0` before recreating a container would wait
   * forever, and the obvious fix — waiting a bit and going anyway — is the
   * thing that kills someone's turn.
   *
   * `busyCount === 0` is the real "nobody is mid-conversation" signal. A live
   * but idle session costs nothing to recreate: it is resumed from SQLite on
   * the next mention.
   */
  get busyCount(): number {
    let busy = 0;
    for (const session of this.#sessions.values()) if (session.busy) busy += 1;
    return busy;
  }

  /**
   * Called whenever the live or busy count may have moved.
   *
   * Set by the waker to the ops status publisher. A callback rather than an
   * EventEmitter because there is exactly one subscriber and it must never be
   * able to throw into session handling — see the wrapper in daemon.ts.
   */
  onCountsChanged: () => void = () => {};

  /**
   * How a live session is built.
   *
   * Assignable, and the same shape as `onCountsChanged` above, for one reason:
   * constructing an `AgentSession` starts a containerised `claude`. The
   * constructor creates the workspace, links the skills, and hands the SDK a
   * `spawnClaudeCodeProcess` that writes an env file into
   * `container.execEnvDir` and runs `docker exec`. What this class is, on the
   * other hand, is bookkeeping: a map, a cap, an eviction rule and which
   * identity gets written back. A test of that which had to stand up a
   * container would pass or fail on whether the host had docker and a live
   * image, which are not facts about the pool.
   *
   * The waker never touches this. It is the seam that made `acquire`,
   * `persist`, `capacity` and eviction testable at all — see Clawcius #130 and
   * test/sessions.test.js — and everything it hands over is what `acquire`
   * decided, which is the part under test.
   */
  newSession: (
    channelId: string,
    workspacePath: string,
    resumeSessionId: string | undefined,
    events: AgentEvents,
    mcpServers: Record<string, McpServerConfig> | null,
    model: string | undefined,
  ) => AgentSession = (channelId, workspacePath, resumeSessionId, events, mcpServers, model) =>
    new AgentSession(channelId, workspacePath, resumeSessionId, events, mcpServers, model);

  has(channelId: string): boolean {
    return this.#sessions.has(channelId);
  }

  /**
   * Is a turn in flight for this agent right now?
   *
   * False for an agent with no session at all, which is the same answer as an
   * agent with an idle one — and deliberately so. Nothing interrupts a running
   * turn (CLAWSKY.md § Lifecycle), and "resumed, not resident" means having a
   * live `claude` process is not part of what it is to be busy.
   */
  isBusy(channelId: string): boolean {
    return this.#sessions.get(channelId)?.busy === true;
  }

  /**
   * Live session for a channel, resuming a stored one or creating fresh.
   * Throws at the concurrency cap — the caller surfaces that to Discord rather
   * than queueing silently, so the user learns why nothing happened.
   */
  acquire(channelId: string, events: AgentEvents): AgentSession {
    const existing = this.#sessions.get(channelId);
    if (existing) {
      this.#registry.touch(channelId);
      return existing;
    }

    if (this.#sessions.size >= config().agent.sessions.maxConcurrent) {
      throw new AtCapacityError(this.#sessions.size, config().agent.sessions.maxConcurrent);
    }

    const persisted = this.#registry.get(channelId);
    const workspacePath = persisted?.workspacePath ?? join(config().agent.sessions.workspaceRoot, channelId);
    const resumeFrom = isResumable(persisted?.sessionId) ? persisted.sessionId : undefined;

    // Registered before the turn rather than after it. The row is the identity
    // mail is addressed to, and the id below is what `sendMail` closes over, so
    // a channel whose first turn is in flight can already be written to and can
    // already write — rather than acquiring a mailbox once it happens to finish.
    const identity = this.#registry.ensure(
      channelId,
      this.#identityFor(channelId, workspacePath),
    );

    const session = this.newSession(
      channelId,
      workspacePath,
      resumeFrom,
      events,
      // `channelId` is this session's agent id, and passing it here is the only
      // place a sender is ever named — or an armed condition's owner. The tools
      // close over it; nothing the model can say reaches it. See mail-tool.ts
      // and armed-tool.ts.
      this.#mail
        ? buildMailServer(
            this.#mail,
            channelId,
            hostAgentId(config().agent.clawsky.crew),
            [
              ...(this.#armed ? buildArmedTools(channelId, this.#armed) : []),
              // Offered to a coordinator and to nobody else — CLAWSKY.md,
              // "Spawn and kill: held by the coordinator alone". The tool
              // checks the row again when it runs, so this is which tools a
              // session is given rather than where the rule lives; a session
              // built before an operator edited a role must not out-live the
              // edit.
              ...(this.#mail && this.#spawnLog && identity.role === 'coordinator'
                ? buildSpawnTools(channelId, {
                    registry: this.#registry,
                    mail: this.#mail,
                    workspaceRoot: config().agent.sessions.workspaceRoot,
                    charter: buildSpawnCharter,
                    wakesOnMail: config().agent.clawsky.wakeOnMail,
                    // A getter, not a snapshot: the tool is built once per
                    // session and the pool moves under it.
                    capacity: () => this.capacity,
                    log: this.#spawnLog,
                  })
                : []),
            ],
          )
        : null,
      // Resolved from the ROW's role, not from the id or the caller. A role
      // with no entry gets undefined and falls back to `model`, so the default
      // deployment is unchanged by this existing at all.
      config().agent.modelByRole[identity.role],
    );

    session.onBusyChanged = () => this.onCountsChanged();
    this.#sessions.set(channelId, session);
    this.onCountsChanged();
    // Deliberately not persisted here: the id is still the placeholder. It is
    // written once the SDK reports the real one — see persist().
    return session;
  }

  /**
   * Write the session id back to the row, and only to a row that exists.
   *
   * The absent-row check is the whole of the fix, and preferring the row in
   * `#identityFor` is not a substitute for it. `recordSession` is an upsert:
   * when the row is missing it takes the plain-INSERT branch and writes
   * `identity.role` — so the case worth worrying about, a row that went missing
   * between the wake and the persist, is exactly the case that reaches
   * `#identityFor`'s fallback and gets `coordinator`, which is the one role
   * that may DM the host agent. Reading the row first narrows nothing there,
   * because there is no row to read.
   *
   * So a turn ending for an agent with no row now writes nothing at all,
   * whatever role it would have picked. An agent is a row; a turn is not a
   * thing that may create one.
   *
   * NOT REACHABLE TODAY, and said out loud so nobody reads it as a live hole:
   * nothing in the tree deletes from `agents`, and `!reset` clears the session
   * id rather than the row. It is a guard against a future delete, and against
   * the day somebody adds one without thinking about which code paths mint
   * rows. The loud line is deliberate — silence here would hide the delete that
   * made it reachable.
   */
  persist(channelId: string): void {
    const session = this.#sessions.get(channelId);
    if (!session) return;
    if (!isResumable(session.sessionId)) return;

    if (this.#registry.get(channelId) === undefined) {
      process.stderr.write(
        `[clawcius ${channelId}] finished a turn with no registry row — not creating one. ` +
          'Its session id is lost and the next wake starts cold. Something deleted the row, ' +
          'which nothing in this tree does.\n',
      );
      return;
    }

    this.#registry.recordSession(
      channelId,
      session.sessionId,
      session.workspacePath,
      this.#identityFor(channelId, session.workspacePath),
    );
  }

  async release(channelId: string): Promise<void> {
    const session = this.#sessions.get(channelId);
    if (!session) return;
    this.#sessions.delete(channelId);
    this.onCountsChanged();
    await session.close();
  }

  async #evictIdle(): Promise<void> {
    // 0 disables eviction: sessions stay alive for the life of the process.
    if (config().agent.sessions.idleTimeoutMinutes === 0) return;

    const cutoff = Date.now() - config().agent.sessions.idleTimeoutMinutes * 60_000;
    for (const [channelId, session] of this.#sessions) {
      if (session.busy || session.lastActiveAt > cutoff) continue;
      // The session ID survives in SQLite, so the next mention resumes rather
      // than starting a cold conversation.
      await this.release(channelId);
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.#sweeper);
    await Promise.all([...this.#sessions.keys()].map((id) => this.release(id)));
  }
}
