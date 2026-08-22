/*
 * The client.
 *
 * ── The one rule ──────────────────────────────────────────────────────────
 *
 * NOTHING from the server is ever assigned to innerHTML, or interpolated into a
 * string that becomes markup. Every value goes onto the page as a text node or
 * through `textContent`, and every element is created with createElement. The
 * `el()` helper below is the only way this file builds DOM, and it has no code
 * path that parses HTML — so "did we escape that one?" is not a question that
 * can be asked about any particular field.
 *
 * This is not caution about a hypothetical. The strings on this page are: what
 * people typed into Discord, what web pages the agent fetched said, the
 * contents of files the agent read, and — once Osmosis Jones runs — the body of
 * pull requests opened by strangers. That is attacker-controlled input by any
 * definition. The page being private does not change what a script tag does
 * once it executes in the browser of the person who owns the host.
 *
 * The server's Content-Security-Policy (`default-src 'none'`, no
 * 'unsafe-inline') is the second layer, and the reason there is no inline
 * script or style anywhere in the HTML.
 *
 * Server-side redaction of credential-shaped strings is the third. All three
 * are cheap; none is sufficient alone.
 */

// ── DOM construction ────────────────────────────────────────────────────────

/**
 * Build an element.
 *
 * `attrs` sets properties, not raw attributes, and the two special-cased keys
 * are `class` and `dataset`. Anything in `children` that is not an element is
 * converted with String() and appended as a text node — which is what makes
 * this safe by construction rather than by discipline.
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') for (const [k, v] of Object.entries(value)) node.dataset[k] = v;
    else if (key === 'style') for (const [k, v] of Object.entries(value)) node.style[k] = v;
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const text = (tag, className, value) => el(tag, { class: className }, [value ?? '']);

// ── Formatting ──────────────────────────────────────────────────────────────

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours < 48) return `${hours}h ${minutes}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * "3m ago".
 *
 * Clamped at zero. The server already clamps its own age arithmetic, but this
 * one is computed against the *browser's* clock, which is a third clock and
 * can easily be a minute off the host's. "in 40 seconds" next to a liveness
 * dot reads as a broken page.
 */
function fmtAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  return `${fmtDuration(seconds)} ago`;
}

function fmtClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function fmtTimeOnly(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function fmtBytes(bytes) {
  if (typeof bytes !== 'number') return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtCount(value) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function fmtTokens(usage) {
  if (!usage) return '—';
  const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  if (total === 0) return '—';
  if (total < 1000) return String(total);
  return `${(total / 1000).toFixed(1)}k`;
}

/**
 * Cost, or an honest dash.
 *
 * The SDK-driven sessions on this host record token usage but carry no cost
 * field at all, so "$0.00" would be a fabrication. Null means the transcript
 * did not say; it does not mean free.
 */
function fmtCost(usage) {
  if (!usage || usage.costUsd === null || usage.costUsd === undefined) return '—';
  return `$${usage.costUsd.toFixed(2)}`;
}

const LIVENESS_WORD = {
  running: 'running',
  idle: 'idle',
  stale: 'stale',
  unknown: 'no data',
};

/** Dot plus word, always together — status colour never carries meaning alone. */
function liveness(state) {
  return el('span', { class: 'liveness', dataset: { state } }, [
    el('span', { class: 'liveness-dot' }),
    LIVENESS_WORD[state] ?? state,
  ]);
}

// ── Subagent-type colours ───────────────────────────────────────────────────

/**
 * Subagent TYPES get categorical slots in a FIXED order.
 *
 * Types, not roles. `general-purpose`, `Explore`, `workflow-subagent` — how a
 * subagent was spawned. Nothing coloured here is a crew role; the crew roles
 * are on the front page and are not a palette.
 *
 * The order is the colour-blind-safety property of the palette — adjacent
 * slots are the pairs validated for separation — so types are sorted and
 * assigned deterministically per session rather than in whatever order the
 * filesystem listed them. Two loads of the same session therefore paint the
 * same types the same colours, which matters when you are comparing a page you
 * left open to the one you just refreshed.
 *
 * Past eight types, everything else is one muted "other" colour. Generating a
 * ninth hue would produce a pair nobody validated.
 */
const SERIES = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
];
const OTHER_COLOR = '#898781';

function subagentTypeColors(types) {
  const ordered = [...new Set(types)].sort();
  const map = new Map();
  ordered.forEach((subagentType, index) => {
    map.set(subagentType, index < SERIES.length ? SERIES[index] : OTHER_COLOR);
  });
  return map;
}

/*
 * An empty `subagentType` means two DIFFERENT things depending on which view
 * produced it, so there are two labels and not one.
 *
 * The session view (`buildSessionDetail`) reads the sidecar AND the
 * `subagent_type` on the `Task` call that spawned it. Empty there means both
 * were silent — nothing recorded a type anywhere we look.
 *
 * The roll-up (`buildSubagentRollup`) reads the sidecar only, because the
 * spawning call lives in the parent transcript and reading it would mean
 * indexing, which that view is built not to do. Empty there means "no
 * sidecar", and the session view may well know the answer.
 *
 * Printing "type not recorded" for the second would be the page asserting
 * something it did not check — the same defect this whole change is about, one
 * layer down. Neither says "unknown": that word in a column of agent-ish
 * things reads as a missing value, and beside a page where `role` means
 * engineer or researcher it reads as a missing ROLE.
 */
const NO_TYPE_ANYWHERE = 'type not recorded';
const NO_TYPE_IN_SIDECAR = 'no sidecar';

/** For the swimlane, where both sources were tried. */
function laneTypeLabel(subagentType) {
  return subagentType || NO_TYPE_ANYWHERE;
}

/** For the roll-up, where only the sidecar was read. */
function rollupTypeLabel(subagentType) {
  return subagentType || NO_TYPE_IN_SIDECAR;
}

// ── API ─────────────────────────────────────────────────────────────────────

async function api(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({ error: 'unreadable response' }));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// ── Tooltip ─────────────────────────────────────────────────────────────────

const tooltip = document.getElementById('tooltip');

function attachTooltip(node, rows) {
  const show = (event) => {
    const list = el('dl');
    for (const [label, value] of rows) {
      if (value === null || value === undefined || value === '') continue;
      list.append(el('dt', {}, [label]), el('dd', {}, [value]));
    }
    tooltip.replaceChildren(list);
    tooltip.hidden = false;
    move(event);
  };
  const move = (event) => {
    // Flip before the viewport edge rather than after, so a tooltip on a bar
    // near the right-hand end of the time axis stays on screen.
    const box = tooltip.getBoundingClientRect();
    const x = event.clientX + 14 + box.width > window.innerWidth
      ? event.clientX - box.width - 14
      : event.clientX + 14;
    const y = Math.min(event.clientY + 14, window.innerHeight - box.height - 8);
    tooltip.style.left = `${Math.max(8, x)}px`;
    tooltip.style.top = `${Math.max(8, y)}px`;
  };
  node.addEventListener('mouseenter', show);
  node.addEventListener('mousemove', move);
  node.addEventListener('mouseleave', () => {
    tooltip.hidden = true;
  });
}

// ── Views ───────────────────────────────────────────────────────────────────

const main = document.getElementById('main');

function crumbs(parts) {
  const bar = el('nav', { class: 'crumbs' });
  parts.forEach((part, index) => {
    if (index > 0) bar.append(el('span', { class: 'sep' }));
    bar.append(part.href ? el('a', { href: part.href }, [part.label]) : el('span', {}, [part.label]));
  });
  return bar;
}

function tile(label, value, sub) {
  return el('div', { class: 'tile' }, [
    text('div', 'tile-label', label),
    text('div', 'tile-value', value),
    sub ? text('div', 'tile-sub', sub) : null,
  ]);
}

/**
 * The crew role of one registry row, as a chip.
 *
 * `role` is the registry's column — coordinator, engineer, researcher, poster,
 * updater, host — and this is the only place on the page that renders a word under the
 * heading "Role". Nothing derives it, nothing falls back to a `subagent_type`,
 * and a row that has none says so in words rather than showing a blank cell or
 * borrowing "unknown" from somewhere it would look like a value.
 */
function roleChip(role) {
  if (!role) {
    return el('span', { class: 'chip', dataset: { absent: 'true' } }, [
      'no role in the registry',
    ]);
  }
  return el('span', { class: 'chip', dataset: { role } }, [role]);
}

/**
 * The front page: every crew agent on this host, by crew role.
 *
 * ── What this used to be ───────────────────────────────────────────────────
 *
 * Two cards, "Clawcius" and "Hamachi", under a heading reading "Agents on this
 * host". Those are containers, not agents; the roles were a click away and the
 * only words on the page that looked like an agent's type were a subagent's —
 * `general-purpose`, `Explore`, `workflow-subagent`. The operator asked to see
 * "the types of agents, so like engineer or researcher", which is the registry
 * column those three words are not.
 *
 * So the page is now the registry's rows, grouped by the instance they belong
 * to, with the role in a column of its own. The instance survives as a
 * grouping and keeps its own warnings — an unreadable board has to be visible
 * next to the crew it emptied — but it is no longer the thing being listed.
 *
 * ── Why there are no subagents on it ───────────────────────────────────────
 *
 * Because a subagent is not an agent that happens to be small. It has no
 * registry row, no mailbox, no persistence, and it dies with its parent;
 * CLAWSKY.md's rule is that it inherits its parent's identity and "is an
 * extension of the named agent". Listing one here would file part of an
 * engineer as a colleague of that engineer, and give it a column headed Role
 * that it can never have a value for.
 *
 * They are not deleted and they are not hidden. Their transcripts hang off the
 * agent that spawned them, one click down, and the whole-instance roll-up that
 * reaches every one of them — including the 58 that #80 found in
 * `subagents/workflows/<runId>/` — is still one link from the instance page.
 */
async function viewOverview() {
  const data = await api('/api/overview');
  const frag = document.createDocumentFragment();

  frag.append(
    el('h1', {}, ['Agents on this host']),
    text(
      'p',
      'subtitle',
      `running ≤ ${fmtDuration(data.liveness.runningSeconds)} since last write · ` +
        `stale beyond ${fmtDuration(data.liveness.idleSeconds)} · ` +
        `generated ${fmtClock(data.generatedAt)}`,
    ),
  );

  const instances = data.instances;
  const allAgents = instances.flatMap((instance) => instance.agents);
  const runningAgents = allAgents.filter((agent) => agent.liveness === 'running').length;
  const sessions = instances.reduce((sum, instance) => sum + instance.sessionCount, 0);
  const registered = instances.reduce((sum, instance) => sum + instance.registeredAgentCount, 0);
  const declaredLive = instances.reduce((sum, instance) => sum + instance.declaredLiveCount, 0);
  const unattributed = instances.reduce(
    (sum, instance) => sum + instance.unattributedSessionCount,
    0,
  );

  // Instances whose registry could not be read, or that have none configured.
  // Their agents are not counted in the tiles and every one of their sessions
  // falls into "unattributable", so a tile that did not say so would be the
  // "empty roster reads as a host with no agents" failure this page is built
  // to avoid — in the one place that summarises everything.
  const blind = instances.filter(
    (instance) => instance.registryError || !instance.registryConfigured,
  );
  const blindNote = blind.length > 0 ? ` · ${blind.length} instance(s) not counted` : '';

  frag.append(
    el('div', { class: 'tiles' }, [
      // Agents come from the registry; instances are the configured roots.
      // Conflating the two is what made this page report 49 of something.
      tile(
        'Agents',
        blind.length === instances.length ? '—' : fmtCount(registered),
        `${declaredLive} declared live${blindNote || ' · across all crews'}`,
      ),
      // Observed, beside the declared number above, and never instead of it.
      tile('Writing now', fmtCount(runningAgents), 'transcript written in the running window'),
      tile('Crews', String(instances.length), 'one container each'),
      tile(
        'Sessions',
        fmtCount(sessions),
        blind.length > 0
          ? `${unattributed} unattributed, including every session of ${blind.length} instance(s)`
          : `${unattributed} not attributable to an agent`,
      ),
    ]),
  );

  for (const instance of blind) {
    frag.append(
      text(
        'div',
        'warning-row',
        instance.registryError ??
          `${instance.label} has no boardDb in status-config.yaml, so it has no registry here ` +
            'and none of its agents are counted above.',
      ),
    );
  }

  for (const instance of instances) {
    frag.append(
      el('h2', {}, [
        instance.label,
        el('span', { class: 'h2-note' }, [
          `${instance.agents.length} agent(s) · ${fmtCount(instance.sessionCount)} session(s), ` +
            `${fmtCount(instance.activeSessionCount)} written recently`,
        ]),
      ]),
      // The instance's own liveness and root, kept because they are facts
      // about the container rather than about any one agent — an instance
      // whose whole root has gone quiet is a different problem from an idle
      // engineer, and the path is what you need to go and look.
      el('div', { class: 'instance-line' }, [
        liveness(instance.liveness),
        text('span', 'card-path mono', instance.projectsRoot),
      ]),
    );

    if (instance.error) frag.append(text('div', 'warning-row', instance.error));
    if (instance.registryError) {
      frag.append(text('div', 'warning-row', 'Registry unreadable — see above.'));
    } else if (!instance.registryConfigured) {
      frag.append(
        text(
          'div',
          'warning-row',
          'No boardDb configured for this instance, so there is no registry to list its agents ' +
            'from. Its transcript directories are under the instance page.',
        ),
      );
    }

    if (instance.agents.length === 0) {
      frag.append(
        text(
          'p',
          'placeholder',
          instance.registryConfigured && !instance.registryError
            ? 'This instance has a readable registry with no agents in it.'
            : 'No agents can be listed for this instance.',
        ),
      );
    } else {
      frag.append(agentTable(instance));
    }

    frag.append(
      el('div', { class: 'chips' }, [
        el('a', { class: 'chip', href: `#/agent/${encodeURIComponent(instance.id)}` }, [
          'Sessions and unclaimed directories →',
        ]),
        // The whole-instance roll-up, linked from the front page as well as
        // from the instance page. Subagents are off this list, and "off the
        // list" has to keep meaning "one link away" — a directory nothing
        // links to is how #80 happened.
        el('a', { class: 'chip', href: `#/subagents/${encodeURIComponent(instance.id)}` }, [
          'All subagent transcripts →',
        ]),
      ]),
    );
  }

  main.replaceChildren(frag);
}

/** One instance's registry rows: id, crew role, and both kinds of aliveness. */
function agentTable(instance) {
  const table = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', {}, ['Agent']),
        el('th', {}, ['Role']),
        el('th', {}, ['Crew']),
        el('th', {}, ['State']),
        el('th', {}, ['Declared']),
        el('th', {}, ['Sessions']),
        el('th', {}, ['Last write']),
        el('th', {}, ['Last spoke']),
      ]),
    ]),
  ]);

  const body = el('tbody');
  for (const agent of instance.agents) {
    body.append(
      el('tr', {}, [
        el('td', { class: 'strong' }, [
          el(
            'a',
            {
              class: 'mono',
              href:
                `#/agent/${encodeURIComponent(instance.id)}/` +
                `${encodeURIComponent(agent.projectSlug)}`,
            },
            [agent.id],
          ),
        ]),
        el('td', {}, [roleChip(agent.role)]),
        el('td', {}, [agent.crew]),
        // Two columns, not one, and this is the reason. `State` is observed —
        // a file was written N seconds ago. `Declared` is the registry's
        // `status`, which a kill writes and a crash does not, so it can say
        // `live` about a process that is gone. Living and dead stay
        // distinguishable only while both are on the row.
        el('td', {}, [liveness(agent.liveness)]),
        el('td', {}, [
          el('span', { class: 'declared-word', dataset: { status: agent.declaredStatus } }, [
            agent.declaredStatus || 'not recorded',
          ]),
        ]),
        el('td', { class: 'num' }, [fmtCount(agent.sessionCount)]),
        el('td', {}, [fmtAgo(agent.lastActivity)]),
        el('td', {}, [fmtAgo(agent.lastActiveAt)]),
      ]),
    );
  }

  table.append(body);
  return el(
    'div',
    { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Agents' },
    [table],
  );
}

