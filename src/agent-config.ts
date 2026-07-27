/**
 * Agent behaviour, loaded from `agent-config.yaml`.
 *
 * The split with `.env` is deliberate: the environment carries only secrets and
 * deployment identity, everything describing how the agent *behaves* lives in
 * version-controllable YAML. Changing the agent's personality should be a diff,
 * not an edit to a file full of tokens.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

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
 * Which proxy enforces the egress allowlist for sandboxed commands.
 *
 * Both modes are enforcing, and for the same reason: the SDK sandbox runs the
 * agent under `bwrap --unshare-net`, so it has no route to the internet at all
 * and the only reachable endpoint is a socat bridge to the proxy. The choice
 * below is only *which* proxy sits on the far end of that bridge.
 *
 * - `sdk`   — the SDK's own in-process HTTP proxy. Zero setup, allowlist comes
 *             straight from `allowedDomains`.
 * - `squid` — an external Squid. The SDK skips starting its own proxy and
 *             bridges to Squid instead. Buys real access logs, SSRF/pivot
 *             guards, and an allowlist reviewable outside this process.
 */
export type EgressMode = 'sdk' | 'squid';

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
};

/** Placeholders each template may use. Anything else is a startup error. */
export const PROMPT_PLACEHOLDERS: Record<keyof PromptTemplates, readonly string[]> = {
  protocol: ['cli'],
  roleNotice: [],
  messageWake: ['count', 'plural', 'messages', 'channelId', 'latestMessageId', 'cli', 'roleNotice'],
  messageLine: ['time', 'author', 'authorId', 'messageId', 'content'],
  scheduleWake: ['channelId', 'scheduleId', 'repeats', 'prompt', 'cli', 'roleNotice'],
};

/**
 * Where the agent process runs.
 *
 * - `container` — inside the persistent gVisor container. The whole agent is
 *   contained, every tool included, and its daemons and cron jobs survive
 *   between turns.
 * - `host` — as a local child process, with the SDK's per-bash-command bwrap
 *   sandbox. Retained only for debugging; it confines shell commands and
 *   nothing else.
 */
export type AgentRuntime = 'container' | 'host';

