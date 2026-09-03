import { Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { AgentRegistry } from './store.js';
import { BUILD_INFO } from './build-info.js';
import {
  AtCapacityError,
  DEFAULT_CHANNEL_ROLE,
  SessionManager,
  atCapacityNotice,
} from './agent.js';
import { MailStore } from './mail.js';
import { MailWaker } from './mail-wake.js';
import { ArmedStore } from './armed.js';
import { ArmedWaker } from './armed-wake.js';
import { GitHubClient, type PullRequestSource } from './github.js';
import type { TokenProvider } from './github-app.js';
import { appTokenProvider, checkAppConfig, describeTokenShape } from './github-app.js';
import {
  TokenFileRefresher,
  tokenFilePath,
  writeCurlConfig,
  removeCurlConfig,
} from './token-file.js';
import { WakerStatusPublisher } from './waker-status.js';
import { ConversationWindows } from './window.js';
import { MessageBundler, type BufferedMessage } from './bundler.js';
import { systemd } from './systemd.js';
import { preflight } from './preflight.js';
import { sweepEnvFiles } from './container.js';
import { AuthLogin, AuthOutage, type DeadCredential } from './auth.js';
import type { SubmitOutcome } from './auth.js';
import type { TurnSummary, WakeContext } from './types.js';

/** What the Discord handlers need, and nothing else; each entry is a thing a test can substitute. */
export type HandlerDeps = {
  readonly config: Config;
  readonly client: Client;
  readonly sessions: SessionManager;
  readonly registry: AgentRegistry;
  readonly mail: MailStore | null;
  readonly mailWaker: MailWaker | null;
  readonly armedStore: ArmedStore | null;
  readonly github: PullRequestSource | null;
  readonly windows: ConversationWindows;
  readonly alwaysOnChannels: ReadonlySet<string>;
  /** Decides whether a refusal is a dead credential, and says so. */
  readonly authOutage: AuthOutage;
  /** The login behind `!auth`. */
  readonly authLogin: AuthLogin;
};

/** A message as `handleMessageUpdate` reads it — an edit arrives partial. */
type UpdatedMessage = { readonly author: { readonly id: string } | null; readonly channelId: string };

export type DiscordHandlers = {
  /** Built beside `deliver`: the bundler's flush handler is `deliver`. */
  readonly bundler: MessageBundler;
  handleMessage: (message: Message) => Promise<void>;
  handleMessageUpdate: (updated: UpdatedMessage) => void;
  handleCommand: (message: Message, command: string, rest?: string) => Promise<boolean>;
  deliver: (channelId: string, buffered: BufferedMessage[], afterRespawn?: boolean) => void;
  announceOutage: (channelId: string, summary: TurnSummary) => Promise<void>;
  announceAtCapacity: (channelId: string, error: AtCapacityError) => Promise<void>;
  isAuthorized: (message: Message) => boolean;
  stripMention: (message: Message) => string;
};

/** The three session events a mail wake logs and reacts to. They do not settle the mail: `AgentSession` does, through `TurnSettle`. */
export function mailWakeEvents(opts: {
  persist: () => void;
  release: () => void;
  err: (line: string) => void;
  /** The mail-wake journal, for the completion line. Same sink as `woke X with N`. */
  log: (line: string) => void;
  /** A refused turn with no retry coming. This wiring has no channel; the daemon decides what to say. */
  onRefused?: (summary: TurnSummary) => void;
  agentId: string;
}): {
  onDone: (summary: TurnSummary) => void;
  onError: (error: Error) => void;
  onNeedsRespawn: () => void;
} {
  const { persist, release, err, log, onRefused, agentId } = opts;
  return {
    onDone: (summary) => {
      persist();
      if (summary.apiError) {
        err(
          `mail wake REFUSED (${summary.apiErrorKind})\n` +
            `  ${String(summary.apiError).replace(/\s+/g, ' ').slice(0, 300)}\n` +
            (summary.retryScheduled
              ? `  retry ${summary.retryAttempt} queued`
              : '  not retrying — mail left unread for the next sweep'),
        );
        if (!summary.retryScheduled) onRefused?.(summary);
        return;
      }

      log(
        `${agentId}: mail wake turn ${summary.subtype}` +
          (summary.isError ? ' (isError)' : '') +
          (summary.costUsd === undefined ? '' : ` — $${summary.costUsd.toFixed(4)}`) +
          (summary.numTurns === undefined ? '' : `, ${summary.numTurns} model turn(s)`),
      );
    },
    onError: (error) => {
      err(error.message);
      release();
    },
    onNeedsRespawn: () => {
      err('stale token on a mail wake — dropping session');
      release();
    },
  };
}

/** What `!auth <code>` says back. */
function submitReply(outcome: SubmitOutcome): string {
  if (outcome.ok) return '**Authenticated.** Sessions will pick the new credential up.';
  switch (outcome.reason) {
    case 'bad-code':
      return `Not sending that: ${outcome.detail}.`;
    case 'none-waiting':
      return 'No login is waiting for a code. Run `!auth` to start one.';
    case 'not-taken':
      return 'That did not take — `auth status` still says logged out. Run `!auth` for a fresh link.';
    case 'unreadable':
      return `Code accepted, but \`auth status\` could not be read back: ${outcome.detail}`;
    default:
      return `Could not hand the code to the login: ${outcome.detail}`;
  }
}

/** Post to a channel by id. Throws; every caller decides for itself what a failure to speak is worth. */
async function sendToChannel(client: Client, channelId: string, text: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !('send' in channel)) return;
  await channel.send(text);
}

