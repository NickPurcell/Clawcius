/**
 * Reading Claude Code transcripts off local disk.
 *
 * The on-disk shape, as it actually is on this host (verified 2026-08-08 and
 * re-counted 2026-08-17 against /var/lib/hamachi/agent-home/projects):
 *
 *     <projectsRoot>/
 *       <slugified-cwd>/                      e.g. -var-lib-hamachi-workspaces-146707…
 *         <sessionId>.jsonl                   the main transcript
 *         <sessionId>/
 *           subagents/
 *             agent-<agentId>.jsonl           one per directly spawned subagent
 *             agent-<agentId>.meta.json       {agentType, description, toolUseId,
 *                                              parentAgentId?, spawnDepth, model?}
 *             workflows/
 *               <runId>/                      wf_4f93cd23-af9
 *                 agent-<agentId>.jsonl       one per subagent of that RUN
 *                 agent-<agentId>.meta.json   {agentType: "workflow-subagent",
 *                                              spawnDepth} — and nothing else
 *                 journal.jsonl               the run's own log, not an agent
 *           workflows/
 *             <runId>.json                    {workflowName, summary, status,
 *                                              agentCount, durationMs, startTime,
 *                                              phases[{title, detail}]}
 *           tool-results/                     spilled tool output, not read here
 *
 * The `subagents/workflows/` level is easy to miss and is where MOST of them
 * are: 58 of the 104 subagent transcripts under Hamachi's root on 2026-08-17.
 * This file read only the first level until then, so every subagent count it
 * printed was a little over half the real one.
 *
 * Every line is one JSON object. Most carry the conversation
 * (`type: user | assistant | attachment`), some are operational records with a
 * quite different shape (`type: queue-operation | mode | ai-title |
 * last-prompt`) that have no `uuid` at all. Nothing may assume a key exists.
 *
 * ── Why this file is built the way it is ──────────────────────────────────
 *
 * The obvious implementation reads the JSONL and keeps the parsed objects. On
 * this host one session directory is 4.3 MB with 2.6 MB of subagents, and it
 * is a single Discord channel that has been running for a week. Holding parsed
 * transcripts for every session, re-read on every poll of a page that refreshes
 * itself over SSE, is a memory leak with a UI attached.
 *
 * So the unit of caching is an *index*, not a transcript: for each line we keep
 * its byte offset, its length, its type and its timestamp, and we throw the
 * content away. Rendering a page of the transcript seeks to those offsets and
 * reads back only the lines being shown. An index of a 1.8 MB transcript is
 * tens of kilobytes.
 *
 * The second thing that falls out of JSONL being append-only: re-indexing after
 * an agent writes a line does not have to re-read the file. We remember how
 * many bytes we have indexed and read only the tail. The guard against a file
 * that was rewritten rather than appended to is a fingerprint of its first
 * bytes — a rewrite that happened to keep the size growing would otherwise
 * produce an index that is silently wrong about every offset in it.
 */

import { createReadStream, type Dirent } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { AgentRoot, ReadConfig, StatusConfig } from './config.js';

// ── Untrusted-input handling ────────────────────────────────────────────────

