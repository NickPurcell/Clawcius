/**
 * Agent behaviour, loaded from `agent-config.yaml`.
 *
 * The split with `.env` is deliberate: the environment carries only secrets and
 * deployment identity, everything describing how the agent *behaves* lives in
 * version-controllable YAML. Changing the agent's personality should be a diff,
 * not an edit to a file full of tokens.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { parse } from 'yaml';
import { AGENT_ROLES, isAgentRole, type AgentRole } from './store.js';
import { REPO_NAME } from './github.js';

export type SystemPromptConfig = {
  /**
   * Run with Claude Code's own system prompt as the base. This is what makes
   * the agent behave like Claude Code rather than a generic assistant.
   */
  useClaudeCodeDefault: boolean;
  /** Extra instructions layered on top. */
  append: string;
};

/**
 * Every piece of text the agent receives from us, as templates.
 *
 * These live in config rather than code because they are content, not
 * mechanism — the wording of a wake, how a message renders, what the standing
 * instructions say. Placeholders are `{name}` and are validated at startup, so
 * a typo fails the boot with the offending key named instead of shipping a
 * literal `{chanel_id}` into the model's context.
 */
export type PromptTemplates = {
  /** Standing instructions, prepended to systemPrompt.append. */
  protocol: string;
  /**
   * Rides along on every wake, via `{roleNotice}` in the wake templates.
   *
   * Every agent in the team shares one system prompt, so nothing in it says
   * *which* role is reading. Wake messages are the one channel that reaches
   * only the main agent — subagents are spawned by it and never woken by the
   * waker — which makes this the right place to say so. Set it empty to drop
   * the line entirely.
   */
  roleNotice: string;
  /** Wake message for incoming Discord messages. */
  messageWake: string;
  /** How one message inside a bundle renders. */
  messageLine: string;
  /** Wake message for a schedule the agent set for itself. */
  scheduleWake: string;
  /**
   * Wake message for mail that arrived while the agent was idle.
   *
   * Deliberately the thinnest template of the four. `{mail}` is `checkMail`'s
   * own output, verbatim, and everything wrapped around it is wrapping around
   * the agent's own tool result — so the more this says, the more it reads as
   * somebody else having prodded the agent, which is exactly what the design
   * is trying not to do. No `{roleNotice}` for the same reason.
   */
  mailWake: string;
};

/** Placeholders each template may use. Anything else is a startup error. */
export const PROMPT_PLACEHOLDERS: Record<keyof PromptTemplates, readonly string[]> = {
  protocol: ['cli'],
  roleNotice: [],
  messageWake: ['count', 'plural', 'messages', 'channelId', 'latestMessageId', 'cli', 'roleNotice'],
  messageLine: ['time', 'author', 'authorId', 'messageId', 'content'],
  scheduleWake: ['channelId', 'scheduleId', 'repeats', 'prompt', 'cli', 'roleNotice'],
  mailWake: ['mail', 'count', 'plural'],
};

