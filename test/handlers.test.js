import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHandlers } from '../dist/daemon.js';
import { classifyRetry } from '../dist/agent.js';
import { ConversationWindows } from '../dist/window.js';
import { AtCapacityError } from '../dist/agent.js';

const BOT = 'BOT-USER-ID';
const CHANNEL = 'C-main';

/** Only the keys the handlers read. */
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
      // a TypeError naming it rather than a plausible default.
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

  /** What `handleMessage` buffered, before `deliver` reshapes it. */
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
  nonce = null,
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
    nonce,
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

const authFailure = (overrides = {}) => {
  const base = {
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
  };
  return {
    ...base,
    noRetryReason:
      'noRetryReason' in overrides
        ? overrides.noRetryReason
        : base.retryScheduled
          ? null
          : classifyRetry({
              errorKind: base.apiErrorKind,
              failed: true,
              retriesSpent: 99,
              closed: false,
              hasContext: true,
            }).noRetryReason,
  };
};

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
  await handlers.handleMessage(message({ authorId: BOT, nonce: 'agent', content: 'posted by the agent' }));
  assert.deepEqual(sessions.acquired, [], 'the bot must never wake itself');
  assert.equal(windows.isOpen(CHANNEL), true, 'the bot having spoken keeps the conversation alive');
});

test("a post from our account without the agent stamp — a bot's upload — opens no window", async () => {
  const { handlers, sessions, windows } = harness({
    config: { discord: { followUpWindowSeconds: 300 } },
  });
  await handlers.handleMessage(message({ authorId: BOT, content: 'video.mp4' }));
  assert.deepEqual(sessions.acquired, []);
  assert.equal(windows.isOpen(CHANNEL), false, 'a daemon posting through the same account is not a conversation');
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
  // The window is anchored to bot activity.
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
  assert.match(msg.replies[0], /Sessions: 1\/4 live/);
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
  assert.match(log, /could not wake/);
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
  assert.match(sent[0], /re-login on the host/);
  assert.match(sent[0], /could not authenticate/);
  assert.doesNotMatch(
    sent[0],
    /try again in a few minutes/i,
    'a dead credential must never be reported as an outage to wait out',
  );
});

test('a dead transport drops the session, or the channel fails forever', async () => {
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
  assert.match(sent[0], /re-login on the host/);
  assert.match(sent[0], /could not authenticate/);
  assert.doesNotMatch(
    sent[0],
    /try again in a few minutes/i,
    'a dead credential must never be reported as an outage to wait out',
  );
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

