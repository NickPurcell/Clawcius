/**
 * Clawcius — wakes a containerised Claude Code agent on Discord mentions.
 *
 * This process is deliberately thin. It listens on the gateway, authorizes the
 * mention, and hands the agent context. It does not compose or send replies —
 * the agent does that itself by invoking the `discord` CLI.
 *
 * The one exception is the no-reply fallback: if an agent turn ends without
 * having called the CLI, the user would otherwise see nothing at all, which is
 * indistinguishable from the bot being down. So the waker says something.
 */

import { Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js';
import { config } from './config.js';
import { SessionStore } from './store.js';
import { SessionManager } from './agent.js';
import { WakeSpool } from './wake-spool.js';
import { WakerStatusPublisher } from './waker-status.js';
import { ConversationWindows } from './window.js';
import { MessageBundler, type BufferedMessage } from './bundler.js';
import { systemd } from './systemd.js';
import { preflight } from './preflight.js';
import type { TurnSummary, WakeContext } from './types.js';

// Fail before touching Discord if the container stack is not actually up —
// a missing agent or proxy container reads as a bot that never answers.
await preflight();

const store = new SessionStore(config.storage.dbPath);
const sessions = new SessionManager(store);
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
      store.delete(channelId);
      await message.reply('Session cleared. The next mention starts fresh.');
      return true;
    }

    case 'status': {
      const persisted = store.get(channelId);
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
          persisted
            ? `This channel: session ${persisted.sessionId.slice(0, 8)}…`
            : 'This channel: no session yet',
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
    onCliFailure: () => {},
    // Reached only by `!stop`/`!status`, which acquire a session to look at or
    // interrupt it rather than to run a turn. There is no wake in flight to
    // rescue, so respawning here would be churn.
    onNeedsRespawn: () => {},
  };
}

client.on(Events.MessageCreate, async (message) => {
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
});

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
    // Capacity or startup failure. Logged rather than announced — the bot
    // staying quiet is preferable to it interrupting with its own plumbing.
    process.stderr.write(
      `[clawcius ${channelId}] could not wake: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

const bundler = new MessageBundler(
  config.agent.discord.bundleDebounceMs,
  config.agent.discord.bundleMaxWaitMs,
  deliver,
);

// Editing a message is Discord API activity too — the agent's progress
// checklists work by editing, and those should keep the conversation alive.
client.on(Events.MessageUpdate, (_old, updated) => {
  if (client.user && updated.author?.id === client.user.id) {
    windows.extend(updated.channelId);
  }
});

const windowSweeper = setInterval(() => windows.sweep(), 60_000);
windowSweeper.unref();

/**
 * Wake requests from inside the container.
 *
 * The agent schedules itself with cron and curls this socket. Limits still
 * apply here — a request is a request, not a command, so it cannot be used to
 * escape the concurrency cap.
 */
const wakeCounts = new Map<string, number[]>();

const wakeSpool = config.agent.wake.enabled
  ? new WakeSpool(config.agent.wake.spoolDir, ({ channelId, prompt }) => {
      const now = Date.now();
      const recent = (wakeCounts.get(channelId) ?? []).filter((t) => now - t < 3_600_000);
      if (recent.length >= config.agent.wake.maxPerHour) {
        return { accepted: false, detail: `rate limit: ${config.agent.wake.maxPerHour}/hour` };
      }
      recent.push(now);
      wakeCounts.set(channelId, recent);

      try {
        const session = sessions.acquire(channelId, {
          onToolUse: (tool) => process.stdout.write(`[clawcius ${channelId}] ${tool}\n`),
          onCliFailure: (cmd, out) =>
            process.stderr.write(`[clawcius ${channelId}] discord CLI FAILED\n  ${cmd}\n  ${out}\n`),
          onDone: (summary) => {
            sessions.persist(channelId);
            // Retry itself lives in AgentSession, so scheduled wakes get it
            // without asking. This only has to report what happened.
            if (summary.apiError) {
              process.stderr.write(
                `[clawcius ${channelId}] self-wake REFUSED (${summary.apiErrorKind})\n` +
                  `  ${summary.apiError.replace(/\s+/g, ' ').slice(0, 300)}\n` +
                  (summary.retryScheduled
                    ? `  retry ${summary.retryAttempt} queued\n`
                    : `  not retrying\n`),
              );
            }
            process.stdout.write(
              `[clawcius ${channelId}] self-wake turn ${summary.subtype} ` +
                `$${summary.costUsd.toFixed(4)} (spoke=${summary.sentMessage})\n`,
            );
          },
          onError: (error) => {
            process.stderr.write(`[clawcius ${channelId}] ${error.message}\n`);
            void sessions.release(channelId);
          },
          onNeedsRespawn: () => {
            // Drop the session so the next wake gets a fresh process, but never
            // replay a scheduled prompt: unlike a person's message, nobody is
            // waiting on this one, and re-firing a schedule is how you get the
            // same job run twice.
            process.stderr.write(
              `[clawcius ${channelId}] stale token on self-wake — dropping session\n`,
            );
            void sessions.release(channelId);
          },
        });
        session.wake({ kind: 'schedule', channelId, scheduleId: 'self', prompt });
        return { accepted: true, detail: 'woken' };
      } catch (error) {
        return {
          accepted: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    })
  : null;
wakeSpool?.start();

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
    wakeSpool?.stop();
    wakerStatus.stop();
    // Absent reads as busy to the executor, which is the correct answer for a
    // waker that is no longer running: it cannot vouch for anything.
    wakerStatus.removeOnShutdown();
    clearInterval(windowSweeper);
    bundler.flushAll();
    await sessions.shutdown();
    store.close();
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
