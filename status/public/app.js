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

// ── Role colours ────────────────────────────────────────────────────────────

/**
 * Subagent roles get categorical slots in a FIXED order.
 *
 * The order is the colour-blind-safety property of the palette — adjacent
 * slots are the pairs validated for separation — so roles are sorted and
 * assigned deterministically per session rather than in whatever order the
 * filesystem listed them. Two loads of the same session therefore paint the
 * same roles the same colours, which matters when you are comparing a page you
 * left open to the one you just refreshed.
 *
 * Past eight roles, everything else is one muted "other" colour. Generating a
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

function roleColors(roles) {
  const ordered = [...new Set(roles)].sort();
  const map = new Map();
  ordered.forEach((role, index) => {
    map.set(role, index < SERIES.length ? SERIES[index] : OTHER_COLOR);
  });
  return map;
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

  const running = data.agents.filter((agent) => agent.liveness === 'running').length;
  const stale = data.agents.filter((agent) => agent.liveness === 'stale').length;
  const sessions = data.agents.reduce((sum, agent) => sum + agent.sessionCount, 0);
  const subagents = data.agents.reduce((sum, agent) => sum + agent.subagentCount, 0);
  const registered = data.agents.reduce((sum, agent) => sum + agent.registeredAgentCount, 0);
  const declaredLive = data.agents.reduce((sum, agent) => sum + agent.declaredLiveCount, 0);
  const unattributed = data.agents.reduce(
    (sum, agent) => sum + agent.unattributedSessionCount,
    0,
  );

  // Instances whose registry could not be read, or that have none configured.
  // Their agents are not counted in the tiles and every one of their sessions
  // falls into "unattributable", so a tile that did not say so would be the
  // "empty roster reads as a host with no agents" failure this page is built
  // to avoid — in the one place that summarises everything.
  const blind = data.agents.filter((agent) => agent.registryError || !agent.registryConfigured);
  const blindNote = blind.length > 0 ? ` · ${blind.length} instance(s) not counted` : '';

  frag.append(
    el('div', { class: 'tiles' }, [
      // Agents come from the registry; instances are the configured roots.
      // Conflating the two is what made this page report 49 of something.
      tile(
        'Agents',
        blind.length === data.agents.length ? '—' : fmtCount(registered),
        `${declaredLive} declared live${blindNote || ' · across all crews'}`,
      ),
      tile('Instances', String(data.agents.length), `${running} running · ${stale} stale`),
      tile(
        'Sessions',
        fmtCount(sessions),
        blind.length > 0
          ? `${unattributed} unattributed, including every session of ${blind.length} instance(s)`
          : `${unattributed} not attributable to an agent`,
      ),
      tile('Subagents', fmtCount(subagents), 'transcripts on disk'),
    ]),
  );

  for (const agent of blind) {
    frag.append(
      text(
        'div',
        'warning-row',
        agent.registryError ??
          `${agent.label} has no boardDb in status-config.yaml, so it has no registry here and ` +
            'none of its agents are counted above.',
      ),
    );
  }

  frag.append(el('h2', {}, ['Instances']));
  const cards = el('div', { class: 'cards' });

  for (const agent of data.agents) {
    const card = el('a', { class: 'card', href: `#/agent/${encodeURIComponent(agent.id)}` }, [
      el('div', { class: 'card-head' }, [
        text('span', 'card-title', agent.label),
        liveness(agent.liveness),
      ]),
      text('div', 'card-path mono', agent.projectsRoot),
      el('div', { class: 'card-stats' }, [
        el('div', {}, [
          text('div', 'card-stat-label', 'Agents'),
          text('div', 'card-stat-value', fmtCount(agent.registeredAgentCount)),
        ]),
        el('div', {}, [
          text('div', 'card-stat-label', 'Sessions'),
          text('div', 'card-stat-value', fmtCount(agent.sessionCount)),
        ]),
        el('div', {}, [
          text('div', 'card-stat-label', 'Active'),
          text('div', 'card-stat-value', fmtCount(agent.activeSessionCount)),
        ]),
        el('div', {}, [
          text('div', 'card-stat-label', 'Subagents'),
          text('div', 'card-stat-value', fmtCount(agent.subagentCount)),
        ]),
        el('div', {}, [
          text('div', 'card-stat-label', 'Last activity'),
          text('div', 'card-stat-value', fmtAgo(agent.lastActivity)),
        ]),
      ]),
    ]);

    if (agent.error) card.append(text('div', 'warning-row', agent.error));
    // Short here, because the full sentence is already a warning row under the
    // tiles it qualifies. This is only so you can tell WHICH card it was about.
    if (agent.registryError) {
      card.append(text('div', 'warning-row', 'Registry unreadable — see above.'));
    } else if (!agent.registryConfigured) {
      card.append(text('div', 'warning-row', 'No registry configured — directories only.'));
    }
    cards.append(card);
  }

  frag.append(cards);
  main.replaceChildren(frag);
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
  return table;
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
 * One instance: its agents from the registry, then everything else.
 *
 * The list is NOT the directories under the projects root. That was Clawcius
 * #14 — Clawcius showed 49 of them, and three of Hamachi's five were `/tmp`
 * paths where an engineer ran permission probes. Those still appear, under
 * "Other transcripts", because they are real and readable; they are just not
 * agents.
 */
