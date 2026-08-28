// Every value from the server reaches the page through textContent; nothing is interpolated into markup.

// ── DOM ─────────────────────────────────────────────────────────────────────

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const $ = (id) => document.getElementById(id);

// ── Formatting ──────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function fmtClock(ms, withSeconds = true) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, hour12: false });
}

function fmtDay(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
}

function fmtStamp(ms) {
  return `${fmtDay(ms)} ${fmtClock(ms)}`;
}

function fmtAge(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
}

// ── State ───────────────────────────────────────────────────────────────────

const DEFAULT_RANGE = 3 * HOUR;
const PAGE = 80;
const ZOOM_STEP = 1.5;

const state = {
  crews: [],
  crew: null,
  timeline: null,
  view: { start: Date.now() - DEFAULT_RANGE, end: Date.now() + DEFAULT_RANGE * 0.03 },
  cursor: Date.now(),
  checked: new Set(),
  lanes: new Map(),
  follow: true,
};

function readHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return { crew: params.get('crew'), rows: (params.get('rows') ?? '').split(',').filter(Boolean) };
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.crew) params.set('crew', state.crew);
  if (state.checked.size > 0) params.set('rows', [...state.checked].join(','));
  const next = `#${params.toString()}`;
  if (window.location.hash !== next) history.replaceState(null, '', next);
}

function setFollow(on) {
  state.follow = on;
  $('follow').checked = on;
}

// ── Timeline ────────────────────────────────────────────────────────────────

const tracks = $('tl-tracks');
const names = $('tl-names');

function viewWidth() {
  return state.view.end - state.view.start;
}

function xOf(ms) {
  return ((ms - state.view.start) / viewWidth()) * 100;
}

function timeAtClientX(clientX) {
  const rect = tracks.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  return state.view.start + fraction * viewWidth();
}

/** A tick spacing that gives roughly 6-12 labels across the view. */
function tickStep(width) {
  const steps = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 7 * DAY];
  return steps.find((step) => width / step <= 12) ?? 7 * DAY;
}

function axisTicks() {
  const step = tickStep(viewWidth());
  const ticks = [];
  const offset = new Date(state.view.start).getTimezoneOffset() * MINUTE;
  let at = Math.floor((state.view.start - offset) / step) * step + offset;
  for (; at <= state.view.end; at += step) {
    if (at < state.view.start) continue;
    const local = new Date(at);
    const midnight = local.getHours() === 0 && local.getMinutes() === 0;
    ticks.push({ at, label: midnight || step >= DAY ? fmtDay(at) : fmtClock(at, false), day: midnight });
  }
  return ticks;
}

function intersectsView(spans) {
  return spans.some(([start, end]) => end >= state.view.start && start <= state.view.end);
}

function visibleRows() {
  const rows = state.timeline?.rows ?? [];
  return rows.filter((row) => row.depth === 0 || state.checked.has(row.id) || intersectsView(row.spans));
}

function botRows() {
  return (state.timeline?.bots ?? []).map((bot, i) => {
    const since = bot.since ? Date.parse(bot.since) : NaN;
    const updated = bot.updated ? Date.parse(bot.updated) : NaN;
    const spans = Number.isFinite(since) && Number.isFinite(updated) ? [[since, Math.max(since, updated)]] : [];
    const counts = Object.entries(bot.counts).map(([key, value]) => `${key} ${value}`).join(' · ');
    const summary = bot.error ?? [bot.mode, bot.detail, counts].filter(Boolean).join(' · ');
    return {
      id: `b:${i}`,
      name: bot.error ? 'bots' : bot.workspace ? `${bot.bot} · ${bot.workspace}` : bot.bot,
      spans,
      needsHuman: bot.needsHuman,
      title: bot.needsHuman ? `needs human: ${bot.needsHuman}` : summary,
      note: bot.needsHuman ? `needs human: ${bot.needsHuman}` : summary,
    };
  });
}

