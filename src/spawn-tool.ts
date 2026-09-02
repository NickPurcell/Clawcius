import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MailStore } from './mail.js';
import type { AgentRegistry, AgentRole } from './store.js';

/** The roles a coordinator may spawn. */
export const SPAWNABLE_ROLES: readonly AgentRole[] = ['engineer', 'researcher', 'poster', 'updater'];

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
  /** Disarm every condition `owner` holds; returns how many. */
  disarm: (owner: string) => number;
  /** End `id`'s live session, if it has one. */
  release: (id: string) => Promise<void>;
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

const DESCRIPTION = [
  'Create a long-lived agent on your crew and hand it its first turn.',
  '',
  '    role          one of: ' + SPAWNABLE_ROLES.join(', '),
  '    instructions  what the agent is for. Delivered as its first mail, not as a',
  '                  system prompt, so it reads later as history.',
  '',
  'The id is minted here as <crew>-<role><n> and returned; there is no id argument.',
  'A workspace directory and a registry row are created, and `instructions` is',
  'delivered as mail from you, which starts its first turn. Reach it afterwards',
  'with sendMail. It stays on the board between tasks until you retire it.',
].join('\n');

const RETIRE_DESCRIPTION = [
  'Retire an agent of your crew: its session ends, its armed wakes are disarmed,',
  'and mail no longer wakes it. Only within your own crew, and never a',
  'coordinator. The row stays on the board as history.',
].join('\n');

/** The spawn and retire tools, built for one session. */
export function buildSpawnTools(
  agentId: string,
  options: SpawnToolOptions,
): SdkMcpToolDefinition<any>[] {
  const { registry, mail, workspaceRoot, charter: renderCharter, wakesOnMail, capacity, log, disarm, release } =
    options;

  const retire = tool(
    'retire',
    RETIRE_DESCRIPTION,
    { id: z.string().describe('The agent to retire, e.g. hamachi-researcher2.') },
    async ({ id }) => {
      const caller = registry.get(agentId);
      if (!caller) return refuse(`Not retired — ${agentId} has no row on this board.`);
      if (caller.role !== 'coordinator') {
        return refuse(`Not retired — only a coordinator may retire; ${caller.id} is a ${caller.role}.`);
      }
      const target = registry.get(id.trim());
      if (!target) return refuse(`Not retired — no agent "${id}" on this board.`);
      if (target.crew !== caller.crew) {
        return refuse(`Not retired — ${target.id} is ${target.crew}'s, not ${caller.crew}'s.`);
      }
      if (target.role === 'coordinator') {
        return refuse(`Not retired — ${target.id} is a coordinator; the operator retires those.`);
      }
      if (target.status !== 'live') return say(`${target.id} is already retired.`);

      registry.setStatus(target.id, 'dead');
      const disarmed = disarm(target.id);
      await release(target.id);
      log(`${caller.id} retired ${target.id} (${target.role}); ${disarmed} armed condition(s) disarmed`);
      return say(
        `Retired ${target.id}. Its session is closed, ${disarmed} armed condition(s) are disarmed, ` +
          'and mail will not wake it again.',
      );
    },
    { alwaysLoad: true },
  );

  const spawn = tool(
    'spawn',
    DESCRIPTION,
    {
      role: z.string().describe(`One of: ${SPAWNABLE_ROLES.join(', ')}.`),
      instructions: z.string().describe('What this agent is for. Delivered as its first turn.'),
    },
    async ({ role, instructions }) => {
      // The caller's role is read from its row, never from the caller.
      const caller = registry.get(agentId);
      if (!caller) {
        return refuse(`Not spawned — ${agentId} has no row on this board.`);
      }
      if (caller.role !== 'coordinator') {
        return refuse(
          `Not spawned — only a coordinator may spawn; ${caller.id} is a ${caller.role}. ` +
            `Ask ${caller.crew}'s coordinator.`,
        );
      }

      // A spawned agent has no Discord channel: mail is the only thing that can ever give it a turn.
      if (!wakesOnMail) {
        return refuse(
          'Not spawned — mail does not wake idle agents on this deployment ' +
            '(`clawsky.wakeOnMail` is false), so the row would exist and never run.',
        );
      }

      const wanted = role.trim().toLowerCase();
      if (!(SPAWNABLE_ROLES as readonly string[]).includes(wanted)) {
        if (wanted === 'coordinator') {
          return refuse('Not spawned — a coordinator cannot be spawned; the operator mints one.');
        }
        return refuse(
          `Not spawned — "${role}" is not a role. One of: ${SPAWNABLE_ROLES.join(', ')}.`,
        );
      }
      const newRole = wanted as AgentRole;

      const brief = instructions.trim();
      if (!brief) {
        return refuse('Not spawned — say what the agent is for; an empty brief wakes it to nothing.');
      }
      if (brief.length > MAX_INSTRUCTIONS_CHARS) {
        return refuse(
          `Not spawned — instructions are over ${MAX_INSTRUCTIONS_CHARS} characters. ` +
            'Anything longer than a brief belongs in a file the agent can read.',
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

      // Turn one is ordinary mail, and goes through ordinary mail policy.
      const delivery = mail.deliver({
        author: caller.id,
        recipient: id,
        subject: `You are ${id}, a ${newRole} of crew ${caller.crew}`,
        body: renderCharter({
          id,
          role: newRole,
          crew: caller.crew,
          spawnedBy: caller.id,
          instructions: brief,
        }),
      });

      if (!delivery.accepted) {
        // The row stays: a minted id is never handed out twice. Only the first turn is missing.
        log(`${id} exists but its first turn was NOT delivered: ${delivery.detail}.`);
        return refuse(
          `${id} was created (${newRole}, crew ${caller.crew}, workspace ${workspacePath}) but ` +
            `its first turn could not be delivered — ${delivery.detail}. It exists and is idle; ` +
            'sendMail to it to start it.',
        );
      }

      const started = mail.unread(id).length === 0;
      const pool = capacity();
      const queuedBecause =
        pool.max - pool.live <= 0
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
          `Reach it with sendMail to ${id}.`,
        ].join('\n'),
      );
    },
    { alwaysLoad: true },
  );

  return [spawn, retire];
}
