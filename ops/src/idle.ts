/**
 * Reading the waker's status file, and deciding whether it is safe to destroy
 * a container.
 *
 * `redeploy` and `rollback` both `docker rm -f` the instance. Every live agent
 * session is a `docker exec` into that container, so doing it mid-turn kills
 * the turn: from Discord, a person mid-conversation with an agent that stops
 * replying and never says why. That is the exact failure the waker's outage
 * announcement exists to make legible, and it would be self-inflicted.
 *
 * The waker publishes a small JSON file (see `src/waker-status.ts` in the
 * repo root) with the number of turns in flight and the time it said so. This
 * module reads it and answers one question. The answer defaults to BUSY, and
 * every route to an answer other than "the file says zero and the file is
 * fresh" also lands on busy:
 *
 *   file missing            → busy. The waker is not running, or has never
 *                             run. Either way nothing can vouch for the
 *                             container.
 *   file unreadable         → busy.
 *   malformed JSON          → busy. Includes the torn-read case, which the
 *                             waker's atomic rename should prevent and which
 *                             is not worth trusting it to.
 *   timestamp older than
 *   idle.staleSeconds       → busy. THIS IS THE IMPORTANT ONE. A crashed
 *                             waker leaves a file on disk that says
 *                             `liveCount: 0` and keeps saying it forever. A
 *                             stale zero is the most dangerous value in this
 *                             system: it is the one that reads as permission.
 *   timestamp in the future → busy, and complain. Clock skew between two
 *                             processes on the same host should be impossible;
 *                             if it happens the staleness check is meaningless
 *                             and the safe reading is "I do not know".
 *   liveCount > 0           → busy, obviously.
 *
 * Failing to busy costs a delayed deploy, which is annoying. Failing to idle
 * costs someone's conversation, which is the thing we are trying to stop
 * happening by accident.
 */

import { readFileSync, statSync } from 'node:fs';

export type IdleVerdict = {
  idle: boolean;
  /** Why, in words, for the journal. Always populated. */
  reason: string;
  /** Turns in flight, when known. */
  liveCount: number | null;
  /** Age of the status file in seconds, when known. */
  ageSeconds: number | null;
};

/**
 * Ceiling on the status file's size.
 *
 * It said "It is four fields" until 2026-08-18, by which point it was eight —
 * a sentence that stayed true for a while and then quietly was not, which is
 * the failure mode the build-identity work was for and is worth not repeating
 * here. So: it is a small JSON object, and **one of its fields is now
 * `build`**, which carries the commit the waker was compiled from.
 *
 * Crossing this line does not merely lose a reading. It returns `idle: false`,
 * so the instance is never seen as idle — and because `build` is a compiled-in
 * constant, an oversized one is the SAME every publish, for the life of that
 * artefact, while the reason blames the waker for an implausible write. That is
 * why `scripts/build-info.mjs` caps every string it emits and caps `dirtyFiles`
 * rather than trusting a tree to be small, and why test/build-info.test.js
 * checks the worst case against the number below. Change either and that test
 * fails, which is the point of it.
 */
const MAX_STATUS_BYTES = 8 * 1024;

/**
 * Note the trust boundary: this file is written by the waker, which runs as
 * the host user, not by the agent. That is enforced by *where the file lives*
 * — outside every bind mount in docker/run-container.sh — and both config
 * loaders refuse to start if it is placed inside one. Nothing in this function
 * can tell the difference, which is why the check is made where it can be.
 */
export function readIdle(path: string, staleSeconds: number, now = Date.now()): IdleVerdict {
  let raw: string;
  try {
    const stat = statSync(path);
    if (stat.size > MAX_STATUS_BYTES) {
      return {
        idle: false,
        reason: `waker status file ${path} is ${stat.size} bytes — implausible, treating as busy`,
        liveCount: null,
        ageSeconds: null,
      };
    }
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      idle: false,
      reason:
        code === 'ENOENT'
          ? `no waker status at ${path} — the waker is not running, so nothing can say ` +
            'whether a turn is in flight'
          : `cannot read ${path}: ${String(error)}`,
      liveCount: null,
      ageSeconds: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      idle: false,
      reason: `waker status at ${path} is not valid JSON — treating as busy`,
      liveCount: null,
      ageSeconds: null,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      idle: false,
      reason: `waker status at ${path} is not a JSON object — treating as busy`,
      liveCount: null,
      ageSeconds: null,
    };
  }

  const body = parsed as Record<string, unknown>;
  const at = body['at'];
  const liveCount = body['liveCount'];

  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return {
      idle: false,
      reason: `waker status at ${path} has no usable "at" timestamp — treating as busy`,
      liveCount: null,
      ageSeconds: null,
    };
  }
  if (typeof liveCount !== 'number' || !Number.isInteger(liveCount) || liveCount < 0) {
    return {
      idle: false,
      reason: `waker status at ${path} has no usable "liveCount" — treating as busy`,
      liveCount: null,
      ageSeconds: null,
    };
  }

  const ageSeconds = (now - at) / 1000;

  if (ageSeconds < -5) {
    return {
      idle: false,
      reason:
        `waker status at ${path} is stamped ${Math.abs(ageSeconds).toFixed(0)}s in the FUTURE. ` +
        'Two processes on one host disagree about the time, so the staleness check means ' +
        'nothing — treating as busy.',
      liveCount,
      ageSeconds,
    };
  }

  if (ageSeconds > staleSeconds) {
    return {
      idle: false,
      reason:
        `waker status at ${path} is ${ageSeconds.toFixed(0)}s old (stale after ${staleSeconds}s). ` +
        `It says liveCount=${liveCount}, but a waker that stopped publishing cannot be ` +
        'believed about that — treating as busy.',
      liveCount,
      ageSeconds,
    };
  }

  if (liveCount > 0) {
    return {
      idle: false,
      reason: `${liveCount} turn(s) in flight as of ${ageSeconds.toFixed(0)}s ago`,
      liveCount,
      ageSeconds,
    };
  }

  return {
    idle: true,
    reason: `no turns in flight, published ${ageSeconds.toFixed(0)}s ago`,
    liveCount,
    ageSeconds,
  };
}