/**
 * The session table, used for a registry agent's sessions and for the
 * unattributed ones alike.
 *
 * `currentSessionId` marks the one the registry says this agent is resuming.
 * Without the marker the top row is only "the file written most recently",
 * which is a different claim and is wrong whenever a subagent of an older
 * session wrote last.
 */
function sessionTable(agentId, sessions, currentSessionId) {
  const table = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', {}, ['Session']),
        el('th', {}, ['State']),
        el('th', {}, ['Started']),
        el('th', {}, ['Duration']),
        el('th', {}, ['Turns']),
        el('th', {}, ['Tools']),
        el('th', {}, ['Subagents']),
        el('th', {}, ['Tokens']),
        el('th', {}, ['Cost']),
        el('th', {}, ['Size']),
        el('th', {}, ['Last activity']),
      ]),
    ]),
  ]);

  const body = el('tbody');
  for (const session of sessions) {
    const link = el(
      'a',
      {
        href: `#/session/${encodeURIComponent(agentId)}/${encodeURIComponent(session.sessionId)}`,
        class: 'mono',
      },
      [session.sessionId.slice(0, 8)],
    );

    const first = el('td', { class: 'strong' }, [link]);
    if (currentSessionId && session.sessionId === currentSessionId) {
      first.append(el('span', { class: 'tag', dataset: { current: 'true' } }, ['current']));
    }
    if (session.gitBranch) first.append(el('div', { class: 'mono' }, [session.gitBranch]));

    const row = el('tr', {}, [
      first,
      el('td', {}, [liveness(session.liveness)]),
      el('td', {}, [fmtClock(session.startedAt)]),
      el('td', { class: 'num' }, [fmtDuration(session.durationSeconds)]),
      el('td', { class: 'num' }, [fmtCount(session.assistantTurns)]),
      el('td', { class: 'num' }, [fmtCount(session.toolCalls)]),
      el('td', { class: 'num' }, [fmtCount(session.subagentCount)]),
      el('td', { class: 'num' }, [fmtTokens(session.usage)]),
      el('td', { class: 'num' }, [fmtCost(session.usage)]),
      el('td', { class: 'num' }, [fmtBytes(session.sizeBytes)]),
      el('td', {}, [fmtAgo(session.lastActivity)]),
    ]);

    if (session.malformedLines > 0) {
      row.lastChild.append(
        el('div', { class: 'truncated' }, [`${session.malformedLines} malformed line(s)`]),
      );
    }
    body.append(row);
  }

  table.append(body);

  // Wrapped, because these tables now live INSIDE an agent's card and eleven
  // columns of session stats do not fit in a phone. Unwrapped, the table's
  // min-content width wins: at 380px it rendered straight through the card's
  // border and set the width of the whole document, so every other element on
  // the page sat in a 380px column beside a 900px scroll region. The wrapper
  // takes the width it is given and scrolls inside itself instead.
  //
  // `tabindex` and `role` are what make that scroll region reachable without a
  // mouse. A div with overflow and no focusable child is a part of the page a
  // keyboard cannot get to in every browser, and the columns that end up off
  // the right edge here are tokens, cost and last activity — not decoration.
  return el(
    'div',
    { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Sessions' },
    [table],
  );
}

/**
 * Declared status and last-active, always together.
 *
 * `status` in the registry is written, never observed — a kill writes `dead`,
 * and an agent that died mid-turn writes nothing at all. Today nothing writes
 * `dead` even in principle, because kill is CLAWSKY.md phase 5, so the word on
 * its own would be the same on every row forever. Beside "last spoke 4m ago"
 * it reads correctly now and stays correct the day spawn/kill lands.
 */
function declaredStatus(agent) {
  return el('span', { class: 'declared' }, [
    el('span', { class: 'declared-word', dataset: { status: agent.declaredStatus } }, [
      agent.declaredStatus || 'unknown',
    ]),
    el('span', { class: 'declared-sep' }, ['·']),
    `last spoke ${fmtAgo(agent.lastActiveAt)}`,
  ]);
}

/**
 * One registry agent's card: who it is, its crew role, and its sessions.
 *
 * Shared by the instance roster and by the per-agent page, so the two cannot
 * drift into telling different stories about the same row.
 */
function agentCard(instanceId, agent) {
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('div', { class: 'card-head-left' }, [
        text('span', 'card-title mono', agent.id),
        roleChip(agent.role),
        el('span', { class: 'chip' }, [agent.crew]),
      ]),
      liveness(agent.liveness),
    ]),
    el('div', { class: 'card-sub' }, [declaredStatus(agent)]),
    text('div', 'card-path mono', `${agent.workspacePath}  →  ${agent.projectSlug}`),
  ]);

  const chips = el('div', { class: 'chips' });
  if (agent.spawnedBy) chips.append(el('span', { class: 'chip' }, [`spawned by ${agent.spawnedBy}`]));

  // This agent's subagents, and the sentence that says whose they are. A
  // subagent inherits its parent's identity, so the transcripts of the ones
  // this agent spawned are this agent's work — which is why the link lives on
  // its card and not on a list of agents.
  chips.append(
    agent.subagentCount > 0
      ? el(
          'a',
          {
            class: 'chip',
            href:
              `#/subagents/${encodeURIComponent(instanceId)}/` +
              `${encodeURIComponent(agent.projectSlug)}`,
          },
          [`${fmtCount(agent.subagentCount)} subagent transcript(s) →`],
        )
      // "None here", and nothing about why. It read "this role has no subagent
      // tool" for a coordinator or poster, which CLAWSKY.md does say — under
      // phase 5, unmarked, while phase 6 is Done — but there is no
      // `disallowedTools`, `allowedTools` or `canUseTool` anywhere in `src/`
      // today. So it was the page stating as mechanism something that is
      // currently prompt text. It could only render at a count of zero, so it
      // never visibly contradicted itself; that makes it the kind of wrong
      // sentence that survives, not the kind that gets caught.
      : el('span', { class: 'chip', dataset: { absent: 'true' } }, [
          'no subagent transcripts',
        ]),
  );
  card.append(chips);

  if (agent.sessions.length > 0) {
    card.append(sessionTable(instanceId, agent.sessions, agent.sessionId));
  } else {
    // What this says is what it can check. The previous copy concluded "it
    // has not run a turn", which this page has no way of knowing and which
    // is false today for both boards on this host: `<crew>-host` has a
    // registry row whose `last_active_at` the ops daemon stamps on every
    // boot, so the card said "last spoke 4m ago" directly above "it has not
    // run a turn". Its transcripts are real and are written by root under a
    // different config dir entirely.
    //
    // So: report the absence, which is true and checkable, and let the
    // reason be a separate sentence that only claims what is known.
    card.append(
      text(
        'p',
        'placeholder',
        `No transcripts under this instance's projects root for ${agent.projectSlug}.`,
      ),
    );
    card.append(
      text(
        'p',
        'placeholder',
        agent.role === 'host'
          ? 'The host agent runs on the VPS itself rather than in this instance\'s container, ' +
            'and writes its sessions outside every projects root this page reads. Expect this ' +
            'card to have no transcripts however busy it is; its last-active time above is the ' +
            'board\'s own record and is the honest signal for it.'
          : 'It has an identity and a mailbox here. Whether it has ever run is not something ' +
            'this page can see from an empty directory.',
      ),
    );
  }

  // Outside the branch above, not inside it. A row with a session id and no
  // matching transcripts is the registry's own record that the agent DID run
  // — so it is exactly the case that must not be told it has not — and it is
  // also what this whole page degrades into if the slug join ever stops
  // matching. Having the contradiction visible on the card is the difference
  // between finding that out here and finding it out from a page confidently
  // reporting that every agent has never run.
  if (agent.sessionId && !agent.currentSessionPresent) {
    card.append(
      text(
        'div',
        'warning-row',
        `The registry says this agent resumes session ${agent.sessionId.slice(0, 8)}, and no ` +
          `transcript with that id is under ${agent.projectSlug}. ` +
          (agent.sessions.length === 0
            ? 'It has no transcripts there at all — if that is true of every agent here, the ' +
              'slug join has stopped matching and the sessions are under "other" below.'
            : 'Its other sessions are listed above.'),
      ),
    );
  }
  return card;
}