export type AgentConfig = {
  container: {
    name: string;
    /** In-container path to the claude binary. */
    claudePath: string;
    /**
     * Where the per-exec `--env-file` is written (src/container.ts).
     *
     * MUST NOT be inside any bind mount in `docker/run-container.sh`. The file
     * holds this instance's whole credential environment, and the read-only
     * mounts — the skills directory, the discord CLI — are shared by BOTH
     * instances, so a file placed there would hand one deployment's Discord
     * token to the other deployment's agent. Checked below, as far as this
     * config can see the mounts.
     *
     * Default is a sibling of the state directory's `run/`, chosen for the
     * same reason `status.file` is: `run/` is the mount, its parent is not.
     */
    execEnvDir: string;
  };
  prompts: PromptTemplates;
  model: string;
  /** 0 means unlimited — no turn cap is sent to the SDK at all. */
  maxTurns: number;
  systemPrompt: SystemPromptConfig;
  sessions: {
    maxConcurrent: number;
    /** 0 means never evict — sessions stay alive until the bot restarts. */
    idleTimeoutMinutes: number;
    workspaceRoot: string;
  };
  discord: {
    /** Empty means every channel the bot can see. */
    allowedChannelIds: string[];
    /**
     * After the bot is addressed, seconds during which ordinary messages in
     * that channel also reach the agent. Extended by a new mention or by the
     * bot posting/editing. 0 disables follow-ups — mention required every time.
     */
    followUpWindowSeconds: number;
    /**
     * Channels where a follow-up window may open at all. Empty means every
     * channel, which is the historical behaviour.
     *
     * This exists because the window is extended by the bot's own traffic, and
     * the bot account is shared with automations. An automation posting to a
     * channel therefore opens a window there, after which *every* message in
     * that channel wakes the agent until it expires — uncapped, and in a busy
     * channel, expensive. Naming the channels where conversation is wanted
     * keeps automation output from dragging the agent into one.
     */
    followUpChannelIds: string[];
    /**
     * Channels where every message wakes the agent, with no mention required
     * and no window to expire — a room dedicated to talking to the bot.
     *
     * This is deliberately separate from `followUpChannelIds`. A follow-up
     * window is a grace period anchored to an exchange the bot is part of; this
     * is a standing invitation. Listing a channel here makes `!` commands work
     * without an @ too, on the same reasoning: the room is the bot's.
     *
     * `allowedChannelIds` still applies. A channel named here but absent from a
     * non-empty `allowedChannelIds` will never wake anything, so startup warns
     * rather than leaving you to wonder why the room is silent.
     *
     * Cost note: every message in these channels bills a turn, indefinitely.
     * There is no budget cap. Use it for rooms that exist to talk to the agent,
     * not for busy general channels.
     */
    alwaysOnChannelIds: string[];
    /**
     * Wait this long after a message before handing the bundle to the agent,
     * restarting on each new message. 0 hands every message over immediately.
     */
    bundleDebounceMs: number;
    /** Ceiling from the first message in a bundle, so typing cannot defer forever. */
    bundleMaxWaitMs: number;
  };
  paths: {
    discordCli: string;
    skillsDir: string;
  };
  git: {
    /** Author name on commits the agent makes. */
    userName: string;
    /** Author email. Keep it distinct from yours so agent commits are obvious. */
    userEmail: string;
  };
  wake: {
    /**
     * Unix socket the agent POSTs to in order to be woken later.
     *
     * Replaces the old MCP scheduler: inside its container the agent has cron
     * and daemons, so it schedules itself with tools it already knows and we
     * only have to accept the request.
     */
    enabled: boolean;
    /** Directory the agent drops wake-request JSON files into. */
    spoolDir: string;
    /** Cap on accepted wake requests per channel per rolling hour. */
    maxPerHour: number;
  };
  /**
   * The message board: identity and mail.
   *
   * See CLAWSKY.md. There is nothing here about how mail is sent, because
   * sending is a tool the waker builds per session rather than a path on disk.
   */
  clawsky: {
    /** Off means no `checkMail` or `sendMail` tool is offered to any session. */
    enabled: boolean;
    /**
     * This deployment's crew. Agent ids are `<crew>-<role><ordinal>`, and the
     * crew is the boundary DMs stay inside, so this is identity rather than a
     * label.
     */
    crew: string;
    /**
     * Mail delivered to an idle agent starts a turn — CLAWSKY.md phase 3.
     *
     * Separable from the board itself, and it stays separable: off, agents
     * still send mail and still read it whenever they happen to run, which is
     * the state phases 1 and 2 shipped and which CLAWSKY.md says is worth
     * living with. An operator who wants that back should not have to switch
     * the whole board off to get it.
     */
    wakeOnMail: boolean;
    /**
     * Agents that exist before there is anything to spawn them.
     *
     * Spawn/kill/resurrect are phase 5. Until then this is how a crew gets
     * anyone but the coordinator: the rows are created at startup if absent
     * and never overwritten, so an operator edit adds an agent without
     * disturbing the ones already running.
     */
    agents: Array<{ id: string; role: AgentRole }>;
  };

  /**
   * Armed conditions: `remindMe` and `watchPr`.
   *
   * Nothing here says which agent may arm what, because that is not a policy —
   * an agent may only arm conditions for itself, and it is the tool's closure
   * that makes it so rather than a setting somebody could widen. What is
   * configurable is how often the waker looks, and where it looks.
   *
   * There is no token here on purpose. `GITHUB_TOKEN` is a secret and lives in
   * the environment with the others (see config.ts); this file is committed.
   */
  armed: {
    /** Off means neither tool is offered and nothing polls. */
    enabled: boolean;
    /**
     * How often the waker looks for a condition that has come due.
     *
     * This is the resolution of a reminder, not the poll rate of a watch — a
     * watch carries its own interval and is simply skipped on ticks before it.
     * Reading a handful of indexed rows is cheap enough that the only reason
     * not to make this a second is that no reminder needs that precision.
     */
    tickSeconds: number;
    github: {
      /**
       * `owner/name` used when a `watchPr` call omits `repo`.
       *
       * Empty is legal and means every call must name one — which is the right
       * default for a deployment that watches several repositories, and the
       * wrong one for this deployment, which watches its own.
       */
      repo: string;
      /**
       * Seconds between polls of one watched pull request.
       *
       * A courtesy to a third party's API and not a limit on anything that
       * reaches an agent: one poll produces one mail naming everything it
       * found, however much that is. Two minutes against one repository and a
       * handful of pull requests is nowhere near GitHub's 5000/hour, and a
       * shorter interval buys nothing a human review cycle can perceive.
       */
      pollSeconds: number;
      /** Overridable for a test double or an Enterprise host. */
      apiBase: string;
    };
  };

  /**
   * What this instance publishes for the ops executor (`ops/`).
   *
   * The waker does not read anything from the executor and holds no privilege
   * of its own — this is one-way telemetry. The executor recreates containers,
   * and needs to know whether doing so right now would kill someone's live
   * turn; the waker is the only process that knows that.
   */
  status: {
    /**
     * Absolute path for the status file, or empty to publish nothing.
     *
     * MUST NOT live under `wake.spoolDir` or anywhere else bind-mounted into
     * the agent container. The whole point of the file is that a privileged
     * process trusts it, and the agent inside the container is exactly the
     * party that must not be able to write "I am idle, go ahead and recreate
     * me". `wake.spoolDir` is mounted read-write by design; this is one level
     * up, outside every mount in `docker/run-container.sh`. The ops config
     * loader re-checks the containment and refuses to start if it is violated.
     */
    file: string;
    /** Republish this often even when the live count has not moved. */
    intervalSeconds: number;
    /**
     * This deployment's instance name — the key under `instances:` in
     * ops-config.yaml, and the name the executor uses when it decides whose
     * container it is about to recreate. `clawcius`, `hamachi`.
     */
    instance: string;
  };
};

