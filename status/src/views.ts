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
  /** Rows in this instance's registry. The count of AGENTS, not directories. */
  registeredAgentCount: number;
  /** Of those, how many declare `live`. Declared, never observed — see below. */
  declaredLiveCount: number;
  /**
   * Sessions in a directory no registry row claims.
   *
   * Not an error and not hidden: they are real transcripts and may be worth
   * reading. On this host they are the `/tmp` scratch paths where engineers ran
   * permission probes. They are simply not agents.
   */
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
  /**
   * The workflow run this came from, and that run's name.
   *
   * A workflow subagent has no `description` at all, so without these the
   * swimlane draws an anonymous bar per agent — six of them here, fifty-eight
   * on the real session. The run is what they were for, and the lane says so.
   */
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

  // The registry read is a handful of rows and costs nothing next to the stats
  // below, so the front page can afford to say how many AGENTS there are
  // rather than only how many directories.
  const registry = readRegistry(agent.boardDb);
  const claimedSlugs = new Set(registry.agents.map((row) => row.projectSlug));

  let newestMtime: number | null = null;
  let activeSessionCount = 0;
  let subagentCount = 0;
  let unattributedSessionCount = 0;

  for (const session of sessions) {
    if (!claimedSlugs.has(session.projectSlug)) unattributedSessionCount += 1;
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
    registeredAgentCount: registry.agents.length,
    declaredLiveCount: registry.agents.filter((row) => row.declaredStatus === 'live').length,
    unattributedSessionCount,
    registryError: registry.error,
    registryConfigured: registry.configured,
    error,
  };
}

// ── The roster ──────────────────────────────────────────────────────────────

/**
 * One registry agent, with every session it has ever had.
 *
 * `liveness` here is the same mtime-derived band the rest of the page uses and
 * is a DIFFERENT claim from `declaredStatus`: one is "a file was written 4
 * minutes ago", the other is "nobody has declared this agent dead". Both are
 * carried because neither is sufficient. Nothing writes `dead` today —
 * `setStatus` has no caller outside a test, since kill is CLAWSKY.md phase 5 —
 * so a status column on its own would be the same word on every row forever.
 */
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

/**
 * Everything one instance has: its agents, and what is left over.
 *
 * ── Why this replaced a flat session list ──────────────────────────────────
 *
 * The page used to render one row per `.jsonl` under the root, newest first,
 * and that is Clawcius #14: 49 rows for Clawcius, and for Hamachi five
 * "agents" of which three were `/tmp` directories from permission probes. A
 * transcript file is an artefact of a session; the thing a person is looking
 * for is the agent that had it.
 *
 * So the list comes from the registry and the transcripts hang off it, joined
 * on `slug(workspace_path)` — see `registry.ts` for why that join needs no
 * schema change. Two rows sharing a workspace path would both show the same
 * sessions; the waker gives every agent its own directory
 * (`join(workspaceRoot, id)`), so that does not happen today, and if it ever
 * does, showing the sessions twice is better than deciding which agent loses
 * them.
 *
 * Anything left over is filed under `other`, still browsable and still linking
 * to its transcripts. It is not an error and it is not hidden — those `/tmp`
 * sessions are real and may be worth reading. They are just not agents.
 */
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
  runs: Map<string, WorkflowRun>,
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
    workflowRunId: ref.workflowRunId,
    workflowName: ref.workflowRunId ? (runs.get(ref.workflowRunId)?.name ?? null) : null,
    children: [],
  };
}

export { describeFsError };

// ── Subagents ───────────────────────────────────────────────────────────────

/**
 * One subagent, as a thing in its own right rather than a node in one session's
 * tree.
 *
 * The session view already draws the tree — who spawned whom, over a time axis
 * — and answers "what happened in this run". It cannot answer "what kinds of
 * agent does this system run, and where is the transcript of the one that died
 * at 4am", because you have to know which session to open first. That is
 * Clawcius #22, and it is what this roll-up is for.
 *
 * DELIBERATELY NOT INDEXED. Every field here comes from a `readdir`, a `stat`
 * and a sidecar JSON read. There are 104 subagent transcripts under Hamachi's
 * root today and parsing all of them to put turn counts on a list view would
 * make the cheapest question the most expensive one — the same reasoning as
 * `buildAgentOverview`. Open one and the session view indexes it properly.
 */
