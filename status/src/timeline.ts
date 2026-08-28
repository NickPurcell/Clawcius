import { readdir, readFile } from 'node:fs/promises';
import type { AgentRoot } from './config.js';
import { readRegistry, type RegistryAgent } from './registry.js';
import {
  describeFsError,
  isValidProjectSlug,
  resolveWithin,
  type SessionRef,
  type SubagentRef,
  type TranscriptIndex,
  type TranscriptStore,
} from './transcripts.js';

/** Two transcript lines further apart than this are idle time between them. */
export const IDLE_GAP_MS = 90_000;

export type Span = [start: number, end: number];

type SpanLine = { ts: number | null; hasToolUse: boolean; isToolResult: boolean };

/**
 * Working spans from line timestamps: consecutive lines closer than the idle
 * gap are one span, and a tool call bridges any gap to its result.
 */
export function activitySpans(lines: readonly SpanLine[], gapMs: number = IDLE_GAP_MS): Span[] {
  const stamped = lines.filter((line): line is SpanLine & { ts: number } => line.ts !== null);
  stamped.sort((a, b) => a.ts - b.ts);

  const spans: Span[] = [];
  let current: Span | null = null;
  let previous: (SpanLine & { ts: number }) | null = null;

  for (const line of stamped) {
    if (current && previous) {
      const gap = line.ts - previous.ts;
      const waitingOnTool = previous.hasToolUse && line.isToolResult;
      if (gap <= gapMs || waitingOnTool) {
        current[1] = line.ts;
      } else {
        spans.push(current);
        current = [line.ts, line.ts];
      }
    } else {
      current = [line.ts, line.ts];
    }
    previous = line;
  }
  if (current) spans.push(current);
  return spans;
}

// ── Names ───────────────────────────────────────────────────────────────────

/** "Hamachi coordinator", "Hamachi engineer1": crew label plus the id with its crew prefix removed. */
export function displayName(crewLabel: string, agent: { id: string; crew: string; role: string }): string {
  if (agent.role === 'coordinator') return `${crewLabel} coordinator`;
  const prefix = `${agent.crew}-`;
  const short = agent.id.startsWith(prefix) ? agent.id.slice(prefix.length) : agent.id;
  return `${crewLabel} ${short}`;
}

