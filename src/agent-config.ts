import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { AGENT_ROLES, type AgentRole } from './store.js';
import { REPO_NAME } from './github.js';

/** Every piece of text the agent receives from us, as templates. */
export type PromptTemplates = {
  protocol: string;
  roleNotice: string;
  /** Used instead of `roleNotice` when the row carries a role outside `AgentRole`. */
  roleNoticeUnknown: string;
  messageWake: string;
  messageLine: string;
  mailWake: string;
  spawnCharter: string;
};

/** Placeholders each template may use. Anything else is a startup error. */
export const PROMPT_PLACEHOLDERS: Record<keyof PromptTemplates, readonly string[]> = {
  protocol: ['cli'],
  roleNotice: ['id', 'crew', 'role'],
  roleNoticeUnknown: ['id', 'crew', 'role'],
  messageWake: ['count', 'plural', 'messages', 'channelId', 'latestMessageId', 'cli'],
  messageLine: ['time', 'author', 'authorId', 'messageId', 'content'],
  mailWake: ['mail', 'count', 'plural'],
  spawnCharter: ['id', 'role', 'crew', 'spawnedBy', 'instructions'],
};

const MAIL_WAKE = 'checkMail →\n\n{mail}';

const SPAWN_CHARTER = `You are {id}, a {role} of crew {crew}, spawned by {spawnedBy}. Your brief is below.

{instructions}

When you are done or blocked, DM {spawnedBy} and say which in the first line.
If work is still in motion when your turn ends, arm \`remindMe\` before it ends.
Push the branch, open the pull request or file the issue before you stop; nothing asks you first.`;

export type AgentConfig = {
  crew: string;
  /** The crew's name as it says it — `Clawcius`, `Hamachi`. */
  displayName: string;
  container: {
    /** Off means the crew's sessions run on the host rather than in the sandbox. */
    enabled: boolean;
    name: string;
    /** In-container path to the claude binary. */
    claudePath: string;
    loginCommand: string[];
    stateDir: string;
    /** The Claude config dir: bind-mounted into the container, or CLAUDE_CONFIG_DIR without one. */
    agentHome: string;
    /** Where the per-exec `--env-file` is written (src/container.ts). */
    execEnvDir: string;
    /** Holds the App installation token for agents; mounted READ-ONLY. */
    githubTokenDir: string;
  };
  prompts: PromptTemplates;
  model: string;
  modelByRole: Readonly<Partial<Record<AgentRole, string>>>;
  /** 0 means unlimited — no turn cap is sent to the SDK at all. */
  maxTurns: number;
  systemPrompt: {
    /** Run with Claude Code's own system prompt as the base. */
    useClaudeCodeDefault: boolean;
    append: string;
  };
  sessions: {
    maxConcurrent: number;
    /** 0 means never evict. */
    idleTimeoutMinutes: number;
    workspaceRoot: string;
  };
  discord: {
    allowedChannelIds: string[];
    /** After the bot is addressed, seconds during which ordinary messages in that channel also reach the agent. */
    followUpWindowSeconds: number;
    /** Channels where a follow-up window may open at all. Empty means every channel. */
    followUpChannelIds: string[];
    /** Channels where every message wakes the agent, with no mention required. */
    alwaysOnChannelIds: string[];
    bundleDebounceMs: number;
    /** Ceiling from the first message in a bundle, so typing cannot defer forever. */
    bundleMaxWaitMs: number;
  };
  paths: {
    discordCli: string;
    skillsDir: string;
    claudeCli: string;
  };
  git: {
    userName: string;
    userEmail: string;
  };
  clawsky: {
    /** Off means no `checkMail` or `sendMail` tool is offered to any session. */
    enabled: boolean;
    crew: string;
    /** Mail delivered to an idle agent starts a turn. */
    wakeOnMail: boolean;
    /** Agents that exist before there is anything to spawn them. */
    agents: Array<{ id: string; role: AgentRole }>;
  };
  armed: {
    /** Off means none of the armed tools is offered and nothing polls. */
    enabled: boolean;
    tickSeconds: number;
    github: {
      /** `owner/name` used when a `watchPr` call omits `repo`. */
      repo: string;
      pollSeconds: number;
      apiBase: string;
    };
  };
  status: {
    /** Absolute path for the status file. Must not live anywhere bind-mounted into the agent container. */
    file: string;
    intervalSeconds: number;
    instance: string;
  };
};

