/**
 * clawcius-ops — the host-side executor.
 *
 * Holds one mailbox per crew on the Clawsky board, and carries out the tasks a
 * coordinator DMs to `<crew>-host` by handing each one to a headless Claude
 * Code session on the host: audit every command, health-check either side,
 * answer by DM.
 *
 * It watched a bind-mounted spool per instance until 2026-08-16 and no longer
 * does; the spools and everything that fed them are gone, and the account of
 * what went with them is in ops/src/executor.ts.
 *
 * It has no Discord connection and posts no messages. Since 2026-08-10 it DOES
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
import { ensureDirOwnedBy } from './dirs.js';
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
    `pid ${process.pid}; state ${config.stateDir}; ` +
    `${config.units.length} unit(s) and ${config.instances.length} container(s) health-` +
    `checked around every task; ${config.repos.length} repo(s) in the briefing. ` +
    `HOST AGENT: ${
      config.hostAgent.enabled
        ? `${config.hostAgent.claudePath}, up to ${config.hostAgent.timeoutMinutes}m and ` +
          `$${config.hostAgent.maxCostUsd} per task, cwd ${config.hostAgent.workDir}, as ` +
          (identity.ok
            ? `${describeAgentUser(identity.user)}` +
              (agentProblems(identity.user, identityOptionsFor(config)).length > 0
                ? ' — REFUSED: that account is not contained; see the banner above and ' +
                  'MIGRATION.md. Every task will be refused'
                : '')
            : `NOBODY (${config.hostAgent.user}: ${identity.reason.split('\n')[0]}) — tasks ` +
              'will be refused')
        : 'DISABLED — every task is refused'
    }. ` +
    (config.dryRun
      ? 'DRY RUN — the session has no Bash tool and cannot execute anything; it plans and ' +
        'the plan is logged.'
      : 'LIVE — a Claude Code session with a shell and sudo will run on this host, and ' +
        'every command it issues is written into journal.jsonl before its result is known.'),
});

// Deprecation notices go in the journal, not just to stdout, because the whole
// argument for tolerating a retired key rather than refusing to boot on it is
// that the operator gets a durable record saying it was tolerated and what it
// was taken to mean. A warning that only reaches the systemd journal rotates
// away; this one is in journal.jsonl next to the operations it governed.
for (const notice of config.deprecations) {
  executor.journal.write({ kind: 'boot', what: 'config deprecation', detail: notice });
}

if (executor.state.state.frozen) {
  process.stderr.write(
    `[ops] ══ FROZEN ══ ${executor.state.state.frozenReason}\n` +
      `[ops] Frozen since ${new Date(executor.state.state.frozenAt).toISOString()}. ` +
      'Every task is refused. Clear it with ops/unfreeze.sh once you know why. Nothing sets\n' +
      '[ops] this any more — the breaker that did went with the spools — so this freeze\n' +
      '[ops] predates that.\n',
  );
}

executor.reportRetiredDeadlines();

/**
 * One mailbox per instance that has a board — CLAWSKY.md phase 6.
 *
 * The only way in. A coordinator DMs `<crew>-host` and the session runs, now,
 * and the answer comes back as a DM. Until 2026-08-16 there was a second way —
 * a JSON file in a bind-mounted directory per instance, swept on a timer — and
 * it is gone along with everything that stood around it.
 *
 * A mailbox that cannot be opened is loud and not fatal, same rule as
 * everywhere else in this daemon: this process also serves the unit desk and
 * publishes the status file, and a mistyped database path must not be what
 * takes those with it.
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
      'ops-config.yaml. Nothing else can reach this daemon.\n',
  );
}

if (config.instances.length === 0) {
  // Said as loudly as anything in here, because an executor with no instances
  // health-checks nothing and briefs a session about an empty host — and that
  // looks exactly like a quiet night.
  process.stderr.write(
    '[ops] NO INSTANCES CONFIGURED — nothing is health-checked around a task and the ' +
      'briefing will name no containers. Add entries under instances: in ops-config.yaml.\n',
  );
}

process.stdout.write(
  `[ops] journal ${executor.journal.path}\n` +
    `[ops] status   ${executor.journal.statusPath}\n`,
);

/**
 * The reason this process stays running, stated rather than inherited.
 *
 * Until 2026-08-16 nothing here said it, because nothing had to: `OpsSpool`
 * held one ref'd `fs.watch` per instance, so the executor was alive for as long
 * as it had a spool to watch. Retiring the spools removed that handle, and the
 * only ref'd one left was `HostMailbox`'s `fs.watch` — which is not a keepalive,
 * it is an optimisation. Three states end with no ref'd handle at all and, with
 * it, an immediate `EXIT=0`:
 *
 *   - no instance has a `board:` block, which is the shipped state of a fresh
 *     ops-config.yaml and the documented way to run without a mailbox;
 *   - `Board.register()` refuses because `<crew>-host` is held by something
 *     that is not a host agent — a data condition on a live board, not a typo;
 *   - every `watch()` throws. `HostMailbox.start()` catches that and promises
 *     "polling only", and the poller cannot deliver on that promise if the
 *     process has already exited.
 *
 * `clawcius-ops.service` is `Restart=always` with `StartLimitBurst=0`, so an
 * immediate exit is not one loud failure — it is a five-second restart loop,
 * which is the exact shape of #7 and the thing the retired-key handling in
 * config.ts exists to avoid.
 *
 * And it would be a loop over a process that still has work to do. The comment
 * on the mailbox loop above says a mistyped database path "must not be what
 * takes those with it", meaning the unit desk and the status file; that
 * sentence was false for as long as a mailbox was what held the loop open. So
 * the keepalive is explicit, it is ref'd on purpose, and it is cleared in
 * `shutdown()` — the daemon exits because it was asked to, and for no other
 * reason.
 */
const keepalive = setInterval(() => {}, 60_000);

function shutdown(signal: string): void {
  process.stdout.write(`[ops] ${signal} received, shutting down\n`);
  clearInterval(keepalive);
  for (const mailbox of mailboxes) mailbox.stop();
  executor.stop();
  releaseLock();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  // Logged, never fatal. An unhandled rejection while a session is running must
  // not take down the process that has to write down what it did.
  process.stderr.write(`[ops] unhandled rejection: ${String(reason)}\n`);
});