export type AgentConfig = {
  runtime: AgentRuntime;
  container: {
    name: string;
    /** In-container path to the claude binary. */
    claudePath: string;
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
  sandbox: {
    enabled: boolean;
    allowedDomains: string[];
    weakerNested: boolean;
    egress: {
      mode: EgressMode;
      /** Host port Squid listens on. Only consulted when mode is `squid`. */
      httpProxyPort: number;
      /**
       * The squid.conf whose allowlist must match `allowedDomains`. Preflight
       * parses it and refuses to start on drift — the two lists are enforced
       * by different proxies and a gap between them is a hole.
       */
      confPath: string;
    };
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
  rules: {
    /** Deterministic message automation, evaluated before any LLM wake. */
    enabled: boolean;
    /** Hot-reloaded on write. Absent file simply means no automation. */
    path: string;
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
};

const DEFAULTS: AgentConfig = {
  runtime: 'container',
  container: {
    name: 'clawcius-agent',
    claudePath: '/usr/local/bin/claude',
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
  sandbox: {
    enabled: true,
    allowedDomains: [
      'api.anthropic.com',
      // Required — this is how the agent replies. Without it the agent runs
      // fine and can never say anything.
      'discord.com',
      'registry.npmjs.org',
      'pypi.org',
      'files.pythonhosted.org',
      'github.com',
      'api.github.com',
      'objects.githubusercontent.com',
    ],
    weakerNested: false,
    egress: {
      // `sdk` keeps the previously-working path as the default. Switching to
      // `squid` requires Squid to be installed and running first — see
      // squid/README.md.
      mode: 'sdk',
      httpProxyPort: 3128,
      confPath: '/home/npurcell/clawcius/squid/squid.conf',
    },
  },
  discord: {
    allowedChannelIds: [],
    followUpWindowSeconds: 300,
    bundleDebounceMs: 1500,
    bundleMaxWaitMs: 10000,
  },
  paths: {
    discordCli: '/home/npurcell/clawcius/discord-cli/discord',
    skillsDir: '/home/npurcell/clawcius/.claude',
  },
  rules: {
    enabled: true,
    path: '/home/npurcell/clawcius/rules.yaml',
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
  const sandbox = section(root['sandbox'], 'sandbox');
  const egress = section(sandbox['egress'], 'sandbox.egress');
  const discord = section(root['discord'], 'discord');
  const paths = section(root['paths'], 'paths');
  const wake = section(root['wake'], 'wake');
  const git = section(root['git'], 'git');
  const rules = section(root['rules'], 'rules');
  const prompts = section(root['prompts'], 'prompts');
  const container = section(root['container'], 'container');

  const config: AgentConfig = {
    runtime: oneOf(root['runtime'], 'runtime', DEFAULTS.runtime, ['container', 'host'] as const),
    container: {
      name: str(container['name'], 'container.name', DEFAULTS.container.name),
      claudePath: str(container['claudePath'], 'container.claudePath', DEFAULTS.container.claudePath),
    },
    prompts: {
      protocol: template(prompts['protocol'], 'protocol', DEFAULT_PROMPTS.protocol),
      roleNotice: template(prompts['roleNotice'], 'roleNotice', DEFAULT_PROMPTS.roleNotice),
      messageWake: template(prompts['messageWake'], 'messageWake', DEFAULT_PROMPTS.messageWake),
      messageLine: template(prompts['messageLine'], 'messageLine', DEFAULT_PROMPTS.messageLine),
      scheduleWake: template(prompts['scheduleWake'], 'scheduleWake', DEFAULT_PROMPTS.scheduleWake),
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
    sandbox: {
      enabled: bool(sandbox['enabled'], 'sandbox.enabled', DEFAULTS.sandbox.enabled),
      allowedDomains: strList(
        sandbox['allowedDomains'],
        'sandbox.allowedDomains',
        DEFAULTS.sandbox.allowedDomains,
      ),
      weakerNested: bool(
        sandbox['weakerNested'],
        'sandbox.weakerNested',
        DEFAULTS.sandbox.weakerNested,
      ),
      egress: {
        mode: oneOf(egress['mode'], 'sandbox.egress.mode', DEFAULTS.sandbox.egress.mode, [
          'sdk',
          'squid',
        ]),
        httpProxyPort: num(
          egress['httpProxyPort'],
          'sandbox.egress.httpProxyPort',
          DEFAULTS.sandbox.egress.httpProxyPort,
          1,
          65535,
        ),
        confPath: str(
          egress['confPath'],
          'sandbox.egress.confPath',
          DEFAULTS.sandbox.egress.confPath,
        ),
      },
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
    rules: {
      enabled: bool(rules['enabled'], 'rules.enabled', DEFAULTS.rules.enabled),
      path: str(rules['path'], 'rules.path', DEFAULTS.rules.path),
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

  if (config.runtime === 'container' && config.sandbox.enabled) {
    throw new Error(
      'agent-config.yaml: runtime is "container" but sandbox.enabled is true.\n' +
        '  The SDK sandbox wraps each bash command in bwrap. Inside gVisor that is\n' +
        '  redundant — the whole agent is already contained — and it cannot work:\n' +
        '  apply-seccomp needs a nested user namespace, which AppArmor denies here.\n' +
        '  Set sandbox.enabled: false. Egress is enforced by the container network.',
    );
  }

  if (config.sandbox.enabled && !config.sandbox.allowedDomains.includes('discord.com')) {
    // Worth failing loudly: the agent would start, run, and be unable to reply,
    // which is a confusing thing to debug from the Discord side.
    throw new Error(
      'agent-config.yaml: sandbox.allowedDomains must include "discord.com" — ' +
        'without it the agent cannot send messages.',
    );
  }

  if (config.sandbox.egress.mode === 'squid' && !config.sandbox.enabled) {
    // This is the failure this whole feature exists to avoid.
    //
    // Squid only *enforces* because the SDK sandbox puts the agent in a network
    // namespace with no route, leaving the bridge to Squid as the only way out.
    // With sandbox.enabled false there is no namespace, the agent keeps full
    // direct connectivity, and HTTP_PROXY becomes a suggestion it can ignore
    // with `unset HTTPS_PROXY` or `curl --noproxy '*'`.
    //
    // That configuration looks like egress control in `!status` and in the
    // config file while providing none, which is worse than running with no
    // proxy at all. Refuse it rather than let it be believed.
    throw new Error(
      'agent-config.yaml: sandbox.egress.mode is "squid" but sandbox.enabled is false. ' +
        'Squid only enforces in combination with the SDK sandbox, which is what removes ' +
        "the agent's direct route to the network. Without it the proxy is advisory and " +
        'the agent can bypass it trivially. Set sandbox.enabled: true, or set ' +
        'sandbox.egress.mode: sdk.',
    );
  }

  return config;
}
