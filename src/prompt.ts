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
import type { WakeContext } from './types.js';

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
export function buildSystemPrompt(): Options['systemPrompt'] {
  const protocol = render(config.agent.prompts.protocol, {
    cli: config.agent.paths.discordCli,
  });

  const layered = [protocol, config.agent.systemPrompt.append.trim()]
    .filter(Boolean)
    .join('\n\n');

  if (config.agent.systemPrompt.useClaudeCodeDefault) {
    return { type: 'preset', preset: 'claude_code', append: layered };
  }
  return layered;
}

function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** The per-wake message handed to the agent. */
export function buildWakeMessage(context: WakeContext): string {
  const cli = config.agent.paths.discordCli;
  const { prompts } = config.agent;

  if (context.kind === 'schedule') {
    return render(prompts.scheduleWake, {
      cli,
      roleNotice: prompts.roleNotice,
      channelId: context.channelId,
      scheduleId: context.scheduleId,
      repeats: context.repeats ?? 'once',
      prompt: context.prompt,
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
    roleNotice: prompts.roleNotice,
    count: String(messages.length),
    plural: messages.length === 1 ? 'message' : 'messages',
    messages: rendered,
    channelId: context.channelId,
    latestMessageId: latest?.messageId ?? '',
  });
}
