import { stat } from 'node:fs/promises';
import type { AgentRoot, LivenessConfig, StatusConfig } from './config.js';
import { readMail, type MailMessage } from './mail.js';
import { readRegistry, type RegistryAgent } from './registry.js';
import {
  describeFsError,
  type SessionRef,
  type SpawnRecord,
  type SubagentRef,
  type TranscriptIndex,
  type TranscriptStore,
  type WorkflowRun,
} from './transcripts.js';

export type Liveness = 'running' | 'idle' | 'stale' | 'unknown';

export type OverviewAgent = {
  /** `hamachi-engineer1`. The registry's id, which is also its mailbox. */
  id: string;
  crew: string;
  /** The CREW role, verbatim from the registry (`AgentRole` in the waker's `src/store.ts`). */
  role: string;
  /** `status` verbatim from the registry — written, never observed. */
  declaredStatus: string;
  /** The board's own record of when this agent last ran a turn. */
  lastActiveAt: string | null;
  /** `slug(workspace_path)` — the transcript directory this agent writes into, and the front page's link to that agent's own page. */
  projectSlug: string;
  /** Transcripts under that directory. Zero is normal for `host`. */
  sessionCount: number;
  /** From the newest write across those sessions and their subagents. */
  liveness: Liveness;
  /** ISO of that write, or null when the agent has written none. */
  lastActivity: string | null;
};

export type InstanceOverview = {
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
  /** This instance's registry rows, each with its crew role. */
  agents: OverviewAgent[];
  /** Rows in this instance's registry. The count of AGENTS, not directories. */
  registeredAgentCount: number;
  /** Of those, how many declare `live`. Declared, never observed. */
  declaredLiveCount: number;
  unattributedSessionCount: number;
  /** Non-null when the board could not be read. Rendered as a warning row. */
  registryError: string | null;
  /** False when this instance has no `boardDb` configured. */
  registryConfigured: boolean;
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
  /** How this subagent was spawned — the sidecar's `agentType`, or `subagent_type` from the spawning tool call. */
  subagentType: string;
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
  linkage: 'meta' | 'tool-result' | 'orphan';
  /** The workflow run this came from, and that run's name. */
  workflowRunId: string | null;
  workflowName: string | null;
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

/** Liveness from a file mtime. */
export function livenessFromMtime(
  mtimeMs: number | null,
  now: number,
  config: LivenessConfig,
): Liveness {
  if (mtimeMs === null) return 'unknown';
  // Clamped, so a file mtime in the future reads as "just now" rather than as a negative age in the stale band.
  const ageSeconds = clampSeconds(mtimeMs, now);
  if (ageSeconds <= config.runningSeconds) return 'running';
  if (ageSeconds <= config.idleSeconds) return 'idle';
  return 'stale';
}

export async function buildInstanceOverview(
  store: TranscriptStore,
  agent: AgentRoot,
  config: StatusConfig,
  now: number,
): Promise<InstanceOverview> {
  const { sessions, error } = await store.sessions(agent);

  // The registry read, so the front page counts agents rather than directories.
  const registry = readRegistry(agent.boardDb);
  const claimedSlugs = new Set(registry.agents.map((row) => row.projectSlug));

  let newestMtime: number | null = null;
  let activeSessionCount = 0;
  let unattributedSessionCount = 0;

  const perSlug = new Map<string, { sessions: number; newestMtime: number | null }>();
  const forSlug = (slug: string): { sessions: number; newestMtime: number | null } => {
    const existing = perSlug.get(slug);
    if (existing) return existing;
    const fresh = { sessions: 0, newestMtime: null as number | null };
    perSlug.set(slug, fresh);
    return fresh;
  };

  for (const session of sessions) {
    if (!claimedSlugs.has(session.projectSlug)) unattributedSessionCount += 1;
    const slug = forSlug(session.projectSlug);
    // Counted before the stat, so this agrees with `sessions.length` below
    // even for a transcript that vanishes between the listing and the stat.
    slug.sessions += 1;

    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await stat(session.transcriptPath)).mtimeMs;
    } catch {
      // Vanished between listing and stat — a transcript being rotated, or a
      // race with a `--recreate`. Skip it rather than fail the whole row.
      continue;
    }

    if (newestMtime === null || mtimeMs > newestMtime) newestMtime = mtimeMs;
    if (slug.newestMtime === null || mtimeMs > slug.newestMtime) slug.newestMtime = mtimeMs;
    if (clampSeconds(mtimeMs, now) <= config.liveness.runningSeconds) activeSessionCount += 1;

    for (const subagent of await store.subagents(session)) {
      if (newestMtime === null || subagent.mtimeMs > newestMtime) newestMtime = subagent.mtimeMs;
      if (slug.newestMtime === null || subagent.mtimeMs > slug.newestMtime) {
        slug.newestMtime = subagent.mtimeMs;
      }
    }
  }

  const overviewAgents: OverviewAgent[] = registry.agents.map((row) => {
    const own = perSlug.get(row.projectSlug);
    const newest = own?.newestMtime ?? null;
    return {
      id: row.id,
      crew: row.crew,
      role: row.role,
      declaredStatus: row.declaredStatus,
      lastActiveAt: row.lastActiveAt,
      projectSlug: row.projectSlug,
      sessionCount: own?.sessions ?? 0,
      liveness: livenessFromMtime(newest, now, config.liveness),
      lastActivity: toIso(newest),
    };
  });

  return {
    id: agent.id,
    label: agent.label,
    projectsRoot: agent.projectsRoot,
    liveness: error ? 'unknown' : livenessFromMtime(newestMtime, now, config.liveness),
    lastActivity: toIso(newestMtime),
    lastActivityAgoSeconds: newestMtime === null ? null : clampSeconds(newestMtime, now),
    sessionCount: sessions.length,
    activeSessionCount,
    agents: overviewAgents,
    registeredAgentCount: registry.agents.length,
    declaredLiveCount: registry.agents.filter((row) => row.declaredStatus === 'live').length,
    unattributedSessionCount,
    registryError: registry.error,
    registryConfigured: registry.configured,
    error,
  };
}