/** Cut to `max`, at a word boundary, marking that something was removed. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The journal's half-line reason for no retry. */
export function noRetryJournalReason(summary: TurnSummary): string {
  switch (summary.noRetryReason) {
    case 'exhausted':
      return 'transient, but every retry was spent';
    case 'abandoned':
      return 'retries left — the session was closed or cleared under it';
    case 'credential-dead':
      return 'the auth retry was spent — the credential itself is dead';
    default:
      return 'this one does not clear on its own';
  }
}

/** What to tell the human when a turn was refused and nothing is coming: whose fault it is, whether they were heard, and what to do. */
export function outageMessage(summary: TurnSummary): string {
  const heard = '**Your message did not reach me.**';
  const detail = truncate((summary.apiError ?? '').replace(/\s+/g, ' ').trim(), 200);

  switch (summary.noRetryReason) {
    case 'exhausted':
      return (
        `⚠️ Anthropic's API refused that turn — their side, not ours` +
        (detail ? `: ${detail}` : '.') +
        `\n${heard} Try again in a few minutes.`
      );
    case 'abandoned':
      // Rungs were left on the ladder and something on THIS side took them away:
      // `!reset`, `!stop`, or a dead child process.
      return (
        `⚠️ That turn hit an API error and I was retrying it, but the session ` +
        `was cleared before the retry ran.\n${heard} Send it again.`
      );
    case 'credential-dead':
      // The auth ladder is spent and a respawn has already failed, with a
      // credential file that still reads as refreshable.
      return (
        `⚠️ I could not authenticate to the API, and retrying did not fix it` +
        (detail ? `: ${detail}` : '.') +
        `\n${heard} Run \`!auth\` to log in again.`
      );
    default:
      // `not-retryable`: a standing condition a retry reproduces exactly.
      return (
        `⚠️ I could not run that turn — the API refused it ` +
        `(\`${summary.apiErrorKind}\`), and that is a standing condition a retry ` +
        `cannot change` +
        (detail ? `: ${detail}` : '.') +
        `\n${heard} This one needs a look at the host.`
      );
  }
}

