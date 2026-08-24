/**
 * The Discord handler: who wakes the agent, and what the channel is told when a
 * turn cannot run.
 *
 * None of this could be tested before. `src/index.ts` was 870 lines whose module
 * body WAS the program — it opened the registry, built the wakers, registered
 * every gateway handler and ended in `await client.login(...)` — so importing it
 * started a Discord bot, and every decision in it could only be reasoned about.
 * Clawcius #131. The body is now `main()` in daemon.ts and the handlers are
 * `createHandlers(deps)`, which takes what they used to close over.
 *
 * The four things #131 names, and why each is worth a test rather than a read:
 *
 *   - `handleMessage` — which mentions are authorized, `alwaysOnChannelIds`,
 *     `allowedChannelIds`, the follow-up window. Four rules that interact, and
 *     the failure mode of every one of them is silence.
 *   - `deliver`'s catch — an `AtCapacityError` announces and every other failure
 *     stays quiet. The sentence has been tested since #133 (`atCapacityNotice`);
 *     WHICH errors reach it had not.
 *   - `onDone`'s API-error path: `respawnWillHandleIt`, `retryScheduled`, and
 *     that `announceOutage` fires EXACTLY ONCE across a respawn. That rule is
 *     not an aesthetic one — a duplicate was observed live on 2026-08-03, four
 *     identical messages in three seconds, which reads as a broken bot rather
 *     than a broken credential.
 *   - `onNeedsRespawn`'s replay-only-if-not-acted rule, which decides whether a
 *     turn's side effects get repeated.
 *
 * Nothing here calls `setConfig`. The handlers read the config object they were
 * handed rather than the module-level `config()`, so a test says what this
 * deployment is in the fixture below and nowhere else.
 *
 * Run against `dist/`, like every other test here: Node's type stripping does
 * not resolve a `.js` specifier to a `.ts` file, and testing the built output is
 * also what catches the stale-dist failure this repo keeps hitting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHandlers } from '../dist/daemon.js';
import { ConversationWindows } from '../dist/window.js';
import { AtCapacityError } from '../dist/agent.js';

const BOT = 'BOT-USER-ID';
const CHANNEL = 'C-main';

/**
 * Only the keys the handlers read.
 *
 * The same call `test/sessions.test.js` makes and for the same reason: a fixture
 * obliged to be a complete `AgentConfig` would be a second copy of
 * `agent-config.yaml` going quietly out of step with the real one. A handler
 * that starts reading a key not listed here gets a `TypeError` naming it rather
 * than a plausible default.
 *
 * `bundleDebounceMs: 0` disables bundling, so `handleMessage` hands a bundle
 * straight to `deliver` and a test can assert on it without driving timers. The
 * bundler's own debouncing is `test/`-covered nowhere else either, but it is not
 * what this file is about.
 */
function configFixture(overrides = {}) {
  const discord = {
    allowedChannelIds: [],
    alwaysOnChannelIds: [],
    followUpWindowSeconds: 0,
    followUpChannelIds: [],
    bundleDebounceMs: 0,
    bundleMaxWaitMs: 0,
    ...(overrides.discord ?? {}),
  };
  const sessions = {
    maxConcurrent: 4,
    idleTimeoutMinutes: 0,
    workspaceRoot: '/w',
    ...(overrides.sessions ?? {}),
  };
  return {
    discord: { token: 'unused-by-the-handlers', guildId: 'unused-by-the-handlers' },
    github: { token: '' },
    storage: { dbPath: 'unused-by-the-handlers' },
    agent: {
      model: 'a-model',
      // `!status` resolves the channel's role through this, so an absent key is
      // a TypeError naming it rather than a plausible default — which is what
      // this fixture is for, and which is how it caught the unguarded index.
      modelByRole: overrides.modelByRole ?? {},
      maxTurns: 0,
      container: { name: 'clawcius-agent' },
      clawsky: { crew: 'hamachi' },
      discord,
      sessions,
    },
  };
}

/** A session pool that starts no container and records what it was asked for. */
function fakeSessions() {
  const pool = {
    acquired: [],
    persisted: [],
    released: [],
    interrupted: [],
    liveCount: 1,
    busyCount: 0,
    /** Replaced by a test that wants `acquire` to throw. */
    onAcquire: null,
    has: () => true,
    acquire(channelId, events) {
      const call = { channelId, events, woke: [] };
      pool.acquired.push(call);
      if (pool.onAcquire) pool.onAcquire(call);
      return {
        wake: (context) => call.woke.push(context),
        interrupt: async () => pool.interrupted.push(channelId),
      };
    },
    persist: (channelId) => pool.persisted.push(channelId),
    release: async (channelId) => {
      pool.released.push(channelId);
    },
  };
  return pool;
}