// ── The roster ──────────────────────────────────────────────────────────────

export type RosterAgent = RegistryAgent & {
  /** Every session in this agent's transcript directory. Current first. */
  sessions: SessionSummary[];
  /** True when `sessionId` names a transcript that is actually on disk. */
  currentSessionPresent: boolean;
  /** From the newest transcript write across those sessions. */
  liveness: Liveness;
  /** ISO of that write, or null when the agent has never written one. */
  lastTranscriptActivity: string | null;
  subagentCount: number;
};

/** Sessions in a directory no registry row claims. Browsable, not an agent. */
export type OtherGroup = {
  projectSlug: string;
  sessions: SessionSummary[];
  liveness: Liveness;
  lastActivity: string;
};

export type Roster = {
  agent: string;
  label: string;
  agents: RosterAgent[];
  other: OtherGroup[];
  registryConfigured: boolean;
  /** Non-null when the board could not be read. Rendered, never swallowed. */
  registryError: string | null;
  /** Non-null when the projects root could not be read. */
  error: string | null;
  sessionCount: number;
};

export async function buildRoster(
  store: TranscriptStore,
  agent: AgentRoot,
  config: StatusConfig,
  now: number,
): Promise<Roster> {
  const { sessions, error } = await buildSessionList(store, agent, config, now);
  const registry = readRegistry(agent.boardDb);

  // Sessions keep the newest-activity-first order buildSessionList gave them,
  // so every group below is already sorted without sorting again.
  const bySlug = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const group = bySlug.get(session.projectSlug);
    if (group) group.push(session);
    else bySlug.set(session.projectSlug, [session]);
  }

  const agents: RosterAgent[] = registry.agents.map((row) => {
    const own = [...(bySlug.get(row.projectSlug) ?? [])];

    // The session the agent resumes goes first, whatever its mtime says. It is
    // the one a reader means by "what is it doing", and a subagent writing
    // under an older session would otherwise push it down the list.
    const currentAt = own.findIndex((session) => session.sessionId === row.sessionId);
    if (currentAt > 0) own.unshift(...own.splice(currentAt, 1));

    const newest = own.reduce<number | null>((newestMs, session) => {
      const ms = Date.parse(session.lastActivity);
      if (!Number.isFinite(ms)) return newestMs;
      return newestMs === null || ms > newestMs ? ms : newestMs;
    }, null);

    return {
      ...row,
      sessions: own,
      currentSessionPresent: currentAt !== -1,
      liveness: livenessFromMtime(newest, now, config.liveness),
      lastTranscriptActivity: toIso(newest),
      subagentCount: own.reduce((sum, session) => sum + session.subagentCount, 0),
    };
  });

  const claimed = new Set(registry.agents.map((row) => row.projectSlug));
  const other: OtherGroup[] = [];
  for (const [slug, group] of bySlug) {
    if (claimed.has(slug)) continue;
    const first = group[0];
    if (!first) continue;
    other.push({
      projectSlug: slug,
      sessions: group,
      liveness: first.liveness,
      lastActivity: first.lastActivity,
    });
  }
  other.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));

  return {
    agent: agent.id,
    label: agent.label,
    agents,
    other,
    registryConfigured: registry.configured,
    registryError: registry.error,
    error,
    sessionCount: sessions.length,
  };
}

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
      // One unreadable transcript must not blank the list: no row for it, the others still render.
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

  // The newest write across the session and its subagents.
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

