/**
 * Clawcius — wakes a sandboxed Claude Code agent on Discord mentions.
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
import { Scheduler, describeCadence } from './scheduler.js';
import { ConversationWindows } from './window.js';
import { MessageBundler, type BufferedMessage } from './bundler.js';
import { RuleEngine, fillVars, type RuleAction } from './rules.js';
import { systemd } from './systemd.js';
import { preflight } from './preflight.js';
import type { WakeContext } from './types.js';

// Fail before touching Discord if the sandbox cannot actually work. Async
// because the Squid check has to probe whether the proxy is actually listening.
await preflight();

const store = new SessionStore(config.storage.dbPath);
const scheduler = new Scheduler(store.db, config.agent.scheduling);
const sessions = new SessionManager(store, scheduler);
const windows = new ConversationWindows(config.agent.discord.followUpWindowSeconds);
const rules = config.agent.rules.enabled ? new RuleEngine(config.agent.rules.path) : null;
rules?.watch();

/**
 * Run the actions a rule fired. Deliberately best-effort per action: one bad
 * emoji must not stop the reply that follows it.
 */
async function runActions(message: Message, actions: RuleAction[], ruleName: string): Promise<void> {
  const vars = {
    author: message.author.tag,
    authorId: message.author.id,
    content: message.content,
    channelId: message.channelId,
    messageId: message.id,
  };

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'react':
          await message.react(action.emoji);
          break;
        case 'reply':
          await message.reply(fillVars(action.text, vars));
          break;
        case 'send': {
          const channel = await client.channels.fetch(action.channelId);
          if (channel?.isSendable()) await channel.send(fillVars(action.text, vars));
          break;
        }
        case 'log':
          process.stdout.write(`[rule ${ruleName}] ${fillVars(action.text, vars)}\n`);
          break;
      }
    } catch (error) {
      process.stderr.write(
        `[rule ${ruleName}] action ${action.type} failed: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
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
          `Live sessions: ${sessions.liveCount}/${config.agent.sessions.maxConcurrent}`,
          `Model: ${config.agent.model}`,
          `Turns: ${config.agent.maxTurns === 0 ? 'unlimited' : config.agent.maxTurns}`,
          `Idle eviction: ${idle === 0 ? 'never' : `${idle}m`}`,
          `Buffered: ${bundler.pendingCount(channelId)} message(s)`,
          `Rules: ${rules ? `${rules.count} active` : 'disabled'}`,
          `Follow-up window: ${
            windows.enabled
              ? windows.isOpen(channelId)
                ? `open, ${windows.remainingSeconds(channelId)}s left`
                : `closed (${config.agent.discord.followUpWindowSeconds}s when open)`
              : 'disabled'
          }`,
          `Sandbox: ${config.agent.sandbox.enabled ? 'SDK sandbox on' : 'outer boundary only'}`,
          // Naming the enforcing proxy matters: "uncontrolled" here is the
          // difference between a contained agent and one with open egress.
          `Egress: ${
            config.agent.sandbox.enabled
              ? config.agent.sandbox.egress.mode === 'squid'
                ? `Squid allowlist (127.0.0.1:${config.agent.sandbox.egress.httpProxyPort}), ` +
                  `${config.agent.sandbox.allowedDomains.length} domains`
                : `SDK proxy allowlist, ${config.agent.sandbox.allowedDomains.length} domains`
              : 'uncontrolled'
          }`,
          persisted
            ? `This channel: session ${persisted.sessionId.slice(0, 8)}…`
            : 'This channel: no session yet',
        ].join('\n'),
      );
      return true;
    }

    case 'schedules': {
      const schedules = scheduler.list(channelId);
      if (schedules.length === 0) {
        await message.reply('No scheduled wakes in this channel.');
        return true;
      }
      await message.reply(
        [
          `${schedules.length}/${config.agent.scheduling.maxPending} scheduled:`,
          ...schedules.map(
            (s) =>
              `\`${s.id}\` ${describeCadence(s)} — next <t:${Math.floor(s.nextRunAt / 1000)}:R>` +
              ` — ${s.prompt.slice(0, 80)}`,
          ),
        ].join('\n'),
      );
      return true;
    }

    case 'unschedule': {
      const id = message.content.trim().split(/\s+/).pop() ?? '';
      const removed = scheduler.cancel(channelId, id);
      await message.reply(
        removed ? `Cancelled \`${id}\`.` : `No schedule \`${id}\` in this channel.`,
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
  // Rules run first and see everything, including bot traffic — automation may
  // legitimately want to react to another bot. They cost no tokens.
  let suppressedBy: string | null = null;
  if (rules) {
    const fired = rules.evaluate({
      channelId: message.channelId,
      authorId: message.author.id,
      content: message.content,
      isBot: message.author.bot,
    });
    for (const { rule, actions } of fired) {
      void runActions(message, actions, rule.name);
      if (rule.stopWake) suppressedBy = rule.name;
    }
  }

  if (message.author.bot) return;

  if (suppressedBy) {
    process.stdout.write(
      `[clawcius ${message.channelId}] handled by rule "${suppressedBy}" — no wake\n`,
    );
    return;
  }

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

scheduler.start((schedule) => {
  const cadence = describeCadence(schedule);
  process.stdout.write(
    `[clawcius ${schedule.channelId}] scheduled wake ${schedule.id} (${cadence})\n`,
  );

  try {
    const session = sessions.acquire(schedule.channelId, {
      onToolUse: (toolName) => {
        process.stdout.write(`[clawcius ${schedule.channelId}] tool: ${toolName}\n`);
      },
      onCliFailure: (command, output) => {
        process.stderr.write(
          `[clawcius ${schedule.channelId}] discord CLI FAILED — nothing was posted\n` +
            `  cmd: ${command.replace(/\s+/g, ' ').slice(0, 200)}\n` +
            `  out: ${output.replace(/\s+/g, ' ').slice(0, 300)}\n`,
        );
      },
      onDone: (summary) => {
        sessions.persist(schedule.channelId);
        process.stdout.write(
          `[clawcius ${schedule.channelId}] scheduled turn ${summary.subtype} ` +
            `$${summary.costUsd.toFixed(4)} (sent=${summary.sentMessage})\n`,
        );
      },
      onError: (error) => {
        process.stderr.write(`[clawcius ${schedule.channelId}] ${error.message}\n`);
      },
    });

    session.wake({
      kind: 'schedule',
      channelId: schedule.channelId,
      scheduleId: schedule.id,
      prompt: schedule.prompt,
      ...(schedule.intervalSeconds !== null || schedule.dailyAt !== null
        ? { repeats: cadence }
        : {}),
    });
  } catch (error) {
    // Capacity or startup failure. Log it — there is no user waiting on this
    // one, so there is nobody to apologise to.
    process.stderr.write(
      `[clawcius ${schedule.channelId}] scheduled wake skipped: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
});

// Editing a message is Discord API activity too — the agent's progress
// checklists work by editing, and those should keep the conversation alive.
client.on(Events.MessageUpdate, (_old, updated) => {
  if (client.user && updated.author?.id === client.user.id) {
    windows.extend(updated.channelId);
  }
});

const windowSweeper = setInterval(() => windows.sweep(), 60_000);
windowSweeper.unref();

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
    rules?.stop();
    clearInterval(windowSweeper);
    bundler.flushAll();
    scheduler.stop();
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