/**
 * One instance: its agents from the registry, then everything else. With
 * `slug`, one agent of that instance on its own.
 *
 * The list is NOT the directories under the projects root. That was Clawcius
 * #14 — Clawcius showed 49 of them, and three of Hamachi's five were `/tmp`
 * paths where an engineer ran permission probes. Those still appear, under
 * "Other transcripts", because they are real and readable; they are just not
 * agents.
 *
 * The `slug` form is filtered from the same response rather than fetched from
 * a narrower endpoint. That keeps one shape of data on this page, and it means
 * a slug that matches nothing renders a page that can say what it looked for
 * and what the instance actually has — rather than a 404 that cannot.
 */
async function viewAgent(agentId, slug = null) {
  const data = await api(`/api/agents/${encodeURIComponent(agentId)}/sessions`);
  const frag = document.createDocumentFragment();

  if (slug !== null) return viewOneAgent(agentId, slug, data, frag);

  const otherSessions = data.other.reduce((sum, group) => sum + group.sessions.length, 0);

  frag.append(
    crumbs([{ label: 'Agents', href: '#/overview' }, { label: data.label }]),
    el('h1', {}, [data.label]),
    text(
      'p',
      'subtitle',
      `${data.agents.length} agent(s) in the registry · ${data.sessionCount} session(s) on disk · ` +
        `${otherSessions} not attributable to an agent`,
    ),
  );

  frag.append(
    el('div', { class: 'chips' }, [
      // Unscoped, and it stays unscoped. Every subagent transcript under this
      // root is reachable through this one link whether or not any registry
      // row claims the directory it sits in — which is the property #80 was
      // about, and the per-agent links below cannot provide on their own
      // because three of the five directories here belong to no agent.
      el('a', { class: 'chip', href: `#/subagents/${encodeURIComponent(agentId)}` }, [
        'All subagent transcripts →',
      ]),
    ]),
  );

  if (data.error) frag.append(text('div', 'warning-row', data.error));
  if (data.registryError) frag.append(text('div', 'warning-row', data.registryError));
  if (!data.registryConfigured) {
    frag.append(
      text(
        'div',
        'warning-row',
        'No boardDb configured for this instance in status-config.yaml, so there is no registry ' +
          'to list agents from — only the directories below.',
      ),
    );
  }

  if (data.agents.length === 0 && data.other.length === 0) {
    frag.append(text('p', 'placeholder', 'No agents and no sessions under this root yet.'));
    main.replaceChildren(frag);
    return;
  }

  if (data.agents.length > 0) {
    frag.append(
      el('h2', {}, ['Agents']),
      text(
        'p',
        'subtitle',
        'From the registry — id, crew and role as the board knows them. `status` is declared, ' +
          'not observed, so it is shown beside the time the agent last spoke.',
      ),
    );
  }

  for (const agent of data.agents) {
    frag.append(agentCard(data.agent, agent));
  }

  if (data.other.length > 0) {
    frag.append(
      el('h2', {}, ['Other transcripts']),
      text(
        'p',
        'subtitle',
        'Project directories no registry row claims. Real transcripts, still readable — a cwd ' +
          'somebody ran Claude Code in, not an agent with an identity.',
      ),
    );

    for (const group of data.other) {
      const subagents = group.sessions.reduce(
        (sum, session) => sum + session.subagentCount,
        0,
      );
      frag.append(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            text('span', 'card-title mono', group.projectSlug),
            liveness(group.liveness),
          ]),
          // These directories get the same scoped link an agent's card gets.
          // They have no agent to hang off, which is exactly why they need
          // their own way in: a subagent transcript reachable only through the
          // agent that owns the directory is unreachable when nobody does.
          el('div', { class: 'chips' }, [
            subagents > 0
              ? el(
                  'a',
                  {
                    class: 'chip',
                    href:
                      `#/subagents/${encodeURIComponent(data.agent)}/` +
                      `${encodeURIComponent(group.projectSlug)}`,
                  },
                  [`${fmtCount(subagents)} subagent transcript(s) →`],
                )
              : el('span', { class: 'chip', dataset: { absent: 'true' } }, [
                  'no subagent transcripts',
                ]),
          ]),
          sessionTable(data.agent, group.sessions, null),
        ]),
      );
    }
  }

  main.replaceChildren(frag);
}

/**
 * One agent of one instance, reached from the front page.
 *
 * This is where a subagent goes once it is off the list of agents: under the
 * agent whose identity it borrowed. The card carries its own link to that
 * agent's subagent transcripts, and this page carries the unscoped one as
 * well, so no path here is a dead end for a transcript that exists.
 *
 * A slug that matches no registry row is answered, not 404'd. The registry and
 * the transcript directories are two different lists and they are allowed to
 * disagree; when they do, the page says which one it is showing rather than
 * implying the agent was deleted.
 */
function viewOneAgent(instanceId, slug, data, frag) {
  const agent = data.agents.find((row) => row.projectSlug === slug);

  frag.append(
    crumbs([
      { label: 'Agents', href: '#/overview' },
      { label: data.label, href: `#/agent/${encodeURIComponent(instanceId)}` },
      { label: agent ? agent.id : slug },
    ]),
  );

  if (!agent) {
    frag.append(
      el('h1', {}, ['No such agent']),
      text(
        'div',
        'warning-row',
        `No agent in ${data.label}'s registry has ${slug} as its transcript directory. ` +
          (data.registryError
            ? 'The registry could not be read at all, so this may be a real agent — see below.'
            : `The registry has ${data.agents.length} agent(s); this page lists them.`),
      ),
    );
    if (data.registryError) frag.append(text('div', 'warning-row', data.registryError));
    frag.append(
      el('div', { class: 'chips' }, [
        el('a', { class: 'chip', href: `#/agent/${encodeURIComponent(instanceId)}` }, [
          `All of ${data.label} →`,
        ]),
        // Offered even here. If the slug is a real directory with no registry
        // row — the `/tmp` probe case — its transcripts are still on disk and
        // this is the link that reaches them.
        el(
          'a',
          {
            class: 'chip',
            href: `#/subagents/${encodeURIComponent(instanceId)}/${encodeURIComponent(slug)}`,
          },
          [`Subagent transcripts under ${slug} →`],
        ),
      ]),
    );
    main.replaceChildren(frag);
    return;
  }

  frag.append(
    el('h1', {}, [agent.id]),
    text(
      'p',
      'subtitle',
      `${agent.role || 'no role recorded'} · ${agent.crew} · ` +
        `${agent.sessions.length} session(s) on disk`,
    ),
  );

  frag.append(agentCard(instanceId, agent));

  frag.append(
    el('div', { class: 'chips' }, [
      el('a', { class: 'chip', href: `#/agent/${encodeURIComponent(instanceId)}` }, [
        `All of ${data.label} →`,
      ]),
      el('a', { class: 'chip', href: `#/subagents/${encodeURIComponent(instanceId)}` }, [
        'All subagent transcripts on this instance →',
      ]),
    ]),
  );

  main.replaceChildren(frag);
}

/** Depth-first flatten, so the tree draws as ordered lanes. */
function flattenTree(nodes, out = []) {
  for (const node of nodes) {
    out.push(node);
    flattenTree(node.children, out);
  }
  return out;
}

