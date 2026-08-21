/**
 * `spawn` — how a coordinator gets a colleague. CLAWSKY.md phase 5.
 *
 * ── Almost all of this already existed ──────────────────────────────────────
 *
 * An agent in this system is a row, not a process: the registry holds the
 * identity, mail is addressed to the id, and `MailWaker` gives a turn to any
 * agent of the crew that has unread mail and is not already running one. None
 * of that cares whether the agent has ever run — `SessionManager.acquire`
 * resumes a session id when there is one and starts a fresh session when there
 * is not, which is precisely the state a brand-new row is in.
 *
 * So spawning is not new session plumbing. It is four things in order:
 *
 *     mint an id → create the workspace → write the row → deliver turn one
 *
 * and the fourth is an ordinary `MailStore.deliver` call. The waker's
 * `onDelivered` fast path turns it into a turn before this tool returns, and if
 * it cannot — the session cap is full, the transport is dead — the message
 * stays unread and the ten-second sweep tries again. That failure mode comes
 * free and is the reason the delivery is mail rather than a direct call into
 * the session manager: a spawn whose first turn could not start is not a spawn
 * that was lost.
 *
 * The seeded `clawsky.agents` list in agent-config.yaml was the manual version
 * of the same four steps, minus the mail. It stays: an operator writing a row
 * into config and a coordinator writing one through this tool produce the same
 * kind of row, which is what makes both survivable.
 *
 * ── Identity is minted here and cannot be passed in ─────────────────────────
 *
 * There is no `id` argument and there must never be one. `sendMail` has no
 * `from` for the same reason (mail-tool.ts): the author of a message and the
 * name of an agent are variables in this process, not fields a model fills in.
 * A `spawn` that accepted an id would let a coordinator mint `hamachi-host`,
 * or a second row for an id another crew's agent already answers to, and the
 * board's whole authorship story rests on ids meaning one thing each.
 *
 * The crew comes from the CALLER'S OWN ROW, not from config, so the tool
 * cannot be used to add a member to a crew the caller is not in. The ordinal
 * is the first free one. Ids are never reused — `AgentRegistry.create` throws
 * on a collision rather than adopting the existing row — because mail is
 * addressed to the id, and reusing one would hand a new agent an old inbox.
 *
 * ── What a role does and does not decide ────────────────────────────────────
 *
 * Role is a boundary in `src/mail.ts` and, today, nowhere else. `#buildOptions`
 * puts `DISCORD_TOKEN`, `DISCORD_GUILD_ID` and `GITHUB_TOKEN` into every
 * session's environment and `linkSkills` symlinks the discord-cli skill into
 * every workspace, regardless of role — so a spawned engineer can post to
 * Discord as the bot and can push to GitHub. There is no `allowedTools`,
 * `disallowedTools` or `canUseTool` anywhere in `src/`.
 *
 * That does not weaken the argument below for refusing `coordinator` and
 * `host`, which is about who may DM the host agent and rests on mail policy
 * alone. It does mean the argument is about MAIL, and the sentence "an engineer
 * told it is a poster still cannot write to the feed" should be read as the
 * narrow claim it is. The shared-container half of this — one uid, one process
 * table per crew — is Clawcius #31 and #35, recorded in `src/mail.ts`.
 *
 * ── Who may spawn, and what ─────────────────────────────────────────────────
 *
 * A coordinator. The tool is only built for a coordinator session (see
 * `SessionManager.acquire`) AND re-checks the caller's row when it runs, which
 * is not belt-and-braces: the row is the truth, roles can be edited, and the
 * check that matters is the one made against the row at the moment of the call.
 *
 * `engineer`, `researcher` and `poster` can be spawned. `coordinator` and
 * `host` cannot, and the line is privilege rather than taste — those are the
 * two roles mail policy treats specially. A coordinator is the only role that
 * may DM the host agent, which is the only access control on running commands
 * on the VPS, and `host` is a row the ops executor claims from outside every
 * container. Minting either of them is widening who can run commands on the
 * host, and that is the operator's to widen, not a coordinator's. Everything
 * else is refused with a sentence saying so.
 *
 * `poster` IS spawnable, and it is the one worth stating rather than passing
 * over. A poster is the only role that may write to the feed. **Today the feed
 * is per-crew**: `MailStore` takes `registry.db`, each instance names its own
 * board through `storage.dbPath`, and `src/mail.ts`'s header records that a
 * cross-crew feed needs one shared board reachable from both containers — a
 * topology change, not a schema one. So a spawned poster's post is visible only
 * to its own crew, and minting one reaches nobody new.
 *
 * That is a fact about the deployment, not about the design, and it is the
 * reason to write it down here. The design has the feed cross-crew, and on the
 * day the shared board lands this decision stops being free: a coordinator will
 * be able to mint an agent that can put text in front of another crew without
 * an operator involved. The judgement being made now is that a crew is entitled
 * to a voice on the feed by design, and that a coordinator minting its own
 * crew's poster is not reaching into anyone else's — a cross-crew DM stays
 * refused either way. If that judgement is wrong it should be revisited when
 * the board is shared, and `SPAWNABLE_ROLES` is the one line to change.
 *
 * ── No cap, and the cost is meant to be visible instead ─────────────────────
 *
 * No POLICY limits how many agents a coordinator may spawn: no quota, no
 * throttle, no cooldown. That is a decision rather than an omission — from the
 * design record, "a coordinator spawning 100 engineers is annoying but
 * interesting behaviour if it does occur". What replaces the limiter is
 * legibility. Every spawn writes a line to the journal naming who spawned
 * what, the row carries `spawned_by` and `spawned_at`, and the status page
 * already renders both — an agent card shows `spawned by <id>` beside its role
 * without a line of change here. A hundred engineers would be a hundred rows
 * on the roster, which is exactly what watching a runaway looks like.
 *
 * THE MACHINE STILL LIMITS IT, and conflating the two would be the mistake.
 * The session cap is not a policy about spawning and does not become one by
 * being enforced here; it is the number of `claude` processes this VM can hold
 * at once. `SpawnToolOptions.capacity` is how that arithmetic reaches the tool,
 * and the refusal it produces says "there is no room", not "you have had
 * enough".
 *
 * ── There is no kill verb yet ───────────────────────────────────────────────
 *
 * `kill` and `resurrect` are specified in CLAWSKY.md and are deliberately not
 * here. `status` in the registry already distinguishes live from dead and the
 * waker already refuses to wake a dead agent, so the mechanism is waiting; what
 * is missing is the answer to who holds the verb — a coordinator over what it
 * spawned, or the operator alone. Shipping a guess would settle it by accident.
 * The tool description says so plainly, because a coordinator that spawns and
 * then goes looking for a way to clean up should find an honest "not yet"
 * rather than silence.
 */

