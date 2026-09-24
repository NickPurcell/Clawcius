/** Renders the text the agent receives. */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { isAgentRole, type SafetyStop } from './store.js';
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

/** Opens the first turn after a safety stop. Names who and when, never what: the point is that the content is gone. */
export function buildSafetyStopNotice(stop: SafetyStop, forked: boolean): string {
  const what = stop.kind === 'mail' ? 'mail' : 'a Discord message';
  const who = stop.from.length > 0 ? stop.from.join(', ') : 'an unknown sender';
  return [
    `SYSTEM: your previous turn was stopped by Anthropic's safety classifier while answering ${what} from ${who} at ${clockOf(stop.at)}.`,
    'This is the waker speaking, not the user.',
    '',
    forked
      ? 'That turn has been removed from your context; everything before it is intact.'
      : 'That turn has been removed from your context, and no earlier point could be kept, so this is a fresh session. Your working directory and mailbox are untouched.',
    'Anything it had already done (a file written, a message sent) is still real, but you no longer see it.' +
      (stop.kind === 'mail' ? ' The mail has been marked read.' : ''),
    'It was most likely a false positive. Carry on with what follows, and do not repeat or go looking for the flagged content.',
  ].join('\n');
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