function renderTimeline() {
  const ticks = axisTicks();
  const nameNodes = [el('div', { class: 'tl-name axis' })];
  const trackNodes = [
    el('div', { class: 'tl-axis' }, ticks.map((tick) =>
      el('span', { class: tick.day ? 'tick day' : 'tick', style: { left: `${xOf(tick.at)}%` } }, tick.label),
    )),
  ];
  const gridlines = () => ticks.map((tick) => el('span', { class: 'gridline', style: { left: `${xOf(tick.at)}%` } }));
  const spanNodes = (spans, extraClass = '') =>
    spans
      .filter(([start, end]) => end >= state.view.start && start <= state.view.end)
      .map(([start, end]) =>
        el('span', {
          class: `span ${extraClass}`.trim(),
          style: { left: `${Math.max(0, xOf(start))}%`, width: `${Math.max(0, Math.min(100, xOf(end)) - Math.max(0, xOf(start)))}%` },
          title: `${fmtStamp(start)} – ${fmtClock(end)}`,
        }),
      );

  for (const row of visibleRows()) {
    const sub = row.depth > 0;
    const box = el('input', { type: 'checkbox', id: `check-${row.id}` });
    box.checked = state.checked.has(row.id);
    box.addEventListener('change', () => toggleLane(row.id, box.checked));
    const status = row.status && row.status !== 'live' ? el('span', { class: `status ${row.status}` }, row.status) : null;
    nameNodes.push(
      el('div', { class: sub ? 'tl-name sub' : 'tl-name', style: sub ? { paddingLeft: `${8 + row.depth * 12}px` } : null, title: row.name }, [
        box,
        el('label', { for: `check-${row.id}` }, row.name),
        status,
      ]),
    );
    trackNodes.push(el('div', { class: sub ? 'tl-track sub' : 'tl-track' }, [...gridlines(), ...spanNodes(row.spans)]));
  }

  const bots = botRows();
  nameNodes.push(el('div', { class: 'tl-name group' }, 'bots'));
  trackNodes.push(el('div', { class: 'tl-track' }, bots.length === 0 ? [...gridlines(), el('span', { class: 'note' }, 'none')] : gridlines()));
  for (const bot of bots) {
    nameNodes.push(el('div', { class: 'tl-name bot', title: bot.title }, [el('label', {}, bot.name)]));
    const last = bot.spans[0]?.[1];
    trackNodes.push(
      el('div', { class: 'tl-track bot', title: bot.title }, [
        ...gridlines(),
        ...spanNodes(bot.spans, bot.needsHuman ? 'needs-human' : ''),
        el('span', { class: 'note', style: { left: last ? `${Math.min(96, Math.max(0, xOf(last)))}%` : '0' } }, bot.note),
      ]),
    );
  }

  const now = Date.now();
  if (now >= state.view.start && now <= state.view.end) {
    trackNodes.push(el('div', { class: 'tl-now', style: { left: `${xOf(now)}%` } }));
  }
  trackNodes.push(el('div', { class: 'tl-cursor', id: 'tl-cursor', style: { left: `${xOf(state.cursor)}%` } }));

  names.replaceChildren(...nameNodes);
  tracks.replaceChildren(...trackNodes);
  renderCursor();
}

function renderCursor() {
  const line = $('tl-cursor');
  if (line) {
    line.style.left = `${xOf(state.cursor)}%`;
    line.hidden = state.cursor < state.view.start || state.cursor > state.view.end;
  }
  $('cursor-label').textContent = fmtStamp(state.cursor);
}

/** Shift the view by `delta` ms; the cursor travels with it. */
function pan(delta, syncLanes = true) {
  state.view.start += delta;
  state.view.end += delta;
  state.cursor += delta;
  if (delta < 0) setFollow(false);
  renderTimeline();
  if (syncLanes) scheduleLaneSync();
}

/** Scale the view about `pivot` (ms); the cursor stays where it is unless it leaves the view. */
function zoom(factor, pivot) {
  const start = pivot - (pivot - state.view.start) * factor;
  const end = pivot + (state.view.end - pivot) * factor;
  if (end - start < 5 * MINUTE || end - start > 60 * DAY) return;
  state.view = { start, end };
  state.cursor = Math.min(end, Math.max(start, state.cursor));
  renderTimeline();
  scheduleLaneSync();
}

function showRange(width) {
  const now = Date.now();
  state.view = { start: now - width, end: now + width * 0.03 };
  state.cursor = Math.min(state.cursor, now);
  if (state.cursor < state.view.start) state.cursor = now;
  renderTimeline();
  scheduleLaneSync();
}

function setCursor(ms, fromLane = false) {
  state.cursor = ms;
  if (ms < state.view.start || ms > state.view.end) {
    const width = viewWidth();
    state.view = { start: ms - width * 0.3, end: ms + width * 0.7 };
    renderTimeline();
  } else {
    renderCursor();
  }
  if (!fromLane) scheduleLaneSync();
}

// Wheel: plain scrolling pans, ctrl/meta scrolling zooms about the pointer.
tracks.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    zoom(event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, timeAtClientX(event.clientX));
    return;
  }
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  pan((delta / Math.max(1, tracks.clientWidth)) * viewWidth());
}, { passive: false });