/** Display name per registry id; a repeated name gets " 2", " 3" in the order given. */
export function nameMap(crewLabel: string, agents: readonly RegistryAgent[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Map<string, number>();
  for (const agent of agents) {
    const base = displayName(crewLabel, agent);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    names.set(agent.id, count === 1 ? base : `${base} ${count}`);
  }
  return names;
}

/** A subagent's name: its recorded description, else its type, else "subagent". */
export function subagentName(ref: { meta: { description: string | null; agentType: string | null } | null }, spawn: { description: string; subagentType: string } | null): string {
  return ref.meta?.description || spawn?.description || ref.meta?.agentType || spawn?.subagentType || 'subagent';
}

// ── Rows ────────────────────────────────────────────────────────────────────

export type TimelineRow = {
  /** `a:<registry id>` or `s:<subagent id>`; the lane route takes this. */
  id: string;
  name: string;
  role: string;
  /** 0 for a registry agent; a subagent is one deeper than its parent. */
  depth: number;
  parent: string | null;
  status: string;
  spans: Span[];
  lastTs: number | null;
  /** Stamped transcript lines behind the row, the lane's `total`. */
  lines: number;
};

export type RowSource = {
  row: TimelineRow;
  /** The transcripts a lane merges, by timestamp. */
  transcripts: string[];
  /** The registry id for mail lookups; null for a subagent. */
  mailId: string | null;
};

export type Timeline = {
  crew: string;
  label: string;
  generatedAt: string;
  error: string | null;
  rows: TimelineRow[];
  bots: BotHealth[];
};

const ROLE_ORDER: Record<string, number> = { coordinator: 0 };

function byRole(a: RegistryAgent, b: RegistryAgent): number {
  const ra = ROLE_ORDER[a.role] ?? 1;
  const rb = ROLE_ORDER[b.role] ?? 1;
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
  return a.id.localeCompare(b.id);
}

async function indexOrNull(store: TranscriptStore, path: string): Promise<TranscriptIndex | null> {
  try {
    return await store.index(path);
  } catch {
    return null;
  }
}

/** Every row of a crew, coordinator first, each subagent after the row that spawned it. */
export async function buildTimeline(
  store: TranscriptStore,
  crew: AgentRoot,
  now: number,
): Promise<{ timeline: Timeline; sources: Map<string, RowSource> }> {
  const registry = readRegistry(crew.boardDb);
  const names = nameMap(crew.label, registry.agents);
  const agents = [...registry.agents].sort(byRole);
  const rows: TimelineRow[] = [];
  const sources = new Map<string, RowSource>();

  for (const agent of agents) {
    const sessions = await store.sessionsIn(crew, agent.projectSlug);
    const indexed: Array<{ session: SessionRef; index: TranscriptIndex }> = [];
    for (const session of sessions) {
      const index = await indexOrNull(store, session.transcriptPath);
      if (index && index.lines.length > 0) indexed.push({ session, index });
    }
    indexed.sort((a, b) => (a.index.firstTs ?? 0) - (b.index.firstTs ?? 0));

    const rowId = `a:${agent.id}`;
    const row: TimelineRow = {
      id: rowId,
      name: names.get(agent.id) ?? agent.id,
      role: agent.role,
      depth: 0,
      parent: null,
      status: agent.declaredStatus,
      spans: activitySpans(indexed.flatMap((entry) => entry.index.lines)),
      lastTs: indexed.length === 0 ? null : Math.max(...indexed.map((entry) => entry.index.lastTs ?? 0)),
      lines: indexed.reduce((sum, entry) => sum + entry.index.stamped, 0),
    };
    rows.push(row);
    sources.set(rowId, { row, transcripts: indexed.map((entry) => entry.session.transcriptPath), mailId: agent.id });

    for (const { session, index } of indexed) {
      const refs = await store.subagents(session);
      const subRows = await subagentRows(store, rowId, refs, index);
      for (const sub of subRows) {
        rows.push(sub.row);
        sources.set(sub.row.id, sub);
      }
    }
  }

  return {
    timeline: {
      crew: crew.id,
      label: crew.label,
      generatedAt: new Date(now).toISOString(),
      error: registry.error,
      rows,
      bots: await readBots(crew.workspacesRoot, registry.agents, names),
    },
    sources,
  };
}

/** Rows for one session's subagents, ordered by start, each after its parent. */
async function subagentRows(
  store: TranscriptStore,
  agentRowId: string,
  refs: SubagentRef[],
  parentIndex: TranscriptIndex,
): Promise<RowSource[]> {
  const built: RowSource[] = [];
  for (const ref of refs) {
    const index = await indexOrNull(store, ref.path);
    if (!index || index.lines.length === 0) continue;
    const spawn = parentIndex.spawns.find(
      (candidate) => candidate.agentId === ref.agentId || (ref.meta?.toolUseId !== null && candidate.toolUseId === ref.meta?.toolUseId),
    ) ?? null;
    built.push({
      row: {
        id: `s:${ref.agentId}`,
        name: subagentName(ref, spawn),
        role: 'subagent',
        depth: 1,
        parent: ref.meta?.parentAgentId ? `s:${ref.meta.parentAgentId}` : agentRowId,
        status: '',
        spans: activitySpans(index.lines),
        lastTs: index.lastTs,
        lines: index.stamped,
      },
      transcripts: [ref.path],
      mailId: null,
    });
  }

  // A parent named in a sidecar that is not among the rows falls back to the agent.
  const ids = new Set(built.map((entry) => entry.row.id));
  for (const entry of built) {
    if (entry.row.parent !== agentRowId && !ids.has(entry.row.parent ?? '')) entry.row.parent = agentRowId;
  }
  const depthOf = (entry: RowSource): number => {
    let depth = 1;
    let parent = entry.row.parent;
    while (parent && parent !== agentRowId) {
      depth += 1;
      parent = built.find((candidate) => candidate.row.id === parent)?.row.parent ?? null;
      if (depth > 8) break;
    }
    return depth;
  };
  for (const entry of built) entry.row.depth = depthOf(entry);

  built.sort((a, b) => (a.row.spans[0]?.[0] ?? 0) - (b.row.spans[0]?.[0] ?? 0));
  const ordered: RowSource[] = [];
  const place = (parent: string): void => {
    for (const entry of built) {
      if (entry.row.parent === parent && !ordered.includes(entry)) {
        ordered.push(entry);
        place(entry.row.id);
      }
    }
  };
  place(agentRowId);
  return ordered;
}

// ── Bots ────────────────────────────────────────────────────────────────────

export type BotHealth = {
  /** The bot directory's name. */
  bot: string;
  /** Display name of the agent whose workspace holds it, else the workspace directory. */
  workspace: string;
  mode: string | null;
  detail: string | null;
  since: string | null;
  updated: string | null;
  needsHuman: string | null;
  counts: Record<string, number>;
  error: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Parse one health.json body into the shape the board shows. */
export function parseHealth(bot: string, workspace: string, raw: string): BotHealth {
  const empty: BotHealth = { bot, workspace, mode: null, detail: null, since: null, updated: null, needsHuman: null, counts: {}, error: null };
  let record: Record<string, unknown> | null;
  try {
    record = asRecord(JSON.parse(raw));
  } catch {
    return { ...empty, error: 'health.json is not valid JSON' };
  }
  if (!record) return { ...empty, error: 'health.json is not an object' };

  const counts: Record<string, number> = {};
  const rawCounts = asRecord(record['counts']);
  if (rawCounts) {
    for (const [key, value] of Object.entries(rawCounts)) {
      if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
    }
  }
  return {
    ...empty,
    mode: stringOrNull(record['mode']),
    detail: stringOrNull(record['detail']),
    since: stringOrNull(record['since']),
    updated: stringOrNull(record['updated']),
    needsHuman: stringOrNull(record['needs_human']),
    counts,
  };
}

/** The directory under a crew's workspaces where supervised bots run. */
const BOTS_DIR = '.bots';

/**
 * One entry per health file: `<workspacesRoot>/.bots/<name>/health.json`
 * (a supervised bot) and `<workspacesRoot>/<workspace>/<bot>/run/health.json`
 * (a bot an agent runs from its own workspace).
 */
export async function readBots(
  workspacesRoot: string | null,
  agents: readonly RegistryAgent[],
  names: ReadonlyMap<string, string>,
): Promise<BotHealth[]> {
  if (workspacesRoot === null) return [];
  let workspaces: string[];
  try {
    workspaces = (await readdir(workspacesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    return [{ bot: '', workspace: '', mode: null, detail: null, since: null, updated: null, needsHuman: null, counts: {}, error: describeFsError(error, workspacesRoot) }];
  }

  const bots: BotHealth[] = [];
  for (const workspace of workspaces.sort()) {
    if (!isValidProjectSlug(workspace)) continue;
    const dir = resolveWithin(workspacesRoot, workspace);
    if (!dir) continue;
    const supervised = workspace === BOTS_DIR;
    const owner = agents.find((agent) => agent.workspacePath === dir);
    const label = supervised ? '' : owner ? (names.get(owner.id) ?? owner.id) : workspace;

    let children: string[];
    try {
      children = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const bot of children.sort()) {
      if (!isValidProjectSlug(bot)) continue;
      const path = supervised ? resolveWithin(dir, bot, 'health.json') : resolveWithin(dir, bot, 'run', 'health.json');
      if (!path) continue;
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      bots.push(parseHealth(bot, label, raw));
    }
  }
  return bots;
}