async function viewSession(agentId, sessionId) {
  const data = await api(
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
  );
  const frag = document.createDocumentFragment();

  frag.append(
    crumbs([
      { label: 'Agents', href: '#/overview' },
      { label: agentId, href: `#/agent/${encodeURIComponent(agentId)}` },
      { label: sessionId.slice(0, 8) },
    ]),
    el('h1', {}, [`Session ${sessionId.slice(0, 8)}`]),
    text('p', 'subtitle', data.cwd ?? ''),
  );

  frag.append(
    el('div', { class: 'tiles' }, [
      tile('State', LIVENESS_WORD[data.liveness] ?? data.liveness, fmtAgo(data.lastActivity)),
      tile('Duration', fmtDuration(data.durationSeconds), fmtClock(data.startedAt)),
      tile('Turns', fmtCount(data.assistantTurns), `${fmtCount(data.toolCalls)} tool calls`),
      tile('Subagents', fmtCount(data.subagentCount), `${fmtBytes(data.sizeBytes)} parent`),
      tile('Tokens', fmtTokens(data.usage), fmtCost(data.usage) === '—' ? 'no cost recorded' : fmtCost(data.usage)),
    ]),
  );

  frag.append(
    el('div', { class: 'chips' }, [
      el(
        'a',
        {
          class: 'chip',
          href: `#/transcript/${encodeURIComponent(agentId)}/${encodeURIComponent(sessionId)}`,
        },
        ['Open transcript →'],
      ),
      data.model ? el('span', { class: 'chip' }, [data.model]) : null,
      data.gitBranch ? el('span', { class: 'chip' }, [`branch ${data.gitBranch}`]) : null,
      data.malformedLines > 0
        ? el('span', { class: 'chip' }, [`${data.malformedLines} malformed line(s)`])
        : null,
    ]),
  );

  frag.append(el('h2', {}, ['Subagent branching']));

  const all = [...flattenTree(data.subagents), ...flattenTree(data.orphans)];
  if (all.length === 0) {
    frag.append(
      text('p', 'placeholder', 'This session spawned no subagents. Everything happened in the main thread.'),
    );
  } else {
    frag.append(renderLanes(data, all, agentId, sessionId));
  }

  main.replaceChildren(frag);
}

/**
 * The swimlane.
 *
 * One row per subagent, indented by tree depth, with a bar spanning its start
 * to its end on a shared time axis. Time is on the x-axis because that is the
 * question this view answers — what ran at the same time as what, and where
 * the run actually spent its wall clock. A pure indented tree hides exactly
 * that.
 *
 * Bars are positioned as percentages of the session span rather than in
 * pixels, so the whole thing reflows with the window without recomputation.
 */
function renderLanes(detail, nodes, agentId, sessionId) {
  const spanStart = Date.parse(detail.spanStart ?? detail.startedAt ?? '') || Date.now();
  let spanEnd = Date.parse(detail.spanEnd ?? detail.endedAt ?? '') || spanStart + 1000;
  // A zero-width span — a session whose every timestamp is identical, or one
  // with a single instant recorded — would make every bar `width: Infinity%`.
  if (spanEnd <= spanStart) spanEnd = spanStart + 1000;
  const spanMs = spanEnd - spanStart;

  const colors = subagentTypeColors(nodes.map((node) => node.subagentType));
  const lanes = el('div', { class: 'lanes' });

  // Eight ticks, matching the eight background grid columns of every track, so
  // labels and gridlines line up.
  const axis = el('div', { class: 'lane-axis' });
  for (let i = 0; i <= 8; i += 1) {
    const at = spanStart + (spanMs * i) / 8;
    axis.append(
      el(
        'span',
        { class: 'axis-tick', style: { left: `${(i / 8) * 100}%` } },
        [fmtTimeOnly(new Date(at).toISOString())],
      ),
    );
  }
  lanes.append(axis);

  for (const node of nodes) {
    const color = colors.get(node.subagentType) ?? OTHER_COLOR;
    const startMs = Date.parse(node.startedAt ?? '') || spanStart;
    const endMs = Date.parse(node.endedAt ?? '') || startMs;

    const left = ((startMs - spanStart) / spanMs) * 100;
    // A floor on width so an instant subagent — one that failed immediately —
    // is still a visible mark rather than a zero-pixel nothing.
    const width = Math.max(0.6, ((endMs - startMs) / spanMs) * 100);

    const bar = el('div', {
      class: 'lane-bar',
      dataset: { active: String(node.active) },
      style: {
        left: `${Math.max(0, Math.min(99.4, left))}%`,
        width: `${Math.min(100 - Math.max(0, Math.min(99.4, left)), width)}%`,
        background: color,
      },
    });

    attachTooltip(bar, [
      ['subagent type', laneTypeLabel(node.subagentType)],
      ['task', node.description],
      ['started', fmtClock(node.startedAt)],
      ['ended', node.active ? 'still running' : fmtClock(node.endedAt)],
      ['duration', fmtDuration(node.durationSeconds)],
      ['turns', `${fmtCount(node.assistantTurns)} · ${fmtCount(node.toolCalls)} tool calls`],
      ['transcript', fmtBytes(node.sizeBytes)],
      ['linkage', node.linkage],
      ['workflow', node.workflowName ?? node.workflowRunId],
      ['agent id', node.agentId],
    ]);

    const label = el('div', {
      class: 'lane-label',
      style: { paddingLeft: `${(node.depth - 1) * 14}px` },
    });
    label.append(
      el('span', { class: 'lane-swatch', style: { background: color } }),
      el(
        'a',
        {
          class: 'lane-type',
          href:
            `#/transcript/${encodeURIComponent(agentId)}/${encodeURIComponent(sessionId)}` +
            `/${encodeURIComponent(node.agentId)}`,
        },
        [laneTypeLabel(node.subagentType)],
      ),
      // A workflow subagent carries no description; the run's name is what it
      // was for, and an anonymous bar is what this view exists not to draw.
      text(
        'span',
        'lane-desc',
        node.description || (node.workflowName ? `run ${node.workflowName}` : node.agentId),
      ),
    );
    if (node.linkage === 'orphan') {
      label.append(el('span', { class: 'tag', dataset: { linkage: 'orphan' } }, ['unlinked']));
    }

    lanes.append(el('div', { class: 'lane' }, [label, el('div', { class: 'lane-track' }, [bar])]));
  }

  // Legend for identity, always — the row labels already name each subagent
  // type in text, so colour is never the only channel, but the legend makes
  // the type→colour mapping readable at a glance across many rows.
  const legend = el('div', { class: 'legend' });
  for (const [subagentType, color] of colors) {
    legend.append(
      el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-swatch', style: { background: color } }),
        laneTypeLabel(subagentType),
      ]),
    );
  }
  lanes.append(legend);
  return lanes;
}

// ── Transcript ──────────────────────────────────────────────────────────────

function renderBlock(block) {
  if (block.kind === 'text' || block.kind === 'thinking') {
    return el('div', { class: `block block-${block.kind}` }, [
      text('div', 'block-prose', block.text),
      block.truncated ? el('span', { class: 'truncated' }, ['… truncated'] ) : null,
    ]);
  }

  if (block.kind === 'tool_use') {
    return el('div', { class: 'block' }, [
      el('div', { class: 'tool' }, [
        el('div', { class: 'tool-head' }, [
          'tool call',
          el('span', { class: 'tool-name' }, [block.name]),
        ]),
        text('pre', 'tool-body', block.input),
      ]),
      block.truncated ? el('span', { class: 'truncated' }, ['… truncated']) : null,
    ]);
  }

  if (block.kind === 'tool_result') {
    return el('div', { class: 'block' }, [
      el('div', { class: 'tool', dataset: { error: String(block.isError) } }, [
        el('div', { class: 'tool-head' }, [block.isError ? 'tool error' : 'tool result']),
        text('pre', 'tool-body', block.text),
      ]),
      block.truncated ? el('span', { class: 'truncated' }, ['… truncated']) : null,
    ]);
  }

  return el('div', { class: 'block' }, [
    el('div', { class: 'tool' }, [
      el('div', { class: 'tool-head' }, [block.label]),
      text('pre', 'tool-body', block.text),
    ]),
  ]);
}

function renderEntry(entry) {
  const node = el('article', {
    class: 'entry',
    dataset: { role: entry.role ?? '', type: entry.type },
  });

  node.append(
    el('div', { class: 'entry-head' }, [
      el('span', { class: 'entry-role' }, [entry.role ?? entry.type]),
      el('span', {}, [fmtClock(entry.ts)]),
      el('span', {}, [`#${entry.n}`]),
    ]),
  );

  if (entry.summary) node.append(text('div', 'block-prose', entry.summary));
  for (const block of entry.blocks) node.append(renderBlock(block));
  return node;
}

