/**
 * Claude Code transcripts off local disk:
 *
 *     <projectsRoot>/<slugified-cwd>/<sessionId>.jsonl              the session
 *     <projectsRoot>/<slug>/<sessionId>/subagents/agent-<id>.jsonl  one per subagent
 *     ...agent-<id>.meta.json                                       {agentType, description, toolUseId, parentAgentId?}
 *     ...subagents/workflows/<runId>/                               the same pair per workflow subagent
 *
 * What is cached per transcript is an index (byte offset, length, type and
 * timestamp per line), never content; it grows by reading only the appended
 * tail and is rebuilt when the first bytes of the file change.
 */

import { createReadStream, type Dirent } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { AgentRoot, ReadConfig, StatusConfig } from './config.js';

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
  /\b(Authorization:\s*(?:Bearer|Basic|token))\s+\S+/gi,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
];

/** Replace credential-shaped substrings with `[redacted]`, keeping an Authorization scheme. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, group1: string | undefined) =>
      typeof group1 === 'string' ? `${group1} [redacted]` : '[redacted]',
    );
  }
  return out;
}

const MAX_META_CHARS = 2000;

function metaText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const safe = redact(value);
  return safe.length <= MAX_META_CHARS ? safe : `${safe.slice(0, MAX_META_CHARS)}…`;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROJECT_SLUG_PATTERN = /^[A-Za-z0-9._-][A-Za-z0-9._-]{0,255}$/;
const WORKFLOW_RUN_PATTERN = /^wf_[A-Za-z0-9_-]{1,120}$/;

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}
export function isValidSubagentId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}
export function isValidProjectSlug(value: string): boolean {
  if (value === '.' || value === '..') return false;
  return PROJECT_SLUG_PATTERN.test(value);
}

/** Resolve `parts` under `root`; null for anything that escapes it. */
export function resolveWithin(root: string, ...parts: string[]): string | null {
  const target = resolve(root, ...parts);
  if (target === root) return target;
  return target.startsWith(root.endsWith(sep) ? root : root + sep) ? target : null;
}

// ── Index types ─────────────────────────────────────────────────────────────

/** What is kept per transcript line. Never the content. */
export type LineMeta = {
  offset: number;
  length: number;
  type: string;
  /** Milliseconds since epoch, or null when the line has no usable timestamp. */
  ts: number | null;
  /** True when this line contains at least one tool_use block. */
  hasToolUse: boolean;
  /** True when this line's content is a tool_result rather than prose. */
  isToolResult: boolean;
};

/** A Task/Agent tool call seen in a transcript — one subagent being spawned. */
export type SpawnRecord = {
  toolUseId: string;
  subagentType: string;
  description: string;
  /** Filled in from the tool_result, which announces the id the runtime assigned. */
  agentId: string | null;
};

export type TranscriptIndex = {
  path: string;
  /** Bytes folded into the index — always a whole number of complete lines. */
  indexedBytes: number;
  size: number;
  mtimeMs: number;
  /** First bytes of the file, to detect a rewrite masquerading as an append. */
  fingerprint: string;
  lines: LineMeta[];
  /** Lines with a timestamp: what a lane pages through. */
  stamped: number;
  spawns: SpawnRecord[];
  malformedLines: number;
  firstTs: number | null;
  lastTs: number | null;
};

const FINGERPRINT_BYTES = 512;

// ── Line-level extraction ───────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const AGENT_ID_IN_RESULT = /\bagentId:\s*([0-9a-f]{8,})/;

function contentBlocks(line: Record<string, unknown>): unknown[] {
  const message = asRecord(line['message']);
  if (!message) return [];
  const content = message['content'];
  return Array.isArray(content) ? content : [];
}

function emptyIndex(path: string): TranscriptIndex {
  return {
    path,
    indexedBytes: 0,
    size: 0,
    mtimeMs: 0,
    fingerprint: '',
    lines: [],
    stamped: 0,
    spawns: [],
    malformedLines: 0,
    firstTs: null,
    lastTs: null,
  };
}