/** Sessions already warned about, so the log below fires once each per process. */
const oversizeWarned = new Set<string>();

export function resetOversizeWarnings(): void {
  oversizeWarned.clear();
}

export async function buildSessionDetail(
  store: TranscriptStore,
  session: SessionRef,
  config: StatusConfig,
  now: number,
): Promise<SessionDetail> {
  const summary = await summariseSession(store, session, config, now);
  const sessionIndex = await store.index(session.transcriptPath);
  const subagentRefs = await store.subagents(session);

  const needed = subagentRefs.length + 1;
  if (needed > config.read.maxCachedSessions && !oversizeWarned.has(session.sessionId)) {
    oversizeWarned.add(session.sessionId);
    console.warn(
      `[status] session ${session.sessionId} has ${needed} transcripts and ` +
        `read.maxCachedSessions is ${config.read.maxCachedSessions}. Every rebuild of this ` +
        'session will re-parse all of them — the cache cannot hold one pass, so it evicts ' +
        'what the next pass needs. Raise read.maxCachedSessions above ' +
        `${needed} in status-config.yaml.`,
    );
  }

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
      // Unreadable subagent transcript: it still gets a node, from its sidecar
      // and its stat, with zeroed counts.
    }
  }

  const spawnFor = (ref: SubagentRef): OwnedSpawn | undefined =>
    (ref.meta?.toolUseId ? spawnsByToolUse.get(ref.meta.toolUseId) : undefined) ??
    spawnsByAgentId.get(ref.agentId);

  const runs = await store.workflowRuns(session);
  const nodes = new Map<string, SubagentNode>();
  for (const ref of subagentRefs) {
    nodes.set(
      ref.agentId,
      buildNode(ref, indexes.get(ref.agentId), spawnFor(ref), now, config, runs),
    );
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

  // Depth is assigned by walking, not taken from the sidecar's `spawnDepth`, so it matches the tree actually built here.
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
  runs: Map<string, WorkflowRun>,
): SubagentNode {
  // Empty, not `'unknown'`, when neither source has it.
  const subagentType = ref.meta?.agentType ?? fromToolUse?.spawn.subagentType ?? '';
  const description = ref.meta?.description ?? fromToolUse?.spawn.description ?? '';

  // Start prefers the spawn instant over the subagent's first line: the gap
  // between "the parent asked" and "the child wrote its first line" is real
  // queueing time, and hiding it makes a backed-up run look instant.
  const startMs = fromToolUse?.spawn.spawnedAt ?? index?.firstTs ?? null;
  const endMs = index?.lastTs ?? null;

  return {
    agentId: ref.agentId,
    subagentType,
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
    workflowRunId: ref.workflowRunId,
    workflowName: ref.workflowRunId ? (runs.get(ref.workflowRunId)?.name ?? null) : null,
    children: [],
  };
}