export function createHandlers(deps: HandlerDeps): DiscordHandlers {
  const { config, client, sessions, registry, mail, mailWaker } = deps;
  const { armedStore, github, windows, alwaysOnChannels, authOutage, authLogin } = deps;

  /** Anyone in the server may wake the agent — there is no per-user allowlist. */
  function isAuthorized(message: Message): boolean {
    return config.agent.discord.allowedChannelIds.includes(message.channelId);
  }

  /** Strip the leading bot mention so the agent sees the actual request. */
  function stripMention(message: Message): string {
    const botId = client.user?.id;
    if (!botId) return message.content.trim();
    return message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
  }

  async function handleCommand(message: Message, command: string, rest = ''): Promise<boolean> {
    const channelId = message.channelId;

    switch (command) {
      /**
       * Log this crew back in. Answered here rather than by the agent, which
       * cannot run while the credential it authenticates with is dead. Gated on
       * the channel check and nothing else: anyone in the room may log the crew
       * in, with any Claude account.
       */
      case 'auth': {
        const login = authLogin;

        if (rest !== '') {
          await message.reply(submitReply(await login.submit(rest)));
          return true;
        }

        const status = await login.status();
        if (status.loggedIn === true) {
          await message.reply('Logged in already — `auth status` says so. Nothing to do.');
          return true;
        }
        const started = await login.begin();
        await message.reply(
          'url' in started
            ? `${status.loggedIn === false ? 'Logged out.' : `Could not read \`auth status\` (${status.detail}).`}` +
                ` **Authorize here:** ${started.url}\nThen paste the code back with \`!auth <code>\`.`
            : `Could not start a login: ${started.error}`,
        );
        return true;
      }

      case 'stop': {
        if (!sessions.has(channelId)) {
          await message.reply('Nothing running here.');
          return true;
        }
        const session = sessions.acquire(channelId, silentEvents());
        await session.interrupt();
        await message.reply('Interrupted.');
        return true;
      }

      case 'reset': {
        // Not awaited: the slot is free as soon as `release` returns its promise, but
        // the drain waits on the SDK stream — 4m14s on 2026-08-24, which is how long
        // `Session cleared` took to arrive.
        const draining = sessions.release(channelId);
        // The session, not the identity: the registry row is what mail is
        // addressed to, so deleting it would throw away the mailbox along with
        // the transcript.
        registry.clearSession(channelId);
        await message.reply('Session cleared. The next mention starts fresh.');

        // Not dropped either: an unobserved rejection is an unhandled one.
        void draining
          .then(() => process.stdout.write(`[clawcius ${channelId}] reset: old session drained\n`))
          .catch((error) =>
            process.stderr.write(
              `[clawcius ${channelId}] reset: draining the old session failed — ${String(error)}\n`,
            ),
          );
        return true;
      }

      case 'status': {
        const persisted = registry.get(channelId);
        await message.reply(
          [
            `Build ${BUILD_INFO.shortCommit ?? 'unknown'}${BUILD_INFO.dirty ? ' (dirty)' : ''}`,
            `Sessions: ${sessions.liveCount}/${config.agent.sessions.maxConcurrent} live, ${sessions.busyCount} mid-turn`,
            persisted?.sessionId
              ? `This channel: session ${persisted.sessionId.slice(0, 8)}…, ${mail ? mail.unread(channelId).length : 0} unread mail`
              : 'This channel: no session yet',
            armedStore ? `Armed: ${armedStore.listFor(channelId).length} condition(s)` : 'Armed: disabled',
          ].join('\n'),
        );
        return true;
      }

      default:
        return false;
    }
  }



  function silentEvents() {
    return {
      onToolUse: () => {},
      onDone: () => {},
      onError: () => {},
      // Reached only by `!stop`/`!status`, which acquire a session to look at or
      // interrupt it rather than to run a turn. There is no wake in flight to
      // rescue, so respawning here would be churn.
      onNeedsRespawn: () => {},
    };
  }

  async function handleMessage(message: Message): Promise<void> {
    if (!client.user) return;

    // Our account also posts as vidbot; only the agent's own replies, stamped by
    // the discord CLI, keep the conversation alive.
    if (message.author.id === client.user.id) {
      if (message.nonce === 'agent') windows.extend(message.channelId);
      return;
    }
    if (message.author.bot) return;

    const mentioned = message.mentions.has(client.user);
    // An always-on channel is a standing invitation: treat every message as if it
    // had carried an @. Kept distinct from `mentioned` below, because stripping a
    // mention that was never typed would eat real text.
    const alwaysOn = alwaysOnChannels.has(message.channelId);
    const addressed = mentioned || alwaysOn;
    const inWindow = windows.isOpen(message.channelId);

    // Wake on an explicit mention, in an always-on channel, or on any message
    // while a window is open. Without one of those the agent would fire on every
    // message it can see.
    if (!addressed && !inWindow) return;

    if (!isAuthorized(message)) return;

    const stripped = mentioned ? stripMention(message) : message.content.trim();
    // An @ with no text is still someone getting your attention.
    const emptyPlaceholder = mentioned ? '(mentioned you, no text)' : '(no text)';
    const content = stripped || (addressed ? emptyPlaceholder : '');
    if (!content) return;

    // Commands are handled by the waker, not the agent, and only when addressed —
    // otherwise any '!' line in a live channel would hit them. An always-on
    // channel counts as addressed: the room exists to talk to the bot.
    if (addressed && content.startsWith('!')) {
      const words = content.slice(1).split(/\s+/);
      const handled = await handleCommand(message, words[0] ?? '', words.slice(1).join(' '));
      if (handled) {
        windows.extend(message.channelId);
        return;
      }
    }

    // A fresh mention opens or extends the window.
    if (mentioned) windows.extend(message.channelId);

    bundler.add(message.channelId, {
      messageId: message.id,
      authorId: message.author.id,
      authorTag: message.author.tag,
      content,
      addressed,
      at: message.createdTimestamp,
    });
  }

  // Editing a message is Discord API activity too — the agent's progress
  // checklists work by editing, and those should keep the conversation alive.
  function handleMessageUpdate(updated: UpdatedMessage): void {
    if (client.user && updated.author?.id === client.user.id) {
      windows.extend(updated.channelId);
    }
  }

  /** Say, in the channel, that a turn was refused and will not be retried. */
  async function announceOutage(channelId: string, summary: TurnSummary): Promise<void> {
    try {
      await sendToChannel(client, channelId, outageMessage(summary));
    } catch (error) {
      // Best effort. If Discord is also unreachable the journal is the record,
      // and throwing out of a completion handler would take the process with it.
      process.stderr.write(
        `[clawcius ${channelId}] could not announce outage: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  /** Hand a coalesced bundle to the agent. */
  function deliver(channelId: string, buffered: BufferedMessage[], afterRespawn = false): void {
    if (buffered.length === 0) return;

    const context: WakeContext = {
      kind: 'messages',
      channelId,
      messages: buffered.map(({ messageId, authorId, authorTag, content, at }) => ({
        messageId,
        authorId,
        authorTag,
        content,
        at,
      })),
    };

    try {
      const session = sessions.acquire(channelId, {
        onToolUse: (tool, input) => {
          const cmd = typeof input['command'] === 'string' ? input['command'] : '';
          const detail = cmd ? `: ${cmd.replace(/\s+/g, ' ').slice(0, 160)}` : '';
          process.stdout.write(`[clawcius ${channelId}] ${tool}${detail}\n`);
        },
        onDone: (summary) => {
          sessions.persist(channelId);
          const seconds = (summary.durationMs / 1000).toFixed(1);
          if (summary.apiError) {
            // Loud and separate: the SDK reports the turn as succeeded, so the success line below would claim everything is fine.
            process.stderr.write(
              `[clawcius ${channelId}] API REFUSED THE TURN (${summary.apiErrorKind}) — ` +
                `the agent never ran\n` +
                `  ${summary.apiError.replace(/\s+/g, ' ').slice(0, 300)}\n` +
                (summary.retryScheduled
                  ? `  retry ${summary.retryAttempt} queued\n`
                  : `  not retrying — ${noRetryJournalReason(summary)}\n`),
            );
            // A respawn is about to be attempted for auth failures, so that path
            // owns the announcement. Saying "this needs a look at the host" here
            // would cry outage at something about to fix itself.
            const respawnWillHandleIt =
              summary.apiErrorKind === 'authentication_failed' && !afterRespawn;
            // `announceOutage` is the only thing in the tree that speaks to a channel on
            // a session's behalf, so the drain gate belongs here rather than in the
            // session, which cannot tell a channel wiring from the mail one. #264.
            if (!summary.retryScheduled && !respawnWillHandleIt && !summary.drained) {
              // A credential the disk says is finished gets the message that
              // names it, in place of the generic one.
              const dead = authOutage.owns(summary);
              if (dead) void authOutage.announce(dead, channelId);
              else void announceOutage(channelId, summary);
            }
          }
          process.stdout.write(
            `[clawcius ${channelId}] turn ${summary.subtype} in ${seconds}s ` +
              `$${summary.costUsd.toFixed(4)}\n`,
          );
        },
        onError: (error) => {
          process.stderr.write(`[clawcius ${channelId}] ${error.message}\n`);
          // A session whose child process is gone can never recover. Drop it so
          // the next message spawns a fresh one instead of failing forever.
          void sessions.release(channelId);
        },
        onNeedsRespawn: (acted) => {
          if (afterRespawn) {
            process.stderr.write(
              `[clawcius ${channelId}] respawned session ALSO failed to authenticate\n`,
            );
            return;
          }
          process.stderr.write(
            `[clawcius ${channelId}] stale token in a live session — respawning\n`,
          );
          void sessions.release(channelId).then(() => {
            // Replay only when the dead turn had not acted yet; a fresh session resumes a transcript whose work is already done.
            if (!acted) {
              deliver(channelId, buffered, true);
              return;
            }
            process.stderr.write(
              `[clawcius ${channelId}] not replaying — the dead turn had already acted\n`,
            );
          });
        },
      });

      session.wake(context);
    } catch (error) {
      process.stderr.write(
        `[clawcius ${channelId}] could not wake: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
      // A startup failure stays quiet — the bot narrating its own plumbing is worse than a dropped turn, and the next message usually works.
      if (error instanceof AtCapacityError) {
        void announceAtCapacity(channelId, error);
      }
    }
  }

  /** Say, in the channel, that there was no session slot. */
  async function announceAtCapacity(channelId: string, error: AtCapacityError): Promise<void> {
    try {
      await sendToChannel(client, channelId, atCapacityNotice(error));
    } catch (sendError) {
      // Best effort, as in announceOutage. If Discord is unreachable too, the
      // journal is the record, and throwing here would take the process down.
      process.stderr.write(
        `[clawcius ${channelId}] could not announce capacity: ` +
          `${sendError instanceof Error ? sendError.message : String(sendError)}\n`,
      );
    }
  }

  const bundler = new MessageBundler(
    config.agent.discord.bundleDebounceMs,
    config.agent.discord.bundleMaxWaitMs,
    deliver,
  );

  return {
    bundler,
    handleMessage,
    handleMessageUpdate,
    handleCommand,
    deliver,
    announceOutage,
    announceAtCapacity,
    isAuthorized,
    stripMention,
  };
}

