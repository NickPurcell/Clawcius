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
import {
  BANNER,
  CONSEQUENCE,
  journalWhat,
  summariseVerify,
  verifyAll,
} from './verify.js';

/**
 * This oneshot is ALWAYS LIVE. It does not read `config.dryRun`, and setting
 * `OPS_DRY_RUN` in its environment changes nothing.
 *
 * ── Why this is not simply "follow the executor" ──────────────────────────
 *
 * Until 2026-08-20 this file built its Runner with `config.dryRun`, which was
 * fine only because both processes read the same file. Once `dryRun` became a
 * per-machine setting carried in the executor's own systemd drop-in (see
 * `DryRunSource` in config.ts), the two units silently disagreed: the executor
 * got the deviation and this one did not, so on a host running live the verifier
 * would have gone on reading the tracked `dryRun: true` for ever.
 *
 * Copying the deviation into a second place would have fixed the symptom and
 * kept the disease — two files carrying the same setting, drifting apart the
 * next time one of them is edited, which is the exact arrangement this change
 * set out to remove. So the answer is that this process has no dry-run mode at
 * all, for two reasons:
 *
 * **There is nothing here for dry run to protect.** Everything this oneshot
 * does to the machine is `docker run` of a restored snapshot into a throwaway
 * container it names, creates and removes — no `--restart`, no `--env-file`, no
 * `-v`, on the internal network under gVisor (`verify.ts`). It touches no live
 * instance, no unit and no spool. "Describe instead of doing" is not a safety
 * property here; it is the absence of the only thing this unit does.
 *
 * **And a dry-run verify is worse than no verify.** `verify.ts` returns
 * `ok: true, finding: 'dry-run'` for a healthy instance, the loop below counts
 * only failures, and this process exits 0 — so systemd marks the oneshot
 * successful and `systemctl --failed` stays clean while nothing was restored
 * and nothing was proven. That is the same defect as an unbounded start limit
 * on `clawcius-ops`: a failure that never reaches `failed` is invisible to the
 * one channel anyone here watches. It arrives as a green light rather than a
 * silent loop, which is worse, because `verifyAll` has exactly one non-test
 * caller — this one — and nothing else in the repository ever attempts a
 * restore. Staleness would still be measured, since `docker images` is a probe
 * and runs in either mode, so what a dry-run verify silently drops is precisely
 * "does the newest image restore and start".
 *
 * `verify.ts` keeps its dry-run branch: it is a library, the self-test drives
 * it, and the branch is what makes the paragraph above checkable rather than
 * asserted. It is simply unreachable from this entry point.
 */
const DRY_RUN = false;

const config = loadOpsConfig();

// The mode, in the journal, in the same shape and for the same reason as the
// executor's boot line — `journalctl` is the only channel anyone on this host
// can read, and until now this process said nothing at all about which mode it
// ran in. Unlike the executor's, this clause names no input, because there is
// no input: the answer does not depend on the file, the environment or the
// host.
process.stdout.write(
  `[ops verify] SETTING: dryRun=false, always — this oneshot has no dry-run mode. It ` +
    'ignores OPS_DRY_RUN and the dryRun: key in ops-config.yaml, which between them would ' +
    `have resolved to ${config.dryRun} here (${config.dryRunSource.from}). It restores into ` +
    'a throwaway container it creates and removes, so there is nothing here for dry run to ' +
    'protect, and a dry-run verify would exit 0 having proved no restore path at all. See ' +
    'verify-main.ts. The EXECUTOR sets its own mode separately and this line says nothing ' +
    'about it: `journalctl -u clawcius-ops | grep "SETTING: dryRun"` is where that answer is.\n',
);

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

const runner = new Runner(DRY_RUN, config.limits.commandTimeoutSeconds, (line) =>
  process.stdout.write(`[ops verify] ${line}\n`),
);

// The verifier does not hold executor state, so the snapshot it publishes is a
// stub — it must not clobber the daemon's view of pending deadlines and the
// breaker. It only appends journal entries.
const journal = new Journal(config.stateDir, () => ({
  current: 'snapshot-verify',
  frozen: false,
  frozenReason: '',
  // THIS PROCESS'S mode, which is always false — not the executor's, which this
  // process cannot know. `current: 'snapshot-verify'` above is what says whose
  // snapshot this is; anything reading `state.dryRun` for the daemon's answer
  // should read the boot line instead.
  //
  // It said `config.dryRun` until 2026-08-20, and once the executor's value
  // moved into its own drop-in that became a claim about a process this one does
  // not share an environment with — the daemon writing `false` and every
  // nightly verify overwriting it with `true`, wrong in the reassuring
  // direction on the most consequential setting on the host. Clawcius #127 is
  // the wider problem: this whole stub replaces the daemon's `state` wholesale
  // on a file stamped `service: clawcius-ops`.
  dryRun: DRY_RUN,
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
    what: journalWhat(outcome),
    instance: outcome.instance,
    ok: outcome.ok,
    dryRun: DRY_RUN,
    detail: outcome.detail,
  });
  if (!outcome.ok) {
    process.stderr.write(
      `[ops verify] ${BANNER[outcome.finding]} ${outcome.instance}: ${outcome.detail}\n` +
        `[ops verify] ${CONSEQUENCE[outcome.finding]}\n`,
    );
  }
}

// Assembled in verify.ts, and tested there. Everything this oneshot prints is
// now a pure function of the outcomes — which is the point, because the report
// IS the deliverable of this change and the summary line was the one piece of
// it that had no test and was the one piece of it that was wrong.
process.stdout.write(`[ops verify] ${summariseVerify(outcomes, DRY_RUN)}\n`);

process.exit(failed > 0 ? 1 : 0);
