/**
 * Renders the text the agent receives.
 *
 * There is deliberately no prose in this file. Every string the agent sees —
 * the standing instructions, the wake messages, how an individual message
 * renders — lives in `prompts` in agent-config.yaml. This module only supplies
 * the values and substitutes them, so changing what Clawcius is told is a
 * config edit rather than a code change and a rebuild.
 *
 * Placeholders are validated at startup against `PROMPT_PLACEHOLDERS`, so an
 * unknown one fails the boot instead of reaching the model as a literal
 * `{chanel_id}` that looks like the agent misread its own context.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { isAgentRole } from './store.js';
import type { WakeContext } from './types.js';
import { zonedStamp, DEFAULT_TIMEZONE } from './schedule.js';

/** Substitute `{name}` placeholders. Unknown names cannot survive config validation. */
function render(template: string, vars: Record<string, string>): string {
  const filled = template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? (vars[name] as string) : whole,
  );
  // An empty substitution (roleNotice set to "") would otherwise leave a run of
  // blank lines where it stood. Collapse them so switching it off is clean.
  return filled.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Assemble the SDK `systemPrompt`.
 *
 * `useClaudeCodeDefault: true` keeps Claude Code's own prompt as the base and
 * layers ours on top. Setting it false replaces that base entirely, including
 * Claude Code's tool-use guidance, so the agent gets noticeably worse at tool
 * work.
 *
 * Order is protocol then append: the operator's instructions land last and so
 * are the most recent thing in context.
 */
/**
 * Who the session is, as the system prompt needs to say it.
 *
 * Resolved by `SessionPool.acquire`, which holds the registry row, and passed
 * in -- the same shape `model` already uses, and for the reason `AgentSession`'s
 * own comment gives: this module knows nothing about the registry.
 */
export type PromptIdentity = { id: string; crew: string; role: string };

export function buildSystemPrompt(identity: PromptIdentity): Options['systemPrompt'] {
  const protocol = render(config().agent.prompts.protocol, {
    cli: config().agent.paths.discordCli,
  });

  // WHY THE SYSTEM PROMPT AND NOT A FIRST-TURN MESSAGE. This is rebuilt every
  // time a session is constructed, including on resume, so it cannot drift out
  // of step with a session that already carries an old preamble in its history
  // -- and it survives compaction, which a first turn does not.
  //
  // A ROLE THE CREW DOES NOT DEFINE GETS A DIFFERENT TEMPLATE, not a decorated
  // value. Decorating produced `<sousaphonist (not a role this crew defines)>`
  // in the clause that says which section is yours -- still telling the agent a
  // section exists, and naming a nonsense one. Two templates means the unknown
  // case simply has no such clause. It also keeps this file's own rule from the
  // header: no prose the agent sees lives in code, only substitution.
  const known = isAgentRole(identity.role);
  const roleNotice = render(
    known ? config().agent.prompts.roleNotice : config().agent.prompts.roleNoticeUnknown,
    { id: identity.id, crew: identity.crew, role: identity.role },
  );

  const layered = [protocol, roleNotice, config().agent.systemPrompt.append.trim()]
    .filter(Boolean)
    .join('\n\n');

  if (config().agent.systemPrompt.useClaudeCodeDefault) {
    return { type: 'preset', preset: 'claude_code', append: layered };
  }
  return layered;
}

/**
 * The body of the mail a spawned agent wakes to — CLAWSKY.md phase 5.
 *
 * Here rather than in `spawn-tool.ts` because this is the module that renders
 * text the agent receives, and because the template belongs in config with the
 * other four: what a new engineer is told about itself is exactly the kind of
 * thing an operator should be able to change without a rebuild.
 *
 * Every field but `instructions` is derived by the caller from the registry row
 * it just wrote. `instructions` is the caller's prose and is substituted in a
 * single pass, so a `{crew}` inside it stays literal rather than being read as
 * a placeholder.
 */
export function buildSpawnCharter(vars: {
  id: string;
  role: string;
  crew: string;
  spawnedBy: string;
  instructions: string;
}): string {
  return render(config().agent.prompts.spawnCharter, vars);
}

/**
 * The clock an agent reads beside every Discord message.
 *
 * PINNED TO PT AND LABELLED, because the un-pinned version rendered in whatever
 * zone the WAKER PROCESS happened to run in — and the waker runs on the host,
 * which is `Europe/Berlin`. `container.ts` already puts `TZ` in `HOST_ONLY` so
 * that "whatever the server happens to be set to" cannot silently win inside a
 * container; rendering on the host walked around that wall rather than through
 * it, and the agent had no way to tell, because the number carried no label.
 */
function clockOf(at: number): string {
  return zonedStamp(at, DEFAULT_TIMEZONE, 'time');
}

/** The per-wake message handed to the agent. */
export function buildWakeMessage(context: WakeContext): string {
  const cli = config().agent.paths.discordCli;
  const { prompts } = config().agent;

  if (context.kind === 'mail') {
    return render(prompts.mailWake, {
      mail: context.mail,
      count: String(context.count),
      plural: context.count === 1 ? 'message' : 'messages',
    });
  }

  const { messages } = context;
  const latest = messages[messages.length - 1];

  const rendered = messages
    .map((m) =>
      render(prompts.messageLine, {
        time: clockOf(m.at),
        author: m.authorTag,
        authorId: m.authorId,
        messageId: m.messageId,
        content: m.content,
      }),
    )
    .join('\n');

  return render(prompts.messageWake, {
    cli,
    count: String(messages.length),
    plural: messages.length === 1 ? 'message' : 'messages',
    messages: rendered,
    channelId: context.channelId,
    latestMessageId: latest?.messageId ?? '',
  });
}
