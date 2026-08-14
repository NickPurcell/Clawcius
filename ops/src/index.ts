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
import { OpsSpool, ensureDirOwnedBy } from './spool.js';
import { agentProblems, agentWarnings, describeAgentUser } from './agent-user.js';
import { identityOptionsFor } from './host-agent.js';
import { HostMailbox } from './host-mailbox.js';

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
 * Who the host agent is, checked at boot so the answer is in the banner.
 *
 * The boot check is for VISIBILITY. It is not the enforcement point and must
 * not be mistaken for one: `#doTask` re-resolves the account before every task
 * and `runHostAgent` asserts on it again immediately before the spawn, because
 * the failure this whole mechanism exists to catch — somebody typing `usermod
 * -aG docker clawcius-ops` to make something work — happens to a host that is
 * already running, and a check evaluated once at boot on a unit that stays up
 * for weeks would never see it.
 *
 * Note what does NOT happen here: `process.exit(1)`. This unit is
 * `Restart=always` with `StartLimitIntervalSec=0` and `StartLimitBurst=0` — it
 * holds the rollback deadlines and must never stay dead — so refusing the boot
 * would not produce one loud failure, it would produce a root daemon in a
 * five-second restart loop with every armed deadline unhonoured. That is the
 * shape of #7 and this repository has agreed twice not to ship it again. The
 * daemon comes up, holds its deadlines, answers check-ins, performs rollbacks,
 * and refuses every task with the reason and the fix — which is exactly the
 * behaviour `hostAgent.enabled: false` already has, and which this codebase
 * already argues is strictly better than stopping the unit.
 */
const identity = executor.resolveAgentIdentity();
if (config.hostAgent.enabled) {
  if (!identity.ok) {
    process.stderr.write(
      `[ops] ══ HOST AGENT HAS NO IDENTITY ══\n[ops] ${identity.reason.replace(/\n/g, '\n[ops] ')}\n` +
        '[ops] Every task will be REFUSED until this is fixed. Deadlines, check-ins and\n' +
        '[ops] rollbacks are unaffected and this daemon is staying up. See MIGRATION.md.\n',
    );
  } else {
    const problems = agentProblems(identity.user, identityOptionsFor(config));
    if (problems.length > 0) {
      process.stderr.write(
        `[ops] ══ HOST AGENT ACCOUNT IS NOT CONTAINED ══ ${describeAgentUser(identity.user)}\n` +
          problems.map((problem) => `[ops] ${problem.replace(/\n/g, '\n[ops] ')}`).join('\n') +
          '\n[ops] Every task will be REFUSED until this is fixed. Nothing else is affected.\n',
      );
    }
    for (const warning of agentWarnings(identity.user, identityOptionsFor(config))) {
      process.stderr.write(`[ops] host agent warning: ${warning.replace(/\n/g, '\n[ops] ')}\n`);
    }

    // The session's working directory, created and handed to the AGENT
    // account — not, since 2026-08-11, to the checkout's owner. Created here
    // rather than lazily at the first task, because a task that fails because
    // a directory does not exist fails several seconds into a `claude` spawn
    // with a message about a bad cwd, at the moment somebody was waiting on it.
    ensureDirOwnedBy(
      config.hostAgent.workDir,
      { uid: identity.user.uid, gid: identity.user.gid },
      (line) => process.stdout.write(`[ops host-agent] ${line}\n`),
      0o750,
      `so the host agent (${identity.user.user}) can write its own working directory`,
    );
  }
}

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
          (identity.ok
            ? `${describeAgentUser(identity.user)}` +
              (agentProblems(identity.user, identityOptionsFor(config)).length > 0
                ? ' — REFUSED: that account is not contained; see the banner above and ' +
                  'MIGRATION.md. Tasks will be refused; deadlines and rollbacks continue'
                : '')
            : `NOBODY (${config.hostAgent.user}: ${identity.reason.split('\n')[0]}) — tasks ` +
              'will be refused')
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

/**
 * One mailbox per instance that has a board — CLAWSKY.md phase 6.
 *
 * This is the way in that replaces the spool's scheduling: a coordinator DMs
 * `<crew>-host` and the session runs, now. The spools above are left running
 * and inert rather than deleted, so a rollback to the previous `dist/` does not
 * strand a request format that nothing reads.
 *
 * A mailbox that cannot be opened is loud and not fatal — same rule as
 * everywhere else in this daemon. It holds the rollback deadlines, and a
 * mistyped database path must not be what takes those with it.
 */
const mailboxes = config.instances.flatMap((instance) => {
  if (!instance.board) return [];
  if (!config.hostAgent.enabled) {
    process.stderr.write(
      `[ops] instances[${instance.name}].board is configured but hostAgent.enabled is ` +
        'false, so no mailbox is opened. A coordinator DMing the host agent would be told ' +
        'there is no such recipient, which is the honest answer.\n',
    );
    return [];
  }
  try {
    return [
      new HostMailbox({
        dbPath: instance.board.db,
        crew: instance.board.crew,
        instance: instance.name,
        workDir: config.hostAgent.workDir,
        pollSeconds: config.pollSeconds,
        run: (task) => executor.runMailTask(task),
        log: (line) => process.stdout.write(`[ops mail ${instance.name}] ${line}\n`),
      }),
    ];
  } catch (error) {
    process.stderr.write(
      `[ops] ══ NO HOST MAILBOX FOR ${instance.name} ══\n[ops] ${String(error)}\n` +
        '[ops] That crew\'s coordinator cannot reach the host agent by DM. Everything else\n' +
        '[ops] about this daemon is unaffected.\n',
    );
    return [];
  }
});

for (const mailbox of mailboxes) mailbox.start();

if (mailboxes.length === 0 && config.hostAgent.enabled) {
  process.stderr.write(
    '[ops] NO HOST MAILBOX ON ANY INSTANCE — the host agent has no Clawsky identity, so no ' +
      'coordinator can DM it. Add a board: block with db: and crew: under the instance in ' +
      'ops-config.yaml. The ops spool still works.\n',
  );
}

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
  for (const mailbox of mailboxes) mailbox.stop();
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
