/** Long-lived Claude Code sessions, one per Discord channel or thread. */

import { query, type McpServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { tokenFilePath } from './token-file.js';
import { buildSpawnCharter, buildSystemPrompt, buildWakeMessage } from './prompt.js';
import type { PromptIdentity } from './prompt.js';
import { containerSpawner } from './container.js';
import { buildMailServer } from './mail-tool.js';
import { buildArmedTools, type ArmedToolOptions } from './armed-tool.js';
import { buildSpawnTools } from './spawn-tool.js';
import type { MailStore } from './mail.js';
import { type AgentIdentity, type AgentRegistry } from './store.js';
import type { NoRetryReason, TurnSummary, WakeContext } from './types.js';
import { SUPERSEDED } from './types.js';

/** Matches a `discord send` / `discord reply` invocation in a bash command, including the absolute-path form the agent is told to use. */

/** Whether a stored id can actually be handed to `--resume`. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isResumable(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === 'string' && SESSION_UUID.test(sessionId);
}

/** Retry policy for API-level refusals. */
const AUTH_RETRY_DELAYS_MS: readonly number[] = [2_000];
const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

/** SDK error kinds that clear on their own if you wait. */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
]);

type RetryPlan = { kind: 'auth' | 'transient'; delays: readonly number[] };

/** How to react to an SDK error kind, or null to give up. */
export function retryPlanFor(errorKind: string): RetryPlan | null {
  if (errorKind === 'authentication_failed') {
    return { kind: 'auth', delays: AUTH_RETRY_DELAYS_MS };
  }
  if (TRANSIENT_ERRORS.has(errorKind)) {
    return { kind: 'transient', delays: TRANSIENT_RETRY_DELAYS_MS };
  }
  return null;
}

/** Whether to retry a refused turn, and if not, why not. Pure: `daemon.ts` turns `noRetryReason` into the sentence a human reads. */
export function classifyRetry(state: {
  /** The SDK's error kind, or null when the turn did not hit an API error. */
  errorKind: string | null;
  /** Whether the turn failed at all. A success has no reason and no retry. */
  failed: boolean;
  /** Rungs already used on THIS context. Reset by `wake()`, not by a retry. */
  retriesSpent: number;
  /** A closed session has no queue to push to. */
  closed: boolean;
  /** A wake with no stored context has nothing to re-send. */
  hasContext: boolean;
}): { willRetry: boolean; delayMs: number | undefined; noRetryReason: NoRetryReason | null } {
  const plan = state.errorKind !== null ? retryPlanFor(state.errorKind) : null;
  const delay = plan?.delays[state.retriesSpent];
  const willRetry = delay !== undefined && !state.closed && state.hasContext;

  if (!state.failed || willRetry) return { willRetry, delayMs: delay, noRetryReason: null };
  if (plan === null) return { willRetry, delayMs: delay, noRetryReason: 'not-retryable' };
  if (delay === undefined) {
    return {
      willRetry,
      delayMs: delay,
      noRetryReason: plan.kind === 'auth' ? 'credential-dead' : 'exhausted',
    };
  }
  return { willRetry, delayMs: delay, noRetryReason: 'abandoned' };
}

/** Sent instead of the original message when a turn is retried after it had already started doing things. */
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

/** Make the project's skills visible from inside the workspace. */
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