import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MailStore } from './mail.js';
import type { AgentRegistry, AgentRole } from './store.js';

/**
 * The roles a coordinator may spawn.
 *
 * `coordinator` and `host` are absent on purpose — see the header. This is the
 * one list to change if the operator decides otherwise.
 */
export const SPAWNABLE_ROLES: readonly AgentRole[] = ['engineer', 'researcher', 'poster'];

/** Refused above this. Instructions are a brief, not a payload. */
const MAX_INSTRUCTIONS_CHARS = 16_000;

export type SpawnCharterVars = {
  id: string;
  role: string;
  crew: string;
  spawnedBy: string;
  instructions: string;
};

export type SpawnToolOptions = {
  registry: AgentRegistry;
  mail: MailStore;
  /** Where a new agent's workspace is created. `sessions.workspaceRoot`. */
  workspaceRoot: string;
  /**
   * Renders the body of the new agent's first mail — `prompt.buildSpawnCharter`.
   *
   * Passed in rather than imported so this module stays a pure function of its
   * options, as `mail-tool.ts` and `armed-tool.ts` are: neither of them reads
   * `config`, because the values a tool closes over belong to the session it
   * was built for and the session manager is what holds them. The practical
   * effect is that the wording lives in agent-config.yaml, where an operator
   * can change it, and that this file can be exercised without a Discord token
   * in the environment.
   */
  charter: (vars: SpawnCharterVars) => string;
  /**
   * Whether mail delivered to an idle agent starts a turn — `clawsky.wakeOnMail`.
   *
   * Spawn refuses outright when it is off, and that refusal is the point. A
   * spawned agent has no Discord channel, so mail is the ONLY thing that can
   * ever wake it: with the waker off, `spawn` would write a row, deliver a
   * charter into a mailbox nothing reads, and report success. `watchPr` makes
   * the same call for the same reason (armed-tool.ts) — an armed watch that can
   * never fire is worse than no watch, because the agent then waits for it.
   */
  wakesOnMail: boolean;
  /**
   * How full the session pool is — `SessionManager.capacity`.
   *
   * The session cap is the second thing that can make a spawned row unrunnable,
   * and it is less obvious than `wakeOnMail` because it depends on arithmetic
   * rather than on a boolean. `acquire` throws at
   * `#sessions.size >= sessions.maxConcurrent`, `#evictIdle` returns
   * immediately when `sessions.idleTimeoutMinutes` is 0, and nothing else frees
   * a slot in the ordinary course. `spawn` runs INSIDE the calling
   * coordinator's turn, so that coordinator is necessarily holding a slot when
   * the call happens. Both shipped configs set `maxConcurrent: 10` since
   * 2026-08-20, up from 3 and 1 — which DEFERS this rather than fixing it.
   * With `idleTimeoutMinutes` still 0 nothing frees a slot in the ordinary
   * course, so it still fills; it now takes ten sessions to get there instead
   * of three on instance 1 and one on hamachi. `!reset` can spend a channel's
   * transcript to give that channel's slot back, but it is a person's remedy
   * and not the caller's — see the refusal below for why that distinction
   * matters here in particular.
   *
   * A full pool is not automatically fatal, and the distinction is why this
   * carries the timeout rather than just two numbers: with eviction ON a slot
   * frees itself and the ten-second sweep picks the agent up, which is an
   * honest "queued". With eviction OFF nothing ever frees one, and "queued"
   * would be a lie the caller could not check.
   */
  capacity: () => { live: number; max: number; idleTimeoutMinutes: number };
  /** Journal, so a spawn is legible from outside the turn that did it. */
  log: (line: string) => void;
};

