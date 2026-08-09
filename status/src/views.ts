/**
 * Assembling the JSON the UI draws.
 *
 * Kept apart from `transcripts.ts` because the two answer different questions.
 * That file knows the on-disk format; this one knows what a person looking at
 * the page wants to see — liveness bands, a session's shape, the tree of who
 * spawned whom. Changing the presentation should not mean touching the parser.
 *
 * ── On clocks ──────────────────────────────────────────────────────────────
 *
 * There are two clocks in play and they are not the same clock. Transcript
 * timestamps are written by the agent process inside its container; file mtimes
 * are written by the host kernel. They agree closely today because the
 * containers share the host clock, but nothing guarantees it — and the failure
 * mode when they drift is a page reporting "last active in 4 minutes", which
 * reads as a bug in the page rather than as a clock problem.
 *
 * So: liveness is decided from mtime ONLY, because mtime is in the same clock
 * as `Date.now()` and comparing those two is always meaningful. Timestamps are
 * used only for durations *within* a single transcript, where both ends come
 * from the same writer. Every subtraction of the two is clamped at zero, which
 * turns a skew into a wrong-but-harmless "0s" instead of a negative duration.
 */

import { stat } from 'node:fs/promises';
import type { AgentRoot, LivenessConfig, StatusConfig } from './config.js';
import {
  describeFsError,
  type SessionRef,
  type SpawnRecord,
  type SubagentRef,
  type TranscriptIndex,
  type TranscriptStore,
} from './transcripts.js';

export type Liveness = 'running' | 'idle' | 'stale' | 'unknown';

export type AgentOverview = {
  id: string;
  label: string;
  projectsRoot: string;
  liveness: Liveness;
  /** ISO string of the newest transcript write, or null when there is none. */
  lastActivity: string | null;
  /** Seconds since that write, clamped at 0. */
  lastActivityAgoSeconds: number | null;
  sessionCount: number;
  /** Sessions whose transcript was written within the running window. */
  activeSessionCount: number;
  subagentCount: number;
  /** Non-null when the root could not be read. Rendered as a warning row. */
  error: string | null;
};

export type SessionSummary = {
  agent: string;
  sessionId: string;
  projectSlug: string;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  liveness: Liveness;
  lastActivity: string;
  lineCount: number;
  assistantTurns: number;
  userMessages: number;
  toolCalls: number;
  subagentCount: number;
  malformedLines: number;
  sizeBytes: number;
  usage: TranscriptIndex['usage'];
};

export type SubagentNode = {
  agentId: string;
  /** The ROLE — `subagent_type` from the spawning tool call. */
  role: string;
  description: string;
  model: string | null;
  parentAgentId: string | null;
  depth: number;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  /** Still being written to, by mtime. */
  active: boolean;
  assistantTurns: number;
  toolCalls: number;
  lineCount: number;
  sizeBytes: number;
  malformedLines: number;
  /**
   * How the parent link was established. Surfaced in the UI as a small marker
   * because "this tree is a guess" and "this tree is recorded fact" are
   * different claims and the reader deserves to know which one they have.
   */
  linkage: 'meta' | 'tool-result' | 'orphan';
  children: SubagentNode[];
};

export type SessionDetail = SessionSummary & {
  subagents: SubagentNode[];
  /** Subagents that could not be attached to anything, shown separately. */
  orphans: SubagentNode[];
  /** Earliest and latest instant across the session and all its subagents. */
  spanStart: string | null;
  spanEnd: string | null;
};

/** A spawning tool call, plus the agent id of whoever made it (null = root). */
type OwnedSpawn = { spawn: SpawnRecord; owner: string | null };

function clampSeconds(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 1000));
}