let drag = null;
tracks.addEventListener('pointerdown', (event) => {
  drag = { x: event.clientX, moved: false, start: state.view.start };
  tracks.setPointerCapture(event.pointerId);
});
tracks.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.clientX - drag.x;
  if (Math.abs(dx) < 3 && !drag.moved) return;
  drag.moved = true;
  const delta = -(dx / Math.max(1, tracks.clientWidth)) * viewWidth();
  drag.x = event.clientX;
  pan(delta, false);
});
tracks.addEventListener('pointerup', (event) => {
  if (!drag) return;
  if (drag.moved) scheduleLaneSync();
  else setCursor(timeAtClientX(event.clientX));
  drag = null;
});

for (const button of $('ranges').querySelectorAll('button')) {
  button.addEventListener('click', () => showRange(Number(button.dataset.range)));
}
$('pan-left').addEventListener('click', () => pan(-viewWidth() / 4));
$('pan-right').addEventListener('click', () => pan(viewWidth() / 4));
$('zoom-in').addEventListener('click', () => zoom(1 / ZOOM_STEP, state.cursor));
$('zoom-out').addEventListener('click', () => zoom(ZOOM_STEP, state.cursor));
$('now').addEventListener('click', () => {
  setFollow(true);
  showRange(viewWidth() / 1.03);
  setCursor(Date.now());
  for (const lane of state.lanes.values()) jumpToEnd(lane);
});
$('follow').addEventListener('change', (event) => {
  setFollow(event.target.checked);
  if (state.follow) for (const lane of state.lanes.values()) jumpToEnd(lane);
});

// ── Lanes ───────────────────────────────────────────────────────────────────

const lanesRoot = $('lanes');

function rowById(id) {
  return state.timeline?.rows.find((row) => row.id === id) ?? null;
}

function entryNode(entry) {
  const ts = entry.ts ? Date.parse(entry.ts) : NaN;
  const children = [
    el('header', {}, [el('span', { class: 'label' }, entry.label), el('time', {}, Number.isFinite(ts) ? fmtClock(ts) : '')]),
  ];
  if (entry.kind === 'thinking') {
    children.push(el('details', {}, [el('summary', {}, 'thinking'), el('pre', {}, entry.text)]));
  } else if (entry.text) {
    children.push(el('pre', {}, entry.text));
  }
  if (entry.detail !== null) {
    children.push(
      el('details', {}, [el('summary', { class: entry.isError ? 'error' : null }, entry.isError ? 'result (error)' : 'result'), el('pre', {}, entry.detail)]),
    );
  }
  if (entry.truncated) children.push(el('span', { class: 'truncated' }, 'truncated'));
  const node = el('article', { class: `entry ${entry.kind}${entry.isError ? ' error' : ''}` }, children);
  node.dataset.key = entry.key;
  if (Number.isFinite(ts)) node.dataset.ts = String(ts);
  return node;
}

function makeLane(rowId) {
  const row = rowById(rowId);
  const body = el('div', { class: 'lane-body' });
  const err = el('span', { class: 'err' });
  const node = el('section', { class: 'lane' }, [
    el('div', { class: 'lane-head' }, [row?.name ?? rowId, err, el('button', { class: 'close', type: 'button', title: 'close', onclick: () => toggleLane(rowId, false) }, '×')]),
    body,
  ]);
  const lane = { rowId, node, body, err, keys: new Set(), from: null, to: null, total: row?.lines ?? 0, loading: false, quietUntil: 0 };
  body.addEventListener('scroll', () => onLaneScroll(lane));
  return lane;
}

function toggleLane(rowId, on) {
  if (on) state.checked.add(rowId);
  else state.checked.delete(rowId);
  writeHash();
  syncLanes();
  renderTimeline();
}

/** Open or close lane elements so they match the checked set, in timeline row order. */
function syncLanes() {
  const order = (state.timeline?.rows ?? []).map((row) => row.id).filter((id) => state.checked.has(id));
  for (const [id, lane] of state.lanes) {
    if (!state.checked.has(id)) {
      lane.node.remove();
      state.lanes.delete(id);
    }
  }
  for (const id of order) {
    if (!state.lanes.has(id)) {
      const lane = makeLane(id);
      state.lanes.set(id, lane);
      void loadAt(lane, state.follow ? null : state.cursor);
    }
  }
  lanesRoot.replaceChildren(...order.map((id) => state.lanes.get(id).node));
  if (order.length === 0) lanesRoot.replaceChildren(el('p', { class: 'empty' }, 'Tick an agent above to open its lane.'));
}