/** A registry stub — only `!status` reaches it, and only to read. */
function fakeRegistry(rows = {}) {
  return {
    cleared: [],
    get: (id) => rows[id],
    listByCrew: () => Object.values(rows),
    clearSession(id) {
      this.cleared.push(id);
    },
  };
}

/**
 * The handlers, wired to fakes, plus everything they wrote to.
 *
 * `sent` is what actually reached a Discord channel. It is the assertion that
 * matters for the announcement rules: a count of messages in a room, which is
 * what the 2026-08-03 duplicate was.
 */
function harness(overrides = {}) {
  const config = configFixture(overrides.config ?? {});
  const sent = [];
  const fetched = [];
  const sessions = overrides.sessions ?? fakeSessions();
  const registry = overrides.registry ?? fakeRegistry();

  const channel = overrides.channel ?? {
    isTextBased: () => true,
    send: async (text) => {
      sent.push(text);
    },
  };

  const client = {
    user: { id: BOT },
    channels: {
      fetch: async (channelId) => {
        fetched.push(channelId);
        if (overrides.fetchThrows) throw new Error('Unknown Channel');
        return channel;
      },
    },
  };

  const windows = new ConversationWindows(
    config.agent.discord.followUpWindowSeconds,
    config.agent.discord.followUpChannelIds,
  );

  const handlers = createHandlers({
    config,
    client,
    sessions,
    registry,
    mail: overrides.mail ?? null,
    mailWaker: overrides.mailWaker ?? null,
    armedStore: overrides.armedStore ?? null,
    github: overrides.github ?? null,
    windows,
    alwaysOnChannels: new Set(config.agent.discord.alwaysOnChannelIds),
  });

  /**
   * What `handleMessage` buffered, before `deliver` reshapes it.
   *
   * `deliver` maps a `BufferedMessage` down to what a wake carries and drops
   * `addressed` on the way — so the flag `handleMessage` computes is not visible
   * from the other end, and asserting on it there would assert on `undefined`
   * for every case and pass. It is read here instead, and the spy calls through
   * so the delivery path is still exercised.
   */
  const bundled = [];
  const addToBundler = handlers.bundler.add.bind(handlers.bundler);
  handlers.bundler.add = (channelId, buffered) => {
    bundled.push({ channelId, ...buffered });
    addToBundler(channelId, buffered);
  };

  return { handlers, config, sessions, registry, windows, client, sent, fetched, bundled };
}

/** A Discord message, as much of one as the handler touches. */
function message({
  content = 'hello',
  channelId = CHANNEL,
  mentioned = false,
  authorId = 'U-human',
  bot = false,
  id = 'M-1',
} = {}) {
  const replies = [];
  return {
    id,
    channelId,
    content,
    createdTimestamp: 1_700_000_000_000,
    author: { id: authorId, bot, tag: 'human#0001' },
    mentions: { has: () => mentioned },
    replies,
    reply: async (text) => {
      replies.push(text);
    },
  };
}

/** Capture stderr for the duration of `body`. The handlers log rather than throw. */
async function captureStderr(body) {
  const written = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await body();
  } finally {
    process.stderr.write = real;
  }
  return written.join('');
}

/** Let the `void … .then(…)` chains inside the handlers settle. */
async function settle(times = 10) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const authFailure = (overrides = {}) => ({
  isError: false,
  costUsd: 0,
  numTurns: 1,
  durationMs: 1200,
  subtype: 'success',
  sentMessage: false,
  apiError: 'OAuth token revoked',
  apiErrorKind: 'authentication_failed',
  retryScheduled: false,
  retryAttempt: 0,
  ...overrides,
});

const cleanTurn = () => ({
  isError: false,
  costUsd: 0.42,
  numTurns: 3,
  durationMs: 5000,
  subtype: 'success',
  sentMessage: true,
  apiError: null,
  apiErrorKind: null,
  retryScheduled: false,
  retryAttempt: 0,
});

const buffered = (content = 'do the thing') => [
  {
    messageId: 'M-1',
    authorId: 'U-human',
    authorTag: 'human#0001',
    content,
    addressed: true,
    at: 1_700_000_000_000,
  },
];