async function viewTranscript(agentId, sessionId, subagentId) {
  const base =
    `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/transcript`;
  const query = subagentId ? `?subagent=${encodeURIComponent(subagentId)}` : '';
  const first = await api(`${base}${query}`);

  const frag = document.createDocumentFragment();
  frag.append(
    crumbs([
      { label: 'Agents', href: '#/overview' },
      { label: agentId, href: `#/agent/${encodeURIComponent(agentId)}` },
      {
        label: sessionId.slice(0, 8),
        href: `#/session/${encodeURIComponent(agentId)}/${encodeURIComponent(sessionId)}`,
      },
      { label: subagentId ? `subagent ${subagentId.slice(0, 8)}` : 'transcript' },
    ]),
    el('h1', {}, [subagentId ? 'Subagent transcript' : 'Session transcript']),
    text('p', 'subtitle', `${fmtCount(first.total)} lines`),
  );

  const list = el('div');
  frag.append(list);

  // Paged rather than dumped. The largest transcript on this host is 1.8 MB in
  // one file and the largest session directory is 4.3 MB; putting that in the
  // DOM at once is seconds of layout and hundreds of megabytes of nodes.
  const pager = el('div', { class: 'pager' });
  const more = el('button', { type: 'button' }, ['Load more']);
  const progress = el('span');
  pager.append(more, progress);
  frag.append(pager);

  let shown = 0;
  let next = null;

  const absorb = (page) => {
    for (const entry of page.entries) list.append(renderEntry(entry));
    shown += page.entries.length;
    next = page.nextFrom;
    progress.replaceChildren(document.createTextNode(`${shown} of ${fmtCount(page.total)} lines`));
    more.disabled = next === null;
    if (next === null) more.replaceChildren(document.createTextNode('End of transcript'));
  };

  more.addEventListener('click', async () => {
    if (next === null) return;
    more.disabled = true;
    try {
      const separator = query ? '&' : '?';
      absorb(await api(`${base}${query}${separator}from=${next}`));
    } catch (error) {
      progress.replaceChildren(document.createTextNode(String(error.message ?? error)));
      more.disabled = false;
    }
  });

  absorb(first);
  main.replaceChildren(frag);
}

// ── Subagents ───────────────────────────────────────────────────────────────

/**
 * Every subagent an instance has run, grouped by `subagent_type` — or one
 * agent's, when `slug` scopes it.
 *
 * ── The page this is, and the page it is not ───────────────────────────────
 *
 * The session view draws one run's tree over a time axis and answers "what
 * happened here". It cannot answer "where is the transcript of the thing that
 * died at 4am" unless you already know which session it belonged to — which is
 * Clawcius #22, and is what this list is for. Types are ordered by count
 * because "what does this system spend its subagents on" is the question you
 * arrive with; within a type, newest first, because the next question is
 * always "what was the last one doing".
 *
 * It is NOT a list of agents, and the heading used to say "By role", which
 * made it look like one. A subagent has no crew role: it has no registry row
 * to carry one, it shares its parent's identity and it dies with its parent.
 * What it has is a `subagent_type` — the argument its parent passed when it
 * spawned it — and that is what is grouped here, under that name.
 *
 * The UNSCOPED form of this page is the one that reaches everything. Scoped to
 * an agent it shows that agent's; scoped to a directory no agent claims it
 * shows that directory's and says so. Both are filters over the same walk, so
 * "reachable from here" does not depend on the registry being right.
 */
async function viewSubagents(agentId, slug = null) {
  const query = slug === null ? '' : `?slug=${encodeURIComponent(slug)}`;
  const data = await api(`/api/agents/${encodeURIComponent(agentId)}/subagents${query}`);
  const frag = document.createDocumentFragment();

  frag.append(
    crumbs([
      { label: 'Agents', href: '#/overview' },
      { label: data.label, href: `#/agent/${encodeURIComponent(agentId)}` },
      { label: slug === null ? 'Subagents' : `Subagents of ${slug}` },
    ]),
    el('h1', {}, ['Subagents']),
    text(
      'p',
      'subtitle',
      (slug === null
        ? `Every subagent transcript under ${data.label}. `
        : `Scoped to ${slug}. `) +
        `${fmtCount(data.total)} transcript(s) across ${data.types.length} subagent type(s) · ` +
        `${fmtCount(data.fromWorkflows)} from workflow runs`,
    ),
    text(
      'p',
      'subtitle',
      'A subagent type is how the parent spawned it. It is not a crew role — a subagent has ' +
        'no registry row and no identity of its own, so it has none.',
    ),
  );

  if (data.error) frag.append(text('div', 'warning-row', data.error));
  // The registry and the directories disagreeing is a real state, not a fault,
  // and the page names which of the two this scope came from when they do.
  if (data.scopeNote) frag.append(text('div', 'warning-row', data.scopeNote));

  if (slug !== null) {
    frag.append(
      el('div', { class: 'chips' }, [
        el('a', { class: 'chip', href: `#/subagents/${encodeURIComponent(agentId)}` }, [
          `Every subagent transcript under ${data.label} →`,
        ]),
      ]),
    );
  }

  if (data.total === 0) {
    frag.append(
      text(
        'p',
        'placeholder',
        slug === null
          ? 'No subagent transcripts under this root yet.'
          : `No subagent transcripts under ${slug}. The unscoped list above covers the ` +
            'whole instance.',
      ),
    );
    main.replaceChildren(frag);
    return;
  }

  const colors = subagentTypeColors(data.types.map((group) => group.subagentType));

  frag.append(
    el('div', { class: 'tiles' }, [
      tile('Subagents', fmtCount(data.total), `${data.types.length} distinct type(s)`),
      tile(
        'From workflows',
        fmtCount(data.fromWorkflows),
        `${fmtCount(data.total - data.fromWorkflows)} spawned directly`,
      ),
      tile('Workflow runs', fmtCount(data.workflows.length), 'recorded on disk'),
    ]),
  );

  if (data.workflows.length > 0) {
    frag.append(
      el('h2', {}, ['Workflow runs']),
      text(
        'p',
        'subtitle',
        'A run\u2019s subagents carry no description of their own — their sidecar says only ' +
          '"workflow-subagent". This is where the run says what they were for.',
      ),
    );

    for (const run of data.workflows) {
      const card = el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('div', { class: 'card-head-left' }, [
            text('span', 'card-title', run.name || run.runId),
            run.status ? el('span', { class: 'chip' }, [run.status]) : null,
          ]),
          text('span', 'tile-sub', fmtAgo(run.startedAt)),
        ]),
        text('div', 'card-path mono', run.runId),
      ]);

      if (run.summary) card.append(text('p', 'block-prose', run.summary));

      const stats = el('div', { class: 'card-stats' }, [
        el('div', {}, [
          text('div', 'card-stat-label', 'Agents'),
          text('div', 'card-stat-value', fmtCount(run.observedAgents)),
        ]),
        el('div', {}, [
          text('div', 'card-stat-label', 'Duration'),
          text('div', 'card-stat-value', fmtDuration(run.durationSeconds)),
        ]),
        el('div', {}, [
          text('div', 'card-stat-label', 'Phases'),
          text('div', 'card-stat-value', fmtCount(run.phases.length)),
        ]),
      ]);
      card.append(stats);

      // The descriptor records how many agents the run believed it spawned;
      // `observedAgents` is how many transcripts are actually on disk. They
      // agree today. Saying so when they do not is cheaper than wondering.
      if (typeof run.agentCount === 'number' && run.agentCount !== run.observedAgents) {
        card.append(
          text(
            'div',
            'warning-row',
            `The run recorded ${run.agentCount} agent(s); ${run.observedAgents} transcript(s) ` +
              'are on disk for it.',
          ),
        );
      }

      if (run.phases.length > 0) {
        const list = el('ul', { class: 'phases' });
        for (const phase of run.phases) {
          list.append(
            el('li', {}, [
              text('span', 'strong', phase.title || '—'),
              phase.detail ? text('span', 'lane-desc', phase.detail) : null,
            ]),
          );
        }
        card.append(list);
      }

      frag.append(card);
    }
  }

  frag.append(el('h2', {}, ['By subagent type']));

  for (const group of data.types) {
    const color = colors.get(group.subagentType) ?? OTHER_COLOR;
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('div', { class: 'card-head-left' }, [
          el('span', { class: 'lane-swatch', style: { background: color } }),
          text('span', 'card-title', rollupTypeLabel(group.subagentType)),
        ]),
        text('span', 'tile-sub', `${fmtCount(group.count)} transcript(s)`),
      ]),
    ]);

    // The one group that is an absence rather than a type. It says what is
    // missing and where the answer may still be, because this list reads the
    // sidecar only and the session view reads the spawning call as well — so
    // these are not subagents whose type is lost, they are subagents whose
    // type this page did not go and look for.
    if (!group.subagentType) {
      card.append(
        text(
          'p',
          'block-prose',
          'These have no `.meta.json` beside them, which older transcripts on this host do ' +
            'not. This list reads that sidecar and nothing else — deliberately, since the ' +
            'alternative is indexing every parent transcript to render a heading. Open a ' +
            'session below and its subagent branching view will recover the type from the ' +
            'call that spawned it, where the call is still on disk.',
        ),
      );
    }

    const list = el('div', { class: 'subagent-list' });
    for (const entry of group.subagents) {
      const row = el('div', { class: 'subagent', dataset: { active: String(entry.active) } }, [
        el('div', { class: 'subagent-head' }, [
          el(
            'a',
            {
              class: 'mono',
              href:
                `#/transcript/${encodeURIComponent(agentId)}/` +
                `${encodeURIComponent(entry.sessionId)}/${encodeURIComponent(entry.agentId)}`,
            },
            [entry.agentId.slice(0, 10)],
          ),
          entry.active ? el('span', { class: 'tag', dataset: { current: 'true' } }, ['live']) : null,
          entry.model ? el('span', { class: 'tag' }, [entry.model]) : null,
          entry.depth !== null ? el('span', { class: 'tag' }, [`depth ${entry.depth}`]) : null,
          entry.workflowRunId ? el('span', { class: 'tag' }, [entry.workflowRunId]) : null,
        ]),
        // A workflow subagent has no description of its own — the sidecar is
        // `{agentType, spawnDepth}` and identical on all of them — so what is
        // shown is the RUN's name, labelled as the run's rather than passed off
        // as this agent's. Saying "no description recorded" 58 times when the
        // answer is one join away is technically true and no use to anybody.
        entry.description
          ? text('div', 'subagent-desc', entry.description)
          : entry.workflowName
            ? el('div', { class: 'subagent-desc' }, [
                el('span', { class: 'lane-desc' }, ['part of run ']),
                el('span', { class: 'strong' }, [entry.workflowName]),
              ])
            : text(
                'div',
                'subagent-desc lane-desc',
                entry.workflowRunId
                  ? 'part of a workflow run whose descriptor is not on disk yet'
                  : 'no description recorded',
              ),
        text('div', 'tile-sub', `${fmtBytes(entry.sizeBytes)} · ${fmtAgo(entry.lastActivity)}`),
      ]);
      list.append(row);
    }

    card.append(list);
    frag.append(card);
  }

  main.replaceChildren(frag);
}

