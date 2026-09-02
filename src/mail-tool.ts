import {
  createSdkMcpServer,
  tool,
  type McpServerConfig,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { MailMessage, MailStore } from './mail.js';
import { FEED } from './mail.js';
import { zonedStamp, DEFAULT_TIMEZONE } from './schedule.js';

/** PT and labelled, to the minute: an agent reads these beside its own clock, which is PT. */
function stamp(at: number): string {
  return zonedStamp(at, DEFAULT_TIMEZONE);
}

export function renderMail(messages: readonly MailMessage[]): string {
  if (messages.length === 0) return 'No mail.';

  const lines: string[] = [
    `${messages.length} message${messages.length === 1 ? '' : 's'}.`,
  ];
  for (const message of messages) {
    const kind = message.recipient === FEED ? 'FEED' : 'DM';
    lines.push('');
    lines.push(`── [${kind}] from ${message.author} · ${stamp(message.sentAt)}`);
    if (message.subject) lines.push(`subject: ${message.subject}`);
    lines.push(message.body);
  }
  return lines.join('\n');
}

const CHECK_MAIL = [
  'Read everything waiting in your inbox and mark it read. No arguments.',
  'Returns every message — DMs to you and posts on the feed — with sender, time,',
  'subject and body, or "No mail."',
].join('\n');

function describeSendMail(agentId: string): string {
  return [
    'Send mail: a DM to one agent of your crew, or a post to the feed.',
    '',
    '    to       an agent id, or "*" for the feed',
    '    subject  one line; may be omitted',
    '    body     the message',
    '',
    'Delivered before this returns; the result says delivered, or refused and why.',
    `The sender is always you, ${agentId}: there is no "from" argument.`,
  ].join('\n');
}

/** The two tools, built for one session. */
export function buildMailTools(
  mail: MailStore,
  agentId: string,
): SdkMcpToolDefinition<any>[] {
  const checkMail = tool(
    'checkMail',
    CHECK_MAIL,
    {},
    async () => {
      const messages = mail.collect(agentId);
      return { content: [{ type: 'text' as const, text: renderMail(messages) }] };
    },
    { alwaysLoad: true },
  );

  const sendMail = tool(
    'sendMail',
    describeSendMail(agentId),
    {
      to: z.string().describe('An agent id, "<crew>-coordinator", or "*" for the feed.'),
      subject: z.string().optional().describe('One line. May be omitted.'),
      body: z.string().describe('The message.'),
    },
    async ({ to, subject, body }) => {
      // `agentId` is the closure's, never the argument's: that is the whole authorship guarantee.
      const result = mail.deliver({
        author: agentId,
        recipient: typeof to === 'string' ? to.trim() : '',
        subject: subject ?? '',
        body: body ?? '',
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: result.accepted ? result.detail : `Not sent — ${result.detail}`,
          },
        ],
        isError: !result.accepted,
      };
    },
    { alwaysLoad: true },
  );

  return [checkMail, sendMail];
}

/** `extra` is how the armed tools join this server rather than starting a second one. */
export function buildMailServer(
  mail: MailStore,
  agentId: string,
  extra: SdkMcpToolDefinition<any>[] = [],
): Record<string, McpServerConfig> {
  return {
    clawsky: createSdkMcpServer({
      name: 'clawsky',
      version: '0.1.0',
      tools: [...buildMailTools(mail, agentId), ...extra],
      alwaysLoad: true,
    }),
  };
}
