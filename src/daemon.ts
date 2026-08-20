/**
 * The Clawcius daemon: everything `main()` builds at startup, and the Discord
 * handlers it wires.
 *
 * This process is deliberately thin. It listens on the gateway, authorizes the
 * mention, and hands the agent context. It does not compose or send replies —
 * the agent does that itself by invoking the `discord` CLI.
 *
 * The one exception is the no-reply fallback: if an agent turn ends without
 * having called the CLI, the user would otherwise see nothing at all, which is
 * indistinguishable from the bot being down. So the waker says something.
 *
 * ── Why this is a module and not the body of index.ts ───────────────────────
 *
 * It was the body of index.ts until Clawcius #131. Importing a module runs its
 * body, so an 870-line body that ends in `await client.login(...)` is a module
 * that cannot be imported without starting a Discord bot — and every decision
 * in it was therefore unreachable by a test. #133 fixed the same defect one
 * layer down (`config.ts` read the environment while it was being evaluated)
 * and stated the convention it was half of:
 *
 *   1. Config is loaded by a function the entry point calls.
 *   2. An entry point's body is a `main()`; the handlers it wires are exported.
 *
 * This is (2) for the root package. `main()` is the old body, in the old order,
 * and `createHandlers()` returns the handlers it used to define inline. What
 * they closed over is now a parameter, which is the whole of the change: a test
 * hands `createHandlers` a fake session pool and a fake Discord client and gets
 * back the real `deliver`, the real `onDone` and the real `onNeedsRespawn`.
 *
 * ── Why the split rather than a direct-run guard ────────────────────────────
 *
 * The usual way to make an entry point importable is to leave everything in one
 * file and end it with `if (import.meta.url === pathToFileURL(process.argv[1]))
 * await main()`. That was rejected. Its failure mode is a daemon that starts,
 * prints its build banner, runs nothing and exits 0 — a comparison that depends
 * on how systemd happened to spell the path, symlinks included, and which reads
 * from outside as a service that came up fine. index.ts calls `main()`
 * unconditionally instead, so there is no state in which the daemon can decline
 * to be the daemon.
 *
 * NOTHING HERE IMPORTS ./build-banner.js, and that is deliberate twice over.
 * The banner is the FIRST import of index.ts and must stay there (#89, and
 * test/build-info.test.js pins it on the compiled artefact); importing it from
 * here as well would let someone drop it from index.ts with the banner still
 * printing, which is exactly the pin coming loose. It would also print a build
 * line into the output of every test that imports this module.
 */

import { Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { AgentRegistry, hostAgentId } from './store.js';
import { AtCapacityError, SessionManager, atCapacityNotice } from './agent.js';
import { MailStore } from './mail.js';
import { MailWaker } from './mail-wake.js';
import { ArmedStore } from './armed.js';
import { ArmedWaker } from './armed-wake.js';
import { GitHubClient, type PullRequestSource } from './github.js';
import { WakerStatusPublisher } from './waker-status.js';
import { ConversationWindows } from './window.js';
import { MessageBundler, type BufferedMessage } from './bundler.js';
import { systemd } from './systemd.js';
import { preflight } from './preflight.js';
import { sweepEnvFiles } from './container.js';
import type { TurnSummary, WakeContext } from './types.js';

/**
 * What the Discord handlers need, and nothing else.
 *
 * Every field here used to be a `const` in the module body that the handlers
 * closed over. Naming them is what makes the handlers reachable: the list is
 * short, and each entry is a thing a test can substitute — a session pool whose
 * `acquire` records the events it was handed, a client whose `channels.fetch`
 * returns a channel that remembers what it was sent.
 *
 * `config` is the object `loadConfig()` returned, passed in rather than read
 * through `config()`, so every `config.` below is byte-identical to what it was
 * in index.ts and reads the same way (#133).
 */
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
};

/** A message as `handleMessageUpdate` reads it — an edit arrives partial. */
type UpdatedMessage = { readonly author: { readonly id: string } | null; readonly channelId: string };