/** Fold one raw line into the index. */
function foldLine(index: TranscriptIndex, raw: string, offset: number, length: number): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    index.malformedLines += 1;
    return;
  }
  const line = asRecord(parsed);
  if (!line) {
    index.malformedLines += 1;
    return;
  }

  const type = asString(line['type']) ?? 'unknown';
  const ts = parseTimestamp(line['timestamp']);
  let hasToolUse = false;
  let isToolResult = false;

  for (const rawBlock of contentBlocks(line)) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    const blockType = asString(block['type']);

    if (blockType === 'tool_use') {
      hasToolUse = true;
      const name = asString(block['name']);
      if (name === 'Task' || name === 'Agent') {
        const input = asRecord(block['input']);
        const toolUseId = asString(block['id']);
        if (input && toolUseId) {
          index.spawns.push({
            toolUseId,
            subagentType: asString(input['subagent_type']) ?? 'unknown',
            description: asString(input['description']) ?? '',
            agentId: null,
          });
        }
      }
    } else if (blockType === 'tool_result') {
      isToolResult = true;
      const toolUseId = asString(block['tool_use_id']);
      if (toolUseId) {
        const spawn = index.spawns.find((candidate) => candidate.toolUseId === toolUseId);
        if (spawn && spawn.agentId === null) {
          const match = AGENT_ID_IN_RESULT.exec(flattenBlockText(block, 4000));
          if (match?.[1]) spawn.agentId = match[1];
        }
      }
    }
  }

  index.lines.push({ offset, length, type, ts, hasToolUse, isToolResult });

  if (ts !== null) {
    index.stamped += 1;
    if (index.firstTs === null || ts < index.firstTs) index.firstTs = ts;
    if (index.lastTs === null || ts > index.lastTs) index.lastTs = ts;
  }
}

/** Flatten a content block to plain text. */
function flattenBlockText(block: Record<string, unknown>, limit: number): string {
  const direct = block['content'] ?? block['text'];
  if (typeof direct === 'string') return direct.slice(0, limit);
  if (Array.isArray(direct)) {
    const parts: string[] = [];
    let used = 0;
    for (const entry of direct) {
      const record = asRecord(entry);
      const text = record ? asString(record['text']) : null;
      if (text === null) continue;
      parts.push(text);
      used += text.length;
      if (used >= limit) break;
    }
    return parts.join('\n').slice(0, limit);
  }
  return '';
}

/** Read `path` from `fromByte` and fold every COMPLETE line into `index`. */
async function foldFrom(index: TranscriptIndex, path: string, fromByte: number): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path, { start: fromByte });
    // Buffers, not strings: offsets are byte offsets, and a chunk boundary can land inside a multi-byte character.
    let pending: Buffer = Buffer.alloc(0);
    let consumed = fromByte;

    stream.on('data', (chunk: Buffer | string) => {
      pending = Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      let newlineAt = pending.indexOf(0x0a);
      while (newlineAt !== -1) {
        const lineBuffer = pending.subarray(0, newlineAt);
        const text = lineBuffer.toString('utf8').trim();
        if (text.length > 0) foldLine(index, text, consumed, lineBuffer.length);
        consumed += newlineAt + 1;
        pending = pending.subarray(newlineAt + 1);
        newlineAt = pending.indexOf(0x0a);
      }
    });

    stream.on('error', rejectPromise);
    stream.on('end', () => resolvePromise(consumed));
  });
}

async function readFingerprint(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(FINGERPRINT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FINGERPRINT_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('base64');
  } finally {
    await handle.close();
  }
}

// ── The store ───────────────────────────────────────────────────────────────

export type SessionRef = {
  agent: string;
  projectSlug: string;
  sessionId: string;
  transcriptPath: string;
  /** `<projectsRoot>/<slug>/<sessionId>` — may not exist. */
  sessionDir: string;
};

export type SubagentMeta = {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  parentAgentId: string | null;
};

export type SubagentRef = {
  agentId: string;
  path: string;
  meta: SubagentMeta | null;
};

/** Transcript indexes keyed by path, LRU beyond the limit. */
class IndexCache {
  #entries = new Map<string, TranscriptIndex>();
  #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get(path: string): TranscriptIndex | undefined {
    const entry = this.#entries.get(path);
    if (entry) {
      this.#entries.delete(path);
      this.#entries.set(path, entry);
    }
    return entry;
  }

  set(path: string, index: TranscriptIndex): void {
    this.#entries.delete(path);
    this.#entries.set(path, index);
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}

export class TranscriptStore {
  #config: StatusConfig;
  #cache: IndexCache;

  constructor(config: StatusConfig) {
    this.#config = config;
    this.#cache = new IndexCache(config.read.maxCachedSessions);
  }

  get read(): ReadConfig {
    return this.#config.read;
  }

  agent(id: string): AgentRoot | undefined {
    return this.#config.agents.find((candidate) => candidate.id === id);
  }