export { describeFsError };

// ── Subagents ───────────────────────────────────────────────────────────────

export type SubagentEntry = {
  agentId: string;
  sessionId: string;
  /** The transcript directory this subagent was found under. */
  projectSlug: string;
  subagentType: string;
  description: string;
  model: string | null;
  depth: number | null;
  parentAgentId: string | null;
  /** Non-null when this came from `subagents/workflows/<runId>/`. */
  workflowRunId: string | null;
  workflowName: string | null;
  sizeBytes: number;
  lastActivity: string;
  /** Still being written to, by mtime. */
  active: boolean;
};

export type SubagentTypeGroup = {
  subagentType: string;
  count: number;
  subagents: SubagentEntry[];
};

export type WorkflowSummary = WorkflowRun & {
  sessionId: string;
  /** Transcripts actually on disk for this run — not the descriptor's claim. */
  observedAgents: number;
};

export type SubagentRollup = {
  agent: string;
  label: string;
  projectSlug: string | null;
  /** Non-null when the scope names a directory the registry does not claim. */
  scopeNote: string | null;
  total: number;
  /** Of those, how many came from a workflow run rather than a direct spawn. */
  fromWorkflows: number;
  types: SubagentTypeGroup[];
  workflows: WorkflowSummary[];
  error: string | null;
};

export async function buildSubagentRollup(
  store: TranscriptStore,
  agent: AgentRoot,
  config: StatusConfig,
  now: number,
  scope: { projectSlug?: string | null } = {},
): Promise<SubagentRollup> {
  const { sessions, error } = await store.sessions(agent);
  const projectSlug = scope.projectSlug ?? null;

  const entries: SubagentEntry[] = [];
  const workflows: WorkflowSummary[] = [];
  const observed = new Map<string, number>();
  const runNames = new Map<string, string | null>();

  for (const session of sessions) {
    // Every session is still walked, scope or no scope — the filter is on what
    // comes back, never on where we look.
    const inScope = projectSlug === null || session.projectSlug === projectSlug;

    const refs = await store.subagents(session);
    const runs = await store.workflowRuns(session);
    for (const run of runs.values()) {
      runNames.set(run.runId, run.name);
      if (inScope) workflows.push({ ...run, sessionId: session.sessionId, observedAgents: 0 });
    }

    for (const ref of refs) {
      if (ref.workflowRunId) {
        observed.set(ref.workflowRunId, (observed.get(ref.workflowRunId) ?? 0) + 1);
      }
      if (!inScope) continue;
      entries.push({
        agentId: ref.agentId,
        sessionId: session.sessionId,
        projectSlug: session.projectSlug,
        // The sidecar and nothing else: empty here means "no sidecar", which
        // the page labels differently from `buildNode`'s empty.
        subagentType: ref.meta?.agentType ?? '',
        description: ref.meta?.description ?? '',
        model: ref.meta?.model ?? null,
        depth: ref.meta?.spawnDepth ?? null,
        parentAgentId: ref.meta?.parentAgentId ?? null,
        workflowRunId: ref.workflowRunId,
        workflowName: ref.workflowRunId ? (runNames.get(ref.workflowRunId) ?? null) : null,
        sizeBytes: ref.size,
        lastActivity: new Date(ref.mtimeMs).toISOString(),
        active: clampSeconds(ref.mtimeMs, now) <= config.liveness.runningSeconds,
      });
    }
  }

  // Counted across the whole walk on purpose, so a run's "5 agents recorded, 5 on disk" reconciliation stays true under a scope.
  for (const run of workflows) run.observedAgents = observed.get(run.runId) ?? 0;

  const byType = new Map<string, SubagentEntry[]>();
  for (const entry of entries) {
    const group = byType.get(entry.subagentType);
    if (group) group.push(entry);
    else byType.set(entry.subagentType, [entry]);
  }

  const types: SubagentTypeGroup[] = [...byType.entries()]
    .map(([subagentType, group]) => {
      group.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
      return { subagentType, count: group.length, subagents: group };
    })
    .sort((a, b) => b.count - a.count || a.subagentType.localeCompare(b.subagentType));

  workflows.sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''));

  return {
    agent: agent.id,
    label: agent.label,
    projectSlug,
    scopeNote: describeScope(agent, projectSlug),
    total: entries.length,
    fromWorkflows: entries.filter((entry) => entry.workflowRunId !== null).length,
    types,
    workflows,
    error,
  };
}