function laneUrl(lane, params) {
  const query = new URLSearchParams({ row: lane.rowId, limit: String(PAGE), ...params });
  return `/api/crews/${encodeURIComponent(state.crew)}/lane?${query}`;
}

function appendEntries(lane, entries, atTop) {
  const fresh = entries.filter((entry) => !lane.keys.has(entry.key));
  for (const entry of fresh) lane.keys.add(entry.key);
  const nodes = fresh.map(entryNode);
  if (atTop) {
    const before = lane.body.scrollHeight;
    lane.body.prepend(...nodes);
    scrollQuietly(lane, lane.body.scrollTop + lane.body.scrollHeight - before);
  } else {
    lane.body.append(...nodes);
  }
  return fresh.length;
}

function setLaneError(lane, message) {
  lane.err.textContent = message ?? '';
}

/** Replace the lane's content with the page at `ts` (null, or a time past the end: the tail). */
async function loadAt(lane, ts) {
  if (lane.loading) return;
  lane.loading = true;
  try {
    let page = ts === null ? null : await api(laneUrl(lane, { at: String(Math.round(ts)) }));
    if (page === null || page.from >= page.total) {
      page = await api(laneUrl(lane, { from: String(Math.max(0, (page?.total ?? lane.total) - PAGE)) }));
      ts = null;
    }
    lane.keys.clear();
    lane.body.replaceChildren();
    lane.from = page.from;
    lane.to = page.nextFrom ?? page.total;
    lane.total = page.total;
    setLaneError(lane, page.error);
    appendEntries(lane, page.entries, false);
    scrollQuietly(lane, ts === null ? lane.body.scrollHeight : 0);
  } catch (error) {
    setLaneError(lane, error.message);
  } finally {
    lane.loading = false;
  }
}

async function loadBefore(lane) {
  if (lane.loading || lane.from === null || lane.from <= 0) return;
  lane.loading = true;
  try {
    const from = Math.max(0, lane.from - PAGE);
    const page = await api(laneUrl(lane, { from: String(from), limit: String(lane.from - from) }));
    lane.from = page.from;
    appendEntries(lane, page.entries, true);
  } catch (error) {
    setLaneError(lane, error.message);
  } finally {
    lane.loading = false;
  }
}

/** Fetch whatever follows what is loaded; the tail of an up-to-date lane returns only new mail. */
async function loadAfter(lane) {
  if (lane.loading || lane.to === null) return;
  lane.loading = true;
  try {
    const wasAtBottom = atBottom(lane);
    const page = await api(laneUrl(lane, { from: String(lane.to) }));
    lane.total = page.total;
    lane.to = page.nextFrom ?? page.total;
    const added = appendEntries(lane, page.entries, false);
    if (added > 0 && (state.follow || wasAtBottom)) jumpToEnd(lane);
  } catch (error) {
    setLaneError(lane, error.message);
  } finally {
    lane.loading = false;
  }
}

function atBottom(lane) {
  return lane.body.scrollHeight - lane.body.scrollTop - lane.body.clientHeight < 40;
}

/** Set scrollTop without the scroll event moving the cursor; the window outlasts the event. */
function scrollQuietly(lane, top) {
  lane.quietUntil = performance.now() + 200;
  lane.body.scrollTop = top;
}

function jumpToEnd(lane) {
  scrollQuietly(lane, lane.body.scrollHeight);
}

/** The first entry whose bottom edge is below the top of the viewport. */
function topEntry(lane) {
  const top = lane.body.scrollTop;
  for (const node of lane.body.children) {
    if (node.offsetTop + node.offsetHeight > top) return node;
  }
  return null;
}

function onLaneScroll(lane) {
  if (performance.now() < lane.quietUntil) return;
  const node = topEntry(lane);
  if (node && node.dataset.ts) setCursor(Number(node.dataset.ts), true);
  if (!atBottom(lane)) setFollow(false);
  if (lane.body.scrollTop < 200) void loadBefore(lane);
  else if (atBottom(lane) && lane.to !== null && lane.to < lane.total) void loadAfter(lane);
}

/** Scroll every lane to the entry at the cursor, fetching a page there when it is not loaded. */
function syncLanesToCursor() {
  for (const lane of state.lanes.values()) {
    const nodes = [...lane.body.children].filter((node) => node.dataset.ts);
    const first = nodes[0] ? Number(nodes[0].dataset.ts) : null;
    const last = nodes.length ? Number(nodes[nodes.length - 1].dataset.ts) : null;
    if (first === null) {
      if (lane.total > 0 && lane.from === null) void loadAt(lane, state.cursor);
      continue;
    }
    if ((state.cursor < first && lane.from > 0) || (state.cursor > last && lane.to < lane.total)) {
      void loadAt(lane, state.cursor);
    } else {
      const target = nodes.find((node) => Number(node.dataset.ts) >= state.cursor) ?? nodes[nodes.length - 1];
      scrollQuietly(lane, target.offsetTop);
    }
  }
}