export type SubagentEntry = {
  agentId: string;
  sessionId: string;
  /** `agentType` from the sidecar — the ROLE. `unknown` when there is none. */
  role: string;
  description: string;
  model: string | null;
  depth: number | null;
  parentAgentId: string | null;
  /** Non-null when this came from `subagents/workflows/<runId>/`. */
  workflowRunId: string | null;
  /**
   * The run's name, when its descriptor is on disk.
   *
   * Carried because a workflow subagent's sidecar has no description at all —
   * it is `{agentType: "workflow-subagent", spawnDepth: 1}` and identical on
   * every one of them. Without this the list renders 58 rows reading "no
   * description recorded", which is true of the sidecar and useless to a
   * reader when the answer is one join away. It is the RUN's name, and the UI
   * labels it as such rather than passing it off as this agent's own.
   */
  workflowName: string | null;
  sizeBytes: number;
  lastActivity: string;
  /** Still being written to, by mtime. */
  active: boolean;
};

export type RoleGroup = {
  role: string;
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
  total: number;
  /** Of those, how many came from a workflow run rather than a direct spawn. */
  fromWorkflows: number;
  roles: RoleGroup[];
  workflows: WorkflowSummary[];
  error: string | null;
};

/**
 * Every subagent this instance has ever run, grouped by role.
 *
 * Roles are ordered by how many there are, because the question the page is
 * answering is "what does this system spend its subagents on". Within a role
 * the newest is first, because the question after that is always "what was the
 * last one doing".
 */
export async function buildSubagentRollup(
  store: TranscriptStore,
  agent: AgentRoot,
  config: StatusConfig,
  now: number,
): Promise<SubagentRollup> {
  const { sessions, error } = await store.sessions(agent);

  const entries: SubagentEntry[] = [];
  const workflows: WorkflowSummary[] = [];
  const observed = new Map<string, number>();
  const runNames = new Map<string, string | null>();

  for (const session of sessions) {
    const refs = await store.subagents(session);
    const runs = await store.workflowRuns(session);
    for (const run of runs.values()) {
      runNames.set(run.runId, run.name);
      workflows.push({ ...run, sessionId: session.sessionId, observedAgents: 0 });
    }

    for (const ref of refs) {
      if (ref.workflowRunId) {
        observed.set(ref.workflowRunId, (observed.get(ref.workflowRunId) ?? 0) + 1);
      }
      entries.push({
        agentId: ref.agentId,
        sessionId: session.sessionId,
        role: ref.meta?.agentType ?? 'unknown',
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

  for (const run of workflows) run.observedAgents = observed.get(run.runId) ?? 0;

  const byRole = new Map<string, SubagentEntry[]>();
  for (const entry of entries) {
    const group = byRole.get(entry.role);
    if (group) group.push(entry);
    else byRole.set(entry.role, [entry]);
  }

  const roles: RoleGroup[] = [...byRole.entries()]
    .map(([role, group]) => {
      group.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
      return { role, count: group.length, subagents: group };
    })
    .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));

  workflows.sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''));

  return {
    agent: agent.id,
    label: agent.label,
    total: entries.length,
    fromWorkflows: entries.filter((entry) => entry.workflowRunId !== null).length,
    roles,
    workflows,
    error,
  };
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
  /**
   * Registry rows whose role is `poster`.
   *
   * Carried so the page can say WHY the feed is empty rather than showing an
   * empty box that reads as a fault. Only a poster may write to the feed
   * (`src/mail.ts`), so zero posters means an empty feed is the correct and
   * expected state — a checkable statement rather than a reassuring one.
   */
  posterCount: number;
  feed: MailMessage[];
  dms: MailMessage[];
  totalMessages: number;
  shownMessages: number;
  registryConfigured: boolean;
  registryError: string | null;
  mailError: string | null;
};

/**
 * The board, for one instance: who is on it and everything they have said.
 *
 * Two reads of the same file, because they are two questions and either can
 * fail on its own — a board whose `mail` table is missing still has a useful
 * registry, and the page should say which half it lost.
 */
export function buildClawsky(agent: AgentRoot, config: StatusConfig): ClawskyInstance {
  const registry = readRegistry(agent.boardDb);
  const mail = readMail(agent.boardDb, config.read.maxBlockChars);

  const sent = new Map<string, number>();
  for (const message of [...mail.feed, ...mail.dms]) {
    sent.set(message.author, (sent.get(message.author) ?? 0) + 1);
  }

  return {
    agent: agent.id,
    label: agent.label,
    participants: registry.agents.map((row) => ({
      id: row.id,
      crew: row.crew,
      role: row.role,
      declaredStatus: row.declaredStatus,
      lastActiveAt: row.lastActiveAt,
      sent: sent.get(row.id) ?? 0,
    })),
    posterCount: registry.agents.filter((row) => row.role === 'poster').length,
    feed: mail.feed,
    dms: mail.dms,
    totalMessages: mail.totalMessages,
    shownMessages: mail.shownMessages,
    registryConfigured: registry.configured,
    registryError: registry.error,
    mailError: mail.error,
  };
}