/**
 * Credential shapes redacted from anything rendered.
 *
 * This is defence in depth and NOT a guarantee. It catches the well-known
 * prefixed formats — the ones that get pasted into a terminal and end up in a
 * transcript because the agent echoed a command back. It cannot catch a
 * password, a bare hex token, or a key format invented after this list was
 * written. Nothing here should be read as "it is safe to show this page to
 * someone else"; the page is loopback + tailnet for that reason.
 *
 * Ordered longest-first where patterns could overlap, so the more specific
 * match wins.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private keys — the whole block, not just the header, or the payload
  // would survive with only its label removed.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // GitHub: classic PATs, fine-grained PATs, OAuth/app/refresh/server tokens.
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  // Slack, all five token classes.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Anthropic.
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  // OpenAI-style, included because agents paste other providers' keys too.
  /\bsk-[A-Za-z0-9]{32,}/g,
  // Discord bot tokens: base64ish.base64ish.base64ish with a long tail.
  /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
  // Authorization headers, whatever the scheme. Keeps the scheme so the reader
  // can still see what kind of auth was in play.
  /\b(Authorization:\s*(?:Bearer|Basic|token))\s+\S+/gi,
  // AWS access key ids, which are distinctive enough to be worth the line.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
];

/**
 * Replace credential-shaped substrings with a marker.
 *
 * Applied server-side, on the way out, to every piece of transcript text —
 * rather than at render time in the browser — so that the redaction is not
 * something a future UI change can forget to call.
 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    // The Authorization pattern has a capture group it wants to keep; the rest
    // have none, and `$1` in a replacement with no group 1 is left literal, so
    // the two cases have to be distinguished.
    out = out.replace(pattern, (match, group1: string | undefined) =>
      typeof group1 === 'string' ? `${group1} [redacted]` : '[redacted]',
    );
  }
  return out;
}

/**
 * Prose out of a sidecar or a workflow descriptor, made safe to render.
 *
 * `redact` plus a cap, in one place, for the same reason `truncate` exists
 * below: there should be one function that turns metadata into renderable text
 * so "did we remember to redact that one" has a single answer.
 *
 * It did not have one. A subagent's `description` and a workflow's
 * `workflowName`, `summary` and `phases[].detail` went out untouched while
 * mail bodies, transcript blocks and every OJ string were redacted — and
 * `index.ts` states the redaction as a property of the service without
 * qualification. All four are free prose written by a model that has just been
 * reading files; the real workflow summary on this host is the report of a
 * sudoers audit, which is precisely where a pasted credential would survive.
 *
 * The cap is fixed rather than configurable. These are labels — a description
 * and a one-line summary — not documents, and `read.maxBlockChars` is about a
 * transcript page. Anything longer than this is not a label any more.
 */
const MAX_META_CHARS = 2000;

function metaText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return redact(value).slice(0, MAX_META_CHARS);
}

/**
 * Session and agent ids arrive from the URL. They are used to build file
 * paths, so they are validated against a shape rather than sanitised — a
 * denylist of `..` and `/` invites the next encoding trick, whereas "hex and
 * dashes, nothing else" has no interesting cases.
 *
 * `resolveWithin` below is the second, independent check: even a validated id
 * has to land inside its configured root before anything opens it.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SUBAGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/**
 * Slugified cwds are the cwd with every non-alphanumeric turned into `-`.
 *
 * Note the leading `-`, which is not a typo and is not optional: the cwd starts
 * with `/`, so EVERY real slug on this host begins with a dash —
 * `-var-lib-hamachi-workspaces-1467070145343258628`. An earlier version of this
 * pattern required an alphanumeric first character, the way the session-id
 * pattern does, and the result was a status page that found zero sessions
 * under a root containing a week of them and reported it as a healthy, empty
 * host. Caught 2026-08-09 by running it against the real transcripts; it would
 * never have shown up against synthetic fixtures, because you would have named
 * those sensibly.
 *
 * `.` and `..` are excluded separately below rather than by the pattern — they
 * consist entirely of characters the pattern allows, and they are the two
 * names that must never be joined onto a root.
 */
const PROJECT_SLUG_PATTERN = /^[A-Za-z0-9._-][A-Za-z0-9._-]{0,255}$/;

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}
export function isValidSubagentId(value: string): boolean {
  return SUBAGENT_ID_PATTERN.test(value);
}
/**
 * Workflow run ids, `wf_4f93cd23-af9` as written on this host.
 *
 * Named separately from the session pattern because it names a DIRECTORY that
 * gets joined onto a root, and because the underscore is not accidental —
 * every run id carries one and the session pattern would accept it silently
 * either way. `.` is excluded outright rather than by enumerating `.` and
 * `..`: nothing in a run id needs one.
 */
const WORKFLOW_RUN_PATTERN = /^wf_[A-Za-z0-9_-]{1,120}$/;

export function isValidWorkflowRunId(value: string): boolean {
  return WORKFLOW_RUN_PATTERN.test(value);
}
export function isValidProjectSlug(value: string): boolean {
  if (value === '.' || value === '..') return false;
  return PROJECT_SLUG_PATTERN.test(value);
}

/**
 * Resolve `parts` under `root` and refuse anything that escapes it.
 *
 * Belt and braces with the id patterns above. The patterns already exclude
 * `/` and `.`-only names, but this is the check that would still hold if
 * someone later relaxes a pattern to allow, say, dots in a session id and does
 * not think about `..`. The trailing separator matters: without it,
 * `/var/lib/clawcius-evil` passes a naive `startsWith('/var/lib/clawcius')`.
 */