// ── Clawsky ─────────────────────────────────────────────────────────────────

/** One message. Author and recipient are columns, never parsed from the text. */
function mailCard(message) {
  const card = el('div', { class: 'mail' }, [
    el('div', { class: 'mail-head' }, [
      text('span', 'mail-author mono', message.author || 'unknown'),
      el('span', { class: 'mail-arrow' }, ['→']),
      text('span', 'mail-to mono', message.recipient === '*' ? 'feed' : message.recipient),
      text('span', 'tile-sub', fmtAgo(message.sentAt)),
    ]),
  ]);

  if (message.subject) card.append(text('div', 'mail-subject', message.subject));

  // `pre` with a scroll cap rather than a clamp-and-expand: a body can be
  // 20,000 characters and the point of this view is to read them. tabindex,
  // because a scroll region with no focusable child is unreachable by keyboard
  // — the same lesson as the session tables.
  card.append(
    el('pre', { class: 'mail-body', tabindex: '0', role: 'region', 'aria-label': 'Message body' }, [
      message.body,
    ]),
  );

  if (message.bodyTruncated) {
    card.append(text('div', 'truncated', '… truncated — the board holds the whole message'));
  }
  if (message.readBy.length > 0) {
    card.append(text('div', 'tile-sub', `read by ${message.readBy.join(', ')}`));
  }
  return card;
}

async function viewClawsky() {
  const data = await api('/api/clawsky');
  const frag = document.createDocumentFragment();

  frag.append(
    el('h1', {}, ['Clawsky']),
    text(
      'p',
      'subtitle',
      'The board: who is on it, and everything they have said. One row per message — ' +
        'a DM and a feed post are the same table, and the recipient is what tells them apart.',
    ),
  );

  for (const instance of data.instances) {
    frag.append(el('h2', {}, [instance.label]));

    if (!instance.registryConfigured) {
      frag.append(
        text(
          'div',
          'warning-row',
          `${instance.label} has no boardDb in status-config.yaml, so it has no board here.`,
        ),
      );
      continue;
    }
    if (instance.registryError) frag.append(text('div', 'warning-row', instance.registryError));
    if (instance.mailError && instance.mailError !== instance.registryError) {
      frag.append(text('div', 'warning-row', instance.mailError));
    }

    // Every number and every sentence below is gated on this. `posterCount: 0`
    // means "no poster" when the board was read and "we did not get to look"
    // when it was not, and only the first licenses the copy under an empty
    // feed. The server decides it — see `boardReadable` in views.ts — so the
    // claim is on the wire where a test can see it, rather than being a shape
    // this file happens to draw.
    const readable = instance.boardReadable;

    frag.append(
      el('div', { class: 'tiles' }, [
        tile(
          'Participants',
          readable ? fmtCount(instance.participants.length) : '—',
          readable ? `${instance.posterCount} poster(s)` : 'board unreadable',
        ),
        // Each list carries its own total, so each can say when it is showing
        // a window rather than everything. The feed used to have no such
        // qualifier at all, which mattered more than it sounds: its
        // empty-state copy is a positive claim, and a claim under an
        // unmentioned ceiling is a lie waiting for the row count to grow.
        tile(
          'Posts',
          readable ? fmtCount(instance.totalFeed) : '—',
          !readable
            ? 'not read'
            : instance.totalFeed > instance.feed.length
              ? `showing the newest ${instance.feed.length}`
              : 'on the feed',
        ),
        tile(
          'DMs',
          readable ? fmtCount(instance.totalDms) : '—',
          !readable
            ? 'not read'
            : instance.totalDms > instance.dms.length
              ? `showing the newest ${instance.dms.length}`
              : 'agent to agent',
        ),
      ]),
    );

    if (readable && instance.participants.length > 0) {
      const chips = el('div', { class: 'chips' });
      for (const participant of instance.participants) {
        chips.append(
          el('span', { class: 'chip' }, [
            `${participant.id} · ${participant.role} · ${participant.sent} sent`,
          ]),
        );
      }
      frag.append(chips);
    }

    frag.append(el('h3', {}, ['Feed']));
    if (!readable) {
      // The explanation is gated on having read the thing it explains. This is
      // the state the page names itself — mail goes dark exactly when the
      // roster does (#72) — so it is where a confident "nothing is broken"
      // would be read, and it is the one place it must not appear.
      frag.append(
        text(
          'p',
          'placeholder',
          'Unknown: the board could not be read, so whether this crew has posted is not ' +
            'something this page knows. The reason is in the warning above.',
        ),
      );
    } else if (instance.feed.length === 0) {
      // `totalFeed` is counted in SQL over the whole table and the feed query
      // has its own limit, so "no posts" here means no posts — not "none in
      // the window I asked for". Only a poster may write to the feed
      // (src/mail.ts), and `posterCount` came from a successful registry read,
      // so this says the feed CANNOT have posts rather than that it happens
      // not to.
      frag.append(
        text(
          'p',
          'placeholder',
          instance.posterCount === 0
            ? 'Empty, and that is correct: only an agent with the poster role may write to the ' +
                'feed, and this crew has none. Its coordinator can spawn one and has not. ' +
                'Nothing is broken and nothing needs enabling.'
            : `Empty. This crew has ${instance.posterCount} poster(s), so posts are possible — ` +
                'none has been written.',
        ),
      );
    } else {
      for (const message of instance.feed) frag.append(mailCard(message));
    }

    frag.append(el('h3', {}, ['Direct messages']));
    if (!readable) {
      // "No DMs yet" and "the board could not be read" are different sentences.
      frag.append(
        text(
          'p',
          'placeholder',
          'Unknown: the board could not be read, so this page cannot say whether there are ' +
            'any.',
        ),
      );
    } else if (instance.dms.length === 0) {
      frag.append(text('p', 'placeholder', 'No DMs on this board yet.'));
    } else {
      for (const message of instance.dms) frag.append(mailCard(message));
    }
  }

  main.replaceChildren(frag);
}

