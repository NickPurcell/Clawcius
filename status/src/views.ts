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

/**
 * One crew agent, as the front page lists it.
 *
 * ── Why this exists, and why subagents are not in it ───────────────────────
 *
 * The front page used to list INSTANCES — two cards, "Clawcius" and
 * "Hamachi" — and the only things on it wearing a type were subagents, whose
 * type is `general-purpose`, `Explore` or `workflow-subagent`. So an operator
 * who came to the page asking "which of these is the engineer and which is the
 * researcher" was shown neither the agents nor the roles, and was shown three
 * words that look like roles and are not.
 *
 * The list is therefore the registry's rows, and `role` here is the registry's
 * `role` — CLAWSKY.md's four, coordinator / engineer / researcher / poster,
 * plus `host`. It is the only "type" in this system that means anything to a
 * person, and it is the one the operator asked for.
 *
 * Subagents are not here, and the reason is not that a busy page is
 * unpleasant. **A subagent has no identity of its own.** CLAWSKY.md: it
 * inherits its parent's worktree and identity, it has no registry row, no
 * mailbox and no persistence, and it dies with its parent — "it is an
 * extension of the named agent". There is no id to DM and no row to list. So a
 * subagent on a list of agents is not a peer of the engineer above it; it is
 * part of that engineer, filed as though it were a colleague. That is the
 * honest reason it is not here, and it does not stop being true when somebody
 * later decides the page has room.
 *
 * What a subagent DOES contribute here is activity: its writes are its
 * parent's work, so `liveness` below counts subagent transcript mtimes. An
 * engineer blocked for ten minutes waiting on a subagent is working, and a
 * page that called it stale would be wrong about the one thing it is for.
 *
 * The transcripts remain reachable — every one of them, including the 58 that
 * Clawcius #80 found in `subagents/workflows/<runId>/` — through the roll-up
 * at `/api/agents/<id>/subagents`, now scopeable to one agent. Off the front
 * page is not the same as gone, and this file's job is to keep the difference.
 */