  get agents(): readonly AgentRoot[] {
    return this.#config.agents;
  }

  /** Index for a transcript, built or extended as needed. */
  async index(path: string): Promise<TranscriptIndex> {
    const info = await stat(path);
    const cached = this.#cache.get(path);

    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;

    if (cached && info.size >= cached.indexedBytes) {
      const fingerprint = await readFingerprint(path);
      if (fingerprint === cached.fingerprint) {
        cached.indexedBytes = await foldFrom(cached, path, cached.indexedBytes);
        cached.size = info.size;
        cached.mtimeMs = info.mtimeMs;
        this.#cache.set(path, cached);
        return cached;
      }
    }

    const fresh = emptyIndex(path);
    fresh.fingerprint = await readFingerprint(path);
    fresh.indexedBytes = await foldFrom(fresh, path, 0);
    fresh.size = info.size;
    fresh.mtimeMs = info.mtimeMs;
    this.#cache.set(path, fresh);
    return fresh;
  }

  /** Every session transcript in one project directory under an agent's root. */
  async sessionsIn(agent: AgentRoot, slug: string): Promise<SessionRef[]> {
    if (!isValidProjectSlug(slug)) return [];
    const dir = resolveWithin(agent.projectsRoot, slug);
    if (!dir) return [];

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions: SessionRef[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      // `agent-*.jsonl` beside a session is an older layout's subagent transcript, not a session.
      if (!isValidSessionId(sessionId) || sessionId.startsWith('agent-')) continue;
      sessions.push({
        agent: agent.id,
        projectSlug: slug,
        sessionId,
        transcriptPath: join(dir, entry.name),
        sessionDir: join(dir, sessionId),
      });
    }
    return sessions;
  }

  /** The subagent transcripts of one session, direct and workflow-run alike. */
  async subagents(session: SessionRef): Promise<SubagentRef[]> {
    const root = join(session.sessionDir, 'subagents');
    const refs: SubagentRef[] = [];

    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    await collectSubagents(root, entries, refs);

    const workflowsDir = join(root, 'workflows');
    let runDirs: Dirent[] = [];
    try {
      runDirs = await readdir(workflowsDir, { withFileTypes: true });
    } catch {
      return refs;
    }
    for (const runDir of runDirs) {
      if (!runDir.isDirectory() || !WORKFLOW_RUN_PATTERN.test(runDir.name)) continue;
      const resolved = resolveWithin(workflowsDir, runDir.name);
      if (!resolved) continue;
      try {
        await collectSubagents(resolved, await readdir(resolved, { withFileTypes: true }), refs);
      } catch {
        // The run directory vanished between the two readdirs.
      }
    }
    return refs;
  }

  /** A page of a transcript, read back from disk by byte offset. */
  async page(
    path: string,
    from: number,
    limit: number,
  ): Promise<{ entries: RenderedLine[]; total: number; nextFrom: number | null }> {
    const index = await this.index(path);
    const total = index.lines.length;
    const start = Math.max(0, Math.min(from, total));
    const end = Math.min(total, start + Math.max(1, limit));

    const handle = await open(path, 'r');
    try {
      const entries: RenderedLine[] = [];
      let bytesRead = 0;

      for (let i = start; i < end; i += 1) {
        const meta = index.lines[i];
        if (!meta) break;
        // A short page rather than a refused one: the client resumes at `nextFrom`.
        if (bytesRead > 0 && bytesRead + meta.length > this.#config.read.maxPageBytes) {
          return { entries, total, nextFrom: i };
        }
        const buffer = Buffer.alloc(meta.length);
        await handle.read(buffer, 0, meta.length, meta.offset);
        bytesRead += meta.length;
        entries.push(renderLine(buffer.toString('utf8'), i, this.#config.read.maxBlockChars));
      }
      return { entries, total, nextFrom: end < total ? end : null };
    } finally {
      await handle.close();
    }
  }
}

async function collectSubagents(dir: string, entries: Dirent[], into: SubagentRef[]): Promise<void> {
  for (const entry of entries) {
    // `journal.jsonl` beside the agents of a workflow run is the run's log, not a subagent.
    if (!entry.isFile() || !entry.name.startsWith('agent-') || !entry.name.endsWith('.jsonl')) continue;
    const agentId = entry.name.slice('agent-'.length, -'.jsonl'.length);
    if (!isValidSubagentId(agentId)) continue;
    into.push({
      agentId,
      path: join(dir, entry.name),
      meta: await readSubagentMeta(dir, entry.name),
    });
  }
}

async function readSubagentMeta(dir: string, jsonlName: string): Promise<SubagentMeta | null> {
  const metaPath = join(dir, jsonlName.replace(/\.jsonl$/, '.meta.json'));
  try {
    const record = asRecord(JSON.parse(await readFile(metaPath, 'utf8')) as unknown);
    if (!record) return null;
    return {
      agentType: metaText(record['agentType']),
      description: metaText(record['description']),
      toolUseId: asString(record['toolUseId']),
      parentAgentId: asString(record['parentAgentId']),
    };
  } catch {
    return null;
  }
}

// ── Rendering payloads ──────────────────────────────────────────────────────

export type RenderedBlock =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'thinking'; text: string; truncated: boolean }
  | { kind: 'tool_use'; name: string; toolUseId: string; input: string; truncated: boolean }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean; truncated: boolean }
  | { kind: 'other'; label: string; text: string; truncated: boolean };

