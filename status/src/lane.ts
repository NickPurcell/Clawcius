import type { MailRow } from './mail.js';
import type { RenderedLine } from './transcripts.js';

/** One thing an agent read, said or did, labelled by where it came from. */
export type LaneEntry = {
  /** Unique within the lane: `n<line>.<block>` for transcript content, `m<id>` for a board row. */
  key: string;
  ts: string | null;
  kind:
    | 'discord'
    | 'mail'
    | 'reminder'
    | 'schedule'
    | 'prwatch'
    | 'system'
    | 'prompt'
    | 'assistant'
    | 'thinking'
    | 'tool'
    | 'react'
    | 'mail-out'
    | 'mail-in'
    | 'note';
  label: string;
  text: string;
  /** The tool result, shown collapsed under its call. */
  detail: string | null;
  isError: boolean;
  truncated: boolean;
};

export type NameLookup = (id: string) => string;

/** Authors whose mail is the system speaking, not a colleague. */
const SYSTEM_AUTHORS = new Set(['system', 'deploy']);

// ── User-line parsing ───────────────────────────────────────────────────────

export type DiscordMessage = { time: string; author: string; content: string };

const BUNDLE_HEADER = /^\d+ new messages?:$/;
const MESSAGE_LINE = /^\[(\d{1,2}:\d{2})\] ([^:\n]+): ?(.*)$/;

/** The messages in a waker bundle ("N new messages:" then `[time] author: content` lines), or null. */
export function parseDiscordBundle(text: string): DiscordMessage[] | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => BUNDLE_HEADER.test(line.trim()));
  if (start === -1) return null;

  const messages: DiscordMessage[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('channel_id:')) break;
    const match = MESSAGE_LINE.exec(line);
    if (match) {
      messages.push({ time: match[1] ?? '', author: match[2] ?? '', content: match[3] ?? '' });
    } else if (messages.length > 0) {
      const last = messages[messages.length - 1]!;
      last.content = `${last.content}\n${line}`;
    }
  }
  for (const message of messages) message.content = message.content.trim();
  return messages.length > 0 ? messages : null;
}

export type WakeMail = { kind: 'DM' | 'FEED'; author: string; subject: string; body: string };

const MAIL_HEADER = /^── \[(DM|FEED)\] from (\S+) · /;

/** The messages in a mail wake (the `checkMail` rendering), or null when the text is not one. */
export function parseMailWake(text: string): WakeMail[] | null {
  const lines = text.split('\n');
  const messages: WakeMail[] = [];
  let current: WakeMail | null = null;
  let bodyLines: string[] = [];
  const close = (): void => {
    if (current) {
      current.body = bodyLines.join('\n').trim();
      messages.push(current);
    }
    bodyLines = [];
  };

  for (const line of lines) {
    const header = MAIL_HEADER.exec(line);
    if (header) {
      close();
      current = { kind: header[1] === 'FEED' ? 'FEED' : 'DM', author: header[2] ?? '', subject: '', body: '' };
      continue;
    }
    if (!current) continue;
    if (bodyLines.length === 0 && current.subject === '' && line.startsWith('subject: ')) {
      current.subject = line.slice('subject: '.length);
      continue;
    }
    bodyLines.push(line);
  }
  close();
  return messages.length > 0 ? messages : null;
}

/** The origin of a mail by who sent it and, for mail to oneself, what its subject says it is. */
export function mailOrigin(
  author: string,
  subject: string,
  selfId: string,
  nameOf: NameLookup,
): { kind: LaneEntry['kind']; label: string } {
  if (SYSTEM_AUTHORS.has(author)) return { kind: 'system', label: 'System' };
  if (author === selfId) {
    if (subject.startsWith('Reminder:')) return { kind: 'reminder', label: 'Reminder (self)' };
    if (subject.startsWith('Schedule:')) return { kind: 'schedule', label: 'Schedule' };
    if (subject.startsWith('watchPr')) return { kind: 'prwatch', label: 'PR watch' };
    return { kind: 'mail', label: 'Mail (self)' };
  }
  return { kind: 'mail', label: `Mail from ${nameOf(author)}` };
}

// ── Tool calls ──────────────────────────────────────────────────────────────

const REACT_COMMAND = /\bdiscord\s+react\b[^\n]*?\s-e\s+["']?([^\s"']+)/;
const MCP_NAME = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/;

function toolLabel(name: string): string {
  const mcp = MCP_NAME.exec(name);
  return `Tool: ${mcp?.[1] ?? name}`;
}

/** The line a tool call is shown as: a shell command as itself, anything else as its input. */
export function describeToolInput(inputJson: string): string {
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return inputJson;
  }
  if (typeof input !== 'object' || input === null) return inputJson;
  const record = input as Record<string, unknown>;
  if (typeof record['command'] === 'string') return record['command'];
  if (typeof record['file_path'] === 'string') {
    const rest = Object.entries(record).filter(([key]) => key !== 'file_path');
    return rest.length === 0 ? record['file_path'] : `${record['file_path']}\n${JSON.stringify(Object.fromEntries(rest), null, 2)}`;
  }
  return JSON.stringify(record, null, 2);
}

// ── Shaping ─────────────────────────────────────────────────────────────────

/**
 * Lane entries from transcript lines, in transcript order. A tool result is
 * folded under its call when the call is among `lines`; otherwise it stands alone.
 */