// ── handleMessage: who wakes the agent ──────────────────────────────────────

test('an @-mention wakes the agent, with the mention stripped', async () => {
  const { handlers, sessions } = harness();
  await handlers.handleMessage(
    message({ content: `<@${BOT}> deploy the thing`, mentioned: true }),
  );

  assert.equal(sessions.acquired.length, 1);
  const [wake] = sessions.acquired[0].woke;
  assert.equal(wake.kind, 'messages');
  assert.equal(wake.channelId, CHANNEL);
  // The agent should see the request, not the @ that carried it.
  assert.equal(wake.messages[0].content, 'deploy the thing');
});

test('an ordinary message with no mention and no window wakes nothing', async () => {
  const { handlers, sessions } = harness();
  await handlers.handleMessage(message({ content: 'talking amongst ourselves' }));
  assert.deepEqual(sessions.acquired, []);
});

test('allowedChannelIds confines the bot, and an unlisted channel is silent', async () => {
  const { handlers, sessions } = harness({
    config: { discord: { allowedChannelIds: ['C-allowed'] } },
  });

  await handlers.handleMessage(
    message({ content: `<@${BOT}> hi`, mentioned: true, channelId: 'C-elsewhere' }),
  );
  assert.deepEqual(sessions.acquired, [], 'a mention outside the allowlist must wake nothing');

  await handlers.handleMessage(
    message({ content: `<@${BOT}> hi`, mentioned: true, channelId: 'C-allowed' }),
  );
  assert.equal(sessions.acquired.length, 1);
});

test('an empty allowedChannelIds means every channel, which is the default', async () => {
  const { handlers, sessions } = harness();
  await handlers.handleMessage(
    message({ content: `<@${BOT}> hi`, mentioned: true, channelId: 'C-anywhere' }),
  );
  assert.equal(sessions.acquired.length, 1);
});

test('an always-on channel treats every message as addressed, and strips nothing', async () => {
  const { handlers, sessions, bundled } = harness({
    config: { discord: { alwaysOnChannelIds: [CHANNEL] } },
  });

  // No @ was typed, so there is no mention to strip — and stripping one that was
  // never typed would eat real text.
  await handlers.handleMessage(message({ content: `is <@${BOT}> the bot's id?` }));
  assert.equal(sessions.acquired.length, 1);
  assert.equal(sessions.acquired[0].woke[0].messages[0].content, `is <@${BOT}> the bot's id?`);
  // A standing invitation: every message counts as if it had carried an @.
  assert.equal(bundled[0].addressed, true);
});

test('an always-on channel outside allowedChannelIds wakes nothing at all', async () => {
  // The combination the startup warning in main() exists for. It is always a
  // mistake and a silent one: the room simply stays quiet.
  const { handlers, sessions } = harness({
    config: { discord: { alwaysOnChannelIds: ['C-lonely'], allowedChannelIds: ['C-other'] } },
  });
  await handlers.handleMessage(message({ channelId: 'C-lonely', content: 'anyone there' }));
  assert.deepEqual(sessions.acquired, []);
});

test('a follow-up window carries an unmentioned message, and closing it stops that', async () => {
  const { handlers, sessions, windows, bundled } = harness({
    config: { discord: { followUpWindowSeconds: 300 } },
  });

  await handlers.handleMessage(message({ content: `<@${BOT}> start`, mentioned: true }));
  assert.equal(sessions.acquired.length, 1);

  // Inside the window: no @, still delivered — but NOT as `addressed`, which is
  // what keeps `!` lines out of the command handler below.
  await handlers.handleMessage(message({ content: 'and also this', id: 'M-2' }));
  assert.equal(sessions.acquired.length, 2);
  assert.equal(bundled[1].addressed, false);

  windows.close(CHANNEL);
  await handlers.handleMessage(message({ content: 'and this', id: 'M-3' }));
  assert.equal(sessions.acquired.length, 2, 'a closed window must stop carrying messages');
});

test("the bot's own message extends the window rather than waking anything", async () => {
  const { handlers, sessions, windows } = harness({
    config: { discord: { followUpWindowSeconds: 300 } },
  });

  assert.equal(windows.isOpen(CHANNEL), false);
  await handlers.handleMessage(message({ authorId: BOT, content: 'posted by the agent' }));
  assert.deepEqual(sessions.acquired, [], 'the bot must never wake itself');
  assert.equal(windows.isOpen(CHANNEL), true, 'the bot having spoken keeps the conversation alive');
});

