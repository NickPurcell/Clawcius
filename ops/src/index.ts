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
    `pid ${process.pid}; state ${config.stateDir}; spools ` +
    `${config.instances.map((i) => `${i.name}=${i.opsSpoolDir}`).join(', ') || '(NONE)'}; ` +
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

// Deprecation notices go in the journal, not just to stdout, because the whole
// argument for tolerating the old `spoolDir` key rather than refusing to boot
// on it is that the operator gets a durable record saying it was tolerated and
// what it was taken to mean. A warning that only reaches the systemd journal
// rotates away; this one is in journal.jsonl next to the operations it
// governed. See migrateLegacySpoolDir() in config.ts.
for (const notice of config.deprecations) {
  executor.journal.write({ kind: 'boot', what: 'config deprecation', detail: notice });
}

if (executor.state.state.frozen) {
  process.stderr.write(
    `[ops] ══ FROZEN ══ ${executor.state.state.frozenReason}\n` +
      `[ops] Frozen since ${new Date(executor.state.state.frozenAt).toISOString()}. ` +
      'Destructive verbs are refused. Clear it with ops/unfreeze.sh once you know why.\n',
  );
}

executor.restoreDeadlines();

/**
 * One spool per instance, watched concurrently.
 *
 * They are separate `OpsSpool` objects rather than one watcher over a parent
 * directory, and that is the design rather than an implementation detail: the
 * directory a request arrives in is the ONLY evidence of who filed it, so each
 * watcher has to know whose it is and stamp that onto everything it emits. A
 * single watcher over a glob of `/var/lib/<instance>/run/ops` would have to
 * derive the instance from the path, which is string parsing on a
 * security-relevant fact.
 *
 * They are also physically separate mounts. `docker/run-container.sh` gives
 * each container `$CLAWCIUS_STATE/run` and nothing else, so a container can
 * write into exactly one of these directories no matter what it does. That is
 * what makes the provenance unforgeable, and it is the same property that made
 * the old single spool unreachable from Hamachi — the mount asymmetry was
 * always there; this is the first version that uses it instead of tripping
 * over it.
 */
const spools = config.instances.map(
  (instance) =>
    new OpsSpool({
      dir: instance.opsSpoolDir,
      instance: instance.name,
      // The spool should end up owned by whoever owns the instance's state
      // directory — that is the uid the container runs as. See ensureSpoolDir.
      ownerOf: instance.stateDir,
      maxBytes: config.limits.maxRequestBytes,
      maxPerSweep: config.limits.maxPerSweep,
      maxFiles: config.limits.maxSpoolFiles,
      pollSeconds: config.pollSeconds,
      log: (line) => process.stdout.write(`[ops spool ${instance.name}] ${line}\n`),
      onRequest: (raw) => executor.intake(raw),
    }),
);

for (const spool of spools) spool.start();

if (spools.length === 0) {
  // Not fatal — the deadlines and the breaker still need this process — but
  // said as loudly as anything in here, because an executor with no spools is
  // a daemon nobody can talk to, and it looks exactly like a quiet night.
  process.stderr.write(
    '[ops] NO INSTANCES CONFIGURED — there are no spools to watch and no agent can file ' +
      'a request. Deadlines and the breaker still run. Add entries under instances: in ' +
      'ops-config.yaml.\n',
  );
}

process.stdout.write(
  `${spools
    .map((spool) => `[ops] watching ${spool.dir} for ${spool.instance} (sweep ${config.pollSeconds}s)\n`)
    .join('')}` +
    `[ops] journal ${executor.journal.path}\n` +
    `[ops] status   ${executor.journal.statusPath}\n`,
);

function shutdown(signal: string): void {
  process.stdout.write(`[ops] ${signal} received, shutting down\n`);
  for (const spool of spools) spool.stop();
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
