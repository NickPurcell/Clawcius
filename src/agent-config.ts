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

export type AgentConfig = {
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
  scheduling: {
    /** Expose the self-wake tools to the agent at all. */
    enabled: boolean;
    /** Floor on any delay — stops the agent building a tight wake loop. */
    minDelaySeconds: number;
    /** Cap on pending schedules per channel. */
    maxPending: number;
    /** Cap on fires per channel per rolling 24h. */
    maxWakesPerDay: number;
  };
};

const DEFAULTS: AgentConfig = {
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
  scheduling: {
    enabled: true,
    minDelaySeconds: 60,
    maxPending: 20,
    maxWakesPerDay: 48,
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
  const scheduling = section(root['scheduling'], 'scheduling');

  const config: AgentConfig = {
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
    scheduling: {
      enabled: bool(scheduling['enabled'], 'scheduling.enabled', DEFAULTS.scheduling.enabled),
      minDelaySeconds: num(
        scheduling['minDelaySeconds'],
        'scheduling.minDelaySeconds',
        DEFAULTS.scheduling.minDelaySeconds,
        1,
      ),
      maxPending: num(
        scheduling['maxPending'], 'scheduling.maxPending', DEFAULTS.scheduling.maxPending, 1,
      ),
      maxWakesPerDay: num(
        scheduling['maxWakesPerDay'],
        'scheduling.maxWakesPerDay',
        DEFAULTS.scheduling.maxWakesPerDay,
        1,
      ),
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
