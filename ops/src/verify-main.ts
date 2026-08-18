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

// FIRST, and it must stay first. A oneshot rather than a long-lived service,
// and it gets the same line for the same reason: it runs out of the same
// `dist/` as the daemon, so it is subject to the same staleness, and a
// verifier that is itself out of date is worse than no verifier. See
// build-banner.ts.
import './build-banner.js';

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
  frozen: false,
  frozenReason: '',
  dryRun: config.dryRun,
  // Empty rather than a real list: this process holds no executor state, and a
  // status file claiming otherwise would be the verifier lying about the
  // daemon's state on the one page an operator reads to check it.
  //
  // `queued` and `spools` were written here too until 2026-08-16, and went on
  // being written after they were removed from `OpsStatusSnapshot`, because an
  // object literal returned from an arrow in a contextually typed argument
  // position is not freshness-checked — so the compiler had nothing to say and
  // this oneshot published two keys the type no longer had. Found by OJ in
  // review of #67.
  pendingCheckins: [],
  quarantined: [],
  consecutiveFailedRecoveries: 0,
  lastVerify: null,
  // Reported as configured, so the page does not show a blank where the most
  // consequential setting on this host should be. Nothing else here concerns
  // the host agent: this is a oneshot with no session and there never will be
  // one — it exists to boot a snapshot and prove it comes up.
  hostAgent: {
    enabled: config.hostAgent.enabled,
    claudePath: config.hostAgent.claudePath,
    timeoutMinutes: config.hostAgent.timeoutMinutes,
    maxCostUsd: config.hostAgent.maxCostUsd,
    user: config.hostAgent.user,
    // Reported as configured, NOT resolved. This oneshot never starts a
    // session, so it has no business evaluating the docker-group assertion —
    // and a stub that published `identity.ok: true` from a process that never
    // checked would be the verifier vouching for a property it did not test,
    // on the one page an operator reads to check it.
    identity: {
      ok: false,
      detail:
        'not evaluated: clawcius-snapshot-verify does not start a host agent session and ' +
        'does not check the account. The daemon publishes the real answer.',
    },
  },
  auditedCommands: 0,
  lastTask: null,
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