async function viewAgent(agentId) {
  const data = await api(`/api/agents/${encodeURIComponent(agentId)}/sessions`);
  const frag = document.createDocumentFragment();

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
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('div', { class: 'card-head-left' }, [
          text('span', 'card-title mono', agent.id),
          el('span', { class: 'chip' }, [agent.role]),
          el('span', { class: 'chip' }, [agent.crew]),
        ]),
        liveness(agent.liveness),
      ]),
      el('div', { class: 'card-sub' }, [declaredStatus(agent)]),
      text('div', 'card-path mono', `${agent.workspacePath}  →  ${agent.projectSlug}`),
    ]);

    if (agent.spawnedBy) {
      card.append(el('div', { class: 'chips' }, [
        el('span', { class: 'chip' }, [`spawned by ${agent.spawnedBy}`]),
      ]));
    }

    if (agent.sessions.length > 0) {
      card.append(sessionTable(data.agent, agent.sessions, agent.sessionId));
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

    frag.append(card);
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
      frag.append(
        el('div', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            text('span', 'card-title mono', group.projectSlug),
            liveness(group.liveness),
          ]),
          sessionTable(data.agent, group.sessions, null),
        ]),
      );
    }
  }

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

  const colors = roleColors(nodes.map((node) => node.role));
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
    const color = colors.get(node.role) ?? OTHER_COLOR;
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
      ['role', node.role],
      ['task', node.description],
      ['started', fmtClock(node.startedAt)],
      ['ended', node.active ? 'still running' : fmtClock(node.endedAt)],
      ['duration', fmtDuration(node.durationSeconds)],
      ['turns', `${fmtCount(node.assistantTurns)} · ${fmtCount(node.toolCalls)} tool calls`],
      ['transcript', fmtBytes(node.sizeBytes)],
      ['linkage', node.linkage],
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
          class: 'lane-role',
          href:
            `#/transcript/${encodeURIComponent(agentId)}/${encodeURIComponent(sessionId)}` +
            `/${encodeURIComponent(node.agentId)}`,
        },
        [node.role],
      ),
      text('span', 'lane-desc', node.description || node.agentId),
    );
    if (node.linkage === 'orphan') {
      label.append(el('span', { class: 'tag', dataset: { linkage: 'orphan' } }, ['unlinked']));
    }

    lanes.append(el('div', { class: 'lane' }, [label, el('div', { class: 'lane-track' }, [bar])]));
  }

  // Legend for identity, always — the row labels already name each role in
  // text, so colour is never the only channel, but the legend makes the
  // role→colour mapping readable at a glance across many rows.
  const legend = el('div', { class: 'legend' });
  for (const [role, color] of colors) {
    legend.append(
      el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-swatch', style: { background: color } }),
        role,
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
    if (route.name === 'agent' && route.args[0]) await viewAgent(route.args[0]);
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