export function resolveWithin(root: string, ...parts: string[]): string | null {
  const target = resolve(root, ...parts);
  if (target === root) return target;
  return target.startsWith(root.endsWith(sep) ? root : root + sep) ? target : null;
}

// ── Index types ─────────────────────────────────────────────────────────────

/** What we keep per transcript line. Never the content. */
export type LineMeta = {
  /** Byte offset of the line's first byte in the file. */
  offset: number;
  /** Byte length of the line, excluding the trailing newline. */
  length: number;
  /** `type` field, or `unknown` for a line without one. */
  type: string;
  /** Milliseconds since epoch, or null when the line has no usable timestamp. */
  ts: number | null;
  uuid: string | null;
  parentUuid: string | null;
  /** True when this line contains at least one tool_use block. */
  hasToolUse: boolean;
  /** True when this line's content is a tool_result rather than prose. */
  isToolResult: boolean;
};

/** A Task/Agent tool call seen in a transcript — one subagent being spawned. */
export type SpawnRecord = {
  toolUseId: string;
  /** The ROLE. `subagent_type` from the tool input. */
  subagentType: string;
  description: string;
  /** Model override on the spawn, when the caller named one. */
  model: string | null;
  spawnedAt: number | null;
  /** uuid of the assistant line that made the call, for ordering. */
  uuid: string | null;
  /**
   * Filled in from the tool_result, which announces the id the runtime
   * assigned. This is the link that survives when the `.meta.json` sidecar is
   * absent — older sessions on this host have transcripts without one.
   */
  agentId: string | null;
};

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * Sum of any cost field the transcript happened to carry, or null when it
   * carried none.
   *
   * Null and zero are different answers and the UI shows them differently: the
   * SDK-driven sessions on this host record token usage but no cost at all, and
   * printing "$0.00" for those would be a lie rather than an omission.
   */
  costUsd: number | null;
};