/** Build everything the daemon runs, wire the Discord handlers, and log in. */
export async function main(): Promise<void> {
  const config = loadConfig();

  // WHAT IS IN `GITHUB_TOKEN`, said once, before anything can branch past it.
  const tokenShape = describeTokenShape(config.github.token);
  if (tokenShape) process.stderr.write(`[github] ${tokenShape}\n`);

  // Fail before touching Discord if the container stack is not actually up —
  // a missing agent or proxy container reads as a bot that never answers.
  await preflight();

  // Each turn writes its environment to a 0600 file and unlinks it when the exec ends; a SIGKILL of this process skips that.
  const sweptEnvFiles = sweepEnvFiles(config.agent.container.execEnvDir);
  if (sweptEnvFiles > 0) {
    process.stderr.write(
      `[clawcius] removed ${sweptEnvFiles} orphaned exec env file(s) from ` +
        `${config.agent.container.execEnvDir} — this process was killed mid-turn last time.\n`,
    );
  }

  const registry = new AgentRegistry(config.storage.dbPath, { crew: config.agent.clawsky.crew });

  /** The board. */
  const mail = config.agent.clawsky.enabled ? new MailStore(registry) : null;
  if (config.agent.clawsky.enabled) {
    for (const { id, role } of config.agent.clawsky.agents) {
      registry.ensure(id, {
        crew: config.agent.clawsky.crew,
        role,
        workspacePath: join(config.agent.sessions.workspaceRoot, id),
      });
    }
  }

  /** Armed conditions — `remindMe`, `scheduleRecurring` and `watchPr`. */
  const armedStore = config.agent.clawsky.enabled && config.agent.armed.enabled
    ? new ArmedStore(registry)
    : null;

  let github: PullRequestSource | null = null;
  // Declared here rather than beside its construction because `shutdown` is
  // out here and has to be able to stop it.
  let tokenFileRefresher: TokenFileRefresher | null = null;
  if (armedStore) {
    // Prefer the App when this deployment has one.
    const app = config.github.appId || config.github.appPrivateKeyPath;
    // PROVE IT BEFORE ARMING ANYTHING.
    let appTokenOk = false;
    let appProvider: TokenProvider | null = null;
    if (app) {
      const { usable, warning } = checkAppConfig({
        appId: config.github.appId,
        privateKeyPath: config.github.appPrivateKeyPath,
        installationId: config.github.appInstallationId || undefined,
        hasFallbackToken: Boolean(config.github.token),
      });
      appTokenOk = usable;
      if (warning) process.stderr.write(`[armed] ${warning}\n`);
    }
    if (app && appTokenOk) {
      // A PROVIDER, not a token.
      appProvider = appTokenProvider({
        appId: config.github.appId,
        privateKeyPath: config.github.appPrivateKeyPath,
        installationId: config.github.appInstallationId || undefined,
        apiBase: config.agent.armed.github.apiBase,
      });
      github = new GitHubClient(appProvider, config.agent.armed.github.apiBase);
      // Said only once the key has been shown readable.
      process.stderr.write(`[armed] authenticating as GitHub App ${config.github.appId}\n`);

      {
        tokenFileRefresher = new TokenFileRefresher({
          dir: config.agent.container.githubTokenDir,
          provider: appProvider,
          log: (message) => process.stderr.write(`${message}\n`),
        });
        if (await tokenFileRefresher.start()) {
          process.stderr.write(
            '[armed] agent git credentials come from ' +
              `${tokenFilePath(config.agent.container.githubTokenDir)}\n`,
          );
        }
      }
    } else if (config.github.token) {
      github = new GitHubClient(config.github.token, config.agent.armed.github.apiBase);
    } else {
      process.stderr.write(
        '[armed] GITHUB_TOKEN is not set in this process — watchPr will refuse to arm anything ' +
          'and say so. Set it in the EnvironmentFile named by this instance\'s unit, not only in ' +
          'the container.\n',
      );
    }
  }

  // The PAT-only deployment.
  if (!tokenFileRefresher && config.github.token) {
    writeCurlConfig(config.agent.container.githubTokenDir, config.github.token);
    process.stderr.write('[armed] agent REST calls use GITHUB_TOKEN (no App credential in use)\n');
  }

  const armedTools = armedStore
    ? {
        store: armedStore,
        github,
        defaultRepo: config.agent.armed.github.repo,
        pollSeconds: config.agent.armed.github.pollSeconds,
      }
    : null;

  /** `spawn` — CLAWSKY.md phase 5, offered to coordinator sessions. */
  const spawnLog = mail
    ? (line: string): void => {
        process.stdout.write(`[spawn] ${line}\n`);
      }
    : null;

  const sessions = new SessionManager(
    registry,
    mail,
    armedTools,
    spawnLog,
    // UNCONDITIONAL, unlike `spawnLog`.
    (line) => process.stdout.write(`[sessions] ${line}\n`),
  );

  // Assigned below, once there is a client to speak through: the mail waker is
  // built before the Discord client and reads this from inside a callback.
  let authOutage: AuthOutage | null = null;

  const mailWaker =
    mail && config.agent.clawsky.wakeOnMail
      ? new MailWaker({
          crew: config.agent.clawsky.crew,
          registry,
          mail,
          busy: (agentId) => sessions.isBusy(agentId),
          start: (agent, context, settle) => {
            const session = sessions.acquire(agent.id, {
              onToolUse: (tool) => process.stdout.write(`[clawcius ${agent.id}] ${tool}\n`),
              ...mailWakeEvents({
                persist: () => sessions.persist(agent.id),
                release: () => void sessions.release(agent.id),
                err: (line) => process.stderr.write(`[clawcius ${agent.id}] ${line}\n`),
                log: (line) => process.stdout.write(`[mail-wake] ${line}\n`),
                // No channel of its own, so the announcement goes to the crew's main one.
                onRefused: (summary) => {
                  const dead = authOutage?.owns(summary);
                  if (dead) void authOutage?.announce(dead, null);
                },
                agentId: agent.id,
              }),
            });
            session.wake(context, settle);
          },
          log: (line) => process.stdout.write(`[mail-wake] ${line}\n`),
        })
      : null;

  if (mail && mailWaker) {
    // Wrapped, as `onCountsChanged` is: this fires synchronously inside `deliver`, which may be inside another agent's `sendMail` call.
    mail.onDelivered = (message) => {
      try {
        mailWaker.onDelivered(message.recipient);
      } catch (error) {
        process.stderr.write(`[mail-wake] onDelivered failed: ${String(error)}\n`);
      }
    };
  }

  /** The loop that makes an armed condition come true. */
  const armedWaker =
    armedStore && mail
      ? new ArmedWaker({
          store: armedStore,
          registry,
          mail,
          github,
          tickMs: config.agent.armed.tickSeconds * 1000,
          log: (line) => process.stdout.write(`[armed] ${line}\n`),
        })
      : null;

  const windows = new ConversationWindows(
    config.agent.discord.followUpWindowSeconds,
    config.agent.discord.followUpChannelIds,
  );
  /** Tell the ops executor whether this instance is mid-turn. */
  const wakerStatus = new WakerStatusPublisher({
    path: config.agent.status.file,
    intervalSeconds: config.agent.status.intervalSeconds,
    instance: config.agent.status.instance,
    maxConcurrent: config.agent.sessions.maxConcurrent,
    liveCount: () => sessions.busyCount,
  });
  // Wrapped: a failed status write must never propagate into session handling.
  sessions.onCountsChanged = () => {
    try {
      wakerStatus.noteChange();
    } catch (error) {
      process.stderr.write(`[waker-status] noteChange failed: ${String(error)}\n`);
    }
    // A turn just ended: mail that arrived while this agent was busy is due now.
    try {
      mailWaker?.sweep();
    } catch (error) {
      process.stderr.write(`[mail-wake] sweep failed: ${String(error)}\n`);
    }
  };
  wakerStatus.start();

  const alwaysOnChannels = new Set(config.agent.discord.alwaysOnChannelIds);

  // An always-on channel that `allowedChannelIds` excludes wakes nothing at all.
  // That combination is always a mistake, and a silent one — the room simply
  // stays quiet — so say so at startup rather than at debugging time.
  const unreachable = [...alwaysOnChannels].filter(
    (id) => !config.agent.discord.allowedChannelIds.includes(id),
  );
  if (unreachable.length > 0) {
    console.warn(
      `[config] alwaysOnChannelIds ${unreachable.join(', ')} are not in allowedChannelIds — ` +
        'they will never wake the agent. Add them there.',
    );
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Privileged — enable in the Developer Portal under Bot → Privileged
      // Gateway Intents, or login fails outright.
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  const authLogin = new AuthLogin({
    target: {
      containerEnabled: config.agent.container.enabled,
      containerName: config.agent.container.name,
      claudePath: config.agent.container.claudePath,
      hostClaudePath: config.agent.paths.claudeCli,
      home: config.agent.container.agentHome,
    },
    log: (line) => process.stdout.write(`[auth] ${line}\n`),
  });
  authOutage = new AuthOutage({
    home: config.agent.container.agentHome,
    // The crew's main channel. The schema requires at least one.
    mainChannelId: config.agent.discord.allowedChannelIds[0]!,
    crew: config.agent.displayName,
    send: (channelId, text) => sendToChannel(client, channelId, text),
    log: (line) => process.stdout.write(`[auth] ${line}\n`),
  });

  const handlers = createHandlers({
    config,
    client,
    sessions,
    registry,
    mail,
    mailWaker,
    armedStore,
    github,
    windows,
    alwaysOnChannels,
    authOutage,
    authLogin,
  });
  const { bundler } = handlers;

  client.on(Events.MessageCreate, (message) => void handlers.handleMessage(message));
  client.on(Events.MessageUpdate, (_old, updated) => handlers.handleMessageUpdate(updated));

  const windowSweeper = setInterval(() => windows.sweep(), 60_000);
  windowSweeper.unref();

  mailWaker?.start();
  armedWaker?.start();

  client.once(Events.ClientReady, (ready) => {
    // Stamped with the pid and the boot time because Restart=always makes a crash and a deliberate restart look identical afterwards.
    process.stdout.write(
      `[clawcius] logged in as ${ready.user.tag} — pid ${process.pid}, ` +
        `started ${new Date(Date.now() - process.uptime() * 1000).toISOString()}\n`,
    );
    systemd.ready();
    systemd.status(`connected as ${ready.user.tag}`);
  });

  // Only pet the watchdog while the gateway is genuinely healthy, so a wedged connection gets us restarted instead of sitting there looking alive.
  const interval = systemd.watchdogIntervalMs;
  if (interval) {
    let skippingSince: number | null = null;
    let warnedImminent = false;

    const heartbeat = setInterval(() => {
      const ready = client.isReady();
      const ping = client.ws.ping;
      const healthy = ready && ping >= 0;

      if (healthy) {
        if (skippingSince !== null) {
          const seconds = ((Date.now() - skippingSince) / 1000).toFixed(1);
          process.stdout.write(
            `[watchdog] gateway healthy again after ${seconds}s of skipped pings\n`,
          );
          skippingSince = null;
          warnedImminent = false;
        }
        systemd.watchdog();
        return;
      }

      const why = !ready ? 'client not ready' : `ws.ping ${ping}`;
      if (skippingSince === null) {
        skippingSince = Date.now();
        warnedImminent = false;
        process.stdout.write(
          `[watchdog] skipping ping: ${why}. ` +
            `systemd kills us after ${(interval / 1000).toFixed(0)}s without one.\n`,
        );
        return;
      }

      // One more line once we are past halfway, so the journal shows how close
      // it came rather than just that it started.
      const elapsed = Date.now() - skippingSince;
      if (!warnedImminent && elapsed > interval / 2) {
        warnedImminent = true;
        process.stderr.write(
          `[watchdog] still skipping after ${(elapsed / 1000).toFixed(0)}s (${why}). ` +
            `Kill expected at ${(interval / 1000).toFixed(0)}s; ` +
            `all ${sessions.liveCount} live session(s) would be lost.\n`,
        );
      }
    }, Math.max(interval / 3, 5000));
    heartbeat.unref();
  }

  async function shutdown(signal: string): Promise<void> {
    process.stdout.write(`[clawcius] ${signal} received, shutting down\n`);
    systemd.stopping();
    try {
      mailWaker?.stop();
      // Stopping the timer loses nothing: every armed condition is a row, and
      // one that comes due while this process is down fires late on the next
      // start rather than not at all.
      armedWaker?.stop();
      wakerStatus.stop();
      wakerStatus.removeOnShutdown();
      clearInterval(windowSweeper);
      bundler.flushAll();
      tokenFileRefresher?.stop();
      // AND THE BRANCH WITH NO REFRESHER TO HANG IT ON.
      if (!tokenFileRefresher) {
        try {
          removeCurlConfig(config.agent.container.githubTokenDir);
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? String(error.code) : 'failed';
          process.stderr.write(
            `[clawcius] could not remove the curl credential on shutdown (${code}); ` +
              'a usable token may remain on disk. Shutdown continues.\n',
          );
        }
      }
      authLogin.stop();
      await sessions.shutdown();
      registry.close();
      await client.destroy();
    } finally {
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[clawcius] unhandled rejection: ${String(reason)}\n`);
  });

  await client.login(config.discord.token);
}
