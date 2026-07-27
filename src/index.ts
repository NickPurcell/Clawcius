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
import { ConversationWindows } from './window.js';
import { MessageBundler, type BufferedMessage } from './bundler.js';
import { systemd } from './systemd.js';
import { preflight } from './preflight.js';
import type { WakeContext } from './types.js';

// Fail before touching Discord if the container stack is not actually up —
// a missing agent or proxy container reads as a bot that never answers.
await preflight();

const store = new SessionStore(config.storage.dbPath);
const sessions = new SessionManager(store);
const windows = new ConversationWindows(config.agent.discord.followUpWindowSeconds);
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
          `Live sessions: ${sessions.liveCount}/${config.agent.sessions.maxConcurrent}`,
          `Model: ${config.agent.model}`,
          `Turns: ${config.agent.maxTurns === 0 ? 'unlimited' : config.agent.maxTurns}`,
          `Idle eviction: ${idle === 0 ? 'never' : `${idle}m`}`,
          `Buffered: ${bundler.pendingCount(channelId)} message(s)`,
          `Container: ${config.agent.container.name}`,
          `Follow-up window: ${
            windows.enabled
              ? windows.isOpen(channelId)
                ? `open, ${windows.remainingSeconds(channelId)}s left`
                : `closed (${config.agent.discord.followUpWindowSeconds}s when open)`
              : 'disabled'
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

  const addressed = message.mentions.has(client.user);
  const inWindow = windows.isOpen(message.channelId);

  // Wake on an explicit mention, or on any message while a window is open.
  // Without one of those the agent would fire on every message it can see.
  if (!addressed && !inWindow) return;

  if (!isAuthorized(message)) return;

  const stripped = addressed ? stripMention(message) : message.content.trim();
  // An @ with no text is still someone getting your attention. Hand it over
  // and let the agent decide what to do with it, rather than the waker
  // answering on its behalf.
  const content = stripped || (addressed ? '(mentioned you, no text)' : '');
  if (!content) return;

  // Commands are handled by the waker, not the agent, and only when addressed —
  // otherwise any '!' line in a live channel would hit them.
  if (addressed && content.startsWith('!')) {
    const handled = await handleCommand(message, content.slice(1).split(/\s+/)[0] ?? '');
    if (handled) {
      windows.extend(message.channelId);
      return;
    }
  }

  // A fresh mention opens or extends the window. A follow-up does not: the
  // window is anchored to bot activity, not to people talking near it.
  if (addressed) windows.extend(message.channelId);

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
 * Hand a coalesced bundle to the agent.
 *
 * Silence is a normal outcome — nothing here checks whether the agent replied,
 * and nothing posts on its behalf. Whether to speak is the agent's decision,
 * shaped by systemPrompt.append, not by this process.
 */
function deliver(channelId: string, buffered: BufferedMessage[]): void {
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
            `[clawcius ${channelId}] API REFUSED THE TURN — the agent never ran\n` +
              `  ${summary.apiError.replace(/\s+/g, ' ').slice(0, 300)}\n` +
              `  If this is an auth error: the container holds its OAuth token in\n` +
              `  memory, and a host-side refresh revokes it. Fix: docker restart clawcius-agent\n`,
          );
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
            process.stdout.write(
              `[clawcius ${channelId}] self-wake turn ${summary.subtype} ` +
                `$${summary.costUsd.toFixed(4)} (spoke=${summary.sentMessage})\n`,
            );
          },
          onError: (error) => {
            process.stderr.write(`[clawcius ${channelId}] ${error.message}\n`);
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
  process.stdout.write(`[clawcius] logged in as ${ready.user.tag}\n`);
  systemd.ready();
  systemd.status(`connected as ${ready.user.tag}`);
});

// Only pet the watchdog while the gateway is genuinely healthy, so a wedged
// connection gets us restarted instead of sitting there looking alive.
const interval = systemd.watchdogIntervalMs;
if (interval) {
  const heartbeat = setInterval(() => {
    if (client.isReady() && client.ws.ping >= 0) {
      systemd.watchdog();
    }
  }, Math.max(interval / 3, 5000));
  heartbeat.unref();
}

async function shutdown(signal: string): Promise<void> {
  process.stdout.write(`[clawcius] ${signal} received, shutting down\n`);
  systemd.stopping();
  try {
    wakeSpool?.stop();
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
