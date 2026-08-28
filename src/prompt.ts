/** Renders the text the agent receives. */

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

/** Who the session is, as the system prompt needs to say it. */
export type PromptIdentity = { id: string; crew: string; role: string };

/** Assemble the SDK `systemPrompt`. */
export function buildSystemPrompt(identity: PromptIdentity): Options['systemPrompt'] {
  const protocol = render(config().agent.prompts.protocol, {
    cli: config().agent.paths.discordCli,
  });

  const known = isAgentRole(identity.role);
  const roleNotice = render(
    known ? config().agent.prompts.roleNotice : config().agent.prompts.roleNoticeUnknown,
    { id: identity.id, crew: identity.crew, role: identity.role },
  );

  const append = render(config().agent.systemPrompt.append, { cli: config().agent.paths.discordCli });
  const layered = [protocol, roleNotice, append]
    .filter(Boolean)
    .join('\n\n');

  if (config().agent.systemPrompt.useClaudeCodeDefault) {
    return { type: 'preset', preset: 'claude_code', append: layered };
  }
  return layered;
}

/** The body of the mail a spawned agent wakes to — CLAWSKY.md phase 5. */
export function buildSpawnCharter(vars: {
  id: string;
  role: string;
  crew: string;
  spawnedBy: string;
  instructions: string;
}): string {
  return render(config().agent.prompts.spawnCharter, vars);
}

/** The clock an agent reads beside every Discord message. */
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