test('another bot is ignored entirely, window or no window', async () => {
  const { handlers, sessions, windows } = harness({
    config: { discord: { followUpWindowSeconds: 300 } },
  });
  windows.extend(CHANNEL);
  await handlers.handleMessage(message({ authorId: 'U-other-bot', bot: true, content: 'beep' }));
  assert.deepEqual(sessions.acquired, []);
});

test('a bare @ is handed over as a placeholder rather than dropped', async () => {
  const { handlers, sessions } = harness();
  await handlers.handleMessage(message({ content: `<@${BOT}>`, mentioned: true }));
  // Someone getting your attention with no text is still someone getting your
  // attention. The agent decides what to do with it, not the waker.
  assert.equal(sessions.acquired[0].woke[0].messages[0].content, '(mentioned you, no text)');
});

test('a bare attachment in an always-on channel gets the other placeholder', async () => {
  const { handlers, sessions } = harness({
    config: { discord: { alwaysOnChannelIds: [CHANNEL] } },
  });
  await handlers.handleMessage(message({ content: '   ' }));
  assert.equal(sessions.acquired[0].woke[0].messages[0].content, '(no text)');
});

test('an always-on channel does not churn window state it never consults', async () => {
  // The window is anchored to bot activity. An always-on channel wakes on every
  // message anyway, so opening a window there each time would keep a second,
  // invisible piece of state hot for a room that never reads it — and would then
  // keep waking the agent for `followUpWindowSeconds` after the channel stopped
  // being always-on, which is the version of this that bites.
  const { handlers, windows } = harness({
    config: { discord: { alwaysOnChannelIds: [CHANNEL], followUpWindowSeconds: 300 } },
  });

  await handlers.handleMessage(message({ content: 'no @ here' }));
  assert.equal(windows.isOpen(CHANNEL), false);

  // A real mention in the same channel still opens one, as anywhere else.
  await handlers.handleMessage(message({ content: `<@${BOT}> hi`, mentioned: true, id: 'M-2' }));
  assert.equal(windows.isOpen(CHANNEL), true);
});

test('an empty unaddressed message inside a window is dropped, not placeheld', async () => {
  const { handlers, sessions, windows } = harness({
    config: { discord: { followUpWindowSeconds: 300 } },
  });
  windows.extend(CHANNEL);
  await handlers.handleMessage(message({ content: '' }));
  assert.deepEqual(sessions.acquired, []);
});

// ── the ! commands ──────────────────────────────────────────────────────────

test('!status is answered by the waker and never reaches the agent', async () => {
  const { handlers, sessions } = harness();
  const msg = message({ content: `<@${BOT}> !status`, mentioned: true });
  await handlers.handleMessage(msg);

  assert.deepEqual(sessions.acquired, [], 'a command must not wake a turn');
  assert.equal(msg.replies.length, 1);
  assert.match(msg.replies[0], /Live sessions: 1\/4/);
  assert.match(msg.replies[0], /Idle eviction: never/);
  assert.match(msg.replies[0], /Mail: disabled/);
});

test('!stop actually interrupts the live turn, rather than only saying it did', async () => {
  const { handlers, sessions, sent } = harness();
  const msg = message({ content: `<@${BOT}> !stop`, mentioned: true });
  await handlers.handleMessage(msg);

  // The reply is the easy half and it is the half that would still be right if
  // the interrupt were deleted. `!stop` is the one command that reaches into a
  // live turn, so what it did is the assertion, not what it said.
  assert.deepEqual(sessions.interrupted, [CHANNEL]);
  assert.deepEqual(msg.replies, ['Interrupted.']);
  // Acquired to look at the session, not to run a turn.
  assert.equal(sessions.acquired.length, 1);
  assert.deepEqual(sessions.acquired[0].woke, []);

  // And with inert events, which is `silentEvents`' whole reason: there is no
  // wake in flight to rescue here, so a respawn would be churn — and a `!stop`
  // that respawned would restart the very turn it was asked to stop.
  const { events } = sessions.acquired[0];
  await captureStderr(async () => {
    events.onNeedsRespawn(false);
    events.onDone(authFailure());
    events.onError(new Error('ignored'));
    await settle();
  });
  assert.equal(sessions.acquired.length, 1, '`!stop` must not start anything');
  assert.deepEqual(sessions.released, []);
  assert.deepEqual(sessions.persisted, []);
  assert.deepEqual(sent, []);
});