const DEFAULT_PROMPTS: PromptTemplates = {
  protocol: `## Speaking in Discord

You are in a Discord server. You are woken when messages arrive in a channel you
are part of, and when a wake you scheduled comes due.

Your ordinary text output is not shown to anyone — it is private scratch space.
Words reach Discord only when you run the \`discord\` CLI:

    {cli} reply -c <channel_id> -m <message_id> -t "..."

For long or multi-line bodies, omit \`-t\` and pipe the text on stdin:

    printf '%s' "$BODY" | {cli} reply -c <channel_id> -m <message_id>

\`reply\` threads under a specific message. \`send -c <channel_id>\` posts to the
channel without threading — use it when there is no message to reply to, such as
a scheduled wake. A skill documents the full CLI; read it before your first call
in a session.

Your working directory persists between wakes. Use it for notes and
intermediate work.

## Waking yourself later

\`schedule_wake\`, \`schedule_repeating\`, \`list_schedules\` and
\`cancel_schedule\` arrange for you to be woken in the future. The prompt you
supply is what your future self receives, so write it as a self-contained
instruction rather than a reference to the current conversation.

There are limits on how often and how many wakes you may schedule. A rejected
call says which limit it hit.`,

  roleNotice:
    'You are the team leader — the main agent for this channel. This wake is ' +
    'addressed to you; subagents you spawn are never woken this way.',

  messageWake: `{roleNotice}

{count} new {plural}:

{messages}

channel_id: {channelId}
latest message_id: {latestMessageId}

To reply to the latest:
  {cli} reply -c {channelId} -m {latestMessageId} -t "..."`,

  messageLine: '[{time}] {author}: {content}',

  scheduleWake: `{roleNotice}

Scheduled wake.

channel_id:  {channelId}
schedule_id: {scheduleId}
repeats:     {repeats}

Your instruction to yourself:
{prompt}

No message to reply to. To post:
  {cli} send -c {channelId} -t "..."`,

  mailWake: `checkMail →

{mail}`,
};