const CREW_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** What an instance file may carry, and nothing else. */
const Instance = z.strictObject({
  extends: z
    .string({ error: 'instance files must extend the base' })
    .min(1, { error: 'instance files must extend the base' }),
  crew: z.string().regex(CREW_NAME, {
    error: 'must be a short lowercase identifier: it prefixes every agent id in the crew',
  }),
  displayName: z.string().min(1).optional(),
  discord: z
    .strictObject({
      allowedChannelIds: z.array(z.string()).min(1, { error: 'must name at least one channel' }),
      followUpChannelIds: z.array(z.string()).default([]),
      alwaysOnChannelIds: z.array(z.string()).default([]),
    }),
  container: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
});

const Base = z.strictObject({
  prompts: z.strictObject({
    protocol: z.string(),
    roleNotice: z.string(),
    roleNoticeUnknown: z.string(),
    messageWake: z.string(),
    messageLine: z.string(),
  }),
  container: z.strictObject({
    claudePath: z.string().min(1),
    loginCommand: z.array(z.string().min(1)).min(1),
  }),
  model: z.string().min(1),
  modelByRole: z.partialRecord(z.enum(AGENT_ROLES), z.string().min(1)),
  maxTurns: z.number().min(0),
  systemPrompt: z.strictObject({ useClaudeCodeDefault: z.boolean(), append: z.string() }),
  sessions: z.strictObject({
    maxConcurrent: z.number().min(1),
    idleTimeoutMinutes: z.number().min(0),
  }),
  discord: z
    .strictObject({
      followUpWindowSeconds: z.number().min(0),
      bundleDebounceMs: z.number().min(0),
      bundleMaxWaitMs: z.number().min(0),
    })
    .refine((d) => d.bundleDebounceMs === 0 || d.bundleMaxWaitMs >= d.bundleDebounceMs, {
      path: ['bundleMaxWaitMs'],
      error: 'must be >= bundleDebounceMs',
    }),
  paths: z.strictObject({
    discordCli: z.string().min(1),
    skillsDir: z.string().min(1),
    claudeCli: z.string().min(1),
  }),
  clawsky: z.strictObject({
    enabled: z.boolean(),
    wakeOnMail: z.boolean(),
    agents: z.array(z.strictObject({ id: z.string().regex(AGENT_ID), role: z.enum(AGENT_ROLES) })),
  }),
  armed: z.strictObject({
    enabled: z.boolean(),
    tickSeconds: z.number().min(1).max(3600),
    github: z.strictObject({
      repo: z.string().regex(REPO_NAME, { error: 'must be owner/name' }).or(z.literal('')),
      pollSeconds: z.number().min(30).max(86_400),
      apiBase: z.string().min(1),
    }),
  }),
  status: z.strictObject({ intervalSeconds: z.number().min(1).max(3600) }),
});