let laneSyncTimer = null;
function scheduleLaneSync() {
  if (laneSyncTimer) clearTimeout(laneSyncTimer);
  laneSyncTimer = setTimeout(() => {
    laneSyncTimer = null;
    syncLanesToCursor();
  }, 150);
}

// ── Crews, board, refresh ───────────────────────────────────────────────────

function renderCrews() {
  $('crews').replaceChildren(
    ...state.crews.map((crew) =>
      el('button', { type: 'button', 'aria-pressed': crew.id === state.crew ? 'true' : 'false', onclick: () => selectCrew(crew.id) }, crew.label),
    ),
  );
}

function renderSnapshot(snapshot) {
  const chip = $('snapshot');
  if (!snapshot || snapshot.available === false) {
    chip.textContent = 'snapshot: no docker';
    chip.dataset.state = 'unavailable';
    return;
  }
  chip.textContent = snapshot.tag ? `snapshot ${fmtAge(snapshot.ageSeconds)} ago` : 'snapshot: none';
  chip.title = snapshot.tag ? `${snapshot.tag} · ${snapshot.createdAt}` : 'no snap-* tag on clawcius-agent';
  chip.dataset.state = snapshot.stale ? 'stale' : 'fresh';
}

function setBanner(message) {
  const banner = $('banner');
  banner.textContent = message ?? '';
  banner.hidden = !message;
}

async function fetchTimeline() {
  if (!state.crew) return;
  const timeline = await api(`/api/crews/${encodeURIComponent(state.crew)}/timeline`);
  if (timeline.crew !== state.crew) return;
  state.timeline = timeline;
  setBanner(timeline.error);
  for (const lane of state.lanes.values()) {
    const row = rowById(lane.rowId);
    if (row) lane.total = row.lines;
  }
  renderTimeline();
}

async function selectCrew(id, rows = []) {
  if (state.crew === id) return;
  state.crew = id;
  state.timeline = null;
  state.checked = new Set(rows);
  for (const lane of state.lanes.values()) lane.node.remove();
  state.lanes.clear();
  renderCrews();
  writeHash();
  try {
    await fetchTimeline();
  } catch (error) {
    setBanner(error.message);
  }
  syncLanes();
}

async function refresh() {
  try {
    await fetchTimeline();
  } catch (error) {
    setBanner(error.message);
    return;
  }
  if (state.follow) {
    const now = Date.now();
    const width = viewWidth();
    if (now > state.view.end - width * 0.03) {
      const delta = now + width * 0.03 - state.view.end;
      state.view.start += delta;
      state.view.end += delta;
    }
    state.cursor = Math.max(state.cursor, ...[...state.lanes.values()].map((lane) => Number(lane.body.lastElementChild?.dataset.ts ?? 0)));
    renderTimeline();
  }
  for (const lane of state.lanes.values()) void loadAfter(lane);
}

async function boot() {
  const hash = readHash();
  try {
    const board = await api('/api/board');
    state.crews = board.crews;
    renderSnapshot(board.snapshot);
  } catch (error) {
    setBanner(error.message);
    return;
  }
  const initial = state.crews.find((crew) => crew.id === hash.crew) ?? state.crews[0];
  if (initial) await selectCrew(initial.id, hash.rows);
  setInterval(() => api('/api/board').then((board) => renderSnapshot(board.snapshot)).catch(() => {}), 60_000);
}

// ── Live updates ────────────────────────────────────────────────────────────

const streamStatus = $('stream-status');
const streamLabel = streamStatus.querySelector('.stream-label');
let lastBeat = Date.now();
let heartbeatSeconds = 15;

function setStreamState(name, label) {
  streamStatus.dataset.state = name;
  streamLabel.textContent = label;
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
  source.addEventListener('tick', () => {
    lastBeat = Date.now();
    void refresh();
  });
  source.onerror = () => setStreamState('dead', 'reconnecting…');
}

setInterval(() => {
  const silentFor = (Date.now() - lastBeat) / 1000;
  if (silentFor > heartbeatSeconds * 2 + 2) setStreamState('dead', `no updates for ${fmtAge(silentFor)}`);
}, 2000);

connect();
void boot();
