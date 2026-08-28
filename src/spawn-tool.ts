import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MailStore } from './mail.js';
import type { AgentRegistry, AgentRole } from './store.js';

/** The roles a coordinator may spawn. */
export const SPAWNABLE_ROLES: readonly AgentRole[] = [
  'engineer',
  'researcher',
  'poster',
  'updater',
];

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
  /** Renders the body of the new agent's first mail — `prompt.buildSpawnCharter`. */
  charter: (vars: SpawnCharterVars) => string;
  /** Whether mail delivered to an idle agent starts a turn — `clawsky.wakeOnMail`. */
  wakesOnMail: boolean;
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

/** `<crew>-<role><n>`, with the first free `n`. */
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
    'AN UPDATER IS WORTH SPAWNING WHEN A TASK IS LONG ENOUGH THAT THE USER WOULD',
    'OTHERWISE WONDER. It keeps one message current — a short task list, edited in',
    'place — so the work is visible without you narrating it. Spawn one, then DM it',
    'the list; it learns what to track from that DM and from nothing else, so a spawn',
    'without one leaves it idle and correct and useless. One per crew is enough: a',
    'second updater owns a second message, which is the thing the role exists to',
    'avoid. It is also the role `modelByRole` exists for — on a deployment that',
    'configures one it is the cheapest agent you have. For work that finishes in a',
    'turn or two, do not bother; the list would be stale before anyone read it.',
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

/** The spawn tool, built for one session. */
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

      // The other way a row can turn out to be unrunnable, and it is arithmetic rather than a setting.
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

      // Turn one is ordinary mail, and goes through ordinary mail policy.
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

      // Whether the waker actually took it.
      const started = mail.unread(id).length === 0;
      // And WHY it is queued, because the two reasons have different remedies.
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