function dotted(path: PropertyKey[]): string {
  return path
    .map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`))
    .join('');
}

/** Parse `raw` against `schema`; an error names the file and every offending key. */
function check<S extends z.ZodType>(schema: S, raw: unknown, file: string): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const lines = result.error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => `${dotted([...issue.path, key])}: not a key this file may carry`);
    }
    const message =
      issue.code === 'invalid_key'
        ? issue.issues.map((inner) => inner.message).join('; ')
        : issue.message;
    return [`${dotted(issue.path) || 'root'}: ${message}`];
  });
  throw new Error(`${file}: ${lines.join('\n  ')}`);
}

function readYaml(file: string): unknown {
  return parse(readFileSync(file, 'utf8'));
}

function refuseUnknownPlaceholders(
  file: string,
  key: string,
  text: string,
  pattern: RegExp,
  allowed: readonly string[],
  wrap: (name: string) => string,
): void {
  const used = new Set([...text.matchAll(pattern)].map((m) => m[1] as string));
  const unknown = [...used].filter((name) => !allowed.includes(name));
  if (unknown.length === 0) return;
  throw new Error(
    `${file}: ${key} uses unknown placeholder${unknown.length > 1 ? 's' : ''} ` +
      `${unknown.map(wrap).join(', ')}. Available here: ${allowed.map(wrap).join(', ')}`,
  );
}

/** `{{Crew}}` becomes the display name; any other `{{x}}` is refused. Single braces are prose. */
function substituteCrew(text: string, displayName: string, file: string, key: string): string {
  refuseUnknownPlaceholders(file, key, text, /\{\{([^}\n]*)\}\}/g, ['Crew'], (n) => `{{${n}}}`);
  return text.split('{{Crew}}').join(displayName);
}

function deriveInstancePaths(crew: string, displayName: string) {
  const stateDir = `/var/lib/${crew}`;
  return {
    containerName: `${crew}-agent`,
    stateDir,
    execEnvDir: join(stateDir, 'exec-env'),
    agentHome: join(stateDir, 'agent-home'),
    githubTokenDir: join(stateDir, 'github-token'),
    workspaceRoot: join(stateDir, 'workspaces'),
    statusFile: join(stateDir, 'waker-status.json'),
    statusInstance: crew,
    gitUserName: displayName,
    gitUserEmail: `${crew}@users.noreply.github.com`,
  };
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

export function loadAgentConfig(configPath?: string): AgentConfig {
  const instanceFile = resolve(
    configPath ?? process.env['AGENT_CONFIG_PATH'] ?? 'agent-config.yaml',
  );
  const instance = check(Instance, readYaml(instanceFile), instanceFile);
  const baseFile = resolve(dirname(instanceFile), instance.extends);
  const base = check(Base, readYaml(baseFile), baseFile);

  const { crew } = instance;
  const displayName = instance.displayName ?? crew[0]!.toUpperCase() + crew.slice(1);
  const derived = deriveInstancePaths(crew, displayName);

  const prompts: PromptTemplates = {
    ...base.prompts,
    mailWake: MAIL_WAKE,
    spawnCharter: SPAWN_CHARTER,
  };
  for (const [key, text] of Object.entries(prompts) as Array<[keyof PromptTemplates, string]>) {
    refuseUnknownPlaceholders(
      baseFile,
      `prompts.${key}`,
      text,
      /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,
      PROMPT_PLACEHOLDERS[key],
      (n) => `{${n}}`,
    );
  }

  for (const { id } of base.clawsky.agents) {
    if (!id.startsWith(`${crew}-`)) {
      throw new Error(`${baseFile}: clawsky.agents id "${id}" must start with "${crew}-"`);
    }
  }

  const skillsDir = resolve(base.paths.skillsDir);
  const discordCli = resolve(base.paths.discordCli);
  // What docker/run-container.sh bind-mounts into the agent container.
  const mounts: Array<[string, string]> = [
    ['<stateDir>/workspaces, bind-mounted read-write', join(derived.stateDir, 'workspaces')],
    ['<stateDir>/agent-home, bind-mounted read-write', derived.agentHome],
    ['paths.skillsDir', skillsDir],
    ['the directory containing paths.discordCli', dirname(discordCli)],
    ['container.githubTokenDir', derived.githubTokenDir],
  ];
  // What the sandbox must not be able to write: the status file the deploy trusts, and the two credential directories.
  const guarded: Array<[string, string]> = [
    ['status.file', derived.statusFile],
    ['container.execEnvDir', derived.execEnvDir],
    ['container.githubTokenDir', derived.githubTokenDir],
  ];
  for (const [what, dir] of guarded) {
    for (const [label, mount] of mounts) {
      if (label !== what && isInside(dir, mount)) {
        throw new Error(
          `${baseFile}: ${what} (${dir}) is inside ${label} (${mount}), which ` +
            'docker/run-container.sh bind-mounts into the agent container',
        );
      }
    }
  }

  return {
    crew,
    displayName,
    container: {
      enabled: instance.container.enabled,
      name: derived.containerName,
      claudePath: base.container.claudePath,
      loginCommand: base.container.loginCommand,
      stateDir: derived.stateDir,
      agentHome: derived.agentHome,
      execEnvDir: derived.execEnvDir,
      githubTokenDir: derived.githubTokenDir,
    },
    prompts,
    model: base.model,
    modelByRole: base.modelByRole,
    maxTurns: base.maxTurns,
    systemPrompt: {
      useClaudeCodeDefault: base.systemPrompt.useClaudeCodeDefault,
      append: substituteCrew(base.systemPrompt.append, displayName, baseFile, 'systemPrompt.append'),
    },
    sessions: { ...base.sessions, workspaceRoot: derived.workspaceRoot },
    discord: { ...base.discord, ...instance.discord },
    paths: { discordCli, skillsDir, claudeCli: resolve(base.paths.claudeCli) },
    git: { userName: derived.gitUserName, userEmail: derived.gitUserEmail },
    clawsky: { ...base.clawsky, crew },
    armed: base.armed,
    status: {
      file: derived.statusFile,
      intervalSeconds: base.status.intervalSeconds,
      instance: derived.statusInstance,
    },
  };
}
