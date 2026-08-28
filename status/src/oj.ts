import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OjConfig } from './config.js';
import { redact, resolveWithin } from './transcripts.js';

/** Cap on any JSON file read here. */
const MAX_JSON_BYTES = 2_000_000;

/** GitHub owner/repo charset, plus the digits of a PR number. */
const WORKER_DIR_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})__([A-Za-z0-9][A-Za-z0-9._-]{0,99})__(\d{1,12})$/;

export type OjRound = {
  round: number | null;
  verdict: string | null;
  startedAt: string | null;
  endedAt: string | null;
  note: string | null;
};

export type OjWorker = {
  /** The raw directory name, kept for the "unparseable name" case. */
  dirName: string;
  owner: string | null;
  repo: string | null;
  pr: number | null;
  status: string | null;
  verdict: string | null;
  rounds: OjRound[];
  lastActivity: string | null;
  /** Set when the directory exists but nothing in it could be interpreted. */
  note: string | null;
};

export type OjSnapshot = {
  /** False when there is simply nothing to show — the normal state today. */
  present: boolean;
  workersRoot: string;
  stateFile: string;
  /** Human sentence for the empty and broken cases. Rendered as prose. */
  message: string;
  workers: OjWorker[];
  /** Anything from the global state file we could make sense of. */
  state: Record<string, string> | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First present key, coerced to a redacted string. Null when none match. */
function pick(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return redact(value).slice(0, 400);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d{1,9}$/.test(value)) return Number(value);
  }
  return null;
}

async function readJsonCapped(path: string): Promise<unknown | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_JSON_BYTES) return null;
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function roundsFromState(state: Record<string, unknown>): OjRound[] {
  const raw = state['rounds'];
  if (!Array.isArray(raw)) return [];
  const rounds: OjRound[] = [];
  for (const entry of raw.slice(0, 200)) {
    const record = asRecord(entry);
    if (!record) continue;
    rounds.push({
      round: pickNumber(record, ['round', 'n', 'index', 'number']),
      verdict: pick(record, ['verdict', 'result', 'outcome', 'decision', 'status']),
      startedAt: pick(record, ['startedAt', 'started_at', 'start', 'createdAt']),
      endedAt: pick(record, ['endedAt', 'ended_at', 'end', 'finishedAt', 'completedAt']),
      note: pick(record, ['note', 'summary', 'message', 'reason']),
    });
  }
  return rounds;
}

async function roundsFromDirs(workerDir: string): Promise<OjRound[]> {
  let entries: string[];
  try {
    const found = await readdir(workerDir, { withFileTypes: true });
    entries = found
      .filter((entry) => entry.isDirectory() && /^round-\d{1,6}$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const rounds: OjRound[] = [];
  for (const name of entries.sort()) {
    const dir = resolveWithin(workerDir, name);
    if (!dir) continue;
    const state = asRecord(await readJsonCapped(join(dir, 'state.json')));
    let endedAt: string | null = null;
    try {
      endedAt = new Date((await stat(dir)).mtimeMs).toISOString();
    } catch {
      endedAt = null;
    }
    rounds.push({
      round: Number(name.slice('round-'.length)),
      verdict: state ? pick(state, ['verdict', 'result', 'outcome', 'decision']) : null,
      startedAt: state ? pick(state, ['startedAt', 'started_at', 'start']) : null,
      endedAt: state ? (pick(state, ['endedAt', 'ended_at', 'end']) ?? endedAt) : endedAt,
      note: state ? pick(state, ['note', 'summary', 'message']) : null,
    });
  }
  return rounds;
}

export async function readOjSnapshot(config: OjConfig): Promise<OjSnapshot> {
  const empty: OjSnapshot = {
    present: false,
    workersRoot: config.workersRoot,
    stateFile: config.stateFile,
    message: '',
    workers: [],
    state: null,
  };

  let dirNames: string[];
  try {
    const entries = await readdir(config.workersRoot, { withFileTypes: true });
    dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ...empty,
      message:
        code === 'ENOENT'
          ? `No OJ data yet — ${config.workersRoot} does not exist. This is expected until Osmosis Jones runs.`
          : `OJ workers root is not readable: ${config.workersRoot} (${code ?? 'unknown error'}).`,
    };
  }

  const stateRecord = asRecord(await readJsonCapped(config.stateFile));
  const state: Record<string, string> | null = stateRecord
    ? Object.fromEntries(
        Object.entries(stateRecord)
          .slice(0, 40)
          .map(([key, value]) => [
            key.slice(0, 64),
            typeof value === 'object' && value !== null
              ? `${Array.isArray(value) ? 'list' : 'object'} (${Object.keys(value).length} keys)`
              : redact(String(value)).slice(0, 200),
          ]),
      )
    : null;

  if (dirNames.length === 0) {
    return {
      ...empty,
      present: state !== null,
      state,
      message: `No OJ workers yet — ${config.workersRoot} is empty.`,
    };
  }

  const workers: OjWorker[] = [];
  for (const dirName of dirNames.slice(0, 500)) {
    const dir = resolveWithin(config.workersRoot, dirName);
    if (!dir) continue;

    const match = WORKER_DIR_PATTERN.exec(dirName);
    const workerState = asRecord(await readJsonCapped(join(dir, 'state.json')));
    const rounds = workerState ? roundsFromState(workerState) : [];
    const resolvedRounds = rounds.length > 0 ? rounds : await roundsFromDirs(dir);

    let lastActivity: string | null = null;
    try {
      lastActivity = new Date((await stat(dir)).mtimeMs).toISOString();
    } catch {
      lastActivity = null;
    }

    workers.push({
      // Redacted and length-capped even though it is a directory name — it is
      // derived from a repository name, which is not ours.
      dirName: redact(dirName).slice(0, 220),
      owner: match?.[1] ?? null,
      repo: match?.[2] ?? null,
      pr: match?.[3] ? Number(match[3]) : null,
      status: workerState ? pick(workerState, ['status', 'state', 'phase']) : null,
      verdict:
        (workerState ? pick(workerState, ['verdict', 'result', 'outcome', 'decision']) : null) ??
        resolvedRounds.at(-1)?.verdict ??
        null,
      rounds: resolvedRounds,
      lastActivity,
      note: workerState ? null : 'no state.json in this worker directory',
    });
  }

  workers.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));

  return {
    present: true,
    workersRoot: config.workersRoot,
    stateFile: config.stateFile,
    message: '',
    workers,
    state,
  };
}