function toIso(ms: number | null): string | null {
  if (ms === null) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Liveness from a file mtime.
 *
 * `unknown` is a real answer, not a placeholder: an agent whose root has no
 * transcripts at all has never run, and calling that "stale" would put a red
 * dot next to an instance that is simply new.
 */
export function livenessFromMtime(
  mtimeMs: number | null,
  now: number,
  config: LivenessConfig,
): Liveness {
  if (mtimeMs === null) return 'unknown';
  // Clamped, so a file mtime in the future — a clock that stepped backwards on
  // the host, or a container running ahead — reads as "just now" rather than
  // as an enormous negative age that lands in the stale band.
  const ageSeconds = clampSeconds(mtimeMs, now);
  if (ageSeconds <= config.runningSeconds) return 'running';
  if (ageSeconds <= config.idleSeconds) return 'idle';
  return 'stale';
}

/**
 * The overview row for one agent.
 *
 * Deliberately does NOT index any transcript. This runs for every configured
 * agent on every load of the front page, and parsing every session's JSONL to
 * answer "when did something last happen" would make the cheapest page the
 * most expensive one. `stat` on each file is enough, and mtime is the right
 * signal for liveness anyway.
 */
export async function buildAgentOverview(
  store: TranscriptStore,
  agent: AgentRoot,
  config: StatusConfig,
  now: number,
): Promise<AgentOverview> {
  const { sessions, error } = await store.sessions(agent);

  let newestMtime: number | null = null;
  let activeSessionCount = 0;
  let subagentCount = 0;

  for (const session of sessions) {
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await stat(session.transcriptPath)).mtimeMs;
    } catch {
      // Vanished between listing and stat — a transcript being rotated, or a
      // race with a `--recreate`. Skip it rather than fail the whole row.
      continue;
    }

    if (newestMtime === null || mtimeMs > newestMtime) newestMtime = mtimeMs;
    if (clampSeconds(mtimeMs, now) <= config.liveness.runningSeconds) activeSessionCount += 1;

    // Subagent files are counted, not indexed. The count is a useful
    // at-a-glance number and costs one readdir per session; indexing them here
    // would mean parsing megabytes to render a single digit.
    const subagents = await store.subagents(session);
    subagentCount += subagents.length;
    for (const subagent of subagents) {
      if (newestMtime === null || subagent.mtimeMs > newestMtime) newestMtime = subagent.mtimeMs;
    }
  }

  return {
    id: agent.id,
    label: agent.label,
    projectsRoot: agent.projectsRoot,
    liveness: error ? 'unknown' : livenessFromMtime(newestMtime, now, config.liveness),
    lastActivity: toIso(newestMtime),
    lastActivityAgoSeconds: newestMtime === null ? null : clampSeconds(newestMtime, now),
    sessionCount: sessions.length,
    activeSessionCount,
    subagentCount,
    error,
  };
}

/**
 * Summaries for every session of an agent, newest activity first.
 *
 * This one DOES index, because turn counts and durations cannot be had any
 * other way. The index cache and its append-only refresh are what make it
 * affordable on repeat: the second load of this page re-reads only the bytes
 * that were appended since the first.
 */
export async function buildSessionList(
  store: TranscriptStore,
  agent: AgentRoot,
  config: StatusConfig,
  now: number,
): Promise<{ sessions: SessionSummary[]; error: string | null }> {
  const { sessions, error } = await store.sessions(agent);
  const summaries: SessionSummary[] = [];

  for (const session of sessions) {
    try {
      summaries.push(await summariseSession(store, session, config, now));
    } catch (readError) {
      // One unreadable transcript must not blank the list. There is no row for
      // it — a session we cannot read is not a session we can say anything
      // true about — but the others still render.
      void readError;
    }
  }

  summaries.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  return { sessions: summaries, error };
}

async function summariseSession(
  store: TranscriptStore,
  session: SessionRef,
  config: StatusConfig,
  now: number,
): Promise<SessionSummary> {
  const index = await store.index(session.transcriptPath);
  const subagents = await store.subagents(session);

  // The newest write across the session and its subagents. A parent that is
  // blocked waiting on a subagent writes nothing while the subagent works, so
  // judging the session by its own transcript alone would show "idle" for a
  // session that is very much running.
  let newestMtime = index.mtimeMs;
  for (const subagent of subagents) {
    if (subagent.mtimeMs > newestMtime) newestMtime = subagent.mtimeMs;
  }

  return {
    agent: session.agent,
    sessionId: session.sessionId,
    projectSlug: session.projectSlug,
    cwd: index.cwd,
    gitBranch: index.gitBranch,
    model: index.model,
    startedAt: toIso(index.firstTs),
    endedAt: toIso(index.lastTs),
    durationSeconds:
      index.firstTs !== null && index.lastTs !== null
        ? clampSeconds(index.firstTs, index.lastTs)
        : null,
    liveness: livenessFromMtime(newestMtime, now, config.liveness),
    lastActivity: new Date(newestMtime).toISOString(),
    lineCount: index.lines.length,
    assistantTurns: index.assistantTurns,
    userMessages: index.userMessages,
    toolCalls: index.toolCalls,
    subagentCount: subagents.length,
    malformedLines: index.malformedLines,
    sizeBytes: index.size,
    usage: index.usage,
  };
}