const DEFAULTS: AgentConfig = {
  container: {
    name: 'clawcius-agent',
    claudePath: '/usr/local/bin/claude',
    // Deliberately a sibling of `run/`, not a child. `run/` is the bind mount.
    execEnvDir: '/var/lib/clawcius/exec-env',
  },
  prompts: DEFAULT_PROMPTS,
  model: 'claude-opus-5',
  maxTurns: 0,
  systemPrompt: {
    useClaudeCodeDefault: true,
    append: '',
  },
  sessions: {
    maxConcurrent: 3,
    idleTimeoutMinutes: 0,
    workspaceRoot: '/var/lib/clawcius/workspaces',
  },
  discord: {
    allowedChannelIds: [],
    followUpWindowSeconds: 300,
    followUpChannelIds: [],
    alwaysOnChannelIds: [],
    bundleDebounceMs: 1500,
    bundleMaxWaitMs: 10000,
  },
  paths: {
    discordCli: '/home/npurcell/clawcius/discord-cli/discord',
    skillsDir: '/home/npurcell/clawcius/.claude',
  },
  git: {
    userName: 'Clawcius',
    userEmail: 'clawcius@users.noreply.github.com',
  },
  wake: {
    enabled: true,
    spoolDir: '/var/lib/clawcius/run/wake',
    maxPerHour: 30,
  },
  clawsky: {
    enabled: true,
    crew: 'clawcius',
    wakeOnMail: true,
    agents: [],
  },
  armed: {
    enabled: true,
    tickSeconds: 15,
    github: {
      repo: '',
      pollSeconds: 120,
      apiBase: 'https://api.github.com',
    },
  },
  status: {
    // Deliberately a sibling of `run/`, not a child. `run/` is the bind mount.
    file: '/var/lib/clawcius/waker-status.json',
    intervalSeconds: 20,
    instance: 'clawcius',
  },
};

class ConfigError extends Error {
  constructor(path: string, message: string) {
    super(`agent-config.yaml: ${path} ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(raw: unknown, path: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new ConfigError(path, 'must be a string');
  return raw;
}

function bool(raw: unknown, path: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') throw new ConfigError(path, 'must be true or false');
  return raw;
}

function num(raw: unknown, path: string, fallback: number, min: number, max?: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ConfigError(path, 'must be a number');
  }
  if (raw < min) throw new ConfigError(path, `must be >= ${min}`);
  if (max !== undefined && raw > max) throw new ConfigError(path, `must be <= ${max}`);
  return raw;
}

function oneOf<T extends string>(
  raw: unknown,
  path: string,
  fallback: T,
  allowed: readonly T[],
): T {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new ConfigError(path, `must be one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

function strList(raw: unknown, path: string, fallback: string[]): string[] {
  if (raw === undefined || raw === null) return fallback;
  if (!Array.isArray(raw)) throw new ConfigError(path, 'must be a list');
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') throw new ConfigError(`${path}[${index}]`, 'must be a string');
    return entry;
  });
}

/** `hamachi-engineer1` — lowercase, and prefixed with the crew that owns it. */
export const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The pre-spawn agent list.
 *
 * The crew prefix is enforced rather than assumed: an agent id is a handle
 * people and other agents type, mail is addressed to it, and a `hamachi-`
 * agent registered in the `clawcius` crew would be a DM boundary that reads
 * one way and behaves another.
 */
function agentList(
  raw: unknown,
  path: string,
  crew: string,
): Array<{ id: string; role: AgentRole }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError(path, 'must be a list');

  return raw.map((entry, index) => {
    const where = `${path}[${index}]`;
    if (!isRecord(entry)) throw new ConfigError(where, 'must be a mapping with id and role');

    const id = entry['id'];
    if (typeof id !== 'string' || !AGENT_ID.test(id)) {
      throw new ConfigError(`${where}.id`, 'must be a lowercase identifier, e.g. hamachi-engineer1');
    }
    if (!id.startsWith(`${crew}-`)) {
      throw new ConfigError(`${where}.id`, `must start with "${crew}-" — it belongs to that crew`);
    }

    const role = entry['role'];
    if (typeof role !== 'string' || !isAgentRole(role)) {
      throw new ConfigError(`${where}.role`, `must be one of: ${AGENT_ROLES.join(', ')}`);
    }

    return { id, role };
  });
}

/**
 * A prompt template, with its placeholders checked against what the renderer
 * will actually supply.
 *
 * Failing here rather than at render time is the point: an unknown placeholder
 * would otherwise reach the model as a literal `{chanel_id}`, which looks like
 * the agent misread something rather than like a config typo.
 */
