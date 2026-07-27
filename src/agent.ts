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

import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { buildSystemPrompt, buildWakeMessage } from './prompt.js';
import { containerSpawner } from './container.js';
import type { SessionStore } from './store.js';
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
    symlinkSync(config.agent.paths.skillsDir, target, 'dir');
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
 * no file behind it. That matters twice over: the token never lands on disk,
 * and the service user's own ~/.gitconfig is left completely alone — the agent
 * gets its own identity without inheriting or clobbering yours.
 *
 * The credential helper is scoped to github.com and reads GITHUB_TOKEN at call
 * time, so the token appears in no URL, no remote, and no reflog.
 *
 * HTTPS only. The agent has no route out except the proxy bridge, and SSH is
 * not HTTP — `git@github.com` cannot leave the sandbox at all.
 */
function gitEnv(): Record<string, string> {
  const entries: Array<[string, string]> = [
    ['user.name', config.agent.git.userName],
    ['user.email', config.agent.git.userEmail],
  ];

  if (config.github.token) {
    entries.push([
      'credential.https://github.com.helper',
      '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f',
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
  if (config.github.token) env['GITHUB_TOKEN'] = config.github.token;
  return env;
}

export type AgentEvents = {
  /** Fired for each tool the agent runs — used for logging and send-detection. */
  onToolUse: (toolName: string, input: Record<string, unknown>) => void;
  onDone: (summary: TurnSummary) => void;
  onError: (error: Error) => void;
  /** A discord CLI call came back an error — the reply never landed. */
  onCliFailure: (command: string, output: string) => void;
};

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #resolve: (() => void) | null = null;
  #closed = false;

  push(text: string, sessionId: string): void {
    if (this.#closed) throw new Error('Cannot push to a closed PromptQueue');
    this.#pending.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
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
  #consuming: Promise<void> | null = null;
  #closed = false;
  /** Reset at each wake; set when a discord CLI call *succeeds*. */
  #sentThisTurn = false;
  /** tool_use ids of in-flight discord CLI calls, awaiting their results. */
  #discordCalls = new Map<string, string>();

  lastActiveAt = Date.now();
  busy = false;

  constructor(
    channelId: string,
    workspacePath: string,
    resumeSessionId: string | undefined,
    events: AgentEvents,
  ) {
    this.channelId = channelId;
    this.workspacePath = workspacePath;
    this.#events = events;
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
      model: config.agent.model,
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
        DISCORD_TOKEN: config.discord.token,
        DISCORD_GUILD_ID: config.discord.guildId,
        DISCORD_CLI_HOME: join(this.workspacePath, '.discord-cli'),
        ...gitEnv(),
      },
      stderr: (data: string) => {
        process.stderr.write(`[agent ${this.channelId}] ${data}`);
      },
    };

    // 0 means unlimited: omit the cap entirely rather than sending a zero,
    // which the SDK would read as "no turns allowed".
    if (config.agent.maxTurns > 0) {
      options.maxTurns = config.agent.maxTurns;
    }

    if (isResumable(resumeSessionId)) {
      options.resume = resumeSessionId;
    }

    // The agent process itself lives inside gVisor, so containment is the
    // container's job. Permission prompts would only block every tool call
    // with nothing there to answer them.
    options.spawnClaudeCodeProcess = containerSpawner({
      name: config.agent.container.name,
      claudePath: config.agent.container.claudePath,
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
        for (const block of message.message.content) {
          if (block.type !== 'tool_use') continue;

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
        this.#events.onDone({
          isError: message.is_error,
          costUsd: message.total_cost_usd,
          numTurns: message.num_turns,
          durationMs: message.duration_ms,
          subtype: message.subtype,
          sentMessage: this.#sentThisTurn,
        });
        break;
      }

      default:
        break;
    }
  }

  /** Wake the agent. */
  wake(context: WakeContext): void {
    this.lastActiveAt = Date.now();
    this.busy = true;
    this.#sentThisTurn = false;
    this.#discordCalls.clear();
    try {
      this.#queue.push(buildWakeMessage(context), this.#sessionId);
    } catch (error) {
      // The child transport can be dead — a failed spawn, or a process that
      // exited. Route it through onError so the caller can drop the session
      // and retry, rather than letting it surface as an unhandled rejection
      // that says nothing about which channel broke.
      this.busy = false;
      this.#events.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async interrupt(): Promise<void> {
    if (!this.#query || !this.busy) return;
    await this.#query.interrupt();
    this.busy = false;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.close();
    try {
      await this.#consuming;
    } catch {
      // Teardown errors are expected and not actionable.
    }
  }
}

export class SessionManager {
  #sessions = new Map<string, AgentSession>();
  #store: SessionStore;
  #sweeper: NodeJS.Timeout;

  constructor(store: SessionStore) {
    this.#store = store;
    this.#sweeper = setInterval(() => void this.#evictIdle(), 60_000);
    this.#sweeper.unref();
  }

  get liveCount(): number {
    return this.#sessions.size;
  }

  has(channelId: string): boolean {
    return this.#sessions.has(channelId);
  }

  /**
   * Live session for a channel, resuming a stored one or creating fresh.
   * Throws at the concurrency cap — the caller surfaces that to Discord rather
   * than queueing silently, so the user learns why nothing happened.
   */
  acquire(channelId: string, events: AgentEvents): AgentSession {
    const existing = this.#sessions.get(channelId);
    if (existing) {
      this.#store.touch(channelId);
      return existing;
    }

    if (this.#sessions.size >= config.agent.sessions.maxConcurrent) {
      throw new Error(
        `at capacity (${config.agent.sessions.maxConcurrent} concurrent sessions)`,
      );
    }

    const persisted = this.#store.get(channelId);
    const workspacePath = persisted?.workspacePath ?? join(config.agent.sessions.workspaceRoot, channelId);
    const resumeFrom = isResumable(persisted?.sessionId) ? persisted.sessionId : undefined;

    const session = new AgentSession(
      channelId,
      workspacePath,
      resumeFrom,
      events,
    );

    this.#sessions.set(channelId, session);
    // Deliberately not persisted here: the id is still the placeholder. It is
    // written once the SDK reports the real one — see persist().
    return session;
  }

  persist(channelId: string): void {
    const session = this.#sessions.get(channelId);
    if (!session) return;
    if (!isResumable(session.sessionId)) return;
    this.#store.upsert(channelId, session.sessionId, session.workspacePath);
  }

  async release(channelId: string): Promise<void> {
    const session = this.#sessions.get(channelId);
    if (!session) return;
    this.#sessions.delete(channelId);
    await session.close();
  }

  async #evictIdle(): Promise<void> {
    // 0 disables eviction: sessions stay alive for the life of the process.
    if (config.agent.sessions.idleTimeoutMinutes === 0) return;

    const cutoff = Date.now() - config.agent.sessions.idleTimeoutMinutes * 60_000;
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
