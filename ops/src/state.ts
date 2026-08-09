/**
 * The executor's memory: quarantined builds, armed deadlines, the freeze.
 *
 * All of it persists, and persistence is the whole point rather than a
 * convenience. The three things this file holds are precisely the three things
 * a restart would otherwise erase, and erasing any of them turns a safety
 * mechanism into a delay:
 *
 *   **Quarantined builds.** A build that has already been rolled back once
 *   must never be deployed again. Held in memory, that rule survives until the
 *   next `systemctl restart clawcius-ops` — which, note, is a thing the agent
 *   can ask for. An agent that can clear the breaker by restarting the process
 *   that holds it does not have a breaker.
 *
 *   **Pending check-ins.** A destructive operation arms a deadline. If the
 *   executor is restarted inside that window — plausible, since a rebuild is
 *   exactly when someone is fiddling with the host — the deadline has to come
 *   back with it, or a failed rebuild simply never gets rolled back and the
 *   instance stays down with nobody waiting on it.
 *
 *   **The freeze.** After too many consecutive failed recoveries the executor
 *   stops. That has to survive a restart most of all, because the natural
 *   reaction to a stuck daemon is to restart it, and a freeze that clears on
 *   restart would hand the loop straight back.
 *
 * Written atomically by rename. Read once at boot; a malformed file is
 * REPORTED AND KEPT, not silently replaced with an empty one — losing the
 * quarantine list because a disk glitch truncated a JSON file is the failure
 * this whole module exists to prevent, so it fails to start instead and asks
 * for a human.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A build that was rolled back and must not be deployed again. */
export type Quarantine = {
  instance: string;
  /**
   * Build identity: the `buildRepo` HEAD sha where one is configured,
   * otherwise the image id. Both are stable descriptions of "the same bytes",
   * which is what must not be retried — a *new* commit is a different build
   * and is allowed through, because a fix is a new build.
   */
  build: string;
  at: number;
  reason: string;
};

/** A destructive operation waiting to hear that the instance came back. */
export type PendingCheckin = {
  instance: string;
  /** Epoch ms after which no check-in means roll back. */
  deadlineAt: number;
  /** What was done, in words, for the wake and the journal. */
  reason: string;
  /** The build that was deployed, quarantined if this deadline is missed. */
  build: string;
  /**
   * Snapshot tag to roll back TO. Captured before the operation, because
   * afterwards the newest snapshot may well be one taken of the broken build.
   */
  rollbackTag: string;
  /**
   * True when this deadline was armed by a rollback rather than a deploy.
   *
   * Deliberately never set today, and the reason is in the executor: an
   * automatic rollback does NOT arm a new deadline, because a deadline whose
   * expiry triggers another rollback is a loop with a timer on it. Kept in the
   * shape so that a future change has to look at this comment first.
   */
  fromRollback: boolean;
  armedAt: number;
};

export type ExecutorState = {
  version: 1;
  quarantined: Quarantine[];
  pending: PendingCheckin[];
  consecutiveFailedRecoveries: number;
  frozen: boolean;
  frozenReason: string;
  frozenAt: number;
};