/** `slug('/tmp/…')`. */
function isTmpSlug(projectSlug: string): boolean {
  return projectSlug === '-tmp' || projectSlug.startsWith('-tmp-');
}

/** Say which of the two disagreeing sources the scope came from, when they disagree. */
function describeScope(agent: AgentRoot, projectSlug: string | null): string | null {
  if (projectSlug === null) return null;
  const registry = readRegistry(agent.boardDb);
  if (registry.error !== null) {
    return (
      `${registry.error} These subagents are shown by transcript directory ` +
      `(${projectSlug}); which agent owns that directory could not be checked.`
    );
  }
  if (!registry.configured) {
    return (
      `This instance has no boardDb in status-config.yaml, so there is no registry to say ` +
      `which agent owns ${projectSlug}. These subagents are shown by directory.`
    );
  }
  const owner = registry.agents.find((row) => row.projectSlug === projectSlug);
  if (owner) return null;
  return (
    `No agent in the registry has ${projectSlug} as its workspace, so these subagents are ` +
    'attributed to a directory rather than to an agent. ' +
    (isTmpSlug(projectSlug)
      ? 'That directory is under /tmp, which on this host is where engineers have run ' +
        'permission probes — real transcripts, no owner.'
      : 'It may be a cwd somebody ran Claude Code in, or an agent this registry no longer ' +
        'carries. Nothing here can tell those apart: the directory is all there is.')
  );
}

// ── Clawsky ─────────────────────────────────────────────────────────────────

export type ClawskyParticipant = {
  id: string;
  crew: string;
  role: string;
  declaredStatus: string;
  lastActiveAt: string | null;
  /** Messages this agent has sent, across DMs and the feed. */
  sent: number;
};

export type ClawskyInstance = {
  agent: string;
  label: string;
  participants: ClawskyParticipant[];
  /** Registry rows whose role is `poster`. */
  posterCount: number;
  boardReadable: boolean;
  feed: MailMessage[];
  dms: MailMessage[];
  totalFeed: number;
  totalDms: number;
  registryConfigured: boolean;
  registryError: string | null;
  mailError: string | null;
};

export function buildClawsky(agent: AgentRoot, config: StatusConfig): ClawskyInstance {
  const registry = readRegistry(agent.boardDb);
  const mail = readMail(agent.boardDb, config.read.maxBlockChars);

  return {
    agent: agent.id,
    label: agent.label,
    participants: registry.agents.map((row) => ({
      id: row.id,
      crew: row.crew,
      role: row.role,
      declaredStatus: row.declaredStatus,
      lastActiveAt: row.lastActiveAt,
      // From the board's own GROUP BY, not from the returned window — a count
      // taken from a capped list undercounts silently the moment the cap bites.
      sent: mail.sentByAuthor.get(row.id) ?? 0,
    })),
    posterCount: registry.agents.filter((row) => row.role === 'poster').length,
    boardReadable: registry.error === null && mail.error === null && registry.configured,
    feed: mail.feed,
    dms: mail.dms,
    totalFeed: mail.totalFeed,
    totalDms: mail.totalDms,
    registryConfigured: registry.configured,
    registryError: registry.error,
    mailError: mail.error,
  };
}