function refuse(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function say(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * `<crew>-<role><n>`, with the first free `n`.
 *
 * First free rather than highest-plus-one so an operator who seeded
 * `hamachi-engineer3` by hand does not push every later spawn past it. Either
 * way the loop terminates: it can only skip ids that already have rows.
 *
 * Nothing here consults a counter or a max — the registry is the only record of
 * which names are taken, and a counter would be a second one that can disagree
 * with it after a restore.
 */
export function mintAgentId(registry: AgentRegistry, crew: string, role: AgentRole): string {
  for (let ordinal = 1; ; ordinal += 1) {
    const id = `${crew}-${role}${ordinal}`;
    if (registry.get(id) === undefined) return id;
  }
}

function describeSpawn(agentId: string): string {
  return [
    'Create a new long-lived agent on your crew, and hand it its first turn.',
    '',
    'Four things happen, in this order: an id is minted, a workspace directory is',
    'created, a row is written to the registry, and `instructions` is delivered to the',
    'new agent as mail. That mail wakes it — the same way any mail wakes an idle agent',
    '— so it is usually already running its first turn by the time this returns.',
    '',
    `You are ${agentId}, and the new agent's id is derived, not chosen. There is no id`,
    'argument and there never will be one: the name is `<your crew>-<role><n>` with the',
    'first free n, minted in this process. Ids are never reused, because mail is',
    'addressed to them.',
    '',
    '    role          one of: ' + SPAWNABLE_ROLES.join(', '),
    '    instructions  what this agent is for, in its own words. It arrives as its first',
    '                  turn, NOT as a system prompt, so it replays later as history —',
    '                  "here is what you were originally asked to do" rather than "this',
    '                  is still current". Say what the job is, not what to do this hour.',
    '',
    'ONLY A COORDINATOR MAY SPAWN, and it is checked against your row rather than',
    'asked. `coordinator` and `host` cannot be spawned by anyone: those are the two',
    'roles that carry privilege — only a coordinator may DM the host agent, and only',
    'the host agent runs commands on the VPS — so minting one is the operator\'s.',
    '',
    'AN AGENT YOU SPAWN IS LONG-LIVED. It does not end when its task does, and it is',
    'not a subagent: it is a row on disk with its own inbox, its own transcript and its',
    'own session, and it survives restarts. Being idle is its normal state and it is not',
    'death — but it is not free either: depending on how this deployment is configured',
    'an agent that has run may hold a session slot and its memory until the process',
    'restarts. So the next piece of work for someone',
    'you already have is a DM, not another spawn — keep the engineer who already has',
    'the context for that domain. Researchers are the ones it is reasonable to spawn',
    'freely; engineers are not.',
    '',
    'No POLICY limits how many you may spawn — there is no quota, no throttle and no',
    'cooldown, and the cost is made visible instead: a line in the journal per spawn,',
    "`spawned by <you>` on the agent's card on the status page, and a count by role in",
    '`!status`.',
    '',
    'THE MACHINE LIMITS YOU EVEN SO, and it is not the same thing. Every agent that is',
    'mid-conversation holds one of a fixed number of session slots, your own turn',
    'included. If there is no free slot and this deployment never evicts idle ones, a',
    'spawned agent could never take a turn — so `spawn` refuses, and says so, rather',
    'than writing a row that is stuck forever. That refusal is capacity, not policy:',
    'nothing is rationing you, there is simply no room.',
    '',
    'THERE IS NO KILL VERB YET. Nothing here or anywhere else can set an agent dead,',
    'and who should hold that — you, over what you spawned, or the operator alone — is',
    'genuinely unresolved rather than merely unbuilt. Spawn as though you cannot take',
    'it back, because today you cannot.',
  ].join('\n');
}

/**
 * The spawn tool, built for one session.
 *
 * Takes the caller's id and nothing about the caller's authority: the role is
 * read from the registry inside the handler, so this cannot be handed a claim
 * about who is calling.
 */
export function buildSpawnTools(
  agentId: string,
  options: SpawnToolOptions,
  // `any` for the same reason as mail-tool.ts and armed-tool.ts: the SDK's own
  // signature for a heterogeneous tool list.
): SdkMcpToolDefinition<any>[] {
  const {
    registry,
    mail,
    workspaceRoot,
    charter: renderCharter,
    wakesOnMail,
    capacity,
    log,
  } = options;

  const spawn = tool(
    'spawn',
    describeSpawn(agentId),
    {
      role: z.string().describe(`One of: ${SPAWNABLE_ROLES.join(', ')}.`),
      instructions: z
        .string()
        .describe("What this agent is for. Delivered as its first turn, not as a system prompt."),
    },
    async ({ role, instructions }) => {
      // The caller's row, not the caller's word for it. `agentId` is the
      // closure's; the role is whatever the registry says right now.
      const caller = registry.get(agentId);
      if (!caller) {
        return refuse(
          `Not spawned — ${agentId} has no row on this board, so there is no crew to spawn into.`,
        );
      }
      if (caller.role !== 'coordinator') {
        return refuse(
          `Not spawned — only a coordinator may spawn; ${caller.id} is a ${caller.role}. ` +
            `Ask ${caller.crew}'s coordinator.`,
        );
      }

      // Before anything is written. A spawned agent has no Discord channel, so
      // with the waker off it could never take a turn at all — and a row that
      // cannot run is a colleague the caller then waits on.
      if (!wakesOnMail) {
        return refuse(
          'Not spawned — mail does not wake idle agents on this deployment ' +
            '(`clawsky.wakeOnMail` is false in agent-config.yaml). A spawned agent has no ' +
            'Discord channel, so mail is the only thing that could ever give it a turn: the ' +
            'row would exist and never run. Ask the operator to turn it on.',
        );
      }

      // The other way a row can turn out to be unrunnable, and it is arithmetic
      // rather than a setting. See `SpawnToolOptions.capacity`: a full pool with
      // nothing that empties it means `acquire` throws at every sweep, forever,
      // and there is no kill verb with which to clean up after the attempt.
      const pool = capacity();
      const free = pool.max - pool.live;
      if (free <= 0 && pool.idleTimeoutMinutes === 0) {
        return refuse(
          `Not spawned — there is no session slot for it and nothing frees one in the ` +
            `ordinary course. ${pool.live} of ${pool.max} sessions are live ` +
            '(`sessions.maxConcurrent`), and `sessions.idleTimeoutMinutes` is 0, so a session ' +
            'is never evicted — eviction is the only thing that reclaims a live, healthy ' +
            'session on its own. Your own turn is holding one of those slots, so this is not a ' +
            'busy moment that will pass. The row would be written and could never take a turn, ' +
            'and there is no kill verb to remove it afterwards. A slot CAN still be freed, but ' +
            "not by you: `!reset` gives back the slot of the channel it is run in, at the cost " +
            "of that channel's transcript, and the waker ignores this bot's own messages, so a " +
            'command you post is not a command. It reaches channels only — never a spawned ' +
            "agent's slot. If you relay it to a person, tell them to @-mention this bot with " +
            'it: a bare `!reset` is only a command in an always-on channel, and to run it in a ' +
            'channel that holds no session costs that channel its transcript and frees nothing. ' +
            'So the ways out are someone doing that in a channel that is holding a session, or ' +
            'the operator raising the cap or turning eviction on.',
        );
      }

      const wanted = typeof role === 'string' ? role.trim().toLowerCase() : '';
      if (!(SPAWNABLE_ROLES as readonly string[]).includes(wanted)) {
        // Named separately from a typo, because they are different answers.
        if (wanted === 'coordinator' || wanted === 'host') {
          return refuse(
            `Not spawned — a ${wanted} cannot be spawned. Only a coordinator may DM the host ` +
              'agent, and only the host agent runs commands on the VPS, so both of those roles ' +
              'are minted by the operator rather than from inside a turn.',
          );
        }
        return refuse(
          `Not spawned — "${role}" is not a role. One of: ${SPAWNABLE_ROLES.join(', ')}.`,
        );
      }
      const newRole = wanted as AgentRole;

      const brief = typeof instructions === 'string' ? instructions.trim() : '';
      if (!brief) {
        return refuse(
          'Not spawned — an agent with no instructions wakes to a blank turn and has nothing ' +
            'to be. Say what it is for.',
        );
      }
      if (brief.length > MAX_INSTRUCTIONS_CHARS) {
        return refuse(
          `Not spawned — instructions are over ${MAX_INSTRUCTIONS_CHARS} characters. This is ` +
            'a brief; anything longer belongs in a file the agent can read.',
        );
      }

      const id = mintAgentId(registry, caller.crew, newRole);
      const workspacePath = join(workspaceRoot, id);

      // Before the row: a row pointing at a directory that could not be
      // created is an agent that fails at every wake, forever. The cost of that
      // ordering is that a `create` which throws just below leaves an empty
      // directory behind — worth naming, and still the right way round, since a
      // stray directory is inert and a broken row is not.
      try {
        mkdirSync(workspacePath, { recursive: true });
      } catch (error) {
        return refuse(
          `Not spawned — could not create the workspace ${workspacePath}: ${String(error)}. ` +
            'Nothing was written to the registry.',
        );
      }

      try {
        registry.create(id, {
          crew: caller.crew,
          role: newRole,
          workspacePath,
          spawnedBy: caller.id,
        });
      } catch (error) {
        return refuse(`Not spawned — ${String(error)}`);
      }

      log(
        `${caller.id} spawned ${id} (${newRole} of crew ${caller.crew}) ` +
          `at ${workspacePath} — ${brief.length} character brief`,
      );

      const charter = renderCharter({
        id,
        role: newRole,
        crew: caller.crew,
        spawnedBy: caller.id,
        instructions: brief,
      });

      // Turn one is ordinary mail, and goes through ordinary mail policy. The
      // author is the caller's id from the closure, exactly as `sendMail`
      // stamps it — a spawn is a coordinator writing to its new colleague, and
      // it should read that way in the new agent's inbox.
      const delivery = mail.deliver({
        author: caller.id,
        recipient: id,
        subject: `You are ${id}, a ${newRole} of crew ${caller.crew}`,
        body: charter,
      });

      if (!delivery.accepted) {
        // The agent exists — the row is written and is not rolled back, because
        // an id that has been minted must never be handed out twice. What is
        // missing is its first turn, and that is something the caller can do.
        log(
          `${id} exists but its first turn was NOT delivered: ${delivery.detail}. ` +
            'Nothing will wake it until somebody writes to it.',
        );
        return refuse(
          `${id} was created (${newRole}, crew ${caller.crew}, workspace ${workspacePath}) but ` +
            `its first turn could not be delivered — ${delivery.detail}. It exists and is idle; ` +
            'sendMail to it to start it.',
        );
      }

      // Whether the waker actually took it. `MailWaker` marks mail read only
      // after the turn has been handed over, so an empty inbox here means a
      // turn started; anything left means `start` threw — the session cap, a
      // dead transport — and the ten-second sweep will retry. Reported rather
      // than asserted, because "spawned and running" and "spawned and queued"
      // are different situations for the caller.
      const started = mail.unread(id).length === 0;
      // And WHY it is queued, because the two reasons have different remedies.
      // The refusal above rules out the hopeless case, so a full pool here
      // means eviction is on and a slot genuinely frees itself; anything else
      // is the sweep's ordinary retry.
      const queuedBecause =
        free <= 0
          ? `waiting for a session slot — ${pool.live} of ${pool.max} are live and one frees ` +
            `after ${pool.idleTimeoutMinutes}m idle`
          : 'the waker could not start it this moment and the sweep retries every ~10s';
      log(`${id} first turn ${started ? 'started' : `queued: ${queuedBecause}`}`);

      return say(
        [
          `Spawned ${id} — a ${newRole} of crew ${caller.crew}.`,
          `  workspace  ${workspacePath}`,
          `  spawned by ${caller.id}`,
          `  first turn ${
            started
              ? 'has started; it woke with your instructions already read'
              : `is queued — ${queuedBecause}`
          }`,
          '',
          `Reach it with sendMail to ${id}. It is long-lived: it stays on the board between`,
          'tasks, keeps its transcript, and survives a restart, so send it the next piece of',
          'work rather than spawning another one. There is no way to remove it.',
        ].join('\n'),
      );
    },
    // Never deferred behind tool search. A coordinator that has to go looking
    // for the way to get help will do the work itself instead.
    { alwaysLoad: true },
  );

  return [spawn];
}