const EMPTY: ExecutorState = {
  version: 1,
  quarantined: [],
  pending: [],
  consecutiveFailedRecoveries: 0,
  frozen: false,
  frozenReason: '',
  frozenAt: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class StateStore {
  #path: string;
  #state: ExecutorState;
  #maxQuarantined: number;

  constructor(stateDir: string, maxQuarantined: number) {
    this.#path = join(stateDir, 'state.json');
    this.#maxQuarantined = maxQuarantined;
    mkdirSync(stateDir, { recursive: true, mode: 0o750 });
    this.#state = this.#load();
  }

  get path(): string {
    return this.#path;
  }

  get state(): Readonly<ExecutorState> {
    return this.#state;
  }

  #load(): ExecutorState {
    if (!existsSync(this.#path)) return structuredClone(EMPTY);

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, 'utf8'));
    } catch (error) {
      throw new Error(
        `${this.#path} is not valid JSON (${String(error)}). Refusing to start: this file ` +
          'holds the quarantine list and any armed rollback deadline, and starting with ' +
          'an empty one would silently re-enable a build that has already failed. ' +
          'Inspect it, fix it, or move it aside deliberately.',
      );
    }

    if (!isRecord(parsed)) {
      throw new Error(`${this.#path} does not contain a JSON object. Refusing to start.`);
    }
    if (parsed['version'] !== 1) {
      throw new Error(
        `${this.#path} has version ${String(parsed['version'])}, expected 1. Refusing to start.`,
      );
    }

    const quarantined = Array.isArray(parsed['quarantined'])
      ? (parsed['quarantined'].filter(isRecord) as unknown as Quarantine[])
      : [];
    const pending = Array.isArray(parsed['pending'])
      ? (parsed['pending'].filter(isRecord) as unknown as PendingCheckin[])
      : [];

    return {
      version: 1,
      quarantined: quarantined.filter(
        (entry) => typeof entry.instance === 'string' && typeof entry.build === 'string',
      ),
      pending: pending.filter(
        (entry) => typeof entry.instance === 'string' && typeof entry.deadlineAt === 'number',
      ),
      consecutiveFailedRecoveries:
        typeof parsed['consecutiveFailedRecoveries'] === 'number'
          ? parsed['consecutiveFailedRecoveries']
          : 0,
      frozen: parsed['frozen'] === true,
      frozenReason: typeof parsed['frozenReason'] === 'string' ? parsed['frozenReason'] : '',
      frozenAt: typeof parsed['frozenAt'] === 'number' ? parsed['frozenAt'] : 0,
    };
  }

  #save(): void {
    const temp = join(dirname(this.#path), `.state.${process.pid}.tmp`);
    writeFileSync(temp, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o640 });
    renameSync(temp, this.#path);
  }

  // ── Quarantine ──────────────────────────────────────────────────────────

  isQuarantined(instance: string, build: string): Quarantine | null {
    if (!build) return null;
    return (
      this.#state.quarantined.find(
        (entry) => entry.instance === instance && entry.build === build,
      ) ?? null
    );
  }

  quarantine(instance: string, build: string, reason: string): void {
    if (!build) return;
    if (this.isQuarantined(instance, build)) return;
    this.#state.quarantined.push({ instance, build, at: Date.now(), reason });
    // Oldest out first. The cap is generous enough that a build cannot age out
    // of the list inside any plausible incident, and the alternative —
    // unbounded — is a file that grows forever on a host that runs for years.
    while (this.#state.quarantined.length > this.#maxQuarantined) {
      this.#state.quarantined.shift();
    }
    this.#save();
  }

  // ── Pending check-ins ───────────────────────────────────────────────────

  pendingFor(instance: string): PendingCheckin | null {
    return this.#state.pending.find((entry) => entry.instance === instance) ?? null;
  }

  arm(pending: PendingCheckin): void {
    // One per instance. A second destructive operation on an instance that
    // already owes a check-in cannot happen — the lock serialises operations
    // and the deadline outlives the lock — but if it ever did, the newest
    // deadline is the one that describes the running build.
    this.#state.pending = this.#state.pending.filter(
      (entry) => entry.instance !== pending.instance,
    );
    this.#state.pending.push(pending);
    this.#save();
  }

  disarm(instance: string): PendingCheckin | null {
    const found = this.pendingFor(instance);
    if (!found) return null;
    this.#state.pending = this.#state.pending.filter((entry) => entry.instance !== instance);
    this.#save();
    return found;
  }

  // ── Breaker ─────────────────────────────────────────────────────────────

  recordRecoverySuccess(): void {
    if (this.#state.consecutiveFailedRecoveries === 0) return;
    this.#state.consecutiveFailedRecoveries = 0;
    this.#save();
  }

  /** Returns the new count. */
  recordRecoveryFailure(): number {
    this.#state.consecutiveFailedRecoveries += 1;
    this.#save();
    return this.#state.consecutiveFailedRecoveries;
  }

  freeze(reason: string): void {
    if (this.#state.frozen) return;
    this.#state.frozen = true;
    this.#state.frozenReason = reason;
    this.#state.frozenAt = Date.now();
    this.#save();
  }

  /**
   * Clear the freeze. There is deliberately no verb for this.
   *
   * Unfreezing is a human decision made after looking at why it froze, so it
   * is `ops/unfreeze.sh` on the host and not something the agent can ask for —
   * an agent that can unfreeze the breaker that is holding back its own broken
   * build is back where we started.
   */
  unfreeze(): void {
    this.#state.frozen = false;
    this.#state.frozenReason = '';
    this.#state.frozenAt = 0;
    this.#state.consecutiveFailedRecoveries = 0;
    this.#save();
  }
}