/** Git configuration for the agent, injected purely through the environment: `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n`, so no file and no credential in the config itself. */
export function gitEnv(): Record<string, string> {
  const entries: Array<[string, string]> = [
    ['user.name', config().agent.git.userName],
    ['user.email', config().agent.git.userEmail],
  ];

  // THE CONDITION MUST DESCRIBE THE SAME DEPLOYMENT AS THE WRITER'S.
  const appWritesTheFile =
    Boolean(config().github.appId) &&
    config().agent.clawsky.enabled &&
    config().agent.armed.enabled;
  if (config().github.token || appWritesTheFile) {
    entries.push([
      'credential.https://github.com.helper',
      // FILE FIRST, ENVIRONMENT SECOND, resolved on every call rather than at spawn.
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
  env['CURL_HOME'] = config().agent.container.githubTokenDir;
  return env;
}

/** `acquire` had no session slot left. */
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

/** The sentence a user reads when their mention was dropped for want of a slot. */
export function atCapacityNotice(error: AtCapacityError): string {
  return (
    `⚠️ No session slot free — ${error.live} of ${error.max} are in use, so I could not ` +
    'pick that up and it was not queued. Idle sessions are evicted on their own; try again in a few minutes.'
  );
}

export type AgentEvents = {
  /** Fired for each tool the agent runs — used for logging and send-detection. */
  onToolUse: (toolName: string, input: Record<string, unknown>) => void;
  onDone: (summary: TurnSummary) => void;
  onError: (error: Error) => void;
  /** A discord CLI call came back an error — the reply never landed. */
  /** This session cannot recover on its own and must be replaced. */
  onNeedsRespawn: (acted: boolean) => void;
};

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #resolve: (() => void) | null = null;
  #closed = false;

  /** `synthetic` marks a turn nobody typed. */
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

/** The SDK entry point, behind an assignable indirection so a test can construct a session without a container. */
export const sdk = { query };

/** The settle callback for the turn in flight, and the single rule that a new turn ends the one before it. */
export class TurnSettle {
  #pending: ((ran: boolean, why: string) => void) | null = null;

  /** Take over for a new turn, ending whatever turn was still in flight. */
  adopt(next: ((ran: boolean, why: string) => void) | null, why: string): void {
    this.done(false, why);
    this.#pending = next;
  }

  /** End the turn in flight, once. A turn with nothing pending is a no-op. */
  done(ran: boolean, why: string): void {
    const settle = this.#pending;
    this.#pending = null;
    if (settle) settle(ran, why);
  }

  /** Whether a turn is still in flight. */
  get pending(): boolean {
    return this.#pending !== null;
  }
}

export class AgentSession {
  readonly channelId: string;
  readonly workspacePath: string;

  #queue = new PromptQueue();
  #query: Query | null = null;
  #sessionId: string;
  #events: AgentEvents;
  /** In-process tools for this session — today, `checkMail`, bound to this agent's id. */
  #mcpServers: Record<string, McpServerConfig> | null;
  /** Per-role model override; undefined means use `model` from config. */
  #model: string | undefined;
  /** Who this session is, for the system prompt's opening line. */
  #identity: PromptIdentity;
  #consuming: Promise<void> | null = null;
  #closed = false;
  /** Reset at each wake; set when a discord CLI call *succeeds*. */
  readonly #settle = new TurnSettle();
  #apiErrorThisTurn: string | null = null;
  #apiErrorKindThisTurn: string | null = null;
  /** Whether the agent has run any tool since the last real wake. */
  #actedSinceWake = false;
  /** tool_use ids of in-flight discord CLI calls, awaiting their results. */
  /** The wake being served, kept so a retry can re-send it. */
  #lastContext: WakeContext | null = null;
  /** Retries already spent on #lastContext. Reset by wake(), not by retries. */
  #retries = 0;
  #retryTimer: NodeJS.Timeout | null = null;

  lastActiveAt = Date.now();

  #busy = false;
  /** Fired on every transition of `busy`, so the waker can republish its status file the moment a turn starts rather than up to an interval later. */
  onBusyChanged: () => void = () => {};

  get busy(): boolean {
    return this.#busy;
  }

  /** Whether a turn has been handed over and has not yet ended. See `isBusy`. */
  get turnPending(): boolean {
    return this.#settle.pending;
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
    /** This session's model, already resolved from the agent's role by `acquire`. */
    // `string | undefined` rather than optional, so the required `identity`
    // can follow it. `newSession` -- the only caller -- already passes both.
    model: string | undefined,
    identity: PromptIdentity,
  ) {
    this.channelId = channelId;
    this.workspacePath = workspacePath;
    this.#events = events;
    this.#mcpServers = mcpServers;
    this.#model = model;
    this.#identity = identity;
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
      systemPrompt: buildSystemPrompt(this.#identity),
      // Required for the discord-cli skill to load at all. The SDK defaults to
      // isolation mode, where no filesystem settings — and therefore no skills
      // — are read. Paired with the .claude symlink created above.
      settingSources: ['project'],
      // Inherits the ambient environment, so the agent authenticates the same way the `claude` CLI does for whoever runs this service.
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

    // A crew in a sandbox runs its sessions through docker exec; Hamachi runs them on the host.
    if (config().agent.container.enabled) {
      options.spawnClaudeCodeProcess = containerSpawner({
        name: config().agent.container.name,
        claudePath: config().agent.container.claudePath,
        // The env above holds both tokens, and it reaches the container through
        // a 0600 file in here rather than through the exec's argv, which is
        // world-readable. See the header of src/container.ts.
        execEnvDir: config().agent.container.execEnvDir,
      });
    }
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;

    return options;
  }

  #start(resumeSessionId: string | undefined): void {
    this.#query = sdk.query({
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
        this.#settle.done(false, `the turn died: ${String(error)}`);
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
        // An API-level failure — a revoked OAuth token, a rate limit — arrives as an ordinary assistant message carrying the error as text.
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

          // Any tool call means the wake had side effects, so a retry must continue rather than replay.
          this.#actedSinceWake = true;

          const input = (block.input ?? {}) as Record<string, unknown>;

          this.#events.onToolUse(block.name, input);
        }
        break;
      }


      case 'result': {
        // ── ORDER IS LOAD-BEARING: SETTLE BEFORE PUBLISHING `busy` ───────────
        const { willRetry, delayMs: delay, noRetryReason } = classifyRetry({
          errorKind: this.#apiErrorKindThisTurn,
          failed: this.#apiErrorThisTurn !== null,
          retriesSpent: this.#retries,
          closed: this.#closed,
          hasContext: this.#lastContext !== null,
        });

        // SETTLED HERE, at the one place a turn ends, rather than in three callbacks the caller wires.
        if (this.#apiErrorThisTurn === null) {
          this.#settle.done(true, 'turn completed');
        } else if (!willRetry) {
          this.#settle.done(false, `API refused: ${this.#apiErrorKindThisTurn}`);
        }

        this.#events.onDone({
          isError: message.is_error,
          costUsd: message.total_cost_usd,
          numTurns: message.num_turns,
          durationMs: message.duration_ms,
          subtype: message.subtype,
          apiError: this.#apiErrorThisTurn,
          apiErrorKind: this.#apiErrorKindThisTurn,
          retryScheduled: willRetry,
          retryAttempt: willRetry ? this.#retries + 1 : 0,
          noRetryReason,
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
          this.#settle.done(false, 'stale token, session dropped');
          this.#events.onNeedsRespawn(this.#actedSinceWake);
        }

        // ── AND THE FLIP COMES LAST, FOR THE SAME REASON THE SETTLE CAME
        //    BEFORE IT ────────────────────────────────────────────────────────
        this.busy = false;
        break;
      }

      default:
        break;
    }
  }

  wake(context: WakeContext, onSettled: ((ran: boolean, why: string) => void) | null = null): void {
    // A wake arriving while a previous turn's settle is still pending means that turn never completed — nothing else would have left it.
    this.#settle.adopt(onSettled, SUPERSEDED);
    this.#cancelRetry();
    this.#lastContext = context;
    this.#retries = 0;
    // Only a genuine wake clears this: a retry must continue rather than replay.
    this.#actedSinceWake = false;
    this.#push(buildWakeMessage(context), context.kind === 'mail');
  }

  /** Re-send the current wake after an API refusal. */
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
    this.#apiErrorThisTurn = null;
    this.#apiErrorKindThisTurn = null;
    try {
      this.#queue.push(text, this.#sessionId, synthetic);
    } catch (error) {
      // The child transport can be dead — a failed spawn, or a process that exited.
      this.#settle.done(false, `could not start the turn: ${String(error)}`);
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

    // ── SETTLED BEFORE THE EARLY RETURN, AND THE ANSWER DIFFERS EITHER SIDE
    //    OF IT ─────────────────────────────────────────────────────────────
    if (!this.#query || !this.busy) {
      this.#settle.done(false, 'stopped during a retry backoff — the turn never ran');
      return;
    }
    await this.#query.interrupt();
    this.#settle.done(true, 'interrupted by !stop');
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

/** What a channel with no registry row resolves to. `!status` and `#identityFor` must agree on it. */
export const DEFAULT_CHANNEL_ROLE = 'coordinator' as const;

export class SessionManager {
  #sessions = new Map<string, AgentSession>();
  #registry: AgentRegistry;
  #mail: MailStore | null;
  /** What the armed tools need, or null when armed conditions are off. */
  #armed: ArmedToolOptions | null;
  /** Where a spawn writes its line, or null when spawn is not offered at all. */
  #spawnLog: ((line: string) => void) | null;
  #evictLog: ((line: string) => void) | null;
  #sweeper: NodeJS.Timeout;

  constructor(
    registry: AgentRegistry,
    mail: MailStore | null = null,
    armed: ArmedToolOptions | null = null,
    spawnLog: ((line: string) => void) | null = null,
    evictLog: ((line: string) => void) | null = null,
  ) {
    this.#registry = registry;
    this.#mail = mail;
    this.#armed = armed;
    this.#spawnLog = spawnLog;
    this.#evictLog = evictLog;
    this.#sweeper = setInterval(() => void this.evictIdle(), 60_000);
    this.#sweeper.unref();
  }

  /** The identity to write for an agent. The row wins whenever there is one. */
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
    // A channel the registry has never seen gets a coordinator; allowedChannelIds is the only gate.
    console.warn(`[registry] no row for ${agentId}; minting a ${DEFAULT_CHANNEL_ROLE} for crew ${config().agent.clawsky.crew}`);
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

  /** How full the session pool is, and whether anything ever empties it. */
  get capacity(): { live: number; max: number; idleTimeoutMinutes: number } {
    return {
      live: this.#sessions.size,
      max: config().agent.sessions.maxConcurrent,
      idleTimeoutMinutes: config().agent.sessions.idleTimeoutMinutes,
    };
  }

  /** Sessions with a turn actually in flight. */
  get busyCount(): number {
    let busy = 0;
    // The SAME predicate as `isBusy`: a mid-backoff agent is not interruptible
    // and the waker already skips it.
    for (const session of this.#sessions.values()) {
      if (session.busy || session.turnPending) busy += 1;
    }
    return busy;
  }

  /** Called whenever the live or busy count may have moved. */
  onCountsChanged: () => void = () => {};

  newSession: (
    channelId: string,
    workspacePath: string,
    resumeSessionId: string | undefined,
    events: AgentEvents,
    mcpServers: Record<string, McpServerConfig> | null,
    model: string | undefined,
    identity: PromptIdentity,
  ) => AgentSession = (
    channelId,
    workspacePath,
    resumeSessionId,
    events,
    mcpServers,
    model,
    identity,
  ) =>
    new AgentSession(channelId, workspacePath, resumeSessionId, events, mcpServers, model, identity);

  has(channelId: string): boolean {
    return this.#sessions.has(channelId);
  }

  /** Is a turn in flight for this agent right now? */
  isBusy(channelId: string): boolean {
    const session = this.#sessions.get(channelId);
    if (session === undefined) return false;
    return session.busy || session.turnPending;
  }

  /** Live session for a channel, resuming a stored one or creating fresh. */
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

    // Registered before the turn rather than after it.
    const identity = this.#registry.ensure(
      channelId,
      this.#identityFor(channelId, workspacePath),
    );

    const session = this.newSession(
      channelId,
      workspacePath,
      resumeFrom,
      events,
      // `channelId` is this session's agent id, and passing it here is the only place a sender is ever named — or an armed condition's owner.
      this.#mail
        ? buildMailServer(
            this.#mail,
            channelId,
            [
              ...(this.#armed ? buildArmedTools(channelId, this.#armed) : []),
              // Offered to a coordinator and to nobody else — CLAWSKY.md, "Spawn and kill: held by the coordinator alone".
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
      // Identity for the system prompt's opening line. `channelId` IS the
      // agent id; crew and role come off the row `ensure` just wrote.
      { id: channelId, crew: identity.crew, role: identity.role },
    );

    session.onBusyChanged = () => this.onCountsChanged();
    this.#sessions.set(channelId, session);
    this.onCountsChanged();
    // Deliberately not persisted here: the id is still the placeholder. It is
    // written once the SDK reports the real one — see persist().
    return session;
  }

  /** Write the session id back to the row, and only to a row that exists. */
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

  async evictIdle(): Promise<void> {
    // 0 disables eviction: sessions stay alive for the life of the process.
    if (config().agent.sessions.idleTimeoutMinutes === 0) return;

    const cutoff = Date.now() - config().agent.sessions.idleTimeoutMinutes * 60_000;
    for (const [channelId, session] of this.#sessions) {
      if (session.busy || session.lastActiveAt > cutoff) continue;
      const idleMinutes = Math.round((Date.now() - session.lastActiveAt) / 60_000);
      this.#evictLog?.(`evicting ${channelId} — idle ${idleMinutes} minute(s), slot freed`);
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