test('!stop with nothing running says so and does not create a session to stop', async () => {
  const { handlers, sessions } = harness();
  sessions.has = () => false;
  const msg = message({ content: `<@${BOT}> !stop`, mentioned: true });
  await handlers.handleMessage(msg);

  assert.deepEqual(sessions.acquired, [], 'acquiring here would spawn a container to interrupt it');
  assert.deepEqual(sessions.interrupted, []);
  assert.deepEqual(msg.replies, ['Nothing running here.']);
});

test('!status reports the model this channel resolves to, not the default', async () => {
  // Round 3 of #163. A Discord channel has no row until it has taken a turn, and
  // `acquire` would resolve that case through `#identityFor`'s coordinator
  // fallback — so `!status` has to use the same fallback or it reports one model
  // while the next turn runs on another.
  const { handlers } = harness({ config: { modelByRole: { coordinator: 'a-cheaper-model' } } });
  const msg = message({ content: `<@${BOT}> !status`, mentioned: true });
  await handlers.handleMessage(msg);

  // No registry row for this channel — the fixture's registry is empty — so this
  // is the fallback path, and it must agree with what `acquire` would do.
  assert.match(msg.replies[0], /Model: a-cheaper-model/);
  assert.doesNotMatch(msg.replies[0], /Model: a-model/);
});

test('!status reports the default when the resolved role has no override', async () => {
  const { handlers } = harness({ config: { modelByRole: { updater: 'a-cheaper-model' } } });
  const msg = message({ content: `<@${BOT}> !status`, mentioned: true });
  await handlers.handleMessage(msg);

  // An override exists, but not for the role this channel resolves to. The
  // assertion that would have passed vacuously before the one above.
  assert.match(msg.replies[0], /Model: a-model/);
});

test('answering a command extends the window rather than ending the conversation', async () => {
  // The command path returns before the `if (mentioned)` extend below it, so
  // without its own extend, asking `!status` mid-conversation would close the
  // window that the mention before it had opened.
  const { handlers, windows } = harness({ config: { discord: { followUpWindowSeconds: 300 } } });
  assert.equal(windows.isOpen(CHANNEL), false);

  const msg = message({ content: `<@${BOT}> !status`, mentioned: true });
  await handlers.handleMessage(msg);

  assert.equal(msg.replies.length, 1, 'the command has to have been handled for this to mean anything');
  assert.equal(windows.isOpen(CHANNEL), true);
});

test('!reset clears the session and keeps the row, because the row is the mailbox', async () => {
  const { handlers, sessions, registry } = harness();
  const msg = message({ content: `<@${BOT}> !reset`, mentioned: true });
  await handlers.handleMessage(msg);

  assert.deepEqual(sessions.released, [CHANNEL]);
  // Deleting the row would throw away the mailbox along with the transcript.
  assert.deepEqual(registry.cleared, [CHANNEL]);
  assert.match(msg.replies[0], /Session cleared/);
});

test('a ! line inside a follow-up window is text for the agent, not a command', async () => {
  const { handlers, sessions } = harness({
    config: { discord: { followUpWindowSeconds: 300 } },
  });
  await handlers.handleMessage(message({ content: `<@${BOT}> start`, mentioned: true }));
  sessions.acquired.length = 0;

  // Commands are only handled when addressed — otherwise any '!' line in a live
  // channel would hit them.
  const msg = message({ content: '!status of the deploy is unclear', id: 'M-2' });
  await handlers.handleMessage(msg);
  assert.deepEqual(msg.replies, []);
  assert.equal(sessions.acquired.length, 1);
  assert.equal(sessions.acquired[0].woke[0].messages[0].content, '!status of the deploy is unclear');
});

test('an unrecognised ! command falls through to the agent', async () => {
  const { handlers, sessions } = harness();
  const msg = message({ content: `<@${BOT}> !deploy`, mentioned: true });
  await handlers.handleMessage(msg);
  assert.deepEqual(msg.replies, []);
  assert.equal(sessions.acquired.length, 1);
  assert.equal(sessions.acquired[0].woke[0].messages[0].content, '!deploy');
});

// ── deliver's catch: which failures the channel hears about ─────────────────

