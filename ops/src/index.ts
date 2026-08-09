/**
 * clawcius-ops — the host-side executor.
 *
 * Watches a bind-mounted spool directory that the sandboxed agents write into,
 * and performs a fixed list of privileged operations on their behalf. It has no
 * Discord connection, no Anthropic credential and no model; see executor.ts for
 * why each of those absences is deliberate.
 *
 * It ships with `dryRun: true`. First deploy of a daemon holding docker and
 * systemctl should be watched before it is trusted, and in dry-run every
 * decision is made and logged exactly as it would be, with the argv it would
 * have executed, and nothing runs. Read a week of that log, then turn it off.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { loadOpsConfig } from './config.js';
import { Executor } from './executor.js';
import { OpsSpool } from './spool.js';

const config = loadOpsConfig();

/**
 * One executor per host, enforced with a lock file.
 *
 * systemd already guarantees one instance of the unit, so this is not for the
 * supervised case — it is for the incident case, where someone is on the box
 * at 2am and runs `npm start` by hand next to the running service. Two
 * processes holding "one operation at a time" locks that do not know about
 * each other is two concurrent docker operations, and both would be writing
 * the same state.json.
 */
function takeLock(stateDir: string): () => void {
  mkdirSync(stateDir, { recursive: true, mode: 0o750 });
  const path = join(stateDir, 'executor.lock');

  const claim = (): number | null => {
    try {
      // 'wx' — exclusive create. Fails if it already exists, which is the
      // whole mechanism.
      return openSync(path, 'wx', 0o640);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return null;
    }
  };

  let fd = claim();

  if (fd === null) {
    // Stale lock from a process that was killed. Believe it only if the pid it
    // names is genuinely gone — `kill -0` rather than a timestamp, because a
    // long idle-wait legitimately looks like a hung process from outside.
    let holder = 0;
    try {
      holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    } catch {
      holder = 0;
    }

    let alive = false;
    if (Number.isInteger(holder) && holder > 0) {
      try {
        process.kill(holder, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }

    if (alive) {
      throw new Error(
        `another clawcius-ops is running as pid ${holder} (lock: ${path}). Refusing to ` +
          'start a second one: two executors would each believe they hold the "one ' +
          'operation at a time" lock, and both would be writing the same state.json.',
      );
    }

    process.stderr.write(
      `[ops] removing a stale lock left by pid ${holder || '(unknown)'} — that process is gone\n`,
    );
    unlinkSync(path);
    fd = claim();
    if (fd === null) {
      throw new Error(`could not take ${path} even after clearing a stale lock`);
    }
  }

  writeSync(fd, `${process.pid}\n`);
  closeSync(fd);

  return () => {
    try {
      unlinkSync(path);
    } catch {
      /* going away anyway */
    }
  };
}

const releaseLock = takeLock(config.stateDir);

const executor = new Executor(config);

executor.journal.write({
  kind: 'boot',
  what: 'clawcius-ops',
  dryRun: config.dryRun,
  detail:
    `pid ${process.pid}; spool ${config.spoolDir}; state ${config.stateDir}; ` +
    `${config.units.length} unit(s), ${config.repos.length} repo(s), ` +
    `${config.instances.length} instance(s) allowlisted; ` +
    `deadline ${config.deadline.minutes}m (auto-rollback ` +
    `${config.deadline.autoRollback ? 'on' : 'off'}); ` +
    `breaker freezes after ${config.breaker.maxConsecutiveFailedRecoveries} consecutive ` +
    `failed recoveries. ` +
    (config.dryRun
      ? 'DRY RUN — every decision is made and logged, nothing is executed.'
      : 'LIVE — this process will run systemctl and docker for real.'),
});

if (executor.state.state.frozen) {
  process.stderr.write(
    `[ops] ══ FROZEN ══ ${executor.state.state.frozenReason}\n` +
      `[ops] Frozen since ${new Date(executor.state.state.frozenAt).toISOString()}. ` +
      'Destructive verbs are refused. Clear it with ops/unfreeze.sh once you know why.\n',
  );
}

executor.restoreDeadlines();

const spool = new OpsSpool({
  dir: config.spoolDir,
  maxBytes: config.limits.maxRequestBytes,
  maxPerSweep: config.limits.maxPerSweep,
  maxFiles: config.limits.maxSpoolFiles,
  pollSeconds: config.pollSeconds,
  log: (line) => process.stdout.write(`[ops spool] ${line}\n`),
  onRequest: (raw) => executor.intake(raw),
});
spool.start();

process.stdout.write(
  `[ops] watching ${config.spoolDir} (sweep ${config.pollSeconds}s)\n` +
    `[ops] journal ${executor.journal.path}\n` +
    `[ops] status   ${executor.journal.statusPath}\n`,
);

function shutdown(signal: string): void {
  process.stdout.write(`[ops] ${signal} received, shutting down\n`);
  spool.stop();
  executor.stop();
  releaseLock();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  // Logged, never fatal. An unhandled rejection in a verb handler must not
  // take down the process that holds the rollback deadlines.
  process.stderr.write(`[ops] unhandled rejection: ${String(reason)}\n`);
});
