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

/**
 * The three session events a mail wake logs and reacts to.
 *
 * THEY NO LONGER SETTLE THE MAIL. `AgentSession` does, through `TurnSettle`, at
 * the one place a turn ends — because this object is handed to `acquire`, which
 * DROPS it for a session that already exists, so only the first wake's copy ever
 * ran. Settling from here marked the first message read and then nothing else
 * ever again, and the sweep re-offered the same mail every ten seconds for the
 * life of the process. Clawcius #241, round 1, blocking.
 *
 * A turn is the lifetime the settle belongs to, so it travels with `wake()`.
 *
 * EXTRACTED SO THEY CAN BE TESTED, because this wiring is exactly where #239
 * lived: `onError` did not settle, five messages were marked read for a turn
 * that never ran, and nothing recorded it. A mutation run confirmed the gap was
 * still open after the fix — removing `settle` from either `onError` or
 * `onDone` failed no test, because every test drove `MailWaker` with a stub
 * `start` and never reached the daemon's callbacks.
 *
 * Fixing a path and leaving it untested is the shape that produced the bug.
 */
export function mailWakeEvents(opts: {
  persist: () => void;
  release: () => void;
  err: (line: string) => void;
}): {
  onDone: (summary: TurnSummary) => void;
  onError: (error: Error) => void;
  onNeedsRespawn: () => void;
} {
  const { persist, release, err } = opts;
  return {
    onDone: (summary) => {
      persist();
      if (summary.apiError) {
        // A refusal WITH a retry queued: the retry re-runs this turn, so the
        // mail is neither read nor lost — leave it unsettled and let the
        // retry's own onDone decide.
        //
        // A refusal with NO retry produced nothing, so the mail was never read
        // by anybody. It used to be marked read here on the strength of
        // "already in the transcript", which is the claim #239 disproved:
        // `checkMail` reads unread rows, the row was no longer one, and the
        // message was gone for good.
        err(
          `mail wake REFUSED (${summary.apiErrorKind})\n` +
            `  ${String(summary.apiError).replace(/\s+/g, ' ').slice(0, 300)}\n` +
            (summary.retryScheduled
              ? `  retry ${summary.retryAttempt} queued\n`
              : `  not retrying — mail left unread for the next sweep\n`),
        );
        return;
      }
    },
    // THE PATH THAT ATE FIVE MESSAGES ON 2026-08-24, and the one that claimed
    // nothing. The other two at least asserted a reason a reader could disagree
    // with; this printed one line and released the session, so every documented
    // failure string grepped ZERO while mail vanished. A path with no sentence
    // attached is invisible to every technique we have for finding false ones.
    //
    // Its usual cause is not exotic: the gVisor sentry is OOM-killed inside the
    // container's memcg, every agent's `docker exec` dies in the same second,
    // and this fires once per agent with nothing to say — because there was no
    // per-agent failure to describe.
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
            // The model THIS channel's agent resolves to, not the default. They
            // are the same until an operator gives this row's role an override,
            // and `persisted` is already in hand — so reporting the default here
            // would be a number that is right by coincidence and wrong silently.
            `Model: ${
              config.agent.modelByRole[persisted?.role ?? DEFAULT_CHANNEL_ROLE] ??
              config.agent.model
            }`,
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
      // any better on its own, because with `idleTimeoutMinutes: 0` nothing
      // frees a slot in the ordinary course — someone spending another
      // channel's transcript with `!reset` is what changes that, and it is a
      // deliberate act rather than something to wait for. Silence here is
      // indistinguishable from the bot being down — the same reading
      // `announceOutage` exists to prevent — and spawn is what makes it
      // reachable by a coordinator rather than only by the operator: a spawned
      // agent that has taken a turn holds one of these slots, and `!reset`
      // cannot reach it to give it back.
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

  // WHAT IS IN `GITHUB_TOKEN`, said once, before anything can branch past it.
  //
  // Deliberately here and not beside the App's check at `checkAppConfig`, which
  // sits inside `if (armedStore)`. Three deployments reach this line and the
  // token matters in all three: `clawsky` off, `armed` off, and no App at all
  // still write it into a netrc below and into every agent's environment, so a
  // check nested one block deeper would be absent from exactly the deployments
  // where the PAT is the only credential there is.
  //
  // It REPORTS AND CONTINUES. Nothing here rejects a token or refuses to start
  // — the standing preference is visible failure over guards, and this earns
  // its place by making a failure legible rather than by preventing one. The
  // cost it removes is not a bad request; it is an afternoon spent on scopes
  // and permissions because a 401, or a ByteString error naming a character
  // index, points at the wrong subject.
  const tokenShape = describeTokenShape(config.github.token);
  if (tokenShape) process.stderr.write(`[github] ${tokenShape}\n`);

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
  // Declared here rather than beside its construction because `shutdown` is
  // out here and has to be able to stop it.
  let tokenFileRefresher: TokenFileRefresher | null = null;
  if (armedStore) {
    // Prefer the App when this deployment has one. Both variables are required
    // — a half-configured deployment falls back rather than failing, because a
    // crew that cannot poll is worse than one polling as the older identity.
    //
    // EITHER variable, not both, because this guard decides whether the
    // operator hears anything at all. With `&&` a deployment that set one and
    // typo'd the name of the other said NOTHING — not the fault, and not the
    // "authenticating as GitHub App" line either, since that sits behind the
    // same guard — while every neighbouring misconfiguration was loud. The
    // fallback is unchanged; only its silence is.
    const app = config.github.appId || config.github.appPrivateKeyPath;
    // PROVE IT BEFORE ARMING ANYTHING. Every way an App can be misconfigured —
    // a typo'd PEM path, a PEM the service user cannot read, a wrong app id, an
    // uninstalled App, more than one installation — throws when the provider is
    // FIRST AWAITED, and the first await is inside `#get`, inside the try in
    // `ArmedWaker`, whose catch calls `store.disarm()`. So a misconfiguration
    // does not degrade a poll: it permanently deletes every armed row in the
    // crew, one mail each, which is the exact sweep this file exists to
    // prevent, reached through a different door.
    //
    // An absent GITHUB_TOKEN is already handled by refusing to build the client
    // and letting `watchPr` decline to arm. A half-configured App deserves the
    // same answer and deserves it more, because it fails AFTER arming rather
    // than before.
    let appTokenOk = false;
    let appProvider: TokenProvider | null = null;
    if (app) {
      // Checked at BOOT because it costs no network, no token and no PEM, so
      // there is no reason for it to wait until first use — and first use is
      // inside `ArmedWaker`'s try, where the catch deletes the row. An invisible
      // character in an operator-typed value is an ordinary typo; discovering it
      // at boot is a log line, discovering it at first poll is a permanent sweep.
      //
      // The checks themselves live in `github-app.ts` as a pure function. They
      // were four lines here, and those four lines were wrong in three
      // consecutive reviews without a single test noticing, because nothing was
      // ever going to grow a test around `main()`. `checkAppConfig` is asserted
      // directly; this call site is now too small to be wrong.
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
      // A PROVIDER, not a token. An installation token lasts an hour and this
      // client lives for the life of the daemon; a poll that throws is disarmed
      // rather than retried (`ArmedWaker`), so a stale credential would kill
      // every armed watch in the crew an hour after startup rather than degrade.
      // ONE provider, shared by the waker's client and the agents' token file.
      // Two providers would mint twice as often against the same rate limit and,
      // worse, could disagree — an agent pushing with one token while the waker
      // polls with another is two credentials to reason about instead of one.
      appProvider = appTokenProvider({
        appId: config.github.appId,
        privateKeyPath: config.github.appPrivateKeyPath,
        installationId: config.github.appInstallationId || undefined,
        apiBase: config.agent.armed.github.apiBase,
      });
      github = new GitHubClient(appProvider, config.agent.armed.github.apiBase);
      // Said only once the key has been shown readable. Printing it before
      // anything was proven reported success at the exact moment the failure
      // became undetectable. The id is not a secret; the key and the token are,
      // and neither the PEM's path nor anything minted from it is logged.
      process.stderr.write(`[armed] authenticating as GitHub App ${config.github.appId}\n`);

      // The agent sessions' half of the same credential. Unconditional inside
      // this branch: if the App is usable for the waker it is usable for the
      // agents, and there is no state in which writing the file is wrong here.
      // An earlier comment claimed a guard that let a deployment keep agents on
      // the PAT while the waker used the App — there was no such condition, and
      // that deployment is not expressible, because the file always wins over
      // the PAT. Saying so beats implying a knob that does not exist.
      {
        tokenFileRefresher = new TokenFileRefresher({
          path: tokenFilePath(config.agent.container.githubTokenDir),
          provider: appProvider,
          log: (message) => process.stderr.write(`${message}\n`),
          hasFallbackToken: Boolean(config.github.token),
          // Keep the REST credential in step with the git one. Written here
          // rather than by a second timer so there is one provider, one cache
          // and one moment at which the crew's credential changes.
          onToken: (token) => writeCurlConfig(config.agent.container.githubTokenDir, token),
          // FALLBACK AT THE WRITER, which is where it has to live. Curl cannot
          // do the git helper's file-first/environment-second ordering: with no
          // netrc it sends nothing and takes a 401 rather than falling back.
          // So when the installation token is given up on, the netrc is
          // rewritten with the PAT if there is one — and only removed when
          // there is no credential at all to serve.
          // Shutdown clears rather than falls back: see `stop()`.
          onStop: () => removeCurlConfig(config.agent.container.githubTokenDir),
          onNoToken: () => {
            if (config.github.token) {
              writeCurlConfig(config.agent.container.githubTokenDir, config.github.token);
            } else {
              removeCurlConfig(config.agent.container.githubTokenDir);
            }
          },
        });
        // Awaited so the file exists before any session spawns, but a failure
        // does NOT stop startup — `start()` logs and retries. Throwing here put
        // the whole daemon into a restart loop over a network call, which is
        // the opposite of what `checkAppConfig` does one screen up for the same
        // kind of problem.
        // Said only if the file is actually there. `start()` no longer throws,
        // so printing this unconditionally paired "there is no usable
        // credential at X" with "agent git credentials come from X" in adjacent
        // lines — the second refuted by the first, which is the defect #180
        // spent six rounds removing from the neighbouring warning.
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

  // THE PAT-ONLY DEPLOYMENT, which is Clawcius and which must not change. The
  // refresher only runs when an App is usable, so without this a crew with no
  // App has no netrc — and bare curl then sends nothing and takes a 401, where
  // before it used $GITHUB_TOKEN and worked. Curl cannot do the git helper's
  // file-first/environment-second ordering, so the choice of credential is made
  // here, once, rather than at each call.
  //
  // Also covers `clawsky.enabled: false` and `armed.enabled: false`, where the
  // whole block above is skipped and agents still make REST calls.
  if (!tokenFileRefresher && config.github.token) {
    writeCurlConfig(config.agent.container.githubTokenDir, config.github.token);
    // "(no App credential in use)", not "(no App configured)". Three deployments
    // reach this line and the old wording was false in two of them: an App that
    // is configured but unusable, where `checkAppConfig` has just named the
    // failing variable and this contradicted it one line later; and an App that
    // is fully configured with `clawsky` or `armed` disabled, where `armedStore`
    // is null so the check never runs and NOTHING contradicts it — an operator
    // debugging why their App is not in use reads that it is not configured, and
    // goes to check a configuration that is already correct.
    //
    // This line knows exactly one fact: nothing is refreshing an installation
    // token. That is what it says now, and it is true in all three.
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
   * the session and leaves the mail UNREAD, because replaying it is the point:
   * `onNeedsRespawn` settles the turn false, so the sweep offers the message to
   * the session that replaces this one. (This paragraph said the opposite until
   * #241 — that the mail was already marked read and replaying would deliver it
   * twice. That was true when the mark happened at handoff. It is the sentence
   * the old design left behind, and OJ round 2 caught it still standing.)
   */
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
              onCliFailure: (cmd, out) =>
                process.stderr.write(
                  `[clawcius ${agent.id}] discord CLI FAILED\n  ${cmd}\n  ${out}\n`,
                ),
              ...mailWakeEvents({
                persist: () => sessions.persist(agent.id),
                release: () => void sessions.release(agent.id),
                err: (line) => process.stderr.write(`[clawcius ${agent.id}] ${line}\n`),
              }),
            });
            session.wake(context, settle);
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
      tokenFileRefresher?.stop();
      // AND THE BRANCH WITH NO REFRESHER TO HANG IT ON. The PAT-only path writes
      // a netrc at startup and has no `stop()` to clear it, so a non-expiring
      // credential sat in the bind-mounted directory across every shutdown and
      // redeploy — indefinitely. That is the exposure `stop()`'s own principle
      // rejects for the installation token, which at least has an hour's fuse.
      // Rewritten at the next startup either way; this only shrinks the window,
      // which is the same thing `stop()` is for.
      // GUARDED, and this is the one place on this branch where a guard beats
      // letting it fail. `shutdown()`'s `finally` is `process.exit(0)`, so a
      // throw here skips `sessions.shutdown()`, `registry.close()` and
      // `client.destroy()` — and the daemon still exits 0, reporting a clean
      // shutdown while having released no live session. The failure is not
      // visible, it is SILENCED, and a guard is the only way the real problem
      // gets to be seen at all.
      //
      // `force` swallows ENOENT and nothing else: a directory at that path
      // throws EISDIR, an unwritable parent throws EACCES. `writeSecretFile`'s
      // header names the first case exactly, because that throw took the daemon
      // down at boot once already.
      //
      // AND IT LOGS RATHER THAN SWALLOWING. `removeOnShutdown` two lines up is
      // silent because a stale status file expires on its own; a netrc that
      // could not be removed is a live credential still on disk after shutdown,
      // which is the thing this branch exists to prevent. Silence would be the
      // wrong half of the neighbour's pattern.
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