export type DiscordHandlers = {
  /**
   * Built here rather than by `main`, because the bundler and `deliver` are two
   * halves of one thing: the bundler's flush handler IS `deliver`, and `deliver`
   * is a closure over these deps. Returned so `main` can flush it on shutdown
   * and so `!status` can count what is pending.
   */
  readonly bundler: MessageBundler;
  handleMessage: (message: Message) => Promise<void>;
  handleMessageUpdate: (updated: UpdatedMessage) => void;
  handleCommand: (message: Message, command: string) => Promise<boolean>;
  deliver: (channelId: string, buffered: BufferedMessage[], afterRespawn?: boolean) => void;
  announceOutage: (channelId: string, summary: TurnSummary) => Promise<void>;
  announceAtCapacity: (channelId: string, error: AtCapacityError) => Promise<void>;
  describeHostAgent: () => string;
  describeCrew: () => string;
  isAuthorized: (message: Message) => boolean;
  stripMention: (message: Message) => string;
};

export function createHandlers(deps: HandlerDeps): DiscordHandlers {
  const { config, client, sessions, registry, mail, mailWaker } = deps;
  const { armedStore, github, windows, alwaysOnChannels } = deps;

  /**
   * Anyone in the server may wake the agent — there is no per-user allowlist.
   * The only gate is an optional channel restriction, so the bot can be confined
   * to specific rooms without also maintaining a roster of people.
   */
  function isAuthorized(message: Message): boolean {
    const { allowedChannelIds } = config.agent.discord;
    if (allowedChannelIds.length === 0) return true;
    return allowedChannelIds.includes(message.channelId);
  }

  /** Strip the leading bot mention so the agent sees the actual request. */
  function stripMention(message: Message): string {
    const botId = client.user?.id;
    if (!botId) return message.content.trim();
    return message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
  }

  async function handleCommand(message: Message, command: string): Promise<boolean> {
    const channelId = message.channelId;

    switch (command) {
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
        await sessions.release(channelId);
        // The session, not the identity: the registry row is what mail is
        // addressed to, so deleting it would throw away the mailbox along with
        // the transcript.
        registry.clearSession(channelId);
        await message.reply('Session cleared. The next mention starts fresh.');
        return true;
      }

      case 'status': {
        const persisted = registry.get(channelId);
        const idle = config.agent.sessions.idleTimeoutMinutes;
        await message.reply(
          [
            `Live sessions: ${sessions.liveCount}/${config.agent.sessions.maxConcurrent}` +
              ` (${sessions.busyCount} mid-turn)`,
            `Model: ${config.agent.model}`,
            `Turns: ${config.agent.maxTurns === 0 ? 'unlimited' : config.agent.maxTurns}`,
            `Idle eviction: ${idle === 0 ? 'never' : `${idle}m`}`,
            `Buffered: ${bundler.pendingCount(channelId)} message(s)`,
            `Container: ${config.agent.container.name}`,
            `Always-on: ${alwaysOnChannels.has(channelId) ? 'yes — every message wakes me' : 'no'}`,
            `Follow-up window: ${
              !windows.enabled
                ? 'disabled'
                : !windows.allows(channelId)
                  ? 'not permitted in this channel'
                  : windows.isOpen(channelId)
                    ? `open, ${windows.remainingSeconds(channelId)}s left`
                    : `closed (${config.agent.discord.followUpWindowSeconds}s when open)`
            }`,
            // Naming the enforcing proxy matters: "uncontrolled" here would be the
            // difference between a contained agent and one with open egress.
            `Egress: Squid allowlist (${config.agent.container.name} has no other route)`,
            persisted?.sessionId
              ? `This channel: session ${persisted.sessionId.slice(0, 8)}…`
              : 'This channel: no session yet',
            mail
              ? `Mail: ${mail.unread(channelId).length} unread as ${channelId} (crew ${config.agent.clawsky.crew})` +
                `, wake-on-mail ${mailWaker ? 'on' : 'off'}`
              : 'Mail: disabled',
            // Whether the ops executor has claimed its row. A coordinator that
            // is about to be told "unknown recipient" would rather find out here.
            mail ? `Host agent: ${describeHostAgent()}` : 'Host agent: unreachable (mail disabled)',
            // The crew, by role. Spawning has no cap on purpose, so this is one
            // of the places the cost is meant to be visible — a coordinator that
            // has quietly accumulated nine engineers can see it from Discord
            // rather than only from the status page.
            mail ? `Crew: ${describeCrew()}` : 'Crew: not on a board (mail disabled)',
            // Whether watchPr can arm at all is a property of THIS process, and
            // the agent inside the container has no way to see it — its own
            // GITHUB_TOKEN says nothing about the waker's. So it is reported.
            armedStore
              ? `Armed: ${armedStore.listFor(channelId).length} condition(s) for ${channelId}` +
                `, GitHub ${github ? 'reachable' : 'UNAVAILABLE — no token in the waker process'}`
              : 'Armed: disabled',
          ].join('\n'),
        );
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Is there a host agent on this board, and is this channel allowed to reach it?
   *
   * The row is created by the ops executor, not here, so its absence is a real
   * answer rather than a missing feature: it means no process that can actually
   * run the host agent has claimed the name. Read-only — nothing about this
   * enforces anything, the rule lives in `MailStore.deliver`.
   */
  function describeHostAgent(): string {
    const id = hostAgentId(config.agent.clawsky.crew);
    const row = registry.get(id);
    if (!row || row.role !== 'host') {
      return `${id} is not on this board — the ops executor has not registered it ` +
        '(no board: block in ops-config.yaml, or it could not open the database)';
    }
    return `DM ${id} — coordinators only, enforced in code`;
  }

  /**
   * Who is on this crew's board, by role, and how many of them were spawned.
   *
   * Read straight from the registry on every `!status` rather than counted as
   * spawns happen: the rows are the record, and a tally kept alongside them would
   * be a second one that can disagree after a restart or an operator edit.
   *
   * ROWS, and the word is chosen. A count of `coordinator` here is NOT the number
   * of coordinators the crew has: sessions are keyed on `message.channelId`,
   * which is per thread as well as per channel, and `#identityFor`'s fallback
   * writes any id the registry has not heard of as a `coordinator`. So the number
   * is "Discord conversations this bot has been woken in", and a line reading
   * `9 coordinator` would be read by everybody as nine agents. The parenthetical
   * is load-bearing; do not trim it.
   *
   * `host` is counted too, and named as not being a crew member, because it does
   * sit on this board — leaving it out would make the total disagree with the
   * status page for no stated reason.
   */
  function describeCrew(): string {
    const crew = config.agent.clawsky.crew;
    const rows = registry.listByCrew(crew);
    if (rows.length === 0) return `${crew} — no rows on the board`;

    const byRole = new Map<string, number>();
    for (const row of rows) byRole.set(row.role, (byRole.get(row.role) ?? 0) + 1);
    const roles = [...byRole.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([role, n]) => `${n} ${role}`)
      .join(', ');
    const spawned = rows.filter((row) => row.spawnedBy !== null).length;

    const notes: string[] = [];
    if ((byRole.get('coordinator') ?? 0) > 1) {
      notes.push('a coordinator row is one Discord channel or thread, not one agent');
    }
    if (byRole.has('host')) notes.push('the host runs outside the container and is not crew');
    notes.push(spawned > 0 ? `${spawned} spawned` : 'none spawned');

    return `${crew} — ${rows.length} row(s): ${roles} (${notes.join('; ')})`;
  }

  function silentEvents() {
    return {
      onToolUse: () => {},
      onDone: () => {},
      onError: () => {},
      onCliFailure: () => {},
      // Reached only by `!stop`/`!status`, which acquire a session to look at or
      // interrupt it rather than to run a turn. There is no wake in flight to
      // rescue, so respawning here would be churn.
      onNeedsRespawn: () => {},
    };
  }

  async function handleMessage(message: Message): Promise<void> {
    if (!client.user) return;

    // Our own traffic extends the window rather than waking anything: the bot
    // having just spoken is exactly what should keep the conversation alive.
    if (message.author.id === client.user.id) {
      windows.extend(message.channelId);
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
    // An @ with no text is still someone getting your attention. Hand it over
    // and let the agent decide what to do with it, rather than the waker
    // answering on its behalf. A bare attachment in an always-on channel is the
    // same situation without the @, so both get a placeholder rather than a drop.
    const emptyPlaceholder = mentioned ? '(mentioned you, no text)' : '(no text)';
    const content = stripped || (addressed ? emptyPlaceholder : '');
    if (!content) return;

    // Commands are handled by the waker, not the agent, and only when addressed —
    // otherwise any '!' line in a live channel would hit them. An always-on
    // channel counts as addressed: the room exists to talk to the bot.
    if (addressed && content.startsWith('!')) {
      const handled = await handleCommand(message, content.slice(1).split(/\s+/)[0] ?? '');
      if (handled) {
        windows.extend(message.channelId);
        return;
      }
    }

    // A fresh mention opens or extends the window. A follow-up does not: the
    // window is anchored to bot activity, not to people talking near it. Keyed on
    // `mentioned` rather than `addressed` so an always-on channel doesn't churn
    // window state it never consults.
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

  /**
   * Say, in the channel, that a turn was refused and will not be retried.
   *
   * This process otherwise never speaks for the agent, and that restraint is
   * deliberate. The exception earns itself: silence is the agent's normal way of
   * declining to answer, so an outage wearing the same face is unreadable from
   * Discord — the failure that started all this looked exactly like being
   * ignored. Only terminal failures reach here; anything with a retry queued
   * stays quiet, because it is not yet news.
   */
  async function announceOutage(channelId: string, summary: TurnSummary): Promise<void> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) return;
      await channel.send(
        `⚠️ I could not run that turn — the API refused it (\`${summary.apiErrorKind}\`). ` +
          `Retries are exhausted or would not help, so this needs a look at the host.`,
      );
    } catch (error) {
      // Best effort. If Discord is also unreachable the journal is the record,
      // and throwing out of a completion handler would take the process with it.
      process.stderr.write(
        `[clawcius ${channelId}] could not announce outage: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  /**
   * Hand a coalesced bundle to the agent.
   *
   * Silence is a normal outcome — nothing here checks whether the agent replied,
   * and nothing posts on its behalf. Whether to speak is the agent's decision,
   * shaped by systemPrompt.append, not by this process.
   */
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
        onCliFailure: (command, output) => {
          process.stderr.write(
            `[clawcius ${channelId}] discord CLI FAILED — nothing was posted\n` +
              `  cmd: ${command.replace(/\s+/g, ' ').slice(0, 200)}\n` +
              `  out: ${output.replace(/\s+/g, ' ').slice(0, 300)}\n`,
          );
        },
        onDone: (summary) => {
          sessions.persist(channelId);
          const seconds = (summary.durationMs / 1000).toFixed(1);
          if (summary.apiError) {
            // Loud and separate: the turn "succeeded" as far as the SDK is
            // concerned, so the success line below is about to claim everything
            // is fine. From Discord this is indistinguishable from the agent
            // deciding not to answer.
            process.stderr.write(
              `[clawcius ${channelId}] API REFUSED THE TURN (${summary.apiErrorKind}) — ` +
                `the agent never ran\n` +
                `  ${summary.apiError.replace(/\s+/g, ' ').slice(0, 300)}\n` +
                (summary.retryScheduled
                  ? `  retry ${summary.retryAttempt} queued\n`
                  : `  not retrying — this one does not clear on its own\n`),
            );
            // A respawn is about to be attempted for auth failures, so that path
            // owns the announcement. Saying "this needs a look at the host" here
            // would cry outage at something about to fix itself.
            const respawnWillHandleIt =
              summary.apiErrorKind === 'authentication_failed' && !afterRespawn;
            if (!summary.retryScheduled && !respawnWillHandleIt) {
              void announceOutage(channelId, summary);
            }
          }
          process.stdout.write(
            `[clawcius ${channelId}] turn ${summary.subtype} in ${seconds}s ` +
              `$${summary.costUsd.toFixed(4)} (spoke=${summary.sentMessage})\n`,
          );
        },
        onError: (error) => {
          process.stderr.write(`[clawcius ${channelId}] ${error.message}\n`);
          // A session whose child process is gone can never recover. Drop it so
          // the next message spawns a fresh one instead of failing forever.
          void sessions.release(channelId);
        },
        onNeedsRespawn: (acted) => {
          // Once per wake: afterRespawn suppresses a second round, so a genuinely
          // dead credential fails twice and stops rather than spawning forever.
          if (afterRespawn) {
            // Log only. onDone has already announced this turn: on the respawned
            // attempt `respawnWillHandleIt` is false, so its announceOutage call
            // fires. Announcing here too put the same warning in the channel
            // twice per failure — observed on 2026-08-03 as four identical
            // messages in three seconds, which reads as a broken bot rather than
            // a broken credential.
            process.stderr.write(
              `[clawcius ${channelId}] respawned session ALSO failed to authenticate — ` +
                `the credential on disk is not usable. Needs a re-login on the host.\n`,
            );
            return;
          }
          process.stderr.write(
            `[clawcius ${channelId}] stale token in a live session — respawning\n`,
          );
          void sessions.release(channelId).then(() => {
            // Replay only when the dead turn had not acted yet. An auth failure
            // normally lands on the first API call having spent nothing, which is
            // why this is worth doing at all; but if tools had already run, the
            // fresh session resumes a transcript whose work is already done and
            // replaying the request would repeat it.
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
      // A startup failure stays quiet — the bot narrating its own plumbing is
      // worse than a dropped turn, and the next message usually works.
      //
      // A FULL POOL IS DIFFERENT and is the exception this earns. Nothing is
      // wrong with the request, the channel or the credentials; the messages in
      // this bundle are dropped and no later message in this channel will fare
      // any better, because with `idleTimeoutMinutes: 0` nothing releases a
      // session short of a restart. Silence there is indistinguishable from the
      // bot being down — the same reading `announceOutage` exists to prevent —
      // and spawn is what makes it reachable by a coordinator rather than only
      // by the operator: a spawned agent that has taken a turn holds one of
      // these slots and `!reset` cannot reach it to give it back.
      if (error instanceof AtCapacityError) {
        void announceAtCapacity(channelId, error);
      }
    }
  }

  /**
   * Say, in the channel, that there was no session slot.
   *
   * The sentence itself is `atCapacityNotice` in agent.ts. What is left here is
   * the Discord plumbing: find the channel, send, and never throw out of either.
   */
  async function announceAtCapacity(channelId: string, error: AtCapacityError): Promise<void> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) return;
      await channel.send(atCapacityNotice(error, config.agent.sessions.idleTimeoutMinutes));
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
    describeHostAgent,
    describeCrew,
    isAuthorized,
    stripMention,
  };
}

/**
 * The program.
 *
 * This is the old body of index.ts, in the old order, and the order is
 * load-bearing: `loadConfig()` first so a waker with no `DISCORD_TOKEN` dies at
 * startup on the same line of the journal with the same message; `preflight()`
 * before anything touches Discord; the wakers started after the stores they
 * read exist.
 *
 * Exported and called by index.ts rather than run on import, which is Clawcius
 * #131 — see the header.
 */
export async function main(): Promise<void> {
  // The environment is read HERE, not by importing `./config.js` — that is the
  // whole of Clawcius #130. Importing a module should not need a deployment
  // underneath it, or nothing that imports this graph can be tested; loading is
  // something an entry point does. This is the first statement of `main()`, and
  // `main()` is the first statement of index.ts, so a waker with no
  // DISCORD_TOKEN still dies at startup with the same message.
  //
  // Every `config.` below is this constant, and every one of them reads the same
  // way as before.
  const config = loadConfig();

  // Fail before touching Discord if the container stack is not actually up —
  // a missing agent or proxy container reads as a bot that never answers.
  await preflight();

  // Each turn writes its environment to a 0600 file and unlinks it when the exec
  // ends; a SIGKILL of this process skips that. This is where those survivors are
  // collected, because a file holding both tokens should not outlive the process
  // that wrote it by more than a restart. Nothing else deletes them.
  const sweptEnvFiles = sweepEnvFiles(config.agent.container.execEnvDir);
  if (sweptEnvFiles > 0) {
    process.stderr.write(
      `[clawcius] removed ${sweptEnvFiles} orphaned exec env file(s) from ` +
        `${config.agent.container.execEnvDir} — this process was killed mid-turn last time.\n`,
    );
  }

  const registry = new AgentRegistry(config.storage.dbPath, { crew: config.agent.clawsky.crew });

  /**
   * The board. Off is a supported state — with `clawsky.enabled: false` no
   * `checkMail` or `sendMail` tool is offered and the waker behaves exactly as it
   * did before any of this existed.
   *
   * The seeded agents are how an OPERATOR puts an agent on a crew, by editing a
   * file rather than by asking a coordinator. They predate spawn (CLAWSKY.md
   * phase 5) and outlive it: the rows are identical either way — same table,
   * same columns, `spawned_by` null instead of a coordinator's id — so a crew
   * can be composed from config, from a coordinator's `spawn` calls, or from
   * both. They are created if absent and never overwritten, so the list stays
   * additive: an operator can name a poster without disturbing rows that are
   * already running, spawned or not.
   */
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

  /**
   * Armed conditions — `remindMe` and `watchPr`.
   *
   * ── The token check happens HERE, once, in the process that would use it ────
   *
   * `config.github.token` is this process's `GITHUB_TOKEN`. It is deliberately
   * not the agent's: the container gets its copy through `--env-file` and the
   * waker gets its own through the unit's `EnvironmentFile`, and while on this
   * deployment those are the same file, nothing enforces that and no agent can
   * see which is true. So the client is built here or it is not built at all, and
   * `watchPr` refuses at arm time with a message naming the variable rather than
   * arming a watch that would poll nothing forever.
   *
   * A reminder needs no token and is unaffected: `remindMe` is offered either
   * way, because a clock is not a third party.
   */
  const armedStore = config.agent.clawsky.enabled && config.agent.armed.enabled
    ? new ArmedStore(registry)
    : null;

  let github: PullRequestSource | null = null;
  if (armedStore) {
    if (config.github.token) {
      github = new GitHubClient(config.github.token, config.agent.armed.github.apiBase);
    } else {
      process.stderr.write(
        '[armed] GITHUB_TOKEN is not set in this process — watchPr will refuse to arm anything ' +
          'and say so. Set it in the EnvironmentFile named by this instance\'s unit, not only in ' +
          'the container.\n',
      );
    }
  }

  const armedTools = armedStore
    ? {
        store: armedStore,
        github,
        defaultRepo: config.agent.armed.github.repo,
        pollSeconds: config.agent.armed.github.pollSeconds,
      }
    : null;

  /**
   * `spawn` — CLAWSKY.md phase 5, offered to coordinator sessions.
   *
   * Wired only when the board is on, and the reason is structural rather than
   * tidy: a spawn's last step is delivering the new agent's first turn as mail,
   * so without a board it would write a row that nothing could ever reach.
   *
   * The log function is the whole of what this passes in, because it is the
   * whole of what this process adds. No POLICY caps or throttles spawning,
   * deliberately — the operator would rather watch a runaway than pre-empt one —
   * so the journal is where the cost shows up. Every line here names the
   * coordinator that spawned, the agent it got, and whether the first turn
   * actually started.
   *
   * The session cap binds regardless, and is not a policy about spawning: it is
   * how many `claude` processes fit on this VM. `SessionManager` hands the tool
   * that arithmetic so a spawn that could never run is refused rather than
   * written — see `SpawnToolOptions.capacity`.
   */
  const spawnLog = mail
    ? (line: string): void => {
        process.stdout.write(`[spawn] ${line}\n`);
      }
    : null;

  const sessions = new SessionManager(registry, mail, armedTools, spawnLog);

  /**
   * Mail wakes an idle agent — CLAWSKY.md phase 3.
   *
   * Separable from the board itself and it stays separable: with `wakeOnMail`
   * off, agents still send mail and still read it whenever they happen to run,
   * which is exactly what phases 1 and 2 shipped. An operator who wants that back
   * should not have to switch the whole board off to get it.
   *
   * The events handed to a mail wake are deliberately thinner than the Discord
   * ones. There is no channel to announce an outage in and no message anybody is
   * waiting on, so a failure is a line in the journal; and a stale token drops
   * the session without replaying, because the mail has already been marked read
   * and handed over, and replaying it would deliver the same message twice.
   */
  const mailWaker =
    mail && config.agent.clawsky.wakeOnMail
      ? new MailWaker({
          crew: config.agent.clawsky.crew,
          registry,
          mail,
          busy: (agentId) => sessions.isBusy(agentId),
          start: (agent, context) => {
            const session = sessions.acquire(agent.id, {
              onToolUse: (tool) => process.stdout.write(`[clawcius ${agent.id}] ${tool}\n`),
              onCliFailure: (cmd, out) =>
                process.stderr.write(
                  `[clawcius ${agent.id}] discord CLI FAILED\n  ${cmd}\n  ${out}\n`,
                ),
              onDone: (summary) => {
                sessions.persist(agent.id);
                if (summary.apiError) {
                  process.stderr.write(
                    `[clawcius ${agent.id}] mail wake REFUSED (${summary.apiErrorKind})\n` +
                      `  ${summary.apiError.replace(/\s+/g, ' ').slice(0, 300)}\n` +
                      (summary.retryScheduled
                        ? `  retry ${summary.retryAttempt} queued\n`
                        : `  not retrying — the mail is already in the transcript\n`),
                  );
                }
                process.stdout.write(
                  `[clawcius ${agent.id}] mail wake turn ${summary.subtype} ` +
                    `$${summary.costUsd.toFixed(4)}\n`,
                );
              },
              onError: (error) => {
                process.stderr.write(`[clawcius ${agent.id}] ${error.message}\n`);
                void sessions.release(agent.id);
              },
              onNeedsRespawn: () => {
                process.stderr.write(
                  `[clawcius ${agent.id}] stale token on a mail wake — dropping session\n`,
                );
                void sessions.release(agent.id);
              },
            });
            session.wake(context);
          },
          log: (line) => process.stdout.write(`[mail-wake] ${line}\n`),
        })
      : null;

  if (mail && mailWaker) {
    // Wrapped for the same reason `onCountsChanged` is: this fires synchronously
    // inside `deliver`, which is now inside another agent's `sendMail` call, and
    // a throw here would surface to the sender as its own tool failing after the
    // message had already been committed.
    mail.onDelivered = (message) => {
      try {
        mailWaker.onDelivered(message.recipient);
      } catch (error) {
        process.stderr.write(`[mail-wake] onDelivered failed: ${String(error)}\n`);
      }
    };
  }

  /**
   * The loop that makes an armed condition come true.
   *
   * It needs mail and nothing else — it delivers, and the mail waker above turns
   * that delivery into a turn. Which is why this is wired after that one and why
   * there is no path from here into `sessions`: an armed condition is a producer
   * of mail, not a second way to start an agent.
   */
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
  /**
   * Tell the ops executor whether this instance is mid-turn.
   *
   * One-way: the waker publishes, the executor reads, and nothing comes back.
   * That direction is the design — the executor holds docker and systemctl and
   * one of the things it restarts is this process, so a channel from it to here
   * would be a channel from a privileged daemon into the thing it supervises.
   *
   * `busyCount`, not `liveCount`, is what makes "idle" mean anything on this
   * deployment; see the accessor in agent.ts for why.
   */
  const wakerStatus = new WakerStatusPublisher({
    path: config.agent.status.file,
    intervalSeconds: config.agent.status.intervalSeconds,
    instance: config.agent.status.instance,
    maxConcurrent: config.agent.sessions.maxConcurrent,
    liveCount: () => sessions.busyCount,
  });
  // Wrapped: a failed status write must never propagate into session handling.
  // The publisher already swallows its own IO errors, and this is the second
  // layer, because a bot that dies on a full disk while telling another process
  // it is healthy would be a very stupid way to lose Discord.
  sessions.onCountsChanged = () => {
    try {
      wakerStatus.noteChange();
    } catch (error) {
      process.stderr.write(`[waker-status] noteChange failed: ${String(error)}\n`);
    }
    // A turn just ended is the moment "picked up on the next turn" comes due:
    // mail that arrived while this agent was busy has been sitting unread since,
    // and without this the next turn might never happen. Guarded against
    // re-entrancy inside the waker — `start` flips `busy` and lands back here.
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
  {
    const { allowedChannelIds } = config.agent.discord;
    if (allowedChannelIds.length > 0) {
      const unreachable = [...alwaysOnChannels].filter((id) => !allowedChannelIds.includes(id));
      if (unreachable.length > 0) {
        console.warn(
          `[config] alwaysOnChannelIds ${unreachable.join(', ')} are not in allowedChannelIds — ` +
            'they will never wake the agent. Add them there or clear allowedChannelIds.',
        );
      }
    }
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
  });
  const { bundler } = handlers;

  client.on(Events.MessageCreate, (message) => void handlers.handleMessage(message));
  client.on(Events.MessageUpdate, (_old, updated) => handlers.handleMessageUpdate(updated));

  const windowSweeper = setInterval(() => windows.sweep(), 60_000);
  windowSweeper.unref();

  mailWaker?.start();
  armedWaker?.start();

  client.once(Events.ClientReady, (ready) => {
    // Stamped with the pid and the boot time because Restart=always makes a
    // crash and a deliberate restart look identical afterwards. Two of these
    // close together is a crash loop; one at an odd hour is a crash. Either way
    // every agent session died at that moment, which is the part that shows up
    // as "the bot forgot everything overnight".
    process.stdout.write(
      `[clawcius] logged in as ${ready.user.tag} — pid ${process.pid}, ` +
        `started ${new Date(Date.now() - process.uptime() * 1000).toISOString()}\n`,
    );
    systemd.ready();
    systemd.status(`connected as ${ready.user.tag}`);
  });

  // Only pet the watchdog while the gateway is genuinely healthy, so a wedged
  // connection gets us restarted instead of sitting there looking alive.
  //
  // That restart is not free, and the cost is invisible from here: every live
  // agent session is a `claude` process this one spawned, so systemd killing us
  // destroys all of them. With Restart=always the service is back in five
  // seconds and the only evidence is that every conversation is now cold.
  //
  // So the skips are logged. A run of them ending in silence is what a watchdog
  // kill looks like in the journal, and without these lines there is nothing to
  // distinguish that from an OOM or a clean restart.
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
      // Absent reads as busy to the executor, which is the correct answer for a
      // waker that is no longer running: it cannot vouch for anything.
      wakerStatus.removeOnShutdown();
      clearInterval(windowSweeper);
      bundler.flushAll();
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