test('a full pool is announced, with the numbers and the remedies', async () => {
  const { handlers, sessions, sent } = harness();
  sessions.onAcquire = () => {
    throw new AtCapacityError(4, 4);
  };

  const log = await captureStderr(async () => {
    handlers.deliver(CHANNEL, buffered());
    await settle();
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /No session slot free — 4 of 4 are in use/);
  // `idleTimeoutMinutes: 0` is NOT the shipped configuration any more — 30 is,
  // since #249 — and the test below covers the sentence a real user now gets.
  // This one keeps 0 because 0 is still supported and its refusal is a
  // different, stronger claim: with nothing reclaiming a slot, the pool really
  // cannot clear on its own.
  assert.match(sent[0], /will not clear on its own/);
  // Clawcius #146: this is the sentence a user actually reads, and the whole
  // point of the fix is that it reaches them here rather than only in a doc.
  assert.match(sent[0], /`!reset`/);
  assert.match(log, /could not wake/);
});

test('with eviction on, the same refusal says when to come back instead', async () => {
  const { handlers, sessions, sent } = harness({ config: { sessions: { idleTimeoutMinutes: 30 } } });
  sessions.onAcquire = () => {
    throw new AtCapacityError(2, 2);
  };

  await captureStderr(async () => {
    handlers.deliver(CHANNEL, buffered());
    await settle();
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /A slot frees after 30m idle/);
  assert.doesNotMatch(sent[0], /will not clear on its own/);
});

test('any other wake failure stays quiet — the bot does not narrate its plumbing', async () => {
  const { handlers, sessions, sent } = harness();
  sessions.onAcquire = () => {
    throw new Error('docker: no such container');
  };

  const log = await captureStderr(async () => {
    handlers.deliver(CHANNEL, buffered());
    await settle();
  });

  assert.deepEqual(sent, [], 'only a full pool earns a message in the channel');
  assert.match(log, /could not wake: docker: no such container/);
});

test('an empty bundle acquires nothing', () => {
  const { handlers, sessions } = harness();
  handlers.deliver(CHANNEL, []);
  assert.deepEqual(sessions.acquired, []);
});

test('a channel that cannot be fetched loses the announcement and not the process', async () => {
  const { handlers, sessions, sent } = harness({ fetchThrows: true });
  sessions.onAcquire = () => {
    throw new AtCapacityError(4, 4);
  };

  const log = await captureStderr(async () => {
    handlers.deliver(CHANNEL, buffered());
    await settle();
  });

  assert.deepEqual(sent, []);
  // Best effort: throwing out of here would take the process with it.
  assert.match(log, /could not announce capacity: Unknown Channel/);
});

test('a channel that is not text-based is left alone', async () => {
  // With a `send` on it, so this fails if the `isTextBased()` check is dropped
  // rather than passing because the fake happened to lack the method.
  const sent = [];
  const { handlers } = harness({
    channel: {
      isTextBased: () => false,
      send: async (text) => {
        sent.push(text);
      },
    },
  });
  await handlers.announceOutage(CHANNEL, authFailure());
  await handlers.announceAtCapacity(CHANNEL, new AtCapacityError(1, 1));
  assert.deepEqual(sent, []);
});

// ── onDone: which API failures are news ─────────────────────────────────────

test('a turn with no API error announces nothing', async () => {
  const { handlers, sessions, sent } = harness();
  handlers.deliver(CHANNEL, buffered());

  await captureStderr(async () => {
    sessions.acquired[0].events.onDone(cleanTurn());
    await settle();
  });

  assert.deepEqual(sent, []);
  assert.deepEqual(sessions.persisted, [CHANNEL], 'a finished turn writes its session id back');
});

test('a refusal with a retry queued stays quiet — it is not yet news', async () => {
  const { handlers, sessions, sent } = harness();
  handlers.deliver(CHANNEL, buffered());

  const log = await captureStderr(async () => {
    sessions.acquired[0].events.onDone(
      authFailure({ apiErrorKind: 'rate_limit', retryScheduled: true, retryAttempt: 2 }),
    );
    await settle();
  });

  assert.deepEqual(sent, []);
  assert.match(log, /API REFUSED THE TURN \(rate_limit\)/);
  assert.match(log, /retry 2 queued/);
});

test('a terminal refusal that no respawn will handle is announced', async () => {
  const { handlers, sessions, sent } = harness();
  handlers.deliver(CHANNEL, buffered());

  const log = await captureStderr(async () => {
    sessions.acquired[0].events.onDone(authFailure({ apiErrorKind: 'billing_error' }));
    await settle();
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /the API refused it \(`billing_error`\)/);
  assert.match(log, /not retrying — this one does not clear on its own/);
});

test('an auth failure on the FIRST attempt is left to the respawn', async () => {
  const { handlers, sessions, sent } = harness();
  handlers.deliver(CHANNEL, buffered());

  await captureStderr(async () => {
    sessions.acquired[0].events.onDone(authFailure());
    await settle();
  });

  // A respawn is about to be attempted, and it usually works. Saying "this needs
  // a look at the host" here would cry outage at something about to fix itself.
  assert.deepEqual(sent, []);
});

test('the same auth failure AFTER a respawn is announced', async () => {
  const { handlers, sessions, sent } = harness();
  handlers.deliver(CHANNEL, buffered(), true);

  await captureStderr(async () => {
    sessions.acquired[0].events.onDone(authFailure());
    await settle();
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /needs a look at the host/);
});

test('a dead transport drops the session, or the channel fails forever', async () => {
  // The third event on that object, and the one whose failure mode is worst:
  // a session whose child process is gone can never recover, so if it is left
  // in the pool every later message in that channel acquires the same corpse.
  // From Discord that is a channel that has silently stopped working until
  // somebody restarts the unit — and `deliver`'s catch cannot help, because
  // this arrives asynchronously long after `acquire` returned.
  const { handlers, sessions, sent } = harness();
  handlers.deliver(CHANNEL, buffered());

  const log = await captureStderr(async () => {
    sessions.acquired[0].events.onError(new Error('spawn docker ENOENT'));
    await settle();
  });

  assert.deepEqual(sessions.released, [CHANNEL], 'the dead session must be dropped');
  // And quietly: the bot narrating its own plumbing is worse than a dropped
  // turn, and the next message spawns a fresh session and usually works.
  assert.deepEqual(sent, []);
  assert.match(log, /spawn docker ENOENT/);
});

// ── onNeedsRespawn: replay, and announcing exactly once ─────────────────────

test('a stale token replays the wake into a fresh session when nothing had acted', async () => {
  const { handlers, sessions } = harness();
  handlers.deliver(CHANNEL, buffered('write the file'));

  const log = await captureStderr(async () => {
    sessions.acquired[0].events.onNeedsRespawn(false);
    await settle();
  });

  assert.deepEqual(sessions.released, [CHANNEL], 'the dead session has to go, not be retried');
  assert.equal(sessions.acquired.length, 2, 'the wake is replayed into a fresh session');
  assert.equal(sessions.acquired[1].woke[0].messages[0].content, 'write the file');
  assert.match(log, /stale token in a live session — respawning/);
});

test('a stale token does NOT replay when the dead turn had already acted', async () => {
  const { handlers, sessions } = harness();
  handlers.deliver(CHANNEL, buffered('post the announcement'));

  const log = await captureStderr(async () => {
    sessions.acquired[0].events.onNeedsRespawn(true);
    await settle();
  });

  // The fresh session resumes a transcript whose work is already done. Replaying
  // the request would repeat it: two commits, two Discord posts.
  assert.deepEqual(sessions.released, [CHANNEL]);
  assert.equal(sessions.acquired.length, 1, 'a turn that had acted must not be replayed');
  assert.match(log, /not replaying — the dead turn had already acted/);
});

test('a respawn that also fails to authenticate stops, rather than respawning forever', async () => {
  const { handlers, sessions } = harness();
  handlers.deliver(CHANNEL, buffered(), true);

  const log = await captureStderr(async () => {
    sessions.acquired[0].events.onNeedsRespawn(false);
    await settle();
  });

  assert.equal(sessions.acquired.length, 1, 'afterRespawn must suppress a second round');
  assert.deepEqual(sessions.released, [], 'and must not drop the session a third time');
  assert.match(log, /respawned session ALSO failed to authenticate/);
});

test('a dead credential announces EXACTLY ONCE across the whole respawn cycle', async () => {
  // The rule this file exists for. On 2026-08-03 this shipped as four identical
  // warnings in three seconds, which reads as a broken bot rather than a broken
  // credential. The sequence below is that incident: a wake fails to
  // authenticate, the session is respawned, the respawned one fails the same
  // way, and the channel should learn about it once.
  const { handlers, sessions, sent } = harness();

  const log = await captureStderr(async () => {
    handlers.deliver(CHANNEL, buffered());

    // Attempt one: onDone first (the SDK ends the turn before the pool is told
    // the session is unusable), then the respawn request.
    sessions.acquired[0].events.onDone(authFailure());
    sessions.acquired[0].events.onNeedsRespawn(false);
    await settle();

    assert.equal(sessions.acquired.length, 2, 'the respawn must have replayed the wake');

    // Attempt two, on the fresh session, failing identically.
    sessions.acquired[1].events.onDone(authFailure());
    sessions.acquired[1].events.onNeedsRespawn(false);
    await settle();
  });

  assert.equal(
    sessions.acquired.length,
    2,
    'a genuinely dead credential must fail twice and stop, not spawn forever',
  );
  assert.equal(
    sent.length,
    1,
    `the channel must hear about a dead credential once, not ${sent.length} times: ` +
      JSON.stringify(sent),
  );
  assert.match(sent[0], /needs a look at the host/);
  // And the second round is still in the journal, which is where the detail
  // belongs — the announcement is for the person in the channel.
  assert.match(log, /respawned session ALSO failed to authenticate/);
});

// ── the smaller handlers ────────────────────────────────────────────────────

test('an edit by the bot extends the window; an edit by anyone else does not', () => {
  const { handlers, windows } = harness({ config: { discord: { followUpWindowSeconds: 300 } } });

  handlers.handleMessageUpdate({ author: { id: 'U-human' }, channelId: CHANNEL });
  assert.equal(windows.isOpen(CHANNEL), false);

  // The agent's progress checklists work by editing, and those should keep the
  // conversation alive.
  handlers.handleMessageUpdate({ author: { id: BOT }, channelId: CHANNEL });
  assert.equal(windows.isOpen(CHANNEL), true);
});

test('an edit with no author at all is survivable — an edit arrives partial', () => {
  const { handlers, windows } = harness({ config: { discord: { followUpWindowSeconds: 300 } } });
  handlers.handleMessageUpdate({ author: null, channelId: CHANNEL });
  assert.equal(windows.isOpen(CHANNEL), false);
});

test('the host agent is reported as absent until the ops executor claims the row', () => {
  const absent = harness();
  assert.match(absent.handlers.describeHostAgent(), /is not on this board/);

  const claimed = harness({
    registry: fakeRegistry({ 'hamachi-host': { id: 'hamachi-host', role: 'host', crew: 'hamachi' } }),
  });
  assert.match(claimed.handlers.describeHostAgent(), /DM hamachi-host — coordinators only/);
});

test('a row whose role is not host does not count as the host agent', () => {
  // The id is claimed by whoever writes the row; the ROLE is what mail.ts
  // enforces on. A coordinator about to be told "unknown recipient" would
  // rather find out here.
  const { handlers } = harness({
    registry: fakeRegistry({
      'hamachi-host': { id: 'hamachi-host', role: 'coordinator', crew: 'hamachi' },
    }),
  });
  assert.match(handlers.describeHostAgent(), /is not on this board/);
});

test('the crew line counts rows by role and says how many were spawned', () => {
  const { handlers } = harness({
    registry: fakeRegistry({
      a: { id: 'a', role: 'coordinator', crew: 'hamachi', spawnedBy: null },
      b: { id: 'b', role: 'engineer', crew: 'hamachi', spawnedBy: 'a' },
      c: { id: 'c', role: 'engineer', crew: 'hamachi', spawnedBy: 'a' },
    }),
  });
  const line = handlers.describeCrew();
  assert.match(line, /hamachi — 3 row\(s\): 1 coordinator, 2 engineer/);
  assert.match(line, /2 spawned/);
});

test('more than one coordinator row is annotated, because it is not more than one agent', () => {
  // Sessions are keyed on `message.channelId`, which is per thread as well as
  // per channel, so `9 coordinator` would be read by everybody as nine agents.
  const { handlers } = harness({
    registry: fakeRegistry({
      a: { id: 'a', role: 'coordinator', crew: 'hamachi', spawnedBy: null },
      b: { id: 'b', role: 'coordinator', crew: 'hamachi', spawnedBy: null },
      h: { id: 'h', role: 'host', crew: 'hamachi', spawnedBy: null },
    }),
  });
  const line = handlers.describeCrew();
  assert.match(line, /a coordinator row is one Discord channel or thread, not one agent/);
  assert.match(line, /the host runs outside the container and is not crew/);
  assert.match(line, /none spawned/);
});

test('an empty board says so rather than rendering an empty list', () => {
  const { handlers } = harness();
  assert.equal(handlers.describeCrew(), 'hamachi — no rows on the board');
});