/**
 * The full picture of one session, including the subagent tree.
 *
 * ── How the tree is built ──────────────────────────────────────────────────
 *
 * Two independent sources of truth, used in that order of preference:
 *
 *   1. `agent-<id>.meta.json` beside each subagent transcript. It records
 *      `agentType` (the role), `description`, the `toolUseId` of the call that
 *      spawned it, and `parentAgentId` for anything nested. When present this
 *      is recorded fact and needs no inference at all.
 *
 *   2. The spawning tool call itself. Every transcript — the session's and each
 *      subagent's — is scanned during indexing for `Task`/`Agent` tool_use
 *      blocks, giving `subagent_type` and `description` keyed by tool_use id;
 *      the matching tool_result announces the assigned agent id. Whichever
 *      transcript contained the call is the parent.
 *
 * Both exist because each fails differently. The sidecar is absent on older
 * sessions. The tool-call scan depends on the id appearing in the result text,
 * which is prose and can be reworded. A subagent that neither source explains
 * is reported as an orphan and still listed — a tree that quietly drops
 * branches it cannot explain is worse than one that admits to a loose end.
 */
export async function buildSessionDetail(
  store: TranscriptStore,
  session: SessionRef,
  config: StatusConfig,
  now: number,
): Promise<SessionDetail> {
  const summary = await summariseSession(store, session, config, now);
  const sessionIndex = await store.index(session.transcriptPath);
  const subagentRefs = await store.subagents(session);

  // toolUseId -> the spawn, plus which transcript made the call. The session's
  // own spawns are attributed to the root (null).
  const spawnsByToolUse = new Map<string, OwnedSpawn>();
  const spawnsByAgentId = new Map<string, OwnedSpawn>();

  const collect = (spawns: readonly SpawnRecord[], owner: string | null): void => {
    for (const spawn of spawns) {
      const owned = { spawn, owner };
      spawnsByToolUse.set(spawn.toolUseId, owned);
      if (spawn.agentId) spawnsByAgentId.set(spawn.agentId, owned);
    }
  };

  collect(sessionIndex.spawns, null);

  const indexes = new Map<string, TranscriptIndex>();
  for (const ref of subagentRefs) {
    try {
      const index = await store.index(ref.path);
      indexes.set(ref.agentId, index);
      collect(index.spawns, ref.agentId);
    } catch {
      // Unreadable subagent transcript: it still gets a node, from its
      // sidecar and its stat, with zeroed counts. Better a node saying
      // "we know this ran" than a silently missing branch.
    }
  }

  // The spawning call for each subagent, found by either route.
  //
  // Looking it up by agent id as well as by tool_use id is not redundant: a
  // subagent with no `.meta.json` has no tool_use id to look up with, and
  // resolving it only through the sidecar meant those subagents rendered with
  // `role: unknown` and no description — losing exactly the field this view
  // exists to show. Caught 2026-08-09 by a fixture with the sidecar deliberately
  // absent, which is the shape older sessions on this host actually have.
  const spawnFor = (ref: SubagentRef): OwnedSpawn | undefined =>
    (ref.meta?.toolUseId ? spawnsByToolUse.get(ref.meta.toolUseId) : undefined) ??
    spawnsByAgentId.get(ref.agentId);

  const nodes = new Map<string, SubagentNode>();
  for (const ref of subagentRefs) {
    nodes.set(ref.agentId, buildNode(ref, indexes.get(ref.agentId), spawnFor(ref), now, config));
  }

  // Second pass for parents, so a child indexed before its parent still links.
  for (const ref of subagentRefs) {
    const node = nodes.get(ref.agentId);
    if (!node) continue;

    if (ref.meta?.parentAgentId) {
      node.parentAgentId = ref.meta.parentAgentId;
      continue;
    }

    const owned = spawnFor(ref);
    if (owned) {
      node.parentAgentId = owned.owner;
      if (node.linkage === 'orphan') node.linkage = 'tool-result';
    }
  }

  const roots: SubagentNode[] = [];
  const orphans: SubagentNode[] = [];

  for (const node of nodes.values()) {
    if (node.parentAgentId === null) {
      // A depth-1 subagent spawned by the main session. `linkage: orphan` here
      // means we found no evidence at all — it is still a root, just an
      // unexplained one.
      roots.push(node);
      continue;
    }
    const parent = nodes.get(node.parentAgentId);
    if (parent) {
      parent.children.push(node);
    } else {
      // Names a parent we have no transcript for. Happens when a nested
      // subagent's files are written under a different session directory, or
      // when a file was cleaned up. Shown, not dropped.
      orphans.push(node);
    }
  }

  // Depth is assigned by walking, not trusted from the sidecar's `spawnDepth`:
  // the sidecar is right about its own depth in the run, but the tree we can
  // actually see may be missing an intermediate whose file is gone, and the
  // indentation has to match the tree that is on screen.
  const assignDepth = (node: SubagentNode, depth: number): void => {
    node.depth = depth;
    node.children.sort(byStart);
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  roots.sort(byStart);
  for (const root of roots) assignDepth(root, 1);
  orphans.sort(byStart);
  for (const orphan of orphans) assignDepth(orphan, 1);

  // The time axis the UI draws against spans everything, not just the parent:
  // a subagent can outlive the last line its parent wrote.
  let spanStartMs = sessionIndex.firstTs;
  let spanEndMs = sessionIndex.lastTs;
  for (const index of indexes.values()) {
    if (index.firstTs !== null && (spanStartMs === null || index.firstTs < spanStartMs)) {
      spanStartMs = index.firstTs;
    }
    if (index.lastTs !== null && (spanEndMs === null || index.lastTs > spanEndMs)) {
      spanEndMs = index.lastTs;
    }
  }

  return {
    ...summary,
    subagents: roots,
    orphans,
    spanStart: toIso(spanStartMs),
    spanEnd: toIso(spanEndMs),
  };
}

function byStart(a: SubagentNode, b: SubagentNode): number {
  const aStart = a.startedAt ? Date.parse(a.startedAt) : Number.MAX_SAFE_INTEGER;
  const bStart = b.startedAt ? Date.parse(b.startedAt) : Number.MAX_SAFE_INTEGER;
  return aStart - bStart;
}

function buildNode(
  ref: SubagentRef,
  index: TranscriptIndex | undefined,
  fromToolUse: OwnedSpawn | undefined,
  now: number,
  config: StatusConfig,
): SubagentNode {
  const role = ref.meta?.agentType ?? fromToolUse?.spawn.subagentType ?? 'unknown';
  const description = ref.meta?.description ?? fromToolUse?.spawn.description ?? '';

  // Start prefers the spawn instant over the subagent's first line: the gap
  // between "the parent asked" and "the child wrote its first line" is real
  // queueing time, and hiding it makes a backed-up run look instant.
  const startMs = fromToolUse?.spawn.spawnedAt ?? index?.firstTs ?? null;
  const endMs = index?.lastTs ?? null;

  return {
    agentId: ref.agentId,
    role,
    description,
    model: ref.meta?.model ?? fromToolUse?.spawn.model ?? null,
    parentAgentId: null,
    depth: 1,
    startedAt: toIso(startMs),
    endedAt: toIso(endMs),
    durationSeconds: startMs !== null && endMs !== null ? clampSeconds(startMs, endMs) : null,
    active: clampSeconds(ref.mtimeMs, now) <= config.liveness.runningSeconds,
    assistantTurns: index?.assistantTurns ?? 0,
    toolCalls: index?.toolCalls ?? 0,
    lineCount: index?.lines.length ?? 0,
    sizeBytes: ref.size,
    malformedLines: index?.malformedLines ?? 0,
    linkage: ref.meta ? 'meta' : 'orphan',
    children: [],
  };
}

export { describeFsError };