export function shapeLines(lines: readonly RenderedLine[], selfId: string, nameOf: NameLookup): LaneEntry[] {
  const entries: LaneEntry[] = [];
  const calls = new Map<string, LaneEntry>();

  for (const line of lines) {
    if (line.type === 'system' && line.summary) {
      entries.push(entry(`n${line.n}`, line.ts, 'system', 'System', line.summary));
      continue;
    }
    if (line.type !== 'user' && line.type !== 'assistant') continue;

    line.blocks.forEach((block, i) => {
      const key = `n${line.n}.${i}`;
      if (block.kind === 'tool_result') {
        const call = calls.get(block.toolUseId);
        if (call) {
          call.detail = block.text;
          call.isError = block.isError;
          call.truncated = call.truncated || block.truncated;
        } else {
          entries.push({ ...entry(key, line.ts, 'tool', 'Tool result', block.text), isError: block.isError, truncated: block.truncated });
        }
        return;
      }
      if (block.kind === 'tool_use') {
        const command = describeToolInput(block.input);
        const react = block.name === 'Bash' ? REACT_COMMAND.exec(command.split('\n')[0] ?? '') : null;
        const made = react
          ? entry(key, line.ts, 'react', `reacted ${react[1]}`, command.split('\n').slice(1).join('\n').trim())
          : entry(key, line.ts, 'tool', toolLabel(block.name), command);
        made.truncated = block.truncated;
        entries.push(made);
        if (block.toolUseId) calls.set(block.toolUseId, made);
        return;
      }
      if (block.kind === 'thinking') {
        // A thinking block whose text was not recorded says nothing worth a row.
        if (block.text) entries.push({ ...entry(key, line.ts, 'thinking', 'Thinking', block.text), truncated: block.truncated });
        return;
      }
      if (block.kind === 'other') {
        entries.push({ ...entry(key, line.ts, 'note', block.label, block.text), truncated: block.truncated });
        return;
      }
      if (line.type === 'assistant') {
        entries.push({ ...entry(key, line.ts, 'assistant', 'Assistant', block.text), truncated: block.truncated });
        return;
      }
      for (const made of userEntries(key, line, block.text, selfId, nameOf)) {
        made.truncated = block.truncated;
        entries.push(made);
      }
    });
  }
  return entries;
}

/** A user text block by origin: a Discord bundle, a mail wake, a meta prompt, or a typed prompt. */
function userEntries(key: string, line: RenderedLine, text: string, selfId: string, nameOf: NameLookup): LaneEntry[] {
  const bundle = parseDiscordBundle(text);
  if (bundle) {
    return bundle.map((message, i) =>
      entry(`${key}.${i}`, line.ts, 'discord', `Discord · ${message.author}`, message.content),
    );
  }
  const wake = parseMailWake(text);
  if (wake) {
    return wake.map((message, i) => {
      const origin = mailOrigin(message.author, message.subject, selfId, nameOf);
      const body = message.subject ? `${message.subject}\n\n${message.body}` : message.body;
      return entry(`${key}.${i}`, line.ts, origin.kind, origin.label, body);
    });
  }
  if (line.isMeta) return [entry(key, line.ts, 'system', 'System', text)];
  return [entry(key, line.ts, 'prompt', 'Prompt', text)];
}

function entry(key: string, ts: string | null, kind: LaneEntry['kind'], label: string, text: string): LaneEntry {
  return { key, ts, kind, label, text, detail: null, isError: false, truncated: false };
}

// ── Mail rows ───────────────────────────────────────────────────────────────

/** A board row as the lane shows it: "→ recipient: subject" sent, "← author: subject" received. */
export function mailEntry(row: MailRow, selfId: string, nameOf: NameLookup): LaneEntry {
  const ts = new Date(row.sentAt).toISOString();
  const body = row.body + (row.bodyTruncated ? '…' : '');
  if (SYSTEM_AUTHORS.has(row.author)) {
    return entry(`m${row.id}`, ts, 'system', 'System', row.subject ? `${row.subject}\n\n${body}` : body);
  }
  if (row.author === selfId) {
    if (row.recipient === selfId) {
      const origin = mailOrigin(row.author, row.subject, selfId, nameOf);
      return entry(`m${row.id}`, ts, origin.kind, origin.label, row.subject || body);
    }
    const to = row.recipient === '*' ? 'feed' : nameOf(row.recipient);
    return entry(`m${row.id}`, ts, 'mail-out', `→ ${to}: ${row.subject}`, body);
  }
  return entry(`m${row.id}`, ts, 'mail-in', `← ${nameOf(row.author)}: ${row.subject}`, body);
}

function tsOf(item: LaneEntry): number {
  return item.ts ? Date.parse(item.ts) : 0;
}

/** Transcript entries with mail entries merged in by time; a tie keeps the transcript entry first. */
export function mergeByTime(transcript: readonly LaneEntry[], mail: readonly LaneEntry[]): LaneEntry[] {
  const merged: LaneEntry[] = [];
  let m = 0;
  for (const item of transcript) {
    const at = tsOf(item);
    while (m < mail.length && tsOf(mail[m]!) < at) merged.push(mail[m++]!);
    merged.push(item);
  }
  while (m < mail.length) merged.push(mail[m++]!);
  return merged;
}
