/**
 * Agent behaviour, loaded from an INSTANCE file that names a shared base.
 *
 * The split with `.env` is deliberate: the environment carries only secrets and
 * deployment identity, everything describing how the agent *behaves* lives in
 * version-controllable YAML. Changing the agent's personality should be a diff,
 * not an edit to a file full of tokens.
 *
 * The split BETWEEN the YAML files is the same argument one level down, and is
 * #203. `AGENT_CONFIG_PATH` names a small per-instance file — `crew`,
 * `displayName`, Discord channels — which names `agent-config.base.yaml` with
 * `extends:`. Everything true of every crew lives in the base exactly once.
 * Before that the instance files were deliberate full copies, 937 and 972
 * lines, of which 111 differed and three were config values.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, dirname, join } from 'node:path';
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
  /**
   * The first message a spawned agent receives — CLAWSKY.md phase 5.
   *
   * It is a MAIL BODY, not a system prompt, and that is the whole design.
   * Every agent shares one system prompt (`buildSystemPrompt` takes no
   * arguments), so an agent's role cannot be baked into it; and baking a task
   * into identity would mean a resurrected engineer wakes believing it still
   * owns work that closed three weeks ago. Delivered as turn one it replays on
   * resume as *history*: the agent can see what it was originally asked to do
   * without being told it is still current.
   *
   * `{id}`, `{role}`, `{crew}` and `{spawnedBy}` are derived by the waker from
   * the row it just wrote. `{instructions}` is the only part the caller
   * supplies, and it can say anything at all — including that the agent is
   * something it is not. Mail policy reads the ROW, so an engineer told it is a
   * poster still cannot write to the feed.
   *
   * That guarantee is about MAIL and is narrower than it sounds. Role is a
   * boundary in `src/mail.ts` and nowhere else: every session gets
   * `DISCORD_TOKEN`, `DISCORD_GUILD_ID` and `GITHUB_TOKEN` in its environment
   * and the discord-cli skill symlinked into its workspace, whatever its role.
   * A spawned engineer can post to Discord as the bot and push to GitHub. What
   * its role decides is who it may write to on the board.
   */
  spawnCharter: string;
};

/** Placeholders each template may use. Anything else is a startup error. */
export const PROMPT_PLACEHOLDERS: Record<keyof PromptTemplates, readonly string[]> = {
  protocol: ['cli'],
  roleNotice: [],
  messageWake: ['count', 'plural', 'messages', 'channelId', 'latestMessageId', 'cli', 'roleNotice'],
  messageLine: ['time', 'author', 'authorId', 'messageId', 'content'],
  mailWake: ['mail', 'count', 'plural'],
  spawnCharter: ['id', 'role', 'crew', 'spawnedBy', 'instructions'],
};