export type TranscriptIndex = {
  path: string;
  /** Bytes consumed into the index — always a whole number of complete lines. */
  indexedBytes: number;
  /** Size and mtime at the last index, for staleness checks. */
  size: number;
  mtimeMs: number;
  /** First bytes of the file, to detect a rewrite masquerading as an append. */
  fingerprint: string;
  lines: LineMeta[];
  spawns: SpawnRecord[];
  /** Lines that failed to parse. Reported rather than silently dropped. */
  malformedLines: number;
  firstTs: number | null;
  lastTs: number | null;
  assistantTurns: number;
  userMessages: number;
  toolCalls: number;
  usage: UsageTotals;
  /** Latest `gitBranch`/`cwd` seen, for the session header. */
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
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

/** Sum a numeric field wherever it appears at the top level or in `message`. */
const COST_KEYS = ['costUSD', 'costUsd', 'cost_usd', 'totalCostUsd', 'total_cost_usd'] as const;

function extractCost(line: Record<string, unknown>): number | null {
  for (const key of COST_KEYS) {
    const value = line[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The runtime announces an async subagent's id in the tool_result text:
 *
 *   "agentId: a57d8e224b89bd4cb (internal ID - do not mention to user…)"
 *
 * Matching on that string is admittedly matching on prose, which is why it is
 * the *fallback* and the `.meta.json` sidecar is preferred. When the wording
 * changes this returns null and the sidecar still links the tree; if both ever
 * fail the subagent shows up as an orphan rather than disappearing.
 */
const AGENT_ID_IN_RESULT = /\bagentId:\s*([0-9a-f]{8,})/;

function contentBlocks(line: Record<string, unknown>): unknown[] {
  const message = asRecord(line['message']);
  if (!message) return [];
  const content = message['content'];
  if (Array.isArray(content)) return content;
  return [];
}

// ── Index construction ──────────────────────────────────────────────────────

function emptyIndex(path: string): TranscriptIndex {
  return {
    path,
    indexedBytes: 0,
    size: 0,
    mtimeMs: 0,
    fingerprint: '',
    lines: [],
    spawns: [],
    malformedLines: 0,
    firstTs: null,
    lastTs: null,
    assistantTurns: 0,
    userMessages: 0,
    toolCalls: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: null,
    },
    cwd: null,
    gitBranch: null,
    model: null,
  };
}

/**
 * Fold one raw line into the index.
 *
 * A line that will not parse is counted and skipped. That is not defensive
 * programming for its own sake: the newest line of a transcript being written
 * right now is routinely a half-written one, and treating it as corruption
 * would make every live session look broken. Partial trailing lines are
 * excluded by the reader below, so anything reaching here and failing is a
 * genuinely malformed record.
 */
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

  const blocks = contentBlocks(line);
  let hasToolUse = false;
  let isToolResult = false;

  for (const rawBlock of blocks) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    const blockType = asString(block['type']);

    if (blockType === 'tool_use') {
      hasToolUse = true;
      index.toolCalls += 1;

      // The spawn tool has been called both `Task` and `Agent` across
      // versions — this host's transcripts from 2026-08 use `Agent`, older
      // ones and the documentation say `Task`. Accept either; a rename is not
      // worth losing the whole subagent tree over.
      const name = asString(block['name']);
      if (name === 'Task' || name === 'Agent') {
        const input = asRecord(block['input']);
        const toolUseId = asString(block['id']);
        if (input && toolUseId) {
          index.spawns.push({
            toolUseId,
            subagentType: asString(input['subagent_type']) ?? 'unknown',
            description: asString(input['description']) ?? '',
            model: asString(input['model']),
            spawnedAt: ts,
            uuid: asString(line['uuid']),
            agentId: null,
          });
        }
      }
    } else if (blockType === 'tool_result') {
      isToolResult = true;

      // Late-bind the agent id onto the spawn that produced this result.
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

  index.lines.push({
    offset,
    length,
    type,
    ts,
    uuid: asString(line['uuid']),
    parentUuid: asString(line['parentUuid']),
    hasToolUse,
    isToolResult,
  });

  if (ts !== null) {
    if (index.firstTs === null || ts < index.firstTs) index.firstTs = ts;
    if (index.lastTs === null || ts > index.lastTs) index.lastTs = ts;
  }

  if (type === 'assistant') index.assistantTurns += 1;
  if (type === 'user' && !isToolResult) index.userMessages += 1;

  const message = asRecord(line['message']);
  if (message) {
    const model = asString(message['model']);
    if (model) index.model = model;

    const usage = asRecord(message['usage']);
    if (usage) {
      index.usage.inputTokens += numberOr(usage['input_tokens'], 0);
      index.usage.outputTokens += numberOr(usage['output_tokens'], 0);
      index.usage.cacheReadTokens += numberOr(usage['cache_read_input_tokens'], 0);
      index.usage.cacheCreationTokens += numberOr(usage['cache_creation_input_tokens'], 0);
    }
  }

  const cost = extractCost(line);
  if (cost !== null) index.usage.costUsd = (index.usage.costUsd ?? 0) + cost;

  const cwd = asString(line['cwd']);
  if (cwd) index.cwd = cwd;
  const branch = asString(line['gitBranch']);
  if (branch) index.gitBranch = branch;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Flatten a content block to plain text, for search and for rendering. */
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

/**
 * Read `path` from `fromByte` and fold every COMPLETE line into `index`.
 *
 * Returns the byte offset just past the last complete line, which becomes the
 * new `indexedBytes`. A trailing fragment is deliberately left unindexed: it is
 * a line being written right now, and it will be complete on the next pass.
 */
async function foldFrom(index: TranscriptIndex, path: string, fromByte: number): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path, { start: fromByte });
    // Buffers, not strings: offsets have to be byte offsets for the page
    // reader to seek with them, and a chunk boundary can land in the middle of
    // a multi-byte character. Splitting on 0x0a and decoding whole lines is
    // correct for both.
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
  spawnDepth: number | null;
  model: string | null;
};

export type SubagentRef = {
  agentId: string;
  path: string;
  meta: SubagentMeta | null;
  size: number;
  mtimeMs: number;
  /**
   * The workflow run this subagent belongs to, or null for a direct spawn.
   *
   * Non-null means it came from `subagents/workflows/<runId>/`, where the
   * sidecar carries only `{agentType: "workflow-subagent", spawnDepth: 1}` —
   * so this id is the only route to a description, via `workflowRuns()`.
   */
  workflowRunId: string | null;
};

/** One recorded workflow run. Every field optional; a run in flight has none. */
export type WorkflowRun = {
  runId: string;
  name: string | null;
  summary: string | null;
  status: string | null;
  agentCount: number | null;
  durationSeconds: number | null;
  startedAt: string | null;
  phases: Array<{ title: string | null; detail: string | null }>;
};

/**
 * Cache of transcript indexes, keyed by path, with LRU eviction.
 *
 * A Map preserves insertion order, so "least recently used" is "first key" as
 * long as every hit re-inserts. That is the whole implementation; a real LRU
 * structure would be more code than the problem deserves.
 */
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

  get size(): number {
    return this.#entries.size;
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

  /**
   * Index for a transcript, built or refreshed as needed.
   *
   * The refresh is where the append-only assumption earns its keep: a session
   * that grew by one line re-reads that one line. The fingerprint check is the
   * escape hatch for when the assumption is wrong — a compacted or rewritten
   * transcript throws the index away and starts again, which is slow and
   * correct rather than fast and lying.
   */
  async index(path: string): Promise<TranscriptIndex> {
    const info = await stat(path);
    const cached = this.#cache.get(path);

    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return cached;
    }

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

  /**
   * Every session under an agent's root.
   *
   * Missing or unreadable roots return an empty list and set `error`. They do
   * not throw: one instance that has never started must not blank the page for
   * the one that is running.
   */
  async sessions(agent: AgentRoot): Promise<{ sessions: SessionRef[]; error: string | null }> {
    let projectDirs: string[];
    try {
      const entries = await readdir(agent.projectsRoot, { withFileTypes: true });
      projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      return { sessions: [], error: describeFsError(error, agent.projectsRoot) };
    }

    const sessions: SessionRef[] = [];
    for (const slug of projectDirs) {
      // A slug that fails the pattern is skipped rather than served: it could
      // not be round-tripped through a URL anyway, and anything unexpected
      // sitting in a projects directory is not ours to interpret.
      if (!isValidProjectSlug(slug)) continue;
      const dir = resolveWithin(agent.projectsRoot, slug);
      if (!dir) continue;

      let files: string[];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        files = entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map((entry) => entry.name);
      } catch {
        continue;
      }

      for (const file of files) {
        const sessionId = file.slice(0, -'.jsonl'.length);
        if (!isValidSessionId(sessionId)) continue;
        sessions.push({
          agent: agent.id,
          projectSlug: slug,
          sessionId,
          transcriptPath: join(dir, file),
          sessionDir: join(dir, sessionId),
        });
      }
    }

    return { sessions, error: null };
  }

  /** Locate one session by id, across every project slug under the agent. */
  async findSession(agent: AgentRoot, sessionId: string): Promise<SessionRef | null> {
    if (!isValidSessionId(sessionId)) return null;
    const { sessions } = await this.sessions(agent);
    return sessions.find((candidate) => candidate.sessionId === sessionId) ?? null;
  }

  /**
   * Subagent transcripts belonging to a session, with their sidecar metadata.
   *
   * TWO PLACES, not one, and the second is where most of them are. Counted on
   * this host on 2026-08-17: of 104 `agent-*.jsonl` under Hamachi's root, 45
   * sit directly in `<sessionId>/subagents/` and **58 sit one level deeper**,
   * in `<sessionId>/subagents/workflows/wf_<runId>/`. This method used to
   * `readdir` the first directory and filter for files, so the 58 were not
   * merely undiscoverable — they were invisible, and every count of subagents
   * this service has ever printed was a little over half the real number.
   *
   * The two populations have different metadata and want handling accordingly:
   *
   *   direct      {agentType, description, toolUseId, spawnDepth, model?,
   *                parentAgentId?}  — named, and self-describing
   *   workflow    {agentType: "workflow-subagent", spawnDepth: 1}  — thin,
   *                identical on all 58, and no description at all
   *
   * A workflow subagent's description is not missing, it is somewhere else:
   * `<sessionId>/workflows/<runId>.json` holds one record per run with
   * `workflowName`, `summary`, `phases[]` and `agentCount`. So the run is what
   * names them, and `workflowRunId` on the ref is the join to it — see
   * `workflowRuns` below.
   */
  async subagents(session: SessionRef): Promise<SubagentRef[]> {
    const root = join(session.sessionDir, 'subagents');
    const refs: SubagentRef[] = [];

    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      // No subagents directory at all is the normal case for a session that
      // never delegated. Not an error, not worth reporting.
      return [];
    }

    await this.#collectSubagents(root, entries, null, refs);

    // `subagents/workflows/<runId>/` — one directory per workflow run.
    const workflowsDir = join(root, 'workflows');
    let runDirs: Dirent[] = [];
    try {
      runDirs = await readdir(workflowsDir, { withFileTypes: true });
    } catch {
      return refs;
    }

    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      // Same discipline as the project slug: validated against a shape, and
      // then resolved inside its root independently. This name reaches a path
      // join, and it comes off a directory an agent can write into.
      if (!isValidWorkflowRunId(runDir.name)) continue;
      const resolved = resolveWithin(workflowsDir, runDir.name);
      if (!resolved) continue;

      try {
        await this.#collectSubagents(
          resolved,
          await readdir(resolved, { withFileTypes: true }),
          runDir.name,
          refs,
        );
      } catch {
        // A run directory that vanished between the two readdirs. The rest of
        // the run's siblings still list.
      }
    }

    return refs;
  }

  async #collectSubagents(
    dir: string,
    entries: Dirent[],
    workflowRunId: string | null,
    into: SubagentRef[],
  ): Promise<void> {
    for (const entry of entries) {
      // `journal.jsonl` sits beside the agents in a run directory and is the
      // run's own log, not a subagent. Requiring the `agent-` prefix rather
      // than excluding that one name by hand: an unknown file appearing here
      // later should be skipped, not rendered as an agent with a strange id.
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('agent-') || !entry.name.endsWith('.jsonl')) continue;

      const agentId = entry.name.slice('agent-'.length, -'.jsonl'.length);
      if (!isValidSubagentId(agentId)) continue;
      const path = join(dir, entry.name);

      let size = 0;
      let mtimeMs = 0;
      try {
        const info = await stat(path);
        size = info.size;
        mtimeMs = info.mtimeMs;
      } catch {
        continue;
      }

      into.push({
        agentId,
        path,
        meta: await readSubagentMeta(dir, entry.name),
        size,
        mtimeMs,
        workflowRunId,
      });
    }
  }

  /**
   * The workflow runs a session recorded, by run id.
   *
   * These are what give the 58 thin-metadata subagents above a name. One JSON
   * file per run in `<sessionId>/workflows/`, written when the run ends — so a
   * run in progress has agents on disk and no descriptor yet, which is why
   * every field here is optional and a missing record is not an error.
   */
  async workflowRuns(session: SessionRef): Promise<Map<string, WorkflowRun>> {
    const dir = join(session.sessionDir, 'workflows');
    const runs = new Map<string, WorkflowRun>();

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return runs;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const runId = entry.name.slice(0, -'.json'.length);
      if (!isValidWorkflowRunId(runId)) continue;
      const path = resolveWithin(dir, entry.name);
      if (!path) continue;

      try {
        const record = asRecord(JSON.parse(await readFile(path, 'utf8')) as unknown);
        if (!record) continue;
        runs.set(runId, {
          runId,
          name: metaText(record['workflowName']),
          summary: metaText(record['summary']),
          status: metaText(record['status']),
          agentCount: numberOrNull(record['agentCount']),
          durationSeconds: (() => {
            const ms = numberOrNull(record['durationMs']);
            return ms === null ? null : Math.max(0, Math.round(ms / 1000));
          })(),
          startedAt: (() => {
            const ms = numberOrNull(record['startTime']);
            return ms === null ? null : new Date(ms).toISOString();
          })(),
          phases: Array.isArray(record['phases'])
            ? record['phases'].flatMap((raw) => {
                const phase = asRecord(raw);
                if (!phase) return [];
                return [
                  { title: metaText(phase['title']), detail: metaText(phase['detail']) },
                ];
              })
            : [],
        });
      } catch {
        // Unparseable or half-written. The run's agents still list, with the
        // run id as their only label, which is the honest degradation.
      }
    }

    return runs;
  }

  /**
   * A page of a transcript, read back from disk by byte offset.
   *
   * `from` is a line ordinal, not a byte offset — the client pages through
   * lines and should never see the file layout. Bytes are how we get there.
   */
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
        if (bytesRead > 0 && bytesRead + meta.length > this.#config.read.maxPageBytes) {
          // Short page rather than a refused one. The client asks for the rest
          // starting at `nextFrom`, so an enormous line does not become a wall
          // the reader cannot page past.
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

async function readSubagentMeta(dir: string, jsonlName: string): Promise<SubagentMeta | null> {
  const metaPath = join(dir, jsonlName.replace(/\.jsonl$/, '.meta.json'));
  try {
    const parsed = JSON.parse(await readFile(metaPath, 'utf8')) as unknown;
    const record = asRecord(parsed);
    if (!record) return null;
    return {
      // agentType is a role name and reaches the page as a heading and a colour
      // key; description is free prose. Both are rendered, so both go through
      // the same door.
      agentType: metaText(record['agentType']),
      description: metaText(record['description']),
      toolUseId: asString(record['toolUseId']),
      parentAgentId: asString(record['parentAgentId']),
      spawnDepth:
        typeof record['spawnDepth'] === 'number' && Number.isFinite(record['spawnDepth'])
          ? record['spawnDepth']
          : null,
      model: asString(record['model']),
    };
  } catch {
    // Absent for older sessions, and unparseable if it was caught mid-write.
    // Either way the tree still builds from the parent's tool calls.
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
  /** Line ordinal, so the client can anchor and resume. */
  n: number;
  type: string;
  role: string | null;
  ts: string | null;
  uuid: string | null;
  parentUuid: string | null;
  /** Operational records (`queue-operation`, `mode`, …) carry a one-line summary. */
  summary: string | null;
  blocks: RenderedBlock[];
};

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  const redacted = redact(text);
  if (redacted.length <= limit) return { text: redacted, truncated: false };
  return { text: redacted.slice(0, limit), truncated: true };
}

/**
 * Turn one raw JSONL line into something the UI can draw.
 *
 * Everything textual goes through `truncate`, which redacts. That is on
 * purpose: there is exactly one function that produces renderable text from a
 * transcript, so "did we remember to redact this field" has one answer rather
 * than one per call site.
 */
function renderLine(raw: string, n: number, maxBlockChars: number): RenderedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      n,
      type: 'malformed',
      role: null,
      ts: null,
      uuid: null,
      parentUuid: null,
      summary: 'unparseable line — skipped',
      blocks: [],
    };
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
      if (!block) continue;
      blocks.push(renderBlock(block, maxBlockChars));
    }
  }

  if (blocks.length === 0) {
    // The operational records — queue-operation, mode, ai-title, last-prompt —
    // have no `message` at all. They are genuinely useful for reading a
    // session (they are where a wake came from), so they get a summary line
    // instead of being dropped.
    const operational =
      asString(line['operation']) ??
      asString(line['aiTitle']) ??
      asString(line['mode']) ??
      asString(line['content']);
    if (operational) summary = truncate(operational, 400).text;
    const attachment = asRecord(line['attachment']);
    if (!summary && attachment) summary = `attachment: ${asString(attachment['type']) ?? 'unknown'}`;
  }

  return {
    n,
    type,
    role: message ? asString(message['role']) : null,
    ts: asString(line['timestamp']),
    uuid: asString(line['uuid']),
    parentUuid: asString(line['parentUuid']),
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
    const { text, truncated } = truncate(
      asString(block['thinking']) ?? '[redacted thinking]',
      limit,
    );
    return { kind: 'thinking', text, truncated };
  }

  if (kind === 'tool_use') {
    // Input is shown as JSON. Stringify can throw on a cyclic structure, which
    // JSON.parse cannot produce — but it can also throw on a BigInt, and being
    // wrong here would take down a whole page for one odd tool call.
    let input = '';
    try {
      input = JSON.stringify(block['input'], null, 2) ?? '';
    } catch {
      input = '[uninspectable tool input]';
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

  // Images and anything added to the content-block vocabulary later. Named,
  // not rendered — an unknown block type is not something to guess at.
  const { text, truncated } = truncate(flattenBlockText(block, limit), limit);
  return { kind: 'other', label: kind ?? 'block', text, truncated };
}

export function describeFsError(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return `${path} does not exist yet`;
  if (code === 'EACCES' || code === 'EPERM') return `${path} is not readable by this service`;
  if (code === 'ENOTDIR') return `${path} is not a directory`;
  return `${path}: ${error instanceof Error ? error.message : String(error)}`;
}
