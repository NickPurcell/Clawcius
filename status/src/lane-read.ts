import type { AgentRoot } from './config.js';
import { mailEntry, mergeByTime, shapeLines, type LaneEntry } from './lane.js';
import { readMailFor } from './mail.js';
import { nameMap, type RowSource } from './timeline.js';
import { readRegistry } from './registry.js';
import type { RenderedLine, TranscriptStore } from './transcripts.js';

export type LanePage = {
  row: string;
  /** Stamped transcript lines behind the row. Mail entries are extra and not counted. */
  total: number;
  from: number;
  nextFrom: number | null;
  entries: LaneEntry[];
  error: string | null;
};

/** How many tool_result lines past the page end are pulled in to sit under their calls. */
const RESULT_LOOKAHEAD = 12;

/** One stamped line of one of the row's transcripts, in the lane's global order. */
type Located = { path: string; i: number; ts: number; isToolResult: boolean };

/**
 * Every stamped line of the row's transcripts, ordered by timestamp. A row's
 * sessions can overlap in time, so the lane is a merge, not a concatenation.
 */
async function laneOrder(store: TranscriptStore, source: RowSource): Promise<Located[]> {
  const located: Located[] = [];
  for (const path of source.transcripts) {
    const index = await store.index(path);
    index.lines.forEach((line, i) => {
      if (line.ts !== null) located.push({ path, i, ts: line.ts, isToolResult: line.isToolResult });
    });
  }
  return located.sort((a, b) => a.ts - b.ts);
}

/** The first ordinal whose line is stamped at or after `at`. */
function ordinalAt(order: Located[], at: number): number {
  let low = 0;
  let high = order.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (order[mid]!.ts < at) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Read lines `[from, end)` of the order, grouped into runs so one file read serves consecutive lines. */
async function readRange(store: TranscriptStore, order: Located[], from: number, end: number): Promise<{ lines: RenderedLine[]; cutShort: boolean }> {
  const lines: RenderedLine[] = [];
  let at = from;
  while (at < end) {
    const first = order[at]!;
    let count = 1;
    while (at + count < end && order[at + count]!.path === first.path && order[at + count]!.i === first.i + count) count += 1;
    const page = await store.page(first.path, first.i, count);
    page.entries.forEach((line, k) => lines.push({ ...line, n: at + k }));
    if (page.entries.length < count) return { lines, cutShort: true };
    at += count;
  }
  return { lines, cutShort: false };
}

/**
 * A page of one row's lane: `limit` lines from `from` (or from the first line
 * at or after `at`), the tool results that immediately follow, and the row's
 * mail between the previous line and the next.
 */
export async function readLane(
  store: TranscriptStore,
  crew: AgentRoot,
  source: RowSource,
  position: { from: number } | { at: number },
  limit: number,
): Promise<LanePage> {
  const order = await laneOrder(store, source);
  const total = order.length;
  const from = Math.min(total, 'at' in position ? ordinalAt(order, position.at) : position.from);

  let end = Math.min(total, from + limit);
  for (let extra = 0; extra < RESULT_LOOKAHEAD && end < total && order[end]!.isToolResult; extra += 1) end += 1;

  const { lines, cutShort } = await readRange(store, order, from, end);
  const read = from + lines.length;
  const nextFrom = cutShort || read < total ? read : null;

  const registry = readRegistry(crew.boardDb);
  const names = nameMap(crew.label, registry.agents);
  const nameOf = (id: string): string => names.get(id) ?? id;
  const selfId = source.mailId ?? source.row.id;
  const shaped = shapeLines(lines, selfId, nameOf);

  let mail: LaneEntry[] = [];
  let error: string | null = null;
  if (source.mailId !== null) {
    const after = from > 0 ? order[from - 1]!.ts : 0;
    const until = read < total ? order[read]!.ts : null;
    const window = readMailFor(crew.boardDb, source.mailId, after, until, store.read.maxBlockChars);
    error = window.error;
    mail = window.rows.map((row) => mailEntry(row, source.mailId!, nameOf));
  }

  return { row: source.row.id, total, from, nextFrom, entries: mergeByTime(shaped, mail), error };
}