export type AgentConfig = {
  /**
   * This instance's crew name, and the single fact everything else comes off.
   *
   * REQUIRED, with no default, for the reason `container.stateDir` used to be:
   * a default is a literal and a literal belongs to whichever crew was written
   * first. It was `clawsky.crew` until #203 and is top-level now because it is
   * no longer only clawsky's — the container name, the state directory, the
   * status file and the git identity are all derived from it, and a name that
   * decides where a credential is written does not belong inside the block
   * about the message board.
   */
  crew: string;
  /**
   * The crew's name as it says it — `Clawcius`, `Hamachi`. Defaults to `crew`
   * capitalised.
   *
   * Two consumers, and they are the only two: `{{Crew}}` in
   * `systemPrompt.append`, and `git.userName`. It is separate from `crew`
   * because `crew` is matched as an exact lowercase string by the ops
   * allowlist and by every agent id, and a display name is prose.
   */
  displayName: string;
  container: {
    name: string;
    /** In-container path to the claude binary. */
    claudePath: string;
    /**
     * This instance's `CLAWCIUS_STATE_DIR`, and the only reason this file knows
     * it: `<stateDir>/run` is what `docker/run-container.sh` bind-mounts
     * read-write into the container, and nothing else in this config names it.
     *
     * It used to be reached through `dirname(wake.spoolDir)`, which was
     * accidental — the spool was `<stateDir>/run/wake` and its parent happened
     * to be the mount. That derivation was also wrong by one level for the check
     * it was doing, so `status.file: <stateDir>/run/waker-status.json` passed
     * every check in both loaders while sitting in a directory the agent can
     * write (Clawcius #55). Retiring the spool removed the derivation; this
     * names the thing directly instead, which is what the ops loader has always
     * done with `instances[].stateDir`.
     *
     * MUST match `CLAWCIUS_STATE_DIR` in this instance's container unit, and
     * `instances[].stateDir` in ops-config.yaml. Nothing is created from it and
     * nothing is written to it — it is used to answer "is this path somewhere
     * the container can write", and getting it wrong makes that answer wrong in
     * the direction of passing.
     *
     * DERIVED from `crew` as `/var/lib/{crew}` since #203, and must be ABSOLUTE
     * if stated explicitly. It used to be required with no default, and the
     * reason given was that a default would be `/var/lib/clawcius` — correct
     * for one instance and quietly wrong for the other. That reason is intact
     * and is why this is derived rather than defaulted: a derivation from the
     * instance's own name cannot name its neighbour, which a literal always
     * can. Measured before the change, both shipped instances already held
     * exactly `/var/lib/{crew}`, so deriving it moved no value.
     *
     * A relative override still resolves against the waker's working directory
     * and would leave every check downstream comparing against a directory that
     * does not exist, so it is still refused.
     */
    stateDir: string;
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
    /** Holds the App installation token for agents; mounted READ-ONLY. */
    githubTokenDir: string;
  };
  prompts: PromptTemplates;
  model: string;
  /**
   * Per-role model overrides. A role absent here runs on `model`.
   *
   * Config rather than prose, deliberately. The retired `<updater-agent>` block
   * carried a `<recommended-model>haiku</recommended-model>` hint in the system
   * prompt for the team leader to pass through, and #44 removed that mechanism
   * on the grounds that a model hint in the role text is not a mechanism — it
   * is a suggestion to a model about a parameter it does not control. This is
   * the same intent expressed where the value is actually read.
   */
  modelByRole: Readonly<Partial<Record<AgentRole, string>>>;
  /** 0 means unlimited — no turn cap is sent to the SDK at all. */
  maxTurns: number;
  systemPrompt: SystemPromptConfig;
  sessions: {
    maxConcurrent: number;
    /**
     * 0 means never evict. Eviction is the only thing that reclaims a live,
     * healthy session on its own; a session can still go on `!reset`, on a
     * transport error, or on a stale-token respawn.
     */
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
     * This was the only way to get one before `spawn` (phase 5) existed, and
     * it is still how an OPERATOR adds one: the rows are created at startup if
     * absent and never overwritten, so an edit here adds an agent without
     * disturbing the ones already running. A spawned row is the same row with
     * `spawned_by` set, so the two compose rather than competing — and this
     * list is what bootstraps a crew, since a crew with no coordinator has
     * nobody to call `spawn`.
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
     * MUST NOT live anywhere bind-mounted into the agent container. The whole
     * point of the file is that a privileged process trusts it, and the agent
     * inside the container is exactly the party that must not be able to write
     * "I am idle, go ahead and recreate me". `<stateDir>/run` is mounted
     * read-write by design; the default here is one level up, outside every
     * mount in `docker/run-container.sh`. The ops config loader re-checks the
     * containment against that mount — which it can name, because it holds
     * `instances[].stateDir` — and refuses to start if it is violated.
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

/**
 * Every setting that has a default, and nothing that does not.
 *
 * `container.stateDir` is deliberately absent, and the type says so rather than
 * a comment alone: it names a per-instance directory, so any value here would be
 * right for one instance and silently wrong for the other — which is the bug
 * Clawcius #55 was, one level up. Omitting it from this type is what makes
 * "somebody must write this down" a compile-time fact instead of a convention.
 */
type Defaults = Omit<
  AgentConfig,
  'container' | 'crew' | 'displayName' | 'git' | 'sessions' | 'status' | 'clawsky'
> & {
  container: Pick<AgentConfig['container'], 'claudePath'>;
  sessions: Omit<AgentConfig['sessions'], 'workspaceRoot'>;
  status: Pick<AgentConfig['status'], 'intervalSeconds'>;
  clawsky: Omit<AgentConfig['clawsky'], 'crew'>;
};

/**
 * Defaults for the keys that are the same for every crew.
 *
 * EVERY PER-INSTANCE KEY IS ABSENT FROM THIS TYPE, and that omission is the
 * point rather than tidiness. Until #203 this object held `clawcius-agent`,
 * `/var/lib/clawcius/exec-env`, `/var/lib/clawcius/workspaces`,
 * `/var/lib/clawcius/waker-status.json`, `clawcius` and `Clawcius`. A second
 * instance that set its crew and forgot one of those keys did not fail — it
 * inherited the first crew's value, which for `container.name` means running
 * its turns inside the first crew's container (`src/container.ts:323`).
 *
 * `stateDir` was omitted from this type for exactly that reason and the comment
 * called it "a compile-time fact instead of a convention". All NINE are now
 * omitted on the same grounds; they come from `deriveInstancePaths` instead, so
 * the compiler refuses to let anyone put a crew's name back in here.
 *
 * All nine, and the count is the point. Three of them — `status.file`,
 * `status.instance` and `clawsky.crew` — were briefly left in the type as `''`
 * placeholders whose only job was to satisfy it, which meant
 * `file: '/var/lib/clawcius/waker-status.json'` would still have typechecked
 * while this comment claimed it could not. Harmless, since the loader reads
 * `derived.*` and never those three — but a compile-time guarantee covering six
 * of nine is not the guarantee the sentence describes. OJ round 1 on #207,
 * finding 7.
 */
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

/**
 * The instance file currently being loaded, for error messages.
 *
 * Module-scoped mutable state, which needs the justification: every one of
 * these errors used to begin with the literal `agent-config.yaml:`, and that
 * was already a small lie for the second instance — an operator debugging
 * Hamachi was told to open Clawcius's file. Since #203 there are three files
 * rather than two and the lie is worse, so the prefix names the file the load
 * actually started from.
 *
 * `loadAgentConfig` is synchronous end to end, so nothing can interleave
 * between the assignment and the throws that read it. Errors that name the BASE
 * file specifically build their own prefix (`refuseKeys`), because those are the
 * ones where the distinction is the whole point.
 */
let loadingConfigPath = 'agent-config.yaml';

/**
 * Which file each merged key actually came from, built during `deepMerge`.
 *
 * Without it every error named the INSTANCE file, and after the split almost
 * every value lives in the base — so the two sharpest cases pointed an operator
 * at the one file that may not contain the key they were told to fix. A bad
 * `{{crew}}` in the shared prompt said "fix `systemPrompt.append` in
 * agent-config.yaml"; putting it there is a hard boot error whose message says
 * to move it back. That is the defect this change lists among its own fixes,
 * reintroduced one layer up and covering the majority of keys rather than one
 * instance's worth. OJ round 1 on #207, finding 4.
 */
let keyProvenance = new Map<string, string>();

/**
 * The file to name when complaining about `path`; the root file if unknown.
 *
 * Walks UP the dotted path, and strips a trailing `[index]` at each step — which
 * is the whole of OJ round 2's residual on finding 4. Stripping only at the last
 * `.` made `discord.allowedChannelIds[0]` jump straight past the array's own
 * entry to `discord`, so an element error named whichever file wrote the *parent
 * mapping* — and for `discord.allowedChannelIds` that is always wrong:
 * `BASE_FORBIDDEN` refuses that key in the base, so it can only ever have come
 * from an instance file.
 */
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

/**
 * A path that must be written down, and must be absolute.
 *
 * The same shape as `requiredAbsPath` in `ops/src/config.ts`, and here for the
 * same reason: a relative path resolves against the WAKER'S working directory,
 * which is not a place anybody was thinking about, and `isInside()` then
 * compares against a directory that does not exist — so every containment check
 * downstream passes. There is no fallback argument on purpose. A default for a
 * path that names a per-instance directory is a default that is right for
 * exactly one instance and silently wrong for the other.
 */
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

/**
 * `modelByRole` — a mapping of crew role to the model that role runs on.
 *
 * Both halves are validated at load rather than at first use, because both
 * failures are silent otherwise. An unknown role key is the likelier mistake
 * (a typo, or a role that was renamed) and would simply never match, leaving
 * the agent on `model` with nothing said. And an empty or non-string value
 * would reach the SDK as a model id, where it fails per-session at spawn time
 * rather than at boot — the loader refusing to start naming the key is the
 * cheaper failure by a wide margin.
 *
 * What is NOT validated is whether the string names a real model: this file
 * has no list to check against and inventing one would go stale the week a
 * model ships. A wrong-but-well-formed id fails at the SDK, which is the only
 * place that actually knows.
 */
function roleModels(raw: unknown, path: string): Partial<Record<AgentRole, string>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ConfigError(path, 'must be a mapping of role to model id');

  const out: Partial<Record<AgentRole, string>> = {};
  for (const [role, value] of Object.entries(raw)) {
    if (!isAgentRole(role)) {
      throw new ConfigError(`${path}.${role}`, `is not a role — one of: ${AGENT_ROLES.join(', ')}`);
    }
    // `host` is a role but never a session. `MailWaker.#consider` returns before
    // `acquire` for it (src/mail-wake.ts:149) and the ops executor owns that
    // mailbox from outside the container, so an override here would load clean
    // and never apply — the exact silent no-op this function exists to prevent
    // for a mistyped key. Refused rather than ignored, for the same reason.
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

// ── Layering ────────────────────────────────────────────────────────────────
//
// One shared base file, one small file per instance, and two lists saying which
// keys belong to which. Before #203 there was no base: `agent-config.yaml` and
// `agent-config.hamachi.yaml` were deliberate full copies, 937 and 972 lines,
// of which 111 differed and exactly THREE were config values — the rest was the
// same prose twice, hand-synced, and drifting when somebody forgot. The header
// of the copy said so itself.
//
// The two lists below are enforcement, not documentation. A mechanism that
// silently ignored a misplaced key would have rebuilt the original defect one
// layer up: an edit that does not reach the running system. So both are hard
// boot errors that name the file, the key and the rule.

/**
 * Prompt CONTENT. An instance file may not carry any of it.
 *
 * This is the rule that "a standard system prompt for all the agents" turns
 * into, and it is deliberately about content rather than about wording. Crews
 * DO differ — one had a GitHub App before the other — and the answer is not a
 * per-crew paragraph but a paragraph true of the MECHANISM, with the differing
 * fact interpolated. #197 reached that answer under duress, because the two
 * copies were not allowed to diverge; this makes it the rule.
 *
 * The argument against the alternative is a state, not a preference. A per-crew
 * sentence saying "your crew has no App" is false the day that crew gets one,
 * and once the prompt is genuinely shared there is no drift check left that
 * would notice — an override would be the last place a stale sentence could
 * hide, inside the mechanism built to end stale sentences.
 */
const PROMPT_CONTENT: ReadonlyArray<[string, string]> = [
  ['systemPrompt.append', 'the system prompt is shared by every crew'],
  ['prompts', 'the prompt templates are shared by every crew'],
];

/**
 * The nine keys computed by `deriveInstancePaths`. Refused in BOTH layered
 * files, which is two different bugs closed by one list.
 *
 * In the BASE the danger is INHERITANCE: a shared file's value reaching every
 * instance that did not override it. That was the live defect — `DEFAULTS` held
 * six Clawcius literals, and `container.name` is the `docker exec` target
 * (`src/container.ts:323`).
 *
 * In an INSTANCE file the danger is RESTATEMENT, and it went unnoticed until OJ
 * round 1 on #207 found that `agent-config.yaml`'s own header claimed a refusal
 * the loader did not have. An instance could write
 * `container: { name: clawcius-agent }` and load — crew three `docker exec`-ing
 * into Clawcius's container, from the file whose header said that was refused.
 *
 * Refused rather than the sentence softened, because the sentence described the
 * behaviour anyone would want. A STANDALONE file — no `extends` — is unaffected:
 * there is no shared file to inherit through, and the containment guards need
 * explicit paths to be exercised against.
 *
 * ONE AFFORDANCE THIS REMOVES, RECORDED SO NOBODY RESTORES IT WITHOUT MEANING
 * TO. A layered instance can no longer relocate its state directory at all —
 * `container.stateDir` is refused here, and standalone is the only mode that
 * accepts it, which means giving up the shared base entirely. Nobody needs that
 * today and `/var/lib/<crew>` is right for every crew that exists. If one ever
 * needs its state on another filesystem, the answer is a new mechanism that
 * keeps the derivation coherent — not reopening this key, which is how the
 * half-honoured `stateDir` of OJ round 1 finding 5 happened in the first place.
 */
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

/**
 * Instance identity. The BASE file may not carry any of it.
 *
 * Not symmetry with the list above — this one prevents a specific, demonstrated
 * bug. A shared file that carries `container.name` hands its value to every
 * instance that does not override it, and `container.name` is the `docker exec`
 * target (`src/container.ts:323`), so the inheriting crew does not fail: it
 * runs its turns inside the other crew's container, with that container's
 * mounts and that container's read-only credential directory.
 *
 * That is not hypothetical. Until #203 `DEFAULTS` held `clawcius-agent`,
 * `/var/lib/clawcius/exec-env`, `/var/lib/clawcius/workspaces`,
 * `/var/lib/clawcius/waker-status.json`, `clawcius` and `Clawcius` — six
 * literals, each one a second instance's silent cross-over. `githubTokenDir`
 * was the seventh until #188 finding 11 derived it, and derived exactly one key
 * where the class needed deriving. This list is the rest of that fix.
 */
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

/**
 * Merge an instance file over the base. Mappings merge key by key; anything
 * else replaces wholesale.
 *
 * Arrays replace rather than concatenate, and that is the only choice that is
 * safe here: the arrays in this config are channel allowlists, and a merge that
 * appended would make an instance unable to NARROW an inherited list — it could
 * only ever widen who may wake it. The base carries none of them anyway
 * (`BASE_FORBIDDEN`), so today this is belt on top of braces.
 */
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

    // AN EXPLICIT NULL MEANS INHERIT, NOT OVERRIDE. This is a third semantic
    // nobody chose being removed rather than a preference being expressed.
    //
    // `key:` with nothing after it parses to null. Treating that as a value made
    // it replace the base's — and every reader below (`str`, `num`, `bool`,
    // `section`, `strList`) then treats null as absent and falls back to
    // `DEFAULTS`. So commenting out a value in an instance file neither
    // inherited nor errored: it reset to whatever THIS FILE says, silently.
    // `model:` moved every agent in the crew off the 1M-context model that way.
    // OJ round 1 on #207, finding 3.
    //
    // An explicit EMPTY value is untouched by this — `[]` is a value and still
    // overrides, which is what `alwaysOnChannelIds: []` needs.
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

/**
 * The one substitution the shared prompt gets, and the delimiter is the design.
 *
 * `{{Crew}}`, doubled, because the prompt is 24kB of prose that ALREADY
 * contains single-brace tokens: it documents GitHub REST paths, so
 * `/repos/{owner}/{repo}/issues/{n}/labels` appears in `<habits>` twice. The
 * `{name}` syntax the `prompts.*` templates use is therefore unusable here in
 * both directions — a validator would fail the boot on a pasted URL template,
 * and a substituter would rewrite one.
 *
 * Three sites, all identity, all in `<system description>` and `<style>`.
 * Everything else that says `Clawcius` in the shared prompt is the REPOSITORY
 * or an issue in it — `NickPurcell/Clawcius`, `Clawcius #93`, `Clawcius#88` —
 * and is correct in every crew's prompt. A substitution keyed on the literal
 * name would have rewritten Hamachi's copy to `NickPurcell/Hamachi`, a
 * repository that does not exist, taking `<issue-tracking>` with it and
 * surfacing as a 404 the first time some agent tried to file. Double braces
 * make that mistake unavailable rather than merely documented.
 */
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

/**
 * Every path and identity that comes off the crew name, in one place.
 *
 * Measured on 2026-08-23, before any of this existed: all nine already held
 * exactly this shape in both shipped configs. So this is not a new convention
 * being imposed, it is the convention that was already being hand-maintained,
 * moved somewhere it cannot be forgotten.
 */
function deriveInstancePaths(crew: string, displayName: string, stateDirOverride?: string) {
  // EVERY path below hangs off the same resolved `stateDir`, including when it is
  // stated explicitly. It used not to: `githubTokenDir` re-derived from the
  // explicit value while `execEnvDir`, `workspaceRoot` and `status.file` kept
  // computing from `/var/lib/{crew}`, so `stateDir: /srv/third` produced a
  // `workspaceRoot` outside the directory `run-container.sh` actually mounts —
  // half-honoured, which reads as coherent and is worse than not honoured at all.
  // OJ round 1 on #207, finding 5.
  //
  // Only reachable from a STANDALONE config now, since `DERIVED_KEYS` refuses an
  // explicit `stateDir` in either layered file. That is the case the containment
  // guards are tested through, so it has to be right rather than merely absent.
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
 * The label of `githubTokenDir`'s own entry, named once so its guard can skip
 * that ENTRY rather than skipping a PATH VALUE.
 *
 * The difference is a hole. Comparing resolved paths, `githubTokenDir` set
 * exactly equal to any OTHER mount also matched the skip — so
 * `githubTokenDir: <stateDir>/workspaces` was accepted, which is the read-write
 * mount that is the container's working directory and the exact placement the
 * whole guard exists to refuse. Equality with a mount is the WORST case, not
 * the exempt one; only the entry describing this key itself is exempt.
 */
const GITHUB_TOKEN_DIR_MOUNT = 'container.githubTokenDir, bind-mounted read-only';

/**
 * Host paths that `docker/run-container.sh` bind-mounts into the agent
 * container, as far as this file can know them.
 *
 * ── The three read-write ones, all of them covered ───────────────────────
 *
 * `docker/run-container.sh` mounts three directories read-write, and all three
 * are derived from one variable:
 *
 *     -v "$CLAWCIUS_STATE/workspaces:…:rw"
 *     -v "$CLAWCIUS_STATE/run:…:rw"
 *     -v "$CLAWCIUS_STATE/agent-home:…:rw"
 *
 * Those are the ones that matter most here, because a file inside one is
 * WRITABLE by the agent rather than merely shared with the other deployment —
 * and `status.file` is a file a root process believes. `run` used to be reached
 * as `dirname(wake.spoolDir)`, which was right by accident and wrong by one
 * level (Clawcius #55); `container.stateDir` names it directly now, and the
 * other two come off the same key.
 *
 * `agent-home` was missing from this list until 2026-08-16 and was named in
 * this comment as a known gap instead. That left `ops/src/config.ts` checking
 * three mounts while this file checked two and said so — two halves of one
 * change disagreeing about the completeness of one enumeration, which is the
 * same defect in the opposite direction from the one review had just found.
 * Deriving it was three characters; documenting the disagreement would have
 * been cheaper and worse.
 *
 * ── Still NOT exhaustive, and this is the honest remainder ───────────────
 *
 * Two read-only mounts still do not appear here: `gws-cli` and the Google
 * service-account key. They are read-only, so nothing in a container can write
 * them — the risk is not a forged claim but a shared secret, since a path placed
 * in one would be visible to BOTH deployments' agents.
 *
 * `container.githubTokenDir` WAS a third such omission and is now in the list,
 * which is this paragraph's warning coming true in the interval since it was
 * written: a read-only mount was added and the enumeration was not updated, so
 * `execEnvDir` could be placed inside a directory mounted into the container.
 * Unlike the two above it is in this config, so nothing external excused it.
 *
 * The defence that does not depend on enumeration is the default value: every
 * path this file defaults to is a sibling of the mounts rather than a child —
 * and `githubTokenDir` is now DERIVED from `stateDir` rather than defaulted to a
 * literal, so a second instance gets its own without anyone remembering to say
 * so. Deriving beats enumerating for the same reason this paragraph exists.
 */
function bindMountedPaths(config: AgentConfig): Array<[string, string, string?]> {
  const state = config.container.stateDir;
  // The third element is the CONFIG KEY the mount comes from, where it is one.
  // A collision names two keys — the thing being placed and the mount it landed
  // inside — and after the split those can live in different files. The mount is
  // the actionable half: `status.file` and `sessions.workspaceRoot` are derived
  // and cannot be moved, so an operator fixes the collision by editing the mount.
  // OJ round 2 on #207.
  return [
    ['sessions.workspaceRoot', config.sessions.workspaceRoot, 'sessions.workspaceRoot'],
    // The three `docker run -v … :rw` paths, by the same derivation the script
    // uses. `sessions.workspaceRoot` above is configurable and usually the same
    // directory as the first of these; both are listed because an operator who
    // moves one has not moved the mount.
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
    // Bind-mounted READ-ONLY, and in this list for the same reason the two above
    // are: what it protects is a credential rather than a claim. Without it,
    // `container.execEnvDir: <githubTokenDir>/env` passed validation and put the
    // file holding DISCORD_TOKEN and GITHUB_TOKEN in plain text inside a
    // directory mounted into the container — exactly what that guard refuses.
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

  // `extends` is resolved against the INSTANCE FILE's directory, not the
  // process's working directory. The waker is started by systemd with a
  // WorkingDirectory it did not choose, and an instance file that only resolves
  // when launched from the right cwd is a file that works in development and
  // fails at boot.
  const extendsRaw = instance['extends'];
  let root: Record<string, unknown>;

  // PRESENCE, not value. `extends:` with nothing after it parses to null, and
  // treating null like absent made a bare `extends:` mean "this file is
  // standalone" — so the crew booted with NO system prompt at all, on the code
  // default model instead of the base's, with nothing printed. `extends: ""` was
  // already refused with a good message, but in YAML those are the same edit
  // made two ways and the silent one was the safe-looking one.
  // OJ round 1 on #207, finding 2.
  const standalone = bool(instance['standalone'], 'standalone', false);

  // THE MODE IS DECLARED, NEVER INFERRED. Silence used to MEAN standalone, and
  // #207 closed only the spelling that looks like a mistake:
  //
  //   extends:                    refused since #207 — looks like a mistake
  //   extends: ""                 refused since #207
  //   <the line deleted entirely>  LOADED SILENTLY — looks like a deletion
  //
  // That third row is #221. Delete one line from a shipped instance file and the
  // crew starts with a 0-character system prompt, `claude-opus-5` instead of
  // `claude-opus-5[1m]`, and `maxConcurrent: 3` instead of 10 — measured, on
  // merged `main`. Instance files are now twelve lines and hand-edited, and
  // `extends:` is the one line in them that reads like boilerplate.
  //
  // Nothing upstream catches it any more, and that is this change's own doing:
  // `container.stateDir` was required-with-no-default and would have thrown, but
  // #203 derived it from `crew`, so a file containing `crew:` satisfies the
  // loader completely. The protection was never a guard — it was a side effect
  // of a different requirement, and deriving removed it.
  if (!('extends' in instance) && !standalone) {
    throw new Error(
      `${path}: has no \`extends:\` and does not declare itself standalone.\n` +
        '  An instance file must name its base — `extends: agent-config.base.yaml`.\n' +
        '  A deliberately self-contained config must say so — `standalone: true`.\n' +
        'Without a base this crew would start with no system prompt at all, which is ' +
        'why silence is an error here rather than a default.',
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
    // Standalone, and now DECLARED. Nothing the refusal lists protect against
    // applies: they exist to stop one instance inheriting another's identity
    // through a SHARED file, and there is no shared file here. Both shipped
    // configs use `extends`, and a test asserts it.
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
    if (base['extends'] !== undefined) {
      // One level, deliberately. A chain would make "which file is this value
      // from" a question you answer by tracing, which is the state this whole
      // change is getting out of.
      throw new ConfigError('extends', `${basePath} itself has an \`extends\`; chains are not supported`);
    }

    // Two calls, not one, because the list has two kinds of entry and one rule
    // sentence cannot be true of both — the first version told an operator that
    // `container.name` was prompt content.
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
  // Belt and braces only, and labelled as such rather than as a guard: the
  // config object below is built key by key from `root`, so an unhandled root
  // key cannot reach it whether or not these deletes happen. A test asserting
  // `config.standalone === undefined` therefore passes with the delete removed,
  // which is a test that looks like coverage and is not — found by mutating it.
  delete root['standalone'];

  // Refused wherever it appears, including a standalone file, because unlike
  // everything else here this key MOVED. Left working under its old name it
  // would be a second place to write the crew name, and the one thing the
  // derivation cannot survive is two sources for the fact it derives from.
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
      // Derived from `crew` as `/var/lib/{crew}` — see Clawcius #55, which this
      // key exists to close, and #203, which stopped it being restated per file.
      // An explicit value is still honoured and still has to be absolute: the
      // containment checks below compare against it, and a relative one would
      // make every one of them compare against a directory that does not exist.
      stateDir: derived.stateDir,
      execEnvDir: str(container['execEnvDir'], 'container.execEnvDir', derived.execEnvDir),
      // DERIVED FROM stateDir, NOT DEFAULTED TO A LITERAL, and the difference
      // is one instance serving another instance's crew its credential.
      //
      // A hardcoded `/var/lib/clawcius/github-token` was correct for Clawcius
      // and silently wrong for Hamachi, whose config overrides `stateDir`,
      // `execEnvDir` and `workspaceRoot` but had no reason to know about a key
      // added later. Hamachi's daemon would have written its installation token
      // into Clawcius's directory — which IS mounted read-only into Clawcius's
      // container — while Hamachi's own agents read a path not mounted into
      // theirs and fell silently back to the PAT.
      //
      // `run-container.sh` derives this from `$CLAWCIUS_STATE`, so deriving it
      // here from the same variable means the two sides cannot disagree. That
      // is the argument `bindMountedPaths` already makes for itself: "a second
      // setting to keep in step is a setting that eventually is not."
      githubTokenDir: str(
        container['githubTokenDir'],
        'container.githubTokenDir',
        derived.githubTokenDir,
      ),
    },
    prompts: {
      protocol: template(prompts['protocol'], 'protocol', DEFAULT_PROMPTS.protocol),
      roleNotice: template(prompts['roleNotice'], 'roleNotice', DEFAULT_PROMPTS.roleNotice),
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
      // Not a key any more — the top-level `crew` is the only source, and
      // `clawsky.crew` is refused above rather than quietly shadowed.
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

  // The status file is read by a root process that will recreate containers on
  // the strength of it. Inside a bind mount it would be writable by the agent,
  // which is the party the executor is defending against — a container that can
  // publish `liveCount: 0` can talk a privileged process into destroying a
  // session mid-turn, or into overwriting a rollback decision.
  //
  // It used to be checked against `wake.spoolDir` — `<stateDir>/run/wake`, one
  // level BELOW the directory that is actually mounted — so a status file at
  // `<stateDir>/run/waker-status.json` passed while sitting somewhere the agent
  // can write (Clawcius #55). It is now checked against the same list the exec
  // env file is, which names the mount itself.
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

  // SAME RULE AS execEnvDir ABOVE, and it is here because the first version of
  // this feature broke it. The file holds a GitHub App installation token that
  // every agent's `git push` consumes, and the original design put it in
  // `sessions.workspaceRoot` — a read-write mount, and the container's working
  // directory — reasoning only about who could READ it.
  //
  // The question these guards exist to ask is the other one: is this thing,
  // which the daemon trusts, somewhere the least trusted process on the machine
  // can REWRITE? An agent could create a directory at that path and make
  // `renameSync` throw EISDIR at boot, which with Restart=always is a permanent
  // restart loop that outlives the container; or write a file there and hand a
  // credential of its choosing to every other agent in the crew.
  //
  // The directory is bind-mounted READ-ONLY (`run-container.sh`), which is what
  // makes the file re-readable per call without being writable by the thing it
  // is a credential against. A file the agent cannot write is not a file it can
  // lie with.
  if (!isAbsolute(config.container.githubTokenDir)) {
    throw new ConfigError('container.githubTokenDir', 'must be an absolute path');
  }
  const githubTokenDir = resolve(config.container.githubTokenDir);
  // Its own ENTRY is dropped, not its own PATH. This directory is itself a bind
  // mount and is in that list so other paths can be refused inside it, and
  // `isInside(x, x)` is true — so without dropping it the guard would reject
  // every valid configuration. Dropping by label rather than by resolved path
  // keeps equality with any OTHER mount a refusal, which is what it must be.
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

  // `clawsky.crew` used to be validated here, gated on `clawsky.enabled`. Both
  // halves are gone: the name is now the top-level `crew`, checked against the
  // same pattern before anything is derived from it, and it is checked
  // unconditionally because the container name and the state directory come off
  // it whether or not the message board is switched on.

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
