/**
 * Entry point for `clawcius-snapshot-verify.service`.
 *
 * A oneshot, run by a timer, deliberately separate from the executor daemon.
 * Two reasons, and the second is the real one:
 *
 *   A restore test takes minutes and starts a multi-gigabyte container. Doing
 *   it inside the executor would either block the operation lock for the whole
 *   time — so a verify running at 04:00 would defer a rollback triggered at
 *   04:01 — or run outside it, which would mean two docker operations
 *   overlapping, which is the thing the lock exists to prevent.
 *
 *   And the verifier is the thing you most want to still work when the
 *   executor is frozen. A freeze means a build is failing and the rollback
 *   path matters more than usual; that is precisely the wrong moment for the
 *   only process that tests the rollback path to be stopped.
 *
 * It writes its outcome into the same journal, so a failed restore shows up in
 * ops-status.json next to everything else — a verify failure is not
 * interesting on its own, it is interesting *next to* the rollback that is
 * about to depend on it.
 *
 * Exit code is 1 on any failure, so systemd marks the unit failed and
 * `systemctl --failed` shows it. That is the loud part: a verifier whose
 * failures only appear in a log file is a verifier nobody reads.
 */

import { loadOpsConfig } from './config.js';
import { Journal } from './journal.js';
import { Runner } from './runner.js';
import { verifyAll } from './verify.js';

const config = loadOpsConfig();

if (!config.snapshotVerify.enabled) {
  process.stdout.write('[ops verify] snapshotVerify.enabled is false — nothing to do\n');
  process.exit(0);
}

if (config.snapshotVerify.instances.length === 0) {
  // Not a silent success. An empty list means nobody is testing any restore
  // path, which is the state this service was written to end.
  process.stderr.write(
    '[ops verify] snapshotVerify.instances is empty, so no restore path is being tested ' +
      'at all. That is the gap this timer exists to close — list the instances in ' +
      'ops-config.yaml.\n',
  );
  process.exit(1);
}

const runner = new Runner(config.dryRun, config.limits.commandTimeoutSeconds, (line) =>
  process.stdout.write(`[ops verify] ${line}\n`),
);

// The verifier does not hold executor state, so the snapshot it publishes is a
// stub — it must not clobber the daemon's view of pending deadlines and the
// breaker. It only appends journal entries.
const journal = new Journal(config.stateDir, () => ({
  current: 'snapshot-verify',
  queued: 0,
  frozen: false,
  frozenReason: '',
  dryRun: config.dryRun,
  // Empty rather than the real list: this process watches no spools, and a
  // status file claiming otherwise would be the verifier lying about the
  // daemon's state on the one page an operator reads to check it.
  spools: [],
  pendingCheckins: [],
  quarantined: [],
  consecutiveFailedRecoveries: 0,
  lastVerify: null,
}));

const outcomes = await verifyAll(config, runner);

let failed = 0;
for (const outcome of outcomes) {
  if (!outcome.ok) failed += 1;
  journal.write({
    kind: 'verify',
    what: `snapshot-verify ${outcome.instance}${outcome.tag ? ` ${outcome.tag}` : ''}`,
    instance: outcome.instance,
    ok: outcome.ok,
    dryRun: config.dryRun,
    detail: outcome.detail,
  });
  if (!outcome.ok) {
    process.stderr.write(
      `[ops verify] ══ RESTORE TEST FAILED ══ ${outcome.instance}: ${outcome.detail}\n` +
        '[ops verify] An automatic rollback of this instance would not work today.\n',
    );
  }
}

process.stdout.write(
  `[ops verify] ${outcomes.length - failed}/${outcomes.length} instance(s) have a working ` +
    `restore path${config.dryRun ? ' (DRY RUN — nothing was actually restored)' : ''}\n`,
);

process.exit(failed > 0 ? 1 : 0);