export type OverviewAgent = {
  /** `hamachi-engineer1`. The registry's id, which is also its mailbox. */
  id: string;
  crew: string;
  /**
   * The CREW role, verbatim from the registry: `coordinator`, `engineer`,
   * `researcher`, `poster`, or `host`.
   *
   * Never synthesised. If a row's role is empty the page says the registry
   * recorded none — it does not guess one, and it does not borrow a
   * `subagent_type` from a transcript to fill the gap.
   */
  role: string;
  /**
   * `status` verbatim from the registry — written, never observed.
   *
   * Carried beside `lastActiveAt` and `liveness` for the same reason
   * `RosterAgent` carries it: a kill writes `dead`, a crash writes nothing, so
   * the word alone is not evidence. Living and dead have to stay
   * distinguishable on this page, and one written word is not enough to do it.
   */
  declaredStatus: string;
  /** The board's own record of when this agent last ran a turn. */
  lastActiveAt: string | null;
  /**
   * `slug(workspace_path)` — the transcript directory this agent writes into,
   * and the front page's link to that agent's own page.
   *
   * The workspace path itself is not here. It is on the roster, one click
   * down, where the join it feeds is explained; carrying it on a payload
   * nothing renders is how a field goes stale unnoticed.
   */
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
  /**
   * This instance's registry rows, each with its crew role. The front page's
   * actual content.
   *
   * In the registry's own order — crew, then role, then id — so two loads
   * agree and so the roles cluster. Not sorted by activity: an idle poster
   * moving above a working engineer between refreshes makes a list of five
   * things impossible to read.
   */
  agents: OverviewAgent[];
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
  /**
   * How this subagent was spawned — the sidecar's `agentType`, or
   * `subagent_type` from the spawning tool call. `general-purpose`, `Explore`,
   * `workflow-subagent`.
   *
   * Was called `role`, which is the name this repository uses for a crew role,
   * and it is not one: a subagent has no registry row, so it has no crew role
   * to have. The empty string means the sidecar recorded no type and no
   * spawning call was found — a fact that IS missing, unlike a crew role,
   * which for a subagent is not missing but inapplicable. The UI says which.
   */
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
 * One instance's front-page entry: its crew agents, and totals about them.
 *
 * Deliberately does NOT index any transcript. This runs for every configured
 * instance on every load of the front page, and parsing every session's JSONL
 * to answer "when did something last happen" would make the cheapest page the
 * most expensive one. `stat` on each file is enough, and mtime is the right
 * signal for liveness anyway. The per-agent rows below are built from the same
 * single walk — grouping stats we already have costs nothing, whereas a second
 * pass per registry row would multiply the walk by the size of the crew.
 */
export async function buildInstanceOverview(
  store: TranscriptStore,
  agent: AgentRoot,
  config: StatusConfig,
  now: number,
): Promise<InstanceOverview> {
  const { sessions, error } = await store.sessions(agent);

  // The registry read is a handful of rows and costs nothing next to the stats
  // below, so the front page can afford to say how many AGENTS there are
  // rather than only how many directories.
  const registry = readRegistry(agent.boardDb);
  const claimedSlugs = new Set(registry.agents.map((row) => row.projectSlug));

  let newestMtime: number | null = null;
  let activeSessionCount = 0;
  let unattributedSessionCount = 0;

  // Per transcript directory, so each registry row can be given its own
  // liveness without a second walk of the tree. The join is `projectSlug`,
  // which is `slug(workspace_path)` — see registry.ts for why it needs no
  // schema change.
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

    // Subagent transcripts are STATTED, not counted onto the page and not
    // indexed. Their mtimes decide liveness — a subagent's write is its
    // parent's work, and an engineer blocked waiting on one is working — but
    // the number of them is not a fact about the crew and no longer appears
    // here. See `OverviewAgent` for why a subagent is not a peer of the agent
    // that spawned it.
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
 *      `agentType` (how it was spawned, not a crew role), `description`, the
 *      `toolUseId` of the call that spawned it, and `parentAgentId` for
 *      anything nested. When present this is recorded fact and needs no
 *      inference at all.
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
/**
 * Sessions already warned about, so the log below fires once each per process.
 *
 * A cliff that is silent is a cliff nobody fixes. Not a Map with timestamps:
 * this is a boot-time configuration problem, and saying it once per session is
 * what makes it findable in the journal without becoming noise the next reader
 * filters out.
 */
const oversizeWarned = new Set<string>();

/**
 * Forget which sessions have been warned about.
 *
 * Exported for tests only. The set is module state deliberately — the warning
 * is once per process per session — but that makes any test asserting on it
 * depend on no earlier test in the file having warned for the same fixture
 * session id, and a fixture's session id is a constant. Without this, adding a
 * test above that one turns its assertion into `warnings.length === 0` and the
 * failure reads as the warning being broken rather than as ordering.
 */
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

  // One session is its own transcript plus one per subagent, and this walk
  // touches all of them in order. If that exceeds the LRU, every pass evicts
  // exactly what the next pass asks for first and the cache stops working
  // rather than working less well — measured at 786ms per rebuild instead of
  // 107ms, on a page that rebuilds on every change event.
  //
  // Reported rather than worked around: raising the ceiling is a config change
  // with a memory cost, which is the operator's, and a page that quietly ran
  // seven times slower is how this went unnoticed in the first place.
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
  // no subagent type and no description — losing exactly the fields this view
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
  // Empty, not `'unknown'`, when neither source has it. `unknown` is a word
  // and sat in a column headed "role", so it read as an agent whose crew role
  // nobody had filled in — a claim about the crew, made by a field that has
  // nothing to do with the crew. Empty carries no such suggestion and the UI
  // spells the absence out where there is room to say what is absent.
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
 * `buildInstanceOverview`. Open one and the session view indexes it properly.
 */
export type SubagentEntry = {
  agentId: string;
  sessionId: string;
  /**
   * The transcript directory this subagent was found under.
   *
   * Carried so the roll-up can be scoped to one agent: `projectSlug` is
   * `slug(workspace_path)` for exactly one registry row, so filtering on it
   * turns "every subagent on this instance" into "this engineer's subagents",
   * which is the only grouping that matches how they are actually owned — a
   * subagent inherits its parent's identity and belongs to that agent's work.
   */
  projectSlug: string;
  /**
   * `agentType` from the sidecar. NOT a crew role, and no longer called one.
   *
   * ── Empty means "no sidecar", and only that ────────────────────────────
   *
   * ONE source, deliberately. `buildSessionDetail` has a second — the
   * `subagent_type` on the `Task` call that spawned it — and recovers a type
   * this field leaves empty. That is not an oversight to be tidied up: the
   * spawning call is inside the PARENT transcript, so reading it means
   * indexing, and the header above commits this roll-up to a readdir, a stat
   * and a sidecar read for all 104 transcripts under Hamachi's root.
   *
   * So the honest reading of the empty string here is "this subagent has no
   * sidecar", NOT "nothing anywhere recorded a type" — the session view may
   * well know, and the UI says so rather than claiming the type is lost. The
   * doc used to assert the two-source fallback that `buildNode` has and this
   * does not, which is a sentence outrunning its code, in a change whose whole
   * subject is sentences outrunning their code.
   */
  subagentType: string;
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

/**
 * Subagents sharing a `subagent_type`.
 *
 * Was `RoleGroup`, and the page headed it "By role". Two different things in
 * this system are called a type and only one of them is a role; the group that
 * is NOT the role is the one that had the word.
 */
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
  /**
   * The transcript directory this roll-up was scoped to, or null for the whole
   * instance.
   *
   * On the wire rather than only in the URL because the two answers differ and
   * a reader has to be able to tell which they are looking at: "this instance
   * has run 5 subagents" and "this agent has run 5 subagents" are different
   * claims, and the second is the one that is wrong if the scope silently
   * failed to apply.
   */
  projectSlug: string | null;
  /**
   * Non-null when the scope names a directory the registry does not claim.
   *
   * The registry and the transcript directories are allowed to disagree — the
   * three `/tmp` slugs under Hamachi's root are directories with no agent —
   * and when a scope lands on one of those, the page says so instead of
   * captioning somebody's permission probe with an agent's name.
   */
  scopeNote: string | null;
  total: number;
  /** Of those, how many came from a workflow run rather than a direct spawn. */
  fromWorkflows: number;
  types: SubagentTypeGroup[];
  workflows: WorkflowSummary[];
  error: string | null;
};

/**
 * Every subagent this instance has run, grouped by `subagent_type` — or just
 * one agent's, when `projectSlug` scopes it.
 *
 * Types are ordered by how many there are, because the question the page is
 * answering is "what does this system spend its subagents on". Within a type
 * the newest is first, because the question after that is always "what was the
 * last one doing".
 *
 * ── The scope, and Clawcius #80 ────────────────────────────────────────────
 *
 * The scope is a FILTER over the same walk, not a different walk. That is
 * deliberate and it is the check that keeps #80 fixed: #80 was 58 of 104
 * subagent transcripts sitting in `subagents/workflows/<runId>/`, a directory
 * nothing read. If scoping meant "look in this agent's directory instead", a
 * future edit could narrow where it looks and lose a population again. Here
 * every transcript is still enumerated on every call and the only question is
 * which ones are returned — and the unscoped call, which the instance page
 * still links, returns all of them.
 *
 * A `projectSlug` matching nothing yields an empty roll-up rather than an
 * error. An agent that has spawned no subagents is a perfectly ordinary state,
 * so "none" is an answer and not a fault.
 *
 * This used to add that the coordinator and poster "cannot spawn one at all
 * (CLAWSKY.md: they lose the tool)". CLAWSKY.md does say the tool is removed
 * from those two, but it says it under phase 5, which is unmarked while phase
 * 6 is Done, and there is no `disallowedTools`, `allowedTools` or `canUseTool`
 * anywhere in `src/` today. So it is the intent, written down, and not yet a
 * mechanism — and a comment asserting it is this file claiming a guarantee the
 * code does not make. Removed rather than hedged: "none" needs no explanation.
 */
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
    // comes back, never on where we look. See the header: narrowing the walk
    // is how a population goes missing, and one already did.
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
        // The sidecar and nothing else — see the field's doc. Empty here means
        // "no sidecar", which is weaker than `buildNode`'s empty and is
        // labelled differently on the page for exactly that reason.
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

  // Counted across the whole walk on purpose, so a run's "5 agents recorded, 5
  // on disk" reconciliation stays true under a scope. A scoped page showing 3
  // of a 5-agent run would otherwise print a discrepancy warning about a run
  // that is perfectly consistent.
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

/**
 * `slug('/tmp/…')`. The leading dash is the slugified leading slash — see
 * `slugifyWorkspace`, where every non-alphanumeric becomes one — so this is a
 * statement about the path the directory was named after, not a guess.
 */
function isTmpSlug(projectSlug: string): boolean {
  return projectSlug === '-tmp' || projectSlug.startsWith('-tmp-');
}

/**
 * Say which of the two disagreeing sources the scope came from, when they
 * disagree.
 *
 * Directories are not agents and the registry is the list of agents; a slug
 * can therefore be a real directory full of real transcripts and still belong
 * to nobody. Three of the five under Hamachi's root are exactly that. Null
 * when the scope is a registered agent's own directory, or when there is no
 * scope at all — a note on every page is a note nobody reads.
 */
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
    // Read off the slug in hand, not asserted about "this host". The sentence
    // this replaces named the /tmp permission probes on EVERY unclaimed slug,
    // which made it wrong in the case that matters most: a directory that did
    // belong to an agent the registry no longer carries, which is exactly what
    // an operator scopes to when something has gone wrong. What is left is
    // checkable from the string, and the alternatives are offered as
    // alternatives instead of one of them being reported as an observation.
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
  /**
   * Registry rows whose role is `poster`.
   *
   * Carried so the page can say WHY the feed is empty rather than showing an
   * empty box that reads as a fault. Only a poster may write to the feed
   * (`src/mail.ts`), so zero posters means an empty feed is the correct and
   * expected state — a checkable statement rather than a reassuring one.
   */
  posterCount: number;
  /**
   * True only when BOTH halves of the board were read.
   *
   * The gate on every positive statement the page makes about this board, and
   * it exists because `posterCount: 0` has two meanings — "this crew has no
   * poster" and "the registry could not be read" — and only the first licenses
   * the sentence the page prints under an empty feed. Same for `dms: []`.
   *
   * It is decided here rather than in the client because it is the claim, not
   * the layout: "there are no posts" and "we do not know whether there are
   * posts" are different facts about the world, and a fact belongs on the wire
   * where a test can see it.
   *
   * This is not a rare state. It is the one this page names itself — mail goes
   * dark at exactly the moments the roster does, Clawcius #72 — so the reader
   * met a careful explanation of why the board was unreadable followed by a
   * confident "nothing is broken and nothing needs enabling".
   */
  boardReadable: boolean;
  feed: MailMessage[];
  dms: MailMessage[];
  /**
   * Rows in the table per list, whether or not they were returned.
   *
   * Per list, because the ceiling is per list. A single overall total could
   * not tell the page whether the feed it is about to call empty is empty or
   * merely off the end of a window — which is the difference between the copy
   * being true and being a lie with a reassuring tone.
   */
  totalFeed: number;
  totalDms: number;
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
