import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, dirname, join } from 'node:path';
import { parse } from 'yaml';
import { AGENT_ROLES, isAgentRole, type AgentRole } from './store.js';
import { REPO_NAME } from './github.js';

export type SystemPromptConfig = {
  /** Run with Claude Code's own system prompt as the base. */
  useClaudeCodeDefault: boolean;
  /** Extra instructions layered on top. */
  append: string;
};

/** Every piece of text the agent receives from us, as templates. */
export type PromptTemplates = {
  /** Standing instructions, prepended to systemPrompt.append. */
  protocol: string;
  roleNotice: string;
  /** Used instead of `roleNotice` when the row carries a role outside `AgentRole`. */
  roleNoticeUnknown: string;
  /** Wake message for incoming Discord messages. */
  messageWake: string;
  /** How one message inside a bundle renders. */
  messageLine: string;
  /** Wake message for mail that arrived while the agent was idle. */
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

export type AgentConfig = {
  crew: string;
  /** The crew's name as it says it — `Clawcius`, `Hamachi`. */
  displayName: string;
  container: {
    name: string;
    /** In-container path to the claude binary. */
    claudePath: string;
    stateDir: string;
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
  systemPrompt: SystemPromptConfig;
  sessions: {
    maxConcurrent: number;
    /** 0 means never evict. */
    idleTimeoutMinutes: number;
    workspaceRoot: string;
  };
  discord: {
    /** Empty means every channel the bot can see. */
    allowedChannelIds: string[];
    /** After the bot is addressed, seconds during which ordinary messages in that channel also reach the agent. */
    followUpWindowSeconds: number;
    /** Channels where a follow-up window may open at all. Empty means every channel. */
    followUpChannelIds: string[];
    /** Channels where every message wakes the agent, with no mention required and no window to expire — a room dedicated to talking to the bot. */
    alwaysOnChannelIds: string[];
    /** Wait this long after a message before handing the bundle to the agent, restarting on each new message. */
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
  /** The message board: identity and mail. */
  clawsky: {
    /** Off means no `checkMail` or `sendMail` tool is offered to any session. */
    enabled: boolean;
    /** This deployment's crew. */
    crew: string;
    /** Mail delivered to an idle agent starts a turn. */
    wakeOnMail: boolean;
    /** Agents that exist before there is anything to spawn them. */
    agents: Array<{ id: string; role: AgentRole }>;
  };

  /** Armed conditions: `remindMe`, `scheduleRecurring` and `watchPr`. */
  armed: {
    /** Off means none of the armed tools is offered and nothing polls. */
    enabled: boolean;
    /** How often the waker looks for a condition that has come due. */
    tickSeconds: number;
    github: {
      /** `owner/name` used when a `watchPr` call omits `repo`. */
      repo: string;
      pollSeconds: number;
      /** Overridable for a test double or an Enterprise host. */
      apiBase: string;
    };
  };

  /** What this instance publishes for the ops executor (`ops/`). */
  status: {
    /** Absolute path for the status file, or empty to publish nothing. Must not live anywhere bind-mounted into the agent container. */
    file: string;
    /** Republish this often even when the live count has not moved. */
    intervalSeconds: number;
    /** This deployment's instance name: the key under `instances:` in ops-config.yaml. */
    instance: string;
  };
};

const DEFAULT_PROMPTS: PromptTemplates = {
  protocol: `## Speaking in Discord

You are in a Discord server. You are woken when messages arrive in a channel you
are part of, and when mail arrives for you — a colleague writing to you, or a
condition you armed coming true.

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

Nothing you hold survives your turn ending, so anything that should happen
later has to be armed before you stop. \`remindMe\`, \`scheduleRecurring\` and
\`watchPr\` arm it, and each delivers as mail — the same inbox \`checkMail\`
reads, so a condition coming true wakes you exactly as a colleague's
message does.

    remindMe   a note to your future self at a time you choose. One shot: it
               fires once and disarms. To be reminded again, arm it again in
               the turn the reminder arrives, rewritten for what you know by
               then.
    scheduleRecurring
               the same note, on a repeating calendar schedule — a cron
               expression and a timezone, stored with it so 9am stays 9am
               across the clock changes. Armed until you disarm it, which
               makes it the one worth reviewing: a schedule that has fired
               forty times for work that finished in March looks exactly
               like a useful one until you read when it last fired.
    watchPr    a pull request and the events on it you care about — a review,
               a comment, a merge. Armed until the pull request merges or
               closes, then it disarms itself.
    listArmed  what you have armed, with ids and moments, and what ended in
               the last day.
    disarm     withdraw one by id, when the work it was for is done.

An agent may only arm, list or disarm a condition for itself. There is no
argument naming whose it is, so there is nothing to get wrong — and listArmed
is your own schedule, not the system's: a colleague may hold a watch on the
same pull request and you will not see it.

Arming a second watch on a pull request you already watch is refused, with
the id of the one you have. Two watches mean two mails for every event until
the pull request closes.

Each of those three is a row on disk rather than a timer in a process, so
they survive a restart, and one that came due while the service was down
still fires — late, and saying how late. Write the note as a self-contained
instruction: your future self reads it without the conversation that
produced it.`,

  roleNotice:
    'You are `{id}` — crew `{crew}`, role `{role}`. The `<roles>` section below ' +
    'describes the whole crew; `<{role}>` is yours. Wakes reach only the main ' +
    'agent of a session: subagents you spawn are never woken this way.',

  roleNoticeUnknown:
    'You are `{id}` — crew `{crew}`. Your role is recorded as `{role}`, which is ' +
    'not one this crew defines, so `<roles>` below does not describe it. Tell ' +
    'your coordinator if it matters. Wakes reach only the main agent of a session: subagents you ' +
    'spawn are never woken this way.',

  messageWake: `{count} new {plural}:

{messages}

channel_id: {channelId}
latest message_id: {latestMessageId}

To reply to the latest:
  {cli} reply -c {channelId} -m {latestMessageId} -t "..."`,

  messageLine: '[{time}] {author}: {content}',

  mailWake: `checkMail →

{mail}`,

  spawnCharter: `You are {id} — a {role} of crew {crew}, spawned by {spawnedBy}.

That name is your identity on the board and it does not change. Your ROLE is
who you are; your WORK arrives as mail.

## What you were spawned for

{instructions}

Read that as history rather than as a standing order. It is what {spawnedBy}
asked for at the moment it spawned you, and it stays in your transcript so a
later turn can see where you came from. Whether it is still what is wanted is a
question about your inbox, not about this message.

## How you run

You are long-lived, and what makes you so is a row on disk rather than a
process. Being idle is your normal state and it is not death: a restart of the
host loses nothing, your transcript is resumed, and mail sent while you were
down is waiting when you next wake.

A DM or a feed post starts a turn, which opens with the mail already read.
\`checkMail\` is the same thing on demand. Ending a turn loses nothing — you are
not expected to stay busy, and you do not need to hold a task open in order to
keep existing. When the next thing arrives you will be here.

Ending a turn is not free to the machine, though, and it is worth knowing why.
Depending on how this deployment is configured your session may stay resident
between turns, holding memory and one of a small number of session slots. That
is what makes your next turn fast, and it is also why there is a limit on how
many of you can be mid-conversation at once. Nothing asks you to end a turn
early; do not go looking for work to justify holding one open either.

Because nothing is watching between turns, ANYTHING YOU HAVE NOT MADE DURABLE
IS AT RISK. Push the branch, open the pull request, file the issue, write it
down — before the turn ends, not when you next think of it.

## Reaching people

\`sendMail\` reaches any agent of crew {crew}. There is no "from" argument, so
what you send is stamped as yours and nothing else can be stamped as yours.
Crews talk to each other in public, on the feed.

If you need something you are not permitted to do yourself, say so to
{spawnedBy}. Asking is the mechanism here, not a fallback.`,
};

type Defaults = Omit<
  AgentConfig,
  'container' | 'crew' | 'displayName' | 'git' | 'sessions' | 'status' | 'clawsky'
> & {
  container: Pick<AgentConfig['container'], 'claudePath'>;
  sessions: Omit<AgentConfig['sessions'], 'workspaceRoot'>;
  status: Pick<AgentConfig['status'], 'intervalSeconds'>;
  clawsky: Omit<AgentConfig['clawsky'], 'crew'>;
};

const DEFAULTS: Defaults = {
  container: {
    claudePath: '/usr/local/bin/claude',
  },
  prompts: DEFAULT_PROMPTS,
  model: 'claude-opus-5',
  // Empty on purpose: the default deployment runs every role on `model`. An
  // override is a deliberate act in agent-config.yaml, not something a role
  // acquires by existing.
  modelByRole: {},
  maxTurns: 0,
  systemPrompt: {
    useClaudeCodeDefault: true,
    append: '',
  },
  sessions: {
    maxConcurrent: 3,
    idleTimeoutMinutes: 0,
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
  clawsky: {
    enabled: true,
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
    intervalSeconds: 20,
  },
};

let loadingConfigPath = 'agent-config.yaml';

let keyProvenance = new Map<string, string>();

function fileFor(path: string): string {
  for (let at = path; ; ) {
    const file = keyProvenance.get(at);
    if (file !== undefined) return file;
    if (at.endsWith(']')) {
      const open = at.lastIndexOf('[');
      if (open > 0) {
        at = at.slice(0, open);
        continue;
      }
    }
    const cut = at.lastIndexOf('.');
    if (cut < 0) break;
    at = at.slice(0, cut);
  }
  return loadingConfigPath;
}

class ConfigError extends Error {
  constructor(path: string, message: string) {
    super(`${fileFor(path)}: ${path} ${message}`);
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

/** A path that must be written down, and must be absolute. */
function requiredAbsPath(raw: unknown, path: string): string {
  if (raw === undefined || raw === null || raw === '') {
    throw new ConfigError(path, 'is required and has no default');
  }
  if (typeof raw !== 'string') throw new ConfigError(path, 'must be a string');
  if (!isAbsolute(raw)) throw new ConfigError(path, `("${raw}") must be an absolute path`);
  return resolve(raw);
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

/** `modelByRole` — a mapping of crew role to the model that role runs on. */
function roleModels(raw: unknown, path: string): Partial<Record<AgentRole, string>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ConfigError(path, 'must be a mapping of role to model id');

  const out: Partial<Record<AgentRole, string>> = {};
  for (const [role, value] of Object.entries(raw)) {
    if (!isAgentRole(role)) {
      throw new ConfigError(`${path}.${role}`, `is not a role — one of: ${AGENT_ROLES.join(', ')}`);
    }
    if (role === 'host') {
      throw new ConfigError(
        `${path}.host`,
        'cannot take a model — the host agent runs outside this container and ' +
          'never opens a session here, so an override would never apply',
      );
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(`${path}.${role}`, 'must be a non-empty model id');
    }
    out[role] = value;
  }
  return out;
}

/** `hamachi-engineer1` — lowercase, and prefixed with the crew that owns it. */
export const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** The pre-spawn agent list. */
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

/** A prompt template, with its placeholders checked against what the renderer will actually supply. */
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

// ── Layering ────────────────────────────────────────────────────────────────

const PROMPT_CONTENT: ReadonlyArray<[string, string]> = [
  ['systemPrompt.append', 'the system prompt is shared by every crew'],
  ['prompts', 'the prompt templates are shared by every crew'],
];

const DERIVED_KEYS: ReadonlyArray<[string, string]> = [
  ['container.name', 'is the docker exec target and derives from crew'],
  ['container.stateDir', 'derives from crew'],
  ['container.execEnvDir', "holds one instance's tokens and derives from crew"],
  ['container.githubTokenDir', "holds one instance's credential and derives from crew"],
  ['sessions.workspaceRoot', 'derives from crew'],
  ['status.file', 'is read per instance by the ops executor and derives from crew'],
  ['status.instance', 'is matched against the ops allowlist and derives from crew'],
  ['git.userName', 'derives from displayName'],
  ['git.userEmail', 'derives from crew'],
];

const BASE_FORBIDDEN: ReadonlyArray<[string, string]> = [
  ['crew', 'names one instance'],
  ['displayName', 'names one instance'],
  ['discord.allowedChannelIds', 'each crew lives in its own guild'],
  ['discord.followUpChannelIds', 'each crew lives in its own guild'],
  ['discord.alwaysOnChannelIds', 'each crew lives in its own guild'],
  ...DERIVED_KEYS,
];

/** Is `dotted` present in `root`? Presence, not truthiness — `[]` counts. */
function hasKey(root: Record<string, unknown>, dotted: string): boolean {
  const parts = dotted.split('.');
  let node: unknown = root;
  for (const part of parts) {
    if (!isRecord(node) || !(part in node)) return false;
    node = node[part];
  }
  return true;
}

function refuseKeys(
  root: Record<string, unknown>,
  file: string,
  forbidden: ReadonlyArray<[string, string]>,
  rule: string,
): void {
  const found = forbidden.filter(([key]) => hasKey(root, key));
  if (found.length === 0) return;
  throw new Error(
    `${file}: ${found.map(([key]) => key).join(', ')} ` +
      `${found.length > 1 ? 'do' : 'does'} not belong in this file. ${rule}\n` +
      found.map(([key, why]) => `  ${key} — ${why}`).join('\n'),
  );
}

/** Merge an instance file over the base. */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
  provenance: Map<string, string>,
  baseFile: string,
  overFile: string,
  prefix = '',
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base)) provenance.set(prefix + key, baseFile);

  const claim = (at: string, value: unknown): void => {
    provenance.set(at, overFile);
    if (!isRecord(value)) return;
    for (const [k, v] of Object.entries(value)) claim(`${at}.${k}`, v);
  };

  for (const [key, value] of Object.entries(over)) {
    const dotted = prefix + key;
    const existing = out[key];

    if (value === null || value === undefined) continue;

    if (isRecord(existing) && isRecord(value)) {
      out[key] = deepMerge(existing, value, provenance, baseFile, overFile, `${dotted}.`);
    } else {
      out[key] = value;
      claim(dotted, value);
    }
  }
  return out;
}

const CREW_PLACEHOLDER = 'Crew';

function substituteCrew(text: string, displayName: string, key: string): string {
  const used = [...text.matchAll(/\{\{([^}\n]*)\}\}/g)].map((m) => m[1] as string);
  const unknown = [...new Set(used)].filter((name) => name !== CREW_PLACEHOLDER);
  if (unknown.length > 0) {
    throw new ConfigError(
      key,
      `uses unknown placeholder${unknown.length > 1 ? 's' : ''} ` +
        `${unknown.map((u) => `{{${u}}}`).join(', ')}. ` +
        `The only one available here is {{${CREW_PLACEHOLDER}}}. ` +
        'Single braces are prose and are left alone.',
    );
  }
  return text.split(`{{${CREW_PLACEHOLDER}}}`).join(displayName);
}

function deriveInstancePaths(crew: string, displayName: string, stateDirOverride?: string) {
  const stateDir = stateDirOverride ?? `/var/lib/${crew}`;
  return {
    containerName: `${crew}-agent`,
    stateDir,
    execEnvDir: join(stateDir, 'exec-env'),
    githubTokenDir: join(stateDir, 'github-token'),
    workspaceRoot: join(stateDir, 'workspaces'),
    statusFile: join(stateDir, 'waker-status.json'),
    statusInstance: crew,
    gitUserName: displayName,
    gitUserEmail: `${crew}@users.noreply.github.com`,
  };
}

const CREW_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Is `child` inside `parent`? */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** The label of `githubTokenDir`'s own entry, named once so its guard can skip that ENTRY rather than skipping a PATH VALUE. */
const GITHUB_TOKEN_DIR_MOUNT = 'container.githubTokenDir, bind-mounted read-only';

function bindMountedPaths(config: AgentConfig): Array<[string, string, string?]> {
  const state = config.container.stateDir;
  return [
    ['sessions.workspaceRoot', config.sessions.workspaceRoot, 'sessions.workspaceRoot'],
    // The three `docker run -v … :rw` paths, by the same derivation the script uses.
    ...(['run', 'workspaces', 'agent-home'] as const).map(
      (child) =>
        [`<container.stateDir>/${child}, bind-mounted read-write`, join(state, child)] as [
          string,
          string,
        ],
    ),
    ['paths.skillsDir', config.paths.skillsDir, 'paths.skillsDir'],
    [
      'the directory containing paths.discordCli',
      dirname(config.paths.discordCli),
      'paths.discordCli',
    ],
    // Bind-mounted READ-ONLY, and listed for the same reason as the two above: what it protects is a credential.
    [GITHUB_TOKEN_DIR_MOUNT, config.container.githubTokenDir, 'container.githubTokenDir'],
  ];
}

function readYaml(path: string, what: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(
      `${what} not found at ${path}. ` +
        'Expected agent-config.yaml in the working directory, or set AGENT_CONFIG_PATH.',
    );
  }
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : error}`);
  }
  return section(parsed, 'root');
}

export function loadAgentConfig(configPath?: string): AgentConfig {
  const path = resolve(configPath ?? process.env['AGENT_CONFIG_PATH'] ?? 'agent-config.yaml');
  loadingConfigPath = path;
  keyProvenance = new Map();
  const instance = readYaml(path, 'Agent config');

  // `extends` is resolved against the INSTANCE FILE's directory, not the process's working directory.
  const extendsRaw = instance['extends'];
  let root: Record<string, unknown>;

  const standalone = bool(instance['standalone'], 'standalone', false);

  if (!('extends' in instance) && !standalone) {
    if ((hasKey(instance, 'systemPrompt.append') || 'prompts' in instance) && !('crew' in instance)) {
      throw new Error(
        `${path}: this looks like the SHARED BASE, and AGENT_CONFIG_PATH must name an ` +
          'INSTANCE file rather than the base.\n' +
          '  It carries prompt content and names no `crew` — a base may not have one, and ' +
          'every instance file must.\n' +
          '  Point AGENT_CONFIG_PATH at agent-config.yaml, or at whichever instance file ' +
          'this crew uses; that file names this one with `extends:`.\n' +
          'A base has no mode of its own, so adding `extends:` or `standalone: true` here ' +
          'is not the fix — the first would be a chain and is refused.',
      );
    }

    throw new Error(
      `${path}: has no \`extends:\` and does not declare itself standalone.\n` +
        '\n  Almost certainly you want:  extends: agent-config.base.yaml\n' +
        '    Every crew that ships extends the base. It carries the system prompt, the\n' +
        '    prompt templates, the model and the session limits — around 90% of what a\n' +
        '    crew runs on. If this file is an instance config, this is the line.\n' +
        '\n  Only if this file really is the whole config:  standalone: true\n' +
        '    There is no such config in this repository. A crew with no base starts\n' +
        '    with NO SYSTEM PROMPT AT ALL, on the code default model — which is the\n' +
        '    exact failure this error exists to stop, so do not take this option to\n' +
        '    make the error go away.',
    );
  }
  if ('extends' in instance && standalone) {
    throw new ConfigError(
      'standalone',
      'cannot be true in a file that also has `extends:` — those are the two modes, ' +
        'and a file claiming both says nothing about which one it means',
    );
  }

  if (!('extends' in instance)) {
    // Standalone: the instance file is the whole config.
    root = instance;
  } else {
    if (typeof extendsRaw !== 'string' || extendsRaw.trim() === '') {
      throw new ConfigError(
        'extends',
        'must be a path to the shared base config. A bare `extends:` with no value is ' +
          'this error rather than a silent standalone file — it would drop the entire ' +
          'base, and a crew with no system prompt starts and says nothing.',
      );
    }
    const basePath = resolve(dirname(path), extendsRaw);
    if (basePath === path) {
      throw new ConfigError('extends', `cannot point at the file itself (${basePath})`);
    }
    const base = readYaml(basePath, 'Base config named by `extends`');
    // Both mode keys, refused in one place, because they are one decision: a base
    // is not a file that has a mode, it is the thing a mode points at.
    if ('standalone' in base) {
      throw new Error(
        `${basePath}: has \`standalone:\`, which declares the MODE of one instance file ` +
          'and is meaningless in a shared base. A base is not standalone or extending — it ' +
          'is the thing an instance extends. Delete the line; it is read only from the ' +
          'instance file and was silently ignored here before #228.',
      );
    }
    if (base['extends'] !== undefined) {
      // One level, deliberately: a chain would make "which file is this value
      // from" a question answered by tracing.
      throw new ConfigError('extends', `${basePath} itself has an \`extends\`; chains are not supported`);
    }

    refuseKeys(
      instance,
      path,
      PROMPT_CONTENT,
      'Prompt content is shared: every crew reads the same words, and differs only in ' +
        `facts interpolated into them. Put it in ${basePath}, and if it is true of one crew ` +
        'and not another, rewrite it to be true of the mechanism.',
    );
    refuseKeys(
      instance,
      path,
      DERIVED_KEYS,
      'Every path and identity here derives from `crew`. Restating one is how an instance ' +
        "ends up pointing at another crew's container, state directory or credential — " +
        'delete the key and let it derive.',
    );
    refuseKeys(
      base,
      basePath,
      BASE_FORBIDDEN,
      'This file is shared by every instance, so a value here is inherited by any instance ' +
        'that does not override it — silently, and as the other crew\'s identity. Put it in ' +
        'the instance file, or let it derive from `crew`.',
    );

    root = deepMerge(base, instance, keyProvenance, basePath, path);
  }
  delete root['extends'];
  // Belt and braces: the config object below is built key by key from `root`, so an unhandled root key cannot leak through.
  delete root['standalone'];

  // Refused wherever it appears, including a standalone file.
  if (hasKey(root, 'clawsky.crew')) {
    throw new ConfigError(
      'clawsky.crew',
      'moved to the top level as `crew` in #203 — every path and identity in the ' +
        'deployment derives from it now, not just the message board. Set `crew:` instead.',
    );
  }

  const crew = str(root['crew'], 'crew', '');
  if (!CREW_NAME.test(crew)) {
    throw new ConfigError(
      'crew',
      crew === ''
        ? 'is required and has no default. It names this instance, and every path and ' +
            'identity is derived from it — a default would be one crew\'s name handed to ' +
            'another crew that forgot to say its own'
        : 'must be a short lowercase identifier — it prefixes every agent id in this ' +
            'crew, names its container and its state directory, and is compared as an ' +
            'exact string',
    );
  }
  const displayName = str(root['displayName'], 'displayName', crew[0]!.toUpperCase() + crew.slice(1));
  // Read before deriving, so an explicit stateDir feeds every path rather than
  // one of them. Refused outright in either layered file; reachable only from a
  // standalone config.
  const containerRaw = section(root['container'], 'container');
  const derived = deriveInstancePaths(
    crew,
    displayName,
    containerRaw['stateDir'] === undefined || containerRaw['stateDir'] === null
      ? undefined
      : requiredAbsPath(containerRaw['stateDir'], 'container.stateDir'),
  );

  const prompt = section(root['systemPrompt'], 'systemPrompt');
  const sessions = section(root['sessions'], 'sessions');
  const discord = section(root['discord'], 'discord');
  const paths = section(root['paths'], 'paths');
  const clawsky = section(root['clawsky'], 'clawsky');
  const armed = section(root['armed'], 'armed');
  const armedGithub = section(armed['github'], 'armed.github');
  const status = section(root['status'], 'status');
  const git = section(root['git'], 'git');
  const prompts = section(root['prompts'], 'prompts');
  const container = section(root['container'], 'container');

  const config: AgentConfig = {
    crew,
    displayName,
    container: {
      name: str(container['name'], 'container.name', derived.containerName),
      claudePath: str(container['claudePath'], 'container.claudePath', DEFAULTS.container.claudePath),
      stateDir: derived.stateDir,
      execEnvDir: str(container['execEnvDir'], 'container.execEnvDir', derived.execEnvDir),
      // Derived from stateDir, not defaulted to a literal: a shared literal would have one instance serving another crew its credential.
      githubTokenDir: str(
        container['githubTokenDir'],
        'container.githubTokenDir',
        derived.githubTokenDir,
      ),
    },
    prompts: {
      protocol: template(prompts['protocol'], 'protocol', DEFAULT_PROMPTS.protocol),
      roleNotice: template(prompts['roleNotice'], 'roleNotice', DEFAULT_PROMPTS.roleNotice),
      roleNoticeUnknown: template(
        prompts['roleNoticeUnknown'],
        'roleNoticeUnknown',
        DEFAULT_PROMPTS.roleNoticeUnknown,
      ),
      messageWake: template(prompts['messageWake'], 'messageWake', DEFAULT_PROMPTS.messageWake),
      messageLine: template(prompts['messageLine'], 'messageLine', DEFAULT_PROMPTS.messageLine),
      mailWake: template(prompts['mailWake'], 'mailWake', DEFAULT_PROMPTS.mailWake),
      spawnCharter: template(
        prompts['spawnCharter'],
        'spawnCharter',
        DEFAULT_PROMPTS.spawnCharter,
      ),
    },
    model: str(root['model'], 'model', DEFAULTS.model),
    modelByRole: roleModels(root['modelByRole'], 'modelByRole'),
    maxTurns: num(root['maxTurns'], 'maxTurns', DEFAULTS.maxTurns, 0),
    systemPrompt: {
      useClaudeCodeDefault: bool(
        prompt['useClaudeCodeDefault'],
        'systemPrompt.useClaudeCodeDefault',
        DEFAULTS.systemPrompt.useClaudeCodeDefault,
      ),
      append: substituteCrew(
        str(prompt['append'], 'systemPrompt.append', DEFAULTS.systemPrompt.append),
        displayName,
        'systemPrompt.append',
      ),
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
        derived.workspaceRoot,
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
      userName: str(git['userName'], 'git.userName', derived.gitUserName),
      userEmail: str(git['userEmail'], 'git.userEmail', derived.gitUserEmail),
    },
    clawsky: {
      enabled: bool(clawsky['enabled'], 'clawsky.enabled', DEFAULTS.clawsky.enabled),
      // The top-level `crew` is the only source; `clawsky.crew` is refused above.
      crew,
      wakeOnMail: bool(clawsky['wakeOnMail'], 'clawsky.wakeOnMail', DEFAULTS.clawsky.wakeOnMail),
      agents: agentList(clawsky['agents'], 'clawsky.agents', crew),
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
      file: str(status['file'], 'status.file', derived.statusFile),
      intervalSeconds: num(
        status['intervalSeconds'],
        'status.intervalSeconds',
        DEFAULTS.status.intervalSeconds,
        1,
        3600,
      ),
      instance: str(status['instance'], 'status.instance', derived.statusInstance),
    },
  };

  if (
    config.discord.bundleDebounceMs > 0 &&
    config.discord.bundleMaxWaitMs < config.discord.bundleDebounceMs
  ) {
    throw new Error(
      `${fileFor('discord.bundleMaxWaitMs')}: discord.bundleMaxWaitMs must be >= ` +
        'discord.bundleDebounceMs — a lower ceiling would flush every bundle before the ' +
        'debounce could coalesce anything.',
    );
  }

  if (config.status.file) {
    if (!isAbsolute(config.status.file)) {
      throw new ConfigError('status.file', 'must be an absolute path');
    }
    const statusFile = resolve(config.status.file);
    for (const [label, mount, mountKey] of bindMountedPaths(config)) {
      if (isInside(statusFile, resolve(mount))) {
        throw new Error(
          `${fileFor(mountKey ?? 'status.file')}: status.file (${statusFile}) is inside ${label} ` +
            `(${resolve(mount)}), which docker/run-container.sh bind-mounts into the agent ` +
            'container. The ops executor trusts this file when deciding whether recreating ' +
            'the container would kill a live turn; the agent must not be able to write it.',
        );
      }
    }
  }

  if (!isAbsolute(config.container.execEnvDir)) {
    throw new ConfigError('container.execEnvDir', 'must be an absolute path');
  }
  const execEnvDir = resolve(config.container.execEnvDir);
  for (const [label, mount, mountKey] of bindMountedPaths(config)) {
    if (isInside(execEnvDir, resolve(mount))) {
      throw new Error(
        `${fileFor(mountKey ?? 'container.execEnvDir')}: container.execEnvDir (${execEnvDir}) ` +
          `is inside ${label} ` +
          `(${resolve(mount)}), which docker/run-container.sh bind-mounts into the agent ` +
          'container. That file holds this instance\'s Discord and GitHub tokens; it must ' +
          'not be reachable from inside any sandbox. Put it beside the state directory, ' +
          'not in it — the default is /var/lib/<instance>/exec-env.',
      );
    }
  }

  if (!isAbsolute(config.container.githubTokenDir)) {
    throw new ConfigError('container.githubTokenDir', 'must be an absolute path');
  }
  const githubTokenDir = resolve(config.container.githubTokenDir);
  // Its own ENTRY is dropped, not its own PATH.
  const others = bindMountedPaths(config).filter(([label]) => label !== GITHUB_TOKEN_DIR_MOUNT);
  for (const [label, mount, mountKey] of others) {
    if (isInside(githubTokenDir, resolve(mount))) {
      throw new Error(
        `${fileFor(mountKey ?? 'container.githubTokenDir')}: container.githubTokenDir ` +
          `(${githubTokenDir}) is inside ${label} ` +
          `(${resolve(mount)}). It holds a GitHub App installation token that every agent ` +
          'consumes; it is mounted read-only on purpose, and a path inside a read-write ' +
          'mount would let the sandbox rewrite or replace the credential the daemon serves ' +
          'it. Put it beside the state directory, not in it — the default is ' +
          '/var/lib/<instance>/github-token.',
      );
    }
  }

  // Checked at startup rather than at arm time.
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