export type RenderedLine = {
  /** Line ordinal within its transcript. */
  n: number;
  type: string;
  role: string | null;
  ts: string | null;
  /** True for a user line nobody typed: a mail wake, a skill preamble, a resume prompt. */
  isMeta: boolean;
  /** Operational records (`system`, `queue-operation`, …) carry a one-line summary. */
  summary: string | null;
  blocks: RenderedBlock[];
};

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  const redacted = redact(text);
  if (redacted.length <= limit) return { text: redacted, truncated: false };
  return { text: redacted.slice(0, limit), truncated: true };
}

/** Turn one raw JSONL line into something the UI can draw. */
export function renderLine(raw: string, n: number, maxBlockChars: number): RenderedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { n, type: 'malformed', role: null, ts: null, isMeta: false, summary: 'unparseable line', blocks: [] };
  }

  const line = asRecord(parsed) ?? {};
  const message = asRecord(line['message']);
  const type = asString(line['type']) ?? 'unknown';
  const blocks: RenderedBlock[] = [];
  let summary: string | null = null;

  const content = message?.['content'];
  if (typeof content === 'string') {
    const { text, truncated } = truncate(content, maxBlockChars);
    blocks.push({ kind: 'text', text, truncated });
  } else if (Array.isArray(content)) {
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (block) blocks.push(renderBlock(block, maxBlockChars));
    }
  }

  if (blocks.length === 0) {
    const operational =
      asString(line['operation']) ??
      asString(line['aiTitle']) ??
      asString(line['mode']) ??
      asString(line['content']);
    if (operational) summary = truncate(operational, 400).text;
  }

  return {
    n,
    type,
    role: message ? asString(message['role']) : null,
    ts: asString(line['timestamp']),
    isMeta: line['isMeta'] === true || line['isSynthetic'] === true,
    summary,
    blocks,
  };
}

function renderBlock(block: Record<string, unknown>, limit: number): RenderedBlock {
  const kind = asString(block['type']);

  if (kind === 'text') {
    const { text, truncated } = truncate(asString(block['text']) ?? '', limit);
    return { kind: 'text', text, truncated };
  }

  if (kind === 'thinking' || kind === 'redacted_thinking') {
    const { text, truncated } = truncate(asString(block['thinking']) ?? '[redacted thinking]', limit);
    return { kind: 'thinking', text, truncated };
  }

  if (kind === 'tool_use') {
    let input = '';
    try {
      input = JSON.stringify(block['input']) ?? '';
    } catch {
      input = '"[uninspectable tool input]"';
    }
    const { text, truncated } = truncate(input, limit);
    return {
      kind: 'tool_use',
      name: asString(block['name']) ?? 'unknown',
      toolUseId: asString(block['id']) ?? '',
      input: text,
      truncated,
    };
  }

  if (kind === 'tool_result') {
    const { text, truncated } = truncate(flattenBlockText(block, limit * 2), limit);
    return {
      kind: 'tool_result',
      toolUseId: asString(block['tool_use_id']) ?? '',
      text,
      isError: block['is_error'] === true,
      truncated,
    };
  }

  const { text, truncated } = truncate(flattenBlockText(block, limit), limit);
  return { kind: 'other', label: kind ?? 'block', text, truncated };
}

export function describeFsError(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return `${path} does not exist`;
  if (code === 'EACCES' || code === 'EPERM') return `${path} is not readable by this service`;
  if (code === 'ENOTDIR') return `${path} is not a directory`;
  return `${path}: ${error instanceof Error ? error.message : String(error)}`;
}