// ── Osmosis Jones ───────────────────────────────────────────────────────────

async function viewOj() {
  const data = await api('/api/oj');
  const frag = document.createDocumentFragment();

  frag.append(
    el('h1', {}, ['Osmosis Jones']),
    text('p', 'subtitle', `workers: ${data.workersRoot} · state: ${data.stateFile}`),
  );

  if (!data.present && data.workers.length === 0) {
    // Deliberately calm. OJ not running is the expected state today, and a red
    // error banner for the expected state teaches you to ignore banners.
    frag.append(
      text('p', 'placeholder', data.message || 'No OJ data yet.'),
      text(
        'p',
        'placeholder',
        'This view populates itself once Osmosis Jones writes worker directories. ' +
          'Nothing needs to be enabled here.',
      ),
    );
    main.replaceChildren(frag);
    return;
  }

  if (data.message) frag.append(text('div', 'warning-row', data.message));

  if (data.state) {
    frag.append(el('h2', {}, ['State file']));
    const stateTable = el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, [el('th', {}, ['Key']), el('th', {}, ['Value'])])]),
    ]);
    const stateBody = el('tbody');
    for (const [key, value] of Object.entries(data.state)) {
      stateBody.append(el('tr', {}, [el('td', { class: 'strong mono' }, [key]), el('td', {}, [value])]));
    }
    stateTable.append(stateBody);
    frag.append(stateTable);
  }

  frag.append(el('h2', {}, [`Workers (${data.workers.length})`]));

  for (const worker of data.workers) {
    const title =
      worker.owner && worker.repo && worker.pr !== null
        ? `${worker.owner}/${worker.repo} #${worker.pr}`
        : worker.dirName;

    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        text('span', 'card-title', title),
        worker.verdict ? el('span', { class: 'chip' }, [worker.verdict]) : null,
      ]),
      text('div', 'card-path mono', worker.dirName),
    ]);

    if (worker.status) card.append(el('div', { class: 'chips' }, [el('span', { class: 'chip' }, [worker.status])]));

    if (worker.rounds.length > 0) {
      const table = el('table', { class: 'table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', {}, ['Round']),
            el('th', {}, ['Verdict']),
            el('th', {}, ['Started']),
            el('th', {}, ['Ended']),
            el('th', {}, ['Note']),
          ]),
        ]),
      ]);
      const body = el('tbody');
      for (const round of worker.rounds) {
        body.append(
          el('tr', {}, [
            el('td', { class: 'strong' }, [round.round ?? '—']),
            el('td', {}, [round.verdict ?? '—']),
            el('td', {}, [fmtClock(round.startedAt)]),
            el('td', {}, [fmtClock(round.endedAt)]),
            el('td', {}, [round.note ?? '']),
          ]),
        );
      }
      table.append(body);
      card.append(table);
    } else {
      card.append(text('p', 'placeholder', worker.note ?? 'No rounds recorded yet.'));
    }

    card.append(text('div', 'tile-sub', `last activity ${fmtAgo(worker.lastActivity)}`));
    frag.append(card);
  }

  main.replaceChildren(frag);
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Hash routing, not the History API.
 *
 * A hash route never reaches the server, so there is no deep-link path that
 * needs an SPA fallback and no route that could be confused for an API path.
 * For a page served off a handful of static files behind a proxy, that is one
 * fewer thing to get wrong.
 */
function parseRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'overview', args: parts.slice(1) };
}

let renderToken = 0;

async function render() {
  const route = parseRoute();
  const token = ++renderToken;

  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === route.name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  try {
    // `#/agent/<instance>` is the whole instance; `#/agent/<instance>/<slug>`
    // is one agent of it. Same for `#/subagents/`. The second segment is a
    // project slug, which is `slug(workspace_path)` and identifies exactly one
    // registry row — an id would have needed a lookup the client cannot do.
    if (route.name === 'agent' && route.args[0]) {
      await viewAgent(route.args[0], route.args[1] ?? null);
    } else if (route.name === 'subagents' && route.args[0]) {
      await viewSubagents(route.args[0], route.args[1] ?? null);
    } else if (route.name === 'clawsky') await viewClawsky();
    else if (route.name === 'session' && route.args[0] && route.args[1])
      await viewSession(route.args[0], route.args[1]);
    else if (route.name === 'transcript' && route.args[0] && route.args[1])
      await viewTranscript(route.args[0], route.args[1], route.args[2] ?? null);
    else if (route.name === 'oj') await viewOj();
    else await viewOverview();
  } catch (error) {
    // A render that lost a race — the user clicked through while a fetch was
    // in flight — must not paint its error over the view that won.
    if (token !== renderToken) return;
    main.replaceChildren(
      el('div', { class: 'warning-row' }, [String(error.message ?? error)]),
      el('p', { class: 'placeholder' }, ['The service is read-only; nothing was changed.']),
    );
  }
}

window.addEventListener('hashchange', render);

// ── Live updates ────────────────────────────────────────────────────────────

const streamStatus = document.getElementById('stream-status');
const streamLabel = streamStatus.querySelector('.stream-label');

let lastBeat = Date.now();
let heartbeatSeconds = 15;
let refreshTimer = null;

function setStreamState(state, label) {
  streamStatus.dataset.state = state;
  streamLabel.replaceChildren(document.createTextNode(label));
}

/**
 * A change coalesces into one re-render.
 *
 * The server already debounces filesystem events, but several agents can
 * change at once and the transcript view is expensive to rebuild. This also
 * deliberately skips re-rendering the transcript view: it is paginated and
 * scrolled, and yanking it back to page one because a subagent wrote a line
 * would make it unusable to read.
 */
function scheduleRefresh() {
  if (parseRoute().name === 'transcript') return;
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    render();
  }, 600);
}

function connect() {
  const source = new EventSource('/api/events');

  source.addEventListener('hello', (event) => {
    try {
      heartbeatSeconds = JSON.parse(event.data).heartbeatSeconds ?? 15;
    } catch {
      heartbeatSeconds = 15;
    }
    lastBeat = Date.now();
    setStreamState('live', 'live');
  });

  source.addEventListener('heartbeat', () => {
    lastBeat = Date.now();
    setStreamState('live', 'live');
  });

  source.addEventListener('change', () => {
    lastBeat = Date.now();
    scheduleRefresh();
  });

  source.onerror = () => {
    // EventSource reconnects on its own; the indicator says so rather than
    // pretending the page is current. The watchdog below is what catches the
    // nastier case — a socket that stays open and stops delivering.
    setStreamState('dead', 'reconnecting…');
  };
}

/**
 * The watchdog.
 *
 * This is the whole point of having a heartbeat. A TCP connection through a
 * proxy can stay established and silently stop carrying anything; without this
 * check the page would sit there with a green dot showing data from hours ago,
 * which is a worse failure than showing nothing. Two missed beats and it says
 * so, in words, next to a red dot.
 */
setInterval(() => {
  const silentFor = (Date.now() - lastBeat) / 1000;
  if (silentFor > heartbeatSeconds * 2 + 2) {
    setStreamState('dead', `no updates for ${fmtDuration(silentFor)}`);
  }
}, 2000);

connect();
render();