function template(raw: unknown, key: keyof PromptTemplates, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new ConfigError(`prompts.${key}`, 'must be a string');

  const allowed = new Set(PROMPT_PLACEHOLDERS[key]);
  const used = [...raw.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1] as string);
  const unknown = [...new Set(used)].filter((name) => !allowed.has(name));

  if (unknown.length > 0) {
    throw new ConfigError(
      `prompts.${key}`,
      `uses unknown placeholder${unknown.length > 1 ? 's' : ''} ` +
        `${unknown.map((u) => `{${u}}`).join(', ')}. ` +
        `Available here: ${[...allowed].map((a) => `{${a}}`).join(', ')}`,
    );
  }
  return raw;
}

function section(raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ConfigError(path, 'must be a mapping');
  return raw;
}

/**
 * Is `child` inside `parent`? Both must already be resolved.
 *
 * A prefix test *with* the trailing separator, because the naive
 * `startsWith(parent)` calls `/var/lib/clawcius-ops` a child of
 * `/var/lib/clawcius`. Same helper, same reasoning, as `isInside` in
 * `ops/src/config.ts` — the two files check different configs on different
 * sides of the boundary and neither can import the other.
 */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Host paths that `docker/run-container.sh` bind-mounts into the agent
 * container, as far as this file can know them.
 *
 * NOT exhaustive, and the gap is worth naming: the script also mounts
 * `<stateDir>/agent-home`, `gws-cli` and the Google service-account key, none
 * of which appear in this config at all. So this catches the plausible
 * mistakes (a path written under the workspaces root, or under `run/`) and
 * cannot catch every one. The defence that does not depend on enumeration is
 * the default value, which is a sibling of the mounts rather than a child.
 */
function bindMountedPaths(config: AgentConfig): Array<[string, string]> {
  return [
    ['sessions.workspaceRoot', config.sessions.workspaceRoot],
    // The script mounts `<stateDir>/run`, the PARENT of the wake spool — the
    // spool rides along inside that one mount rather than having its own. So
    // checking against wake.spoolDir alone would wave through a path that is
    // its sibling and just as reachable from the container.
    ['the directory containing wake.spoolDir', dirname(config.wake.spoolDir)],
    ['paths.skillsDir', config.paths.skillsDir],
    ['the directory containing paths.discordCli', dirname(config.paths.discordCli)],
  ];
}

