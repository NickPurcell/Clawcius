/**
 * The agent's mechanical instructions and the per-wake message.
 *
 * Scope is deliberately narrow. This file describes *how the plumbing works* —
 * that ordinary output is invisible, and which command makes words appear in
 * Discord. It does not say when to speak, whether to answer, how chatty to be,
 * or what tone to take. All of that is behaviour, and behaviour belongs to
 * `systemPrompt.append` in agent-config.yaml, where it can be changed without
 * touching code.
 *
 * The CLI itself is documented in `.claude/skills/discord-cli/SKILL.md`, which
 * the agent loads from its workspace. Restating it here would guarantee the two
 * drift apart, with the stale copy in this file silently winning.
 */

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import type { WakeContext } from './types.js';

/**
 * Always included, regardless of config: without it the agent does not know its
 * output is invisible, and nothing it does can reach anyone.
 */
function discordProtocol(): string {
  const cli = config.agent.paths.discordCli;

  return `
## Speaking in Discord

You are in a Discord server. You are woken when messages arrive in a channel you
are part of, and when a wake you scheduled comes due.

Your ordinary text output is not shown to anyone — it is private scratch space.
Words reach Discord only when you run the \`discord\` CLI:

    ${cli} reply -c <channel_id> -m <message_id> -t "..."

For long or multi-line bodies, omit \`-t\` and pipe the text on stdin:

    printf '%s' "$BODY" | ${cli} reply -c <channel_id> -m <message_id>

\`reply\` threads under a specific message. \`send -c <channel_id>\` posts to the
channel without threading — use it when there is no message to reply to, such as
a scheduled wake. A skill documents the full CLI; read it before your first call
in a session.

Your working directory persists between wakes. Use it for notes and
intermediate work.

## Waking yourself later

\`schedule_wake\`, \`schedule_repeating\`, \`list_schedules\` and
\`cancel_schedule\` arrange for you to be woken in the future. The prompt you
supply is what your future self receives, so write it as a self-contained
instruction rather than a reference to the current conversation.

There are limits on how often and how many wakes you may schedule. A rejected
call says which limit it hit.
`.trim();
}

/**
 * Assemble the SDK `systemPrompt` option.
 *
 * `useClaudeCodeDefault: true` keeps Claude Code's own prompt as the base and
 * layers ours on top. Setting it false replaces that base entirely, including
 * Claude Code's tool-use guidance, so the agent gets noticeably worse at tool
 * work. The Discord protocol above is present either way.
 */
export function buildSystemPrompt(): Options['systemPrompt'] {
  const { useClaudeCodeDefault, append } = config.agent.systemPrompt;
  const layered = [discordProtocol(), append.trim()].filter(Boolean).join('\n\n');

  if (useClaudeCodeDefault) {
    return { type: 'preset', preset: 'claude_code', append: layered };
  }
  return layered;
}

function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The per-wake message. Kept compact — everything here is paid for on every
 * wake, so context the agent can fetch on demand is left to the CLI.
 */
export function buildWakeMessage(context: WakeContext): string {
  const cli = config.agent.paths.discordCli;

  if (context.kind === 'schedule') {
    return [
      'Scheduled wake.',
      '',
      `channel_id:  ${context.channelId}`,
      `schedule_id: ${context.scheduleId}`,
      ...(context.repeats ? [`repeats:     ${context.repeats}`] : []),
      '',
      'Your instruction to yourself:',
      context.prompt,
      '',
      'No message to reply to. To post:',
      `  ${cli} send -c ${context.channelId} -t "..."`,
    ].join('\n');
  }

  const { messages } = context;
  const latest = messages[messages.length - 1];
  const plural = messages.length === 1 ? 'message' : 'messages';

  return [
    `${messages.length} new ${plural}:`,
    '',
    ...messages.map((m) => `[${clockOf(m.at)}] ${m.authorTag}: ${m.content}`),
    '',
    `channel_id: ${context.channelId}`,
    `latest message_id: ${latest?.messageId ?? ''}`,
    '',
    'To reply to the latest:',
    `  ${cli} reply -c ${context.channelId} -m ${latest?.messageId ?? ''} -t "..."`,
  ].join('\n');
}
