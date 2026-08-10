/**
 * clawcius-ops — the host-side executor.
 *
 * Watches one bind-mounted spool per instance, and carries out the tasks the
 * sandboxed agents file there by handing each one to a headless Claude Code
 * session on the host: snapshot first, audit every command, health-check after,
 * roll back if it went wrong.
 *
 * It has no Discord connection and files no messages. Since 2026-08-10 it DOES
 * have a model — the sentence that used to be here said it never would, and
 * ops/src/host-agent.ts is the whole account of why that changed, what was
 * given up, and what was put in its place. Read that before this.
 *
 * It ships with `dryRun: true`, and in this mode the session is not asked
 * nicely: Bash and every other tool that can change the machine is removed from
 * it by the permission system, so it can look and plan and cannot act. Read a
 * week of that log, then turn it off.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { loadOpsConfig } from './config.js';
import { Executor } from './executor.js';
import { OpsSpool, ensureOwnedDir } from './spool.js';
import { resolveOwner } from './build.js';

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

/**
 * The host agent's working directory, created and handed to the checkout owner.
 *
 * Created here rather than lazily at the first task, because a task that fails
 * because a directory does not exist fails several seconds into a `claude`
 * spawn with a message about a bad cwd, at the moment somebody was waiting on
 * it. Doing it at boot means the failure — if there is one — is in the boot
 * banner where it belongs.
 *
 * Root-owned would be useless: the session runs as the checkout's owner, so it
 * is chowned to match, exactly as the spools are, with the ownership discovered
 * by stat rather than configured.
 */
const ownerOfCheckout = config.repos[0]?.path ?? '';
if (config.hostAgent.enabled) {
  if (!ownerOfCheckout) {
    process.stderr.write(
      '[ops] hostAgent.enabled is true but no repos: are configured, so there is no ' +
        'checkout to take an owner from. Every task will be refused rather than run a ' +
        'session with a shell as root.\n',
    );
  } else {
    ensureOwnedDir(
      config.hostAgent.workDir,
      ownerOfCheckout,
      (line) => process.stdout.write(`[ops host-agent] ${line}\n`),
      0o750,
    );
  }
}

const owner = ownerOfCheckout ? resolveOwner(ownerOfCheckout) : null;

executor.journal.write({
  kind: 'boot',
  what: 'clawcius-ops',
  dryRun: config.dryRun,
  detail:
    `pid ${process.pid}; state ${config.stateDir}; spools ` +
    `${config.instances.map((i) => `${i.name}=${i.opsSpoolDir}`).join(', ') || '(NONE)'}; ` +
    `${config.units.length} unit(s) and ${config.instances.length} container(s) health-` +
    `checked around every task; ${config.repos.length} repo(s) in the briefing; ` +
    `deadline ${config.deadline.minutes}m (auto-rollback ` +
    `${config.deadline.autoRollback ? 'on' : 'off'}); ` +
    `breaker freezes after ${config.breaker.maxConsecutiveFailedRecoveries} consecutive ` +
    `failed recoveries; snapshots kept: ${config.snapshotKeep}. ` +
    `HOST AGENT: ${
      config.hostAgent.enabled
        ? `${config.hostAgent.claudePath}, up to ${config.hostAgent.timeoutMinutes}m and ` +
          `$${config.hostAgent.maxCostUsd} per task, cwd ${config.hostAgent.workDir}, as ` +
          `${owner?.ok ? `${owner.owner.user} (uid ${owner.owner.uid})` : 'NOBODY — tasks will be refused'}`
        : 'DISABLED — tasks refused, deadlines and rollbacks still honoured'
    }. ` +
    (config.dryRun
      ? 'DRY RUN — the session has no Bash tool and cannot execute anything; it plans and ' +
        'the plan is logged.'
      : 'LIVE — a Claude Code session with a shell and sudo will run on this host, and ' +
        'every command it issues is written into journal.jsonl before its result is known.'),
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