export function loadAgentConfig(configPath?: string): AgentConfig {
  const path = resolve(configPath ?? process.env['AGENT_CONFIG_PATH'] ?? 'agent-config.yaml');

  if (!existsSync(path)) {
    throw new Error(
      `Agent config not found at ${path}. ` +
        'Expected agent-config.yaml in the working directory, or set AGENT_CONFIG_PATH.',
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : error}`);
  }

  const root = section(parsed, 'root');
  const prompt = section(root['systemPrompt'], 'systemPrompt');
  const sessions = section(root['sessions'], 'sessions');
  const discord = section(root['discord'], 'discord');
  const paths = section(root['paths'], 'paths');
  const wake = section(root['wake'], 'wake');
  const clawsky = section(root['clawsky'], 'clawsky');
  const armed = section(root['armed'], 'armed');
  const armedGithub = section(armed['github'], 'armed.github');
  const status = section(root['status'], 'status');
  const git = section(root['git'], 'git');
  const prompts = section(root['prompts'], 'prompts');
  const container = section(root['container'], 'container');

  const config: AgentConfig = {
    container: {
      name: str(container['name'], 'container.name', DEFAULTS.container.name),
      claudePath: str(container['claudePath'], 'container.claudePath', DEFAULTS.container.claudePath),
      execEnvDir: str(
        container['execEnvDir'],
        'container.execEnvDir',
        DEFAULTS.container.execEnvDir,
      ),
    },
    prompts: {
      protocol: template(prompts['protocol'], 'protocol', DEFAULT_PROMPTS.protocol),
      roleNotice: template(prompts['roleNotice'], 'roleNotice', DEFAULT_PROMPTS.roleNotice),
      messageWake: template(prompts['messageWake'], 'messageWake', DEFAULT_PROMPTS.messageWake),
      messageLine: template(prompts['messageLine'], 'messageLine', DEFAULT_PROMPTS.messageLine),
      scheduleWake: template(prompts['scheduleWake'], 'scheduleWake', DEFAULT_PROMPTS.scheduleWake),
      mailWake: template(prompts['mailWake'], 'mailWake', DEFAULT_PROMPTS.mailWake),
    },
    model: str(root['model'], 'model', DEFAULTS.model),
    maxTurns: num(root['maxTurns'], 'maxTurns', DEFAULTS.maxTurns, 0),
    systemPrompt: {
      useClaudeCodeDefault: bool(
        prompt['useClaudeCodeDefault'],
        'systemPrompt.useClaudeCodeDefault',
        DEFAULTS.systemPrompt.useClaudeCodeDefault,
      ),
      append: str(prompt['append'], 'systemPrompt.append', DEFAULTS.systemPrompt.append),
    },
    sessions: {
      maxConcurrent: num(
        sessions['maxConcurrent'],
        'sessions.maxConcurrent',
        DEFAULTS.sessions.maxConcurrent,
        1,
      ),
      idleTimeoutMinutes: num(
        sessions['idleTimeoutMinutes'],
        'sessions.idleTimeoutMinutes',
        DEFAULTS.sessions.idleTimeoutMinutes,
        0,
      ),
      workspaceRoot: str(
        sessions['workspaceRoot'],
        'sessions.workspaceRoot',
        DEFAULTS.sessions.workspaceRoot,
      ),
    },
    discord: {
      allowedChannelIds: strList(
        discord['allowedChannelIds'],
        'discord.allowedChannelIds',
        DEFAULTS.discord.allowedChannelIds,
      ),
      followUpWindowSeconds: num(
        discord['followUpWindowSeconds'],
        'discord.followUpWindowSeconds',
        DEFAULTS.discord.followUpWindowSeconds,
        0,
      ),
      followUpChannelIds: strList(
        discord['followUpChannelIds'],
        'discord.followUpChannelIds',
        DEFAULTS.discord.followUpChannelIds,
      ),
      alwaysOnChannelIds: strList(
        discord['alwaysOnChannelIds'],
        'discord.alwaysOnChannelIds',
        DEFAULTS.discord.alwaysOnChannelIds,
      ),
      bundleDebounceMs: num(
        discord['bundleDebounceMs'],
        'discord.bundleDebounceMs',
        DEFAULTS.discord.bundleDebounceMs,
        0,
      ),
      bundleMaxWaitMs: num(
        discord['bundleMaxWaitMs'],
        'discord.bundleMaxWaitMs',
        DEFAULTS.discord.bundleMaxWaitMs,
        0,
      ),
    },
    paths: {
      discordCli: str(paths['discordCli'], 'paths.discordCli', DEFAULTS.paths.discordCli),
      skillsDir: str(paths['skillsDir'], 'paths.skillsDir', DEFAULTS.paths.skillsDir),
    },
    git: {
      userName: str(git['userName'], 'git.userName', DEFAULTS.git.userName),
      userEmail: str(git['userEmail'], 'git.userEmail', DEFAULTS.git.userEmail),
    },
    wake: {
      enabled: bool(wake['enabled'], 'wake.enabled', DEFAULTS.wake.enabled),
      spoolDir: str(wake['spoolDir'], 'wake.spoolDir', DEFAULTS.wake.spoolDir),
      maxPerHour: num(wake['maxPerHour'], 'wake.maxPerHour', DEFAULTS.wake.maxPerHour, 1),
    },
    clawsky: {
      enabled: bool(clawsky['enabled'], 'clawsky.enabled', DEFAULTS.clawsky.enabled),
      crew: str(clawsky['crew'], 'clawsky.crew', DEFAULTS.clawsky.crew),
      wakeOnMail: bool(clawsky['wakeOnMail'], 'clawsky.wakeOnMail', DEFAULTS.clawsky.wakeOnMail),
      agents: agentList(
        clawsky['agents'],
        'clawsky.agents',
        str(clawsky['crew'], 'clawsky.crew', DEFAULTS.clawsky.crew),
      ),
    },
    armed: {
      enabled: bool(armed['enabled'], 'armed.enabled', DEFAULTS.armed.enabled),
      tickSeconds: num(armed['tickSeconds'], 'armed.tickSeconds', DEFAULTS.armed.tickSeconds, 1, 3600),
      github: {
        repo: str(armedGithub['repo'], 'armed.github.repo', DEFAULTS.armed.github.repo),
        pollSeconds: num(
          armedGithub['pollSeconds'],
          'armed.github.pollSeconds',
          DEFAULTS.armed.github.pollSeconds,
          // A floor of 30s, not as a throttle but because below it the poll is
          // measuring GitHub's own cache rather than anything that happened.
          30,
          86_400,
        ),
        apiBase: str(armedGithub['apiBase'], 'armed.github.apiBase', DEFAULTS.armed.github.apiBase),
      },
    },
    status: {
      file: str(status['file'], 'status.file', DEFAULTS.status.file),
      intervalSeconds: num(
        status['intervalSeconds'],
        'status.intervalSeconds',
        DEFAULTS.status.intervalSeconds,
        1,
        3600,
      ),
      instance: str(status['instance'], 'status.instance', DEFAULTS.status.instance),
    },
  };

  if (
    config.discord.bundleDebounceMs > 0 &&
    config.discord.bundleMaxWaitMs < config.discord.bundleDebounceMs
  ) {
    throw new Error(
      'agent-config.yaml: discord.bundleMaxWaitMs must be >= discord.bundleDebounceMs — ' +
        'a lower ceiling would flush every bundle before the debounce could coalesce anything.',
    );
  }

  // The status file is read by a root process that will recreate containers on
  // the strength of it. Inside the spool directory it would be writable by the
  // agent, which is the party the executor is defending against — a container
  // that can publish `liveCount: 0` can talk a privileged process into
  // destroying a session mid-turn, or into overwriting a rollback decision.
  // Checked here as well as in the ops config loader; neither should be the
  // only place this is true.
  if (config.status.file) {
    if (!isAbsolute(config.status.file)) {
      throw new ConfigError('status.file', 'must be an absolute path');
    }
    const statusFile = resolve(config.status.file);
    // The wake spool is agent-writable by design — it is inside the bind mount
    // and that is the point of it — so it is the one directory this file must
    // not land in.
    const mounted = resolve(config.wake.spoolDir);
    if (statusFile === mounted || statusFile.startsWith(`${mounted}/`)) {
      throw new Error(
        `agent-config.yaml: status.file (${statusFile}) is inside wake.spoolDir ` +
          `(${mounted}), which is bind-mounted read-write into the agent container. ` +
          'The ops executor trusts this file when deciding whether recreating the ' +
          'container would kill a live turn; the agent must not be able to write it.',
      );
    }
  }

  // The exec env file holds DISCORD_TOKEN and GITHUB_TOKEN in plain text — it
  // exists precisely so they are not on a command line any more (#53), and
  // putting it inside a bind mount would trade a leak to every local account
  // for a leak to every container that shares the mount. Two of them are
  // shared by both deployments, so that is not hypothetical.
  //
  // Same shape as the status.file check above, and the same reason for being
  // here rather than trusted: the default is right by construction and the
  // override is the thing that can be wrong.
  if (!isAbsolute(config.container.execEnvDir)) {
    throw new ConfigError('container.execEnvDir', 'must be an absolute path');
  }
  const execEnvDir = resolve(config.container.execEnvDir);
  for (const [label, mount] of bindMountedPaths(config)) {
    if (isInside(execEnvDir, resolve(mount))) {
      throw new Error(
        `agent-config.yaml: container.execEnvDir (${execEnvDir}) is inside ${label} ` +
          `(${resolve(mount)}), which docker/run-container.sh bind-mounts into the agent ` +
          'container. That file holds this instance\'s Discord and GitHub tokens; it must ' +
          'not be reachable from inside any sandbox. Put it beside the state directory, ' +
          'not in it — the default is /var/lib/<instance>/exec-env.',
      );
    }
  }

  if (config.clawsky.enabled) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(config.clawsky.crew)) {
      throw new ConfigError(
        'clawsky.crew',
        'must be a short lowercase identifier — it prefixes every agent id in ' +
          'this crew and is compared as an exact string',
      );
    }
  }

  // Checked at startup rather than at arm time. This string is the default for
  // every `watchPr` call that omits a repository, so a typo here is a tool that
  // refuses every agent that trusts the default — at whatever hour one of them
  // first reaches for it.
  if (config.armed.github.repo && !REPO_NAME.test(config.armed.github.repo)) {
    throw new ConfigError('armed.github.repo', 'must be owner/name, e.g. NickPurcell/Clawcius');
  }

  if (!/^[a-z][a-z0-9-]{0,31}$/.test(config.status.instance)) {
    throw new ConfigError(
      'status.instance',
      'must be a short lowercase identifier — it is matched against the ' +
        'allowlist in ops-config.yaml, which only ever compares exact strings',
    );
  }

  return config;
}
