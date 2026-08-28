import { execFile } from 'node:child_process';

/** The image whose `snap-YYYYMMDD-HHMMSS` tags are the nightly container snapshots. */
export const SNAPSHOT_IMAGE = 'clawcius-agent';
/** A newest snapshot older than this is shown red. */
export const SNAPSHOT_STALE_MS = 48 * 3_600_000;
const CACHE_MS = 60_000;

export type Snapshot =
  | { available: true; tag: string | null; createdAt: string | null; ageSeconds: number | null; stale: boolean }
  | { available: false };

const TAG = /^snap-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

/** The instant a snapshot tag names, read as UTC. */
export function tagTime(tag: string): number | null {
  const match = TAG.exec(tag);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? ms : null;
}

/** The newest snapshot in `docker images` output (one `<tag> <created>` per line). */
export function newestSnapshot(output: string, now: number): Snapshot {
  let best: { tag: string; at: number } | null = null;
  for (const line of output.split('\n')) {
    const tag = line.trim().split(/\s+/)[0] ?? '';
    const at = tagTime(tag);
    if (at !== null && (best === null || at > best.at)) best = { tag, at };
  }
  if (!best) return { available: true, tag: null, createdAt: null, ageSeconds: null, stale: true };
  const age = Math.max(0, now - best.at);
  return {
    available: true,
    tag: best.tag,
    createdAt: new Date(best.at).toISOString(),
    ageSeconds: Math.round(age / 1000),
    stale: age > SNAPSHOT_STALE_MS,
  };
}

let cached: { at: number; value: Snapshot } | null = null;

/** Newest snapshot age via the docker CLI, cached for a minute; `available: false` when docker cannot answer. */
export function readSnapshot(now: number = Date.now()): Promise<Snapshot> {
  if (cached && now - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['images', SNAPSHOT_IMAGE, '--format', '{{.Tag}} {{.CreatedAt}}'],
      { timeout: 5000 },
      (error, stdout) => {
        const value: Snapshot = error ? { available: false } : newestSnapshot(stdout, now);
        cached = { at: now, value };
        resolve(value);
      },
    );
  });
}
