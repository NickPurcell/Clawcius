/**
 * The executor: one task at a time, audited throughout, health-checked either
 * side.
 *
 * ── What this file used to be, and why it is not that any more ───────────
 *
 * Until 2026-08-10 this was a dispatcher over a closed list of seven verbs,
 * each with its own argument allowlist, and the paragraph below this one said
 * — in bold, twice — that there must never be a model in this service. The
 * argument was: this process runs as root with docker and systemctl, its input
 * comes from containers that read text strangers wrote, and its entire safety
 * case is that the set of things it can do is finite and readable in one
 * sitting.
 *
 * That argument was and is correct. It has been overruled, deliberately, by the
 * operator, who was warned twice and accepted the trade in writing. What
 * happened is in ops/src/host-agent.ts at length; the short version is that
 * standing up three services on the evening of 2026-08-10 took a dozen ad-hoc
 * shell commands the operator had to type himself — chown, mkdir, editing a
 * config, installing units, and above all pasting `journalctl` output back to
 * an agent that could not read it — and not one of them was a verb.
 *
 * ── And what went on 2026-08-16: the spools ──────────────────────────────
 *
 * The second half of that. A request used to arrive as a JSON file in a
 * bind-mounted directory and the answer used to leave as a JSON file in
 * another one, and around those two directories stood a verb parser, a queue,
 * a rolling-hour rate limit, a per-instance scope check, a snapshot of every
 * container in scope, a wait for every container in scope to fall idle, a
 * check-in deadline, an automatic rollback on silence, and a circuit breaker
 * counting the rollbacks. All of it is gone.
 *
 * It is gone because the input is gone. A task arrives as a DM to the host
 * agent — `runMailTask` below — the requester is the mail row's author column,
 * and the answer is a DM back. Nothing files a spool request any more, so
 * every one of those stages had exactly no way to be reached, and code that
 * cannot be reached is not a safety property, it is a decoration that reads as
 * one. The two things that actually stood between a request and the machine
 * were never the queue: they are the unprivileged account with its narrow
 * sudoers file, and the audit written before each command's result is known.
 * Both are untouched.
 *
 * What genuinely went with them is the ability to UNDO. The old path could
 * restore every container in scope to an image taken sixty seconds earlier;
 * this one takes no snapshot, so there is nothing to restore to. That is not an
 * oversight, it is the trade recorded in CLAWSKY.md when the queue was retired,
 * and `runMailTask` says so in the reply rather than leaving a coordinator to
 * find out.
 *
 * ── What this file is now: a supervisor, not a rulebook ──────────────────
 *
 * Everything left is about running one session safely and writing down what it
 * did:
 *
 *   - the lock: one task at a time, and a second one refused with a reason
 *     rather than queued;
 *   - the durable journal, fsynced before each step proceeds;
 *   - a health sample either side, which REPORTS rather than repairs;
 *   - a complete audit. Every Bash command the session issues is written into
 *     journal.jsonl, in full, as it is issued and before its result is known.
 *     That log is the accountability mechanism now. A command that runs and is
 *     not logged is the failure mode that matters, which is why an unparseable
 *     line in the agent's output stream FAILS THE TASK rather than being
 *     skipped;
 *   - a dry-run that cannot act. Not "asked not to": the Bash tool, and every
 *     other tool that can change the machine, is removed from the session by
 *     the permission system. Verified against the real CLI; see host-agent.ts.
 *
 * ── What is honestly NOT protected against ───────────────────────────────
 *
 * Nothing here undoes anything. A task that breaks a container, /etc, the
 * checkout or anything else is undone by the VPS snapshot and by git, by a
 * person. That is the deal, it is written down in ops/README.md, and it should
 * not be discovered here.
 *
 * ── The lock ─────────────────────────────────────────────────────────────
 *
 * One task at a time. Two host agent sessions with sudo, running concurrently
 * on the same box, is not a scenario anybody should have to reason about. A
 * second request is REFUSED, in the turn that asked, and the coordinator can
 * ask again — which is a better answer than a session that starts twenty
 * minutes later next to work it knows nothing about.
 */

import { join } from 'node:path';
import type { InstanceEntry, OpsConfig } from './config.js';
import { Journal, type OpsStatusSnapshot, type TaskSummary } from './journal.js';
import { StateStore } from './state.js';
import { Runner } from './runner.js';
import { readDirty } from './build.js';
import {
  identityOptionsFor,
  runHostAgent,
  sanitiseTask,
  sanitiseTaskText,
  type AuditEvent,
  type HostAgentOutcome,
} from './host-agent.js';
import {
  agentProblems,
  agentWarnings,
  describeAgentUser,
  resolveAgentUser,
  type AgentUser,
  type AgentUserResult,
} from './agent-user.js';
import { ensureDirOwnedBy } from './dirs.js';
import {
  drainUnitRequests,
  unitRequestDir,
  unitResultDir,
  unitStagingDir,
  type UnitOpResult,
} from './units.js';

/**
 * The executor's own unit.
 *
 * There is no longer a `restart` verb to refuse, and this daemon can no longer
 * stop the host agent restarting it — the session has a shell, and `sudo
 * systemctl restart clawcius-ops` is one line. So this constant has changed
 * job: it is named in the host agent's standing prompt as the one unit it must
 * not touch, and it is excluded from the health sample (a process that is
 * running does not need to ask whether it is running).
 *
 * The failure it is warning about is unchanged and is worth restating, because
 * it is now prevented by an instruction rather than by a check: restarting this
 * unit kills the task mid-flight, systemd brings the daemon back with an empty
 * queue, and the operation is simply gone — no failure, no journal entry saying
 * it did not finish. The audit would end mid-sentence and nothing would say why.
 */
const SELF_UNIT = 'clawcius-ops.service';

/**
 * How often the executor looks for a unit-install request from the session, and
 * how many it will carry out for one task.
 *
 * ── Why there is a desk here at all, 2026-08-12 ──────────────────────────
 *
 * The two sudo rules that let the session run `install` and `rm -f` against
 * /etc/systemd/system were deleted on 2026-08-12: a `*` in an argument position
 * is "any number of arguments" to sudo, and GNU install applies flags last-wins,
 * so `install -m 0644 -o root -g root -t /etc/sudoers.d …` matched the rule and
 * was one command to full root. The reasoning is in ops/src/units.ts.
 *
 * Deleting them removes a capability the ops mechanism exists to provide, so it
 * had to be replaced rather than dropped. It is replaced the same way
 * `run-container.sh` and `snapshot.sh` already were: the executor does it
 * itself, as root, with everything but the unit's NAME constructed in code. The
 * session stages the content in its own working directory and drops a two-field
 * request; this daemon validates the name, builds the destination, and writes
 * the file.
 *
 * The poll runs WHILE the session runs, not after it, because installing a unit
 * is never the last step — `daemon-reload` and a restart follow, and a session
 * that had to end before its unit appeared could not verify its own work. One
 * second is imperceptible next to a task and costs a `readdir` of an empty
 * directory.
 *
 * The ceiling bounds a session that has been talked into a loop. Thirty-two is
 * more units than this project has.
 */
const UNIT_DESK_POLL_MS = 1_000;
const MAX_UNIT_OPS_PER_TASK = 32;

export class Executor {
  #config: OpsConfig;
  #journal: Journal;
  #state: StateStore;
  #runner: Runner;

  #busy: string | null = null;
  #lastVerify: { at: number; ok: boolean; detail: string } | null = null;
  /** The last task, for the status page. The journal holds every one of them. */
  #lastTask: TaskSummary | null = null;
  /** Bash invocations audited since boot. A counter the status page can show. */
  #auditedCommands = 0;

  constructor(config: OpsConfig) {
    this.#config = config;
    this.#state = new StateStore(config.stateDir, config.breaker.maxQuarantined);
    this.#journal = new Journal(config.stateDir, () => this.snapshot());
    this.#runner = new Runner(config.dryRun, config.limits.commandTimeoutSeconds, (line) =>
      process.stdout.write(`[ops] ${line}\n`),
    );
  }

  get journal(): Journal {
    return this.#journal;
  }

  get state(): StateStore {
    return this.#state;
  }

  get runner(): Runner {
    return this.#runner;
  }

  snapshot(): OpsStatusSnapshot {
    const state = this.#state.state;
    return {
      current: this.#busy ?? 'idle',
      frozen: state.frozen,
      frozenReason: state.frozenReason,
      dryRun: this.#config.dryRun,
      pendingCheckins: state.pending.map((entry) => ({
        instance: entry.instance,
        deadlineAt: entry.deadlineAt,
        reason: entry.reason,
      })),
      quarantined: state.quarantined.map((entry) => ({
        instance: entry.instance,
        build: entry.build,
        at: entry.at,
      })),
      consecutiveFailedRecoveries: state.consecutiveFailedRecoveries,
      lastVerify: this.#lastVerify,
      // Everything below is new on 2026-08-10 and is ADDITIVE. The contract
      // with status/ is that the executor writes <stateDir>/ops-status.json
      // atomically and the page reads it off disk — no socket, no API, no
      // shared library — so a reader that predates these fields keeps working
      // and a reader that wants them does not have to be told where to look.
      // The audit itself needs no new plumbing at all: audit entries are
      // journal entries, so they already appear in `events`, with the full
      // command string in the `command` field the page already knows about.
      hostAgent: {
        enabled: this.#config.hostAgent.enabled,
        claudePath: this.#config.hostAgent.claudePath,
        timeoutMinutes: this.#config.hostAgent.timeoutMinutes,
        maxCostUsd: this.#config.hostAgent.maxCostUsd,
        // Added 2026-08-11 and additive, like everything else in this object.
        // The status page's honest sentence about this daemon used to be "it
        // runs a shell as npurcell"; it can now say which account, and — the
        // part worth publishing — whether that account is currently in a state
        // this daemon will run a session as. A page that says "host agent:
        // enabled" while every task is being refused for a docker-group
        // membership would be reassurance rather than status.
        user: this.#config.hostAgent.user,
        identity: this.#identityStatus(),
      },
      auditedCommands: this.#auditedCommands,
      lastTask: this.#lastTask,
    };
  }

  noteVerify(ok: boolean, detail: string): void {
    this.#lastVerify = { at: Date.now(), ok, detail };
    this.#journal.write({ kind: 'verify', what: 'snapshot-verify', detail, ok });
  }

  // ── Boot ────────────────────────────────────────────────────────────────

  /**
   * Report and clear anything the retired spool path left armed.
   *
   * There used to be a `restoreDeadlines()` here that re-armed check-in
   * deadlines across a restart, treating one that had already expired as missed
   * rather than forgiven — because a restart during the recovery window must not
   * be a way to skip the recovery.
   *
   * Nothing arms a deadline any more. The only thing that ever did was a task
   * filed into the ops spool, and both spools are gone: a task now arrives as a
   * DM and is not snapshotted, so there is no image to roll back to and nothing
   * for an instance to check in against. That was settled at CLAWSKY.md phase 6
   * and is written down there; this method is what makes the transition honest
   * rather than silent.
   *
   * A host upgrading into this build can still have rows in `state.json` that
   * the previous build wrote. Left alone they would sit there being published in
   * `ops-status.json` as pending forever, waiting on a timer nothing arms and a
   * check-in nothing can file. So they are reported once, by name, and cleared —
   * a stale deadline that will never fire is worse than none, because a page
   * showing one reads as a recovery in progress.
   */
  reportRetiredDeadlines(): void {
    const pending = [...this.#state.state.pending];

    for (const entry of pending) {
      this.#journal.write({
        kind: 'deadline-missed',
        what: `checkin ${entry.instance}`,
        instance: entry.instance,
        ok: false,
        detail:
          `armed ${describeInstant(entry.armedAt)} by the ops spool, for: ` +
          `${entry.reason || '(no reason recorded)'}. That path has been retired, so nothing ` +
          `will roll ${entry.instance} back to ${entry.rollbackTag || '(no tag recorded)'} ` +
          'and nothing can file a check-in to close it. Cleared. If that instance is ' +
          'actually broken, it is a person\'s decision now — the ops journal holds every ' +
          'command the task ran.',
      });
      this.#state.disarm(entry.instance);
    }

    // Quarantines go the same way, and for the same reason. `quarantine()` was
    // called from one place — the automatic rollback after a missed check-in —
    // and nothing can reach it now, so a row here is a build that will be
    // refused by nobody, published forever as though something were enforcing
    // it. Cleared with the deadlines rather than in a second pass, because they
    // were written by the same event.
    const quarantined = this.#state.state.quarantined.map((entry) => entry.instance);
    const cleared = this.#state.clearQuarantine();
    if (cleared > 0) {
      this.#journal.write({
        kind: 'breaker',
        what: 'quarantine cleared',
        ok: true,
        detail:
          `${cleared} quarantined build(s) (${quarantined.join(', ')}) were recorded by the ` +
          'retired spool path. Nothing consults the list and nothing can add to it, so it is ' +
          'cleared rather than left being published as a control. If one of those builds is ' +
          'genuinely bad, that is now a fact about git and a person, not about this daemon.',
      });
    }

    if (pending.length === 0 && cleared === 0) return;

    process.stderr.write(
      `[ops] the retired spool path left ${pending.length} check-in deadline(s) and ` +
        `${cleared} quarantined build(s) behind. Cleared — nothing arms, honours or consults ` +
        'either any more. See journal.jsonl.\n',
    );
  }

  /**
   * The service account the host agent runs as, resolved fresh.
   *
   * Public so `index.ts` can print it in the boot banner and so the self-test
   * can assert on the refusals without starting a task. Deliberately NOT
   * memoised: see `#hostAgentAccount` for why a cached answer would miss the
   * exact change this check exists to catch.
   */
  resolveAgentIdentity(): AgentUserResult {
    return this.#resolveAgent();
  }

  /** One line about the agent account, for `ops-status.json`. Never a decision. */
  #identityStatus(): { ok: boolean; detail: string } {
    if (!this.#config.hostAgent.enabled) {
      return { ok: false, detail: 'hostAgent.enabled is false; tasks are refused' };
    }
    const agent = this.#resolveAgent();
    if (!agent.ok) return { ok: false, detail: agent.reason.split('\n')[0] ?? agent.reason };
    const problems = agentProblems(agent.user, identityOptionsFor(this.#config));
    if (problems.length > 0) {
      return {
        ok: false,
        detail: `${describeAgentUser(agent.user)} — ${problems.length} refusal(s): ` +
          `${problems.map((problem) => problem.split('\n')[0]).join(' | ')}`,
      };
    }
    return { ok: true, detail: describeAgentUser(agent.user) };
  }

  #resolveAgent(): AgentUserResult {
    return resolveAgentUser(this.#config.hostAgent.user, {
      passwdPath: this.#config.hostAgent.passwdPath,
      groupPath: this.#config.hostAgent.groupPath,
    });
  }

  /**
   * Resolve the account the session will run as, and prepare its directories.
   *
   * Extracted from `#doTask` when the host agent got a mailbox, so that both
   * ways in reach exactly the same gate. Nothing in it changed: a second copy
   * of these refusals is how one of them quietly grows a hole.
   *
   * Re-resolved from /etc/passwd and /etc/group on EVERY call rather than
   * cached from boot. That is the whole reason the check lives here: the
   * membership it exists to catch — `usermod -aG docker clawcius-ops`, typed to
   * make something work — is added to a RUNNING host, and a boot-time check on
   * a unit that stays up for weeks would not see it until the next restart.
   * Costs two small file reads per task.
   */
  #hostAgentAccount(
    what: string,
    requester: string,
  ): { ok: true; user: AgentUser } | { ok: false; detail: string } {
    const agent = this.#resolveAgent();
    if (!agent.ok) {
      return { ok: false, detail: `${agent.reason}\n\nThe host agent was not started.` };
    }

    const problems = agentProblems(agent.user, identityOptionsFor(this.#config));
    if (problems.length > 0) {
      return {
        ok: false,
        detail:
          `refusing to run a task as ${describeAgentUser(agent.user)}:\n\n` +
          problems.map((problem) => `  * ${problem}`).join('\n\n') +
          '\n\nSince 2026-08-11 the containment story for this service is that the session ' +
          'runs as an unprivileged account of its own. The sudoers scoping, the root-owned ' +
          'journal and the claim that it holds no credential are all downstream of that one ' +
          'fact and none of them survive without it. Nothing was run; the executor is still ' +
          'holding its deadlines and will still perform rollbacks and check-ins.',
      };
    }

    for (const warning of agentWarnings(agent.user, identityOptionsFor(this.#config))) {
      this.#journal.write({
        kind: 'request',
        what,
        requester,
        detail: `host agent identity warning: ${warning}`,
      });
    }

    // Idempotent, and here as well as at boot on purpose. `execFile`/`spawn`
    // report a missing cwd as ENOENT on the BINARY, which reads as "claude is
    // not installed" and sends whoever is debugging it to the wrong place
    // entirely. Costs a stat; saves an evening.
    //
    // Owned by the agent account rather than by the checkout's owner, which is
    // the change of 2026-08-11: the session writes here and it is no longer the
    // same user as the one that owns /home/npurcell/clawcius.
    ensureDirOwnedBy(
      this.#config.hostAgent.workDir,
      { uid: agent.user.uid, gid: agent.user.gid },
      (line) => process.stdout.write(`[ops host-agent] ${line}\n`),
      0o750,
      `so the host agent (${agent.user.user}) can write its own working directory`,
    );

    // The three directories the unit desk runs on. Created and chowned here for
    // the same reason the working directory is: a session that finds them
    // missing would create them itself and the executor would then be reading
    // and unlinking inside something whose ancestry it never established.
    //
    // This used to say "see `ensureDirOwnedBy`, which refuses a symlink rather
    // than repairing it". IT DOES NOT, and never did. The function that refused
    // a symlink was `ensureSpoolDir` — `lstat` at every level, `fchown` through
    // an `O_NOFOLLOW | O_DIRECTORY` descriptor compared by device and inode —
    // and it was deleted with the spools, so the sentence no longer even has a
    // neighbour to have been confused with. `ensureDirOwnedBy` chowns BY NAME.
    //
    // That matters here more than it reads: these four paths are owned by the
    // host agent account, which holds `Bash` and whose cwd is `workDir`, and
    // this runs before EVERY task rather than once at boot. A session that
    // replaces one of them with a symlink gets a root chown of the target on
    // the next one. Clawcius #68; not introduced by the spool retirement, and
    // not fixed by it either.
    for (const dir of [
      unitStagingDir(this.#config.hostAgent.workDir),
      unitRequestDir(this.#config.hostAgent.workDir),
      unitResultDir(this.#config.hostAgent.workDir),
    ]) {
      ensureDirOwnedBy(
        dir,
        { uid: agent.user.uid, gid: agent.user.gid },
        (line) => process.stdout.write(`[ops host-agent] ${line}\n`),
        0o750,
        `so the host agent (${agent.user.user}) can stage and request unit installs`,
      );
    }

    return { ok: true, user: agent.user };
  }

  // ── The mail path — CLAWSKY.md phase 6 ──────────────────────────────────

  /**
   * Run a task that arrived as a DM to the host agent, and answer it.
   *
   * This is now the only way a task reaches this host, and the whole of what it
   * replaced is worth stating rather than inferring from an empty file. Until
   * the spools were retired there was a second path: a JSON file dropped into a
   * bind-mounted directory, parsed against a verb list, queued behind a lock,
   * rate-limited, snapshotted, waited on until every container in scope fell
   * idle, run, health-checked, rolled back on failure, and answered by writing a
   * wake file into ANOTHER bind-mounted directory to be read whenever the
   * requester next happened to run. None of that exists. Somebody asks; the
   * session starts; the answer is a DM back to the agent that asked.
   *
   * It is worth being exact about what went with it: **there is no longer
   * anything to undo.** The old path could restore every container in scope to
   * an image taken sixty seconds earlier. This one cannot, because the snapshot
   * was part of the apparatus the operator asked to remove. The health sample
   * either side survives, and it reports rather than repairs — the reply says so
   * in as many words, because a coordinator asking for something destructive
   * should know that.
   *
   * What did NOT go: the account, the sudoers file, the privilege drop, the
   * tool deny-lists, the per-command audit written before its result is known,
   * and the unit desk. Those are the containment story and none of them was
   * scheduling.
   *
   * Concurrency: refused rather than queued while anything else holds the
   * executor. "No" arriving in a second is a better answer than a session that
   * starts twenty minutes later. It is not a rate limit — nothing is counted
   * and nothing is delayed.
   */
  async runMailTask(task: {
    crew: string;
    requester: string;
    subject: string;
    task: string;
  }): Promise<{ subject: string; body: string }> {
    // A message can be as long as the sender likes; a task cannot. `sanitiseTask`
    // is the one answer to "how long may a task be", and it also strips control
    // characters — hygiene for the journal and the prompt, not a security
    // control, because there is no allowlist available for prose.
    //
    // A message can be 64 KB and a task cannot, so truncation is possible and
    // is REPORTED rather than silent: a coordinator whose last two paragraphs
    // — the ones saying what not to touch — were dropped without being told
    // would be the worst version of this.
    const { text: sanitised, truncated } = sanitiseTaskText(task.task);
    task = { ...task, subject: sanitiseTask(task.subject).slice(0, 200), task: sanitised };
    const what = `task by mail from ${task.requester}`;
    const reply = (subject: string, body: string): { subject: string; body: string } => ({
      subject,
      body,
    });

    this.#journal.write({
      kind: 'request',
      what,
      requester: task.requester,
      detail:
        `by DM to the host agent — subject: ${task.subject || '(none)'}` +
        (truncated ? '; TASK TRUNCATED at 8000 characters' : ''),
    });

    if (!task.task) {
      const detail = 'the message had no task in it once control characters were stripped.';
      this.#journal.write({ kind: 'rejected', what, requester: task.requester, ok: false, detail });
      return reply(`Refused: ${task.subject || '(no subject)'}`, detail);
    }

    if (!this.#config.hostAgent.enabled) {
      const detail =
        'hostAgent.enabled is false in ops-config.yaml, so tasks are refused. This is the ' +
        'setting to leave the host in while somebody works out what the last task did, and ' +
        'it is strictly better than stopping the unit. Nothing was run.';
      this.#journal.write({ kind: 'rejected', what, requester: task.requester, ok: false, detail });
      return reply(`Refused: ${task.subject || '(no subject)'}`, detail);
    }

    if (this.#state.state.frozen) {
      const detail =
        `the executor is FROZEN: ${this.#state.state.frozenReason}. Nothing was run. A human ` +
        'clears it with ops/unfreeze.sh once they know why. Nothing sets this any more — ' +
        'the circuit breaker counted failed recoveries on the spool task path — so a freeze ' +
        'you are reading predates that path being retired (Clawcius #63).';
      this.#journal.write({ kind: 'rejected', what, requester: task.requester, ok: false, detail });
      return reply(`Refused: ${task.subject || '(no subject)'}`, detail);
    }

    if (this.#busy) {
      const detail =
        `the executor is busy with "${this.#busy}". Refused rather than queued — the queue ` +
        'went with the spools. Ask again when it is done.';
      this.#journal.write({ kind: 'rejected', what, requester: task.requester, ok: false, detail });
      return reply(`Refused: ${task.subject || '(no subject)'}`, detail);
    }

    const account = this.#hostAgentAccount(what, task.requester);
    if (!account.ok) {
      this.#journal.write({
        kind: 'failed',
        what,
        requester: task.requester,
        ok: false,
        detail: account.detail,
      });
      return reply(`Failed: ${task.subject || '(no subject)'}`, account.detail);
    }

    this.#busy = what;
    this.#journal.publishStatus();
    try {
      const answer = await this.#runMailSession(what, task, account.user);
      return truncated
        ? {
            subject: answer.subject,
            body:
              'NOTE: your message was longer than a task may be and was cut off at 8000 ' +
              'characters. What the session saw is in the ops journal. If the part that was ' +
              'dropped mattered, assume it did not happen.\n\n' +
              answer.body,
          }
        : answer;
    } finally {
      this.#busy = null;
      // Republish now that the lock is free. Without this the status file keeps
      // saying the executor is mid-task until the next event, which on a quiet
      // host can be hours.
      this.#journal.publishStatus();
    }
  }

  async #runMailSession(
    what: string,
    task: { crew: string; requester: string; subject: string; task: string },
    user: AgentUser,
  ): Promise<{ subject: string; body: string }> {
    // Every instance, because a DM carries no `instance` field. That is the
    // briefing's scope, not a permission: the briefing is facts the executor
    // gathered itself, and a session that can see the whole host is the same
    // session the spool path gave an unscoped task.
    const scope = [...this.#config.instances];
    const before = await this.#sampleHealth();

    let unitOps = 0;
    const serveUnitRequests = (): void => {
      if (unitOps >= MAX_UNIT_OPS_PER_TASK) return;
      for (const result of this.#drainUnitRequests(MAX_UNIT_OPS_PER_TASK - unitOps)) {
        unitOps += 1;
        this.#journalUnitOp(task.requester, undefined, result);
      }
    };
    const desk = setInterval(serveUnitRequests, UNIT_DESK_POLL_MS);
    desk.unref();

    let outcome: HostAgentOutcome;
    try {
      outcome = await runHostAgent({
        config: this.#config,
        agent: user,
        task: task.task,
        // The author column of the mail row, which the waker wrote from the
        // sending session's own id. There is no field a message can carry that
        // reaches this, and nothing here reads one.
        requester: task.requester,
        briefing: await this.#briefing(scope, user),
        onAudit: (event) => this.#audit(task.requester, undefined, event),
        onLog: (line) => process.stdout.write(`[ops] ${line}\n`),
      });
    } catch (error) {
      clearInterval(desk);
      const detail = `the host agent was not started: ${String(error)}`;
      this.#journal.write({ kind: 'failed', what, requester: task.requester, ok: false, detail });
      return { subject: `Failed: ${task.subject || '(no subject)'}`, body: detail };
    }
    clearInterval(desk);
    serveUnitRequests();

    this.#lastTask = {
      at: Date.now() - outcome.durationMs,
      requester: task.requester,
      instance: '(all)',
      what,
      commands: outcome.commands.length,
      turns: outcome.turns,
      costUsd: outcome.costUsd,
      ok: outcome.ok,
      dryRun: outcome.dryRun,
      sessionId: outcome.sessionId,
    };

    // Same three tests as `#doTask`, and for the same reasons: an audit with an
    // admitted hole in it is the absence of the only control there is; the
    // agent is told to say "failed" plainly and first; and a health regression
    // is believed over a cheerful report.
    const auditBroken = outcome.unparsedLines > 0;
    const saidFailed = /\bfailed\b/i.test(outcome.resultText.slice(0, 400));
    const after = await this.#sampleHealth();
    const regressions = compareHealth(before, after);
    const ok = outcome.ok && !auditBroken && !saidFailed && regressions.length === 0;

    const summary =
      `host agent session ${outcome.sessionId}: ${outcome.reason} — ${outcome.detail} ` +
      `${outcome.commands.length} command(s), ${outcome.turns} turn(s), ` +
      `$${outcome.costUsd.toFixed(4)}, ${(outcome.durationMs / 1000).toFixed(1)}s` +
      (outcome.denials ? `, ${outcome.denials} call(s) refused by the permission system` : '');

    this.#journal.write({
      kind: ok ? 'finished' : 'failed',
      what,
      requester: task.requester,
      ok,
      dryRun: outcome.dryRun,
      detail:
        `${summary}` +
        (auditBroken
          ? `\nAUDIT INCOMPLETE: ${outcome.unparsedLines} unparseable line(s) in the output ` +
            'stream. The task is failed for this on its own.'
          : '') +
        (saidFailed && outcome.ok
          ? '\nThe agent exited cleanly but its report says "failed", which is taken at its word.'
          : '') +
        (regressions.length ? `\nHEALTH REGRESSED: ${regressions.join('; ')}` : '') +
        `\nreport: ${outcome.resultText.slice(0, 4000) || '(none)'}`,
    });

    return {
      subject: `${ok ? 'Done' : 'Failed'}: ${task.subject || '(no subject)'}`,
      body: [
        `${ok ? 'SUCCEEDED' : 'FAILED'}${outcome.dryRun ? ' (DRY RUN — nothing was executed)' : ''}.`,
        summary,
        ...(regressions.length ? ['', `Health regressed: ${regressions.join('; ')}`] : []),
        ...(ok || outcome.dryRun
          ? []
          : [
              '',
              'NOT ROLLED BACK. A task filed by mail takes no snapshot first, so there is ' +
                'nothing to restore to. Whatever it did is still done. If that needs undoing ' +
                'it is a person\'s decision and the ops journal holds every command it ran.',
            ]),
        '',
        'The host agent reported:',
        '',
        outcome.resultText.slice(0, 6000) || '(it produced no report)',
        '',
        'Every command it ran is in the ops journal, in full. If you are about to tell the',
        'operator what happened, tell them what it actually did, not what you asked for.',
      ].join('\n'),
    };
  }

  // ── The unit desk ───────────────────────────────────────────────────────

  /**
   * Serve whatever unit-install requests the session has filed so far.
   *
   * Everything hostile-input-shaped about the request directory is handled in
   * units.ts, alongside the reasoning; this method exists so the poll and the
   * post-session sweep share one call and one set of paths, all of them derived
   * from `hostAgent.workDir` and `unitDir` in config rather than from anything a
   * task said.
   */
  #drainUnitRequests(budget: number): UnitOpResult[] {
    const workDir = this.#config.hostAgent.workDir;
    return drainUnitRequests({
      requestDir: unitRequestDir(workDir),
      resultDir: unitResultDir(workDir),
      stagingDir: unitStagingDir(workDir),
      unitDir: this.#config.unitDir,
      dryRun: this.#config.dryRun,
      max: budget,
      onLog: (line) => process.stdout.write(`[ops units] ${line}\n`),
    });
  }

  /**
   * Record one install or removal, refusals included.
   *
   * Its own journal kind, and it carries the destination path in `command` —
   * which is the field the status page already renders as "what was run". This
   * is now the only way bytes reach /etc/systemd/system from a task, so
   * `grep '"kind":"unit"'` has to be the complete answer to what has been
   * written there. A REFUSAL is journalled just as loudly as a success: a run of
   * them is what a session probing for a way past the name validation looks like
   * from outside, and that is worth being able to find later.
   */
  /**
   * Takes `requester` and `instance` rather than a `Job`, since 2026-08-14.
   *
   * A mail task has no Job — there is no queue for it to be an entry in — and
   * the journal only ever wanted these two fields off it. Passing them down
   * keeps one audit path for both ways in; a second one would be a second
   * place for a command to run without being recorded.
   */
  #journalUnitOp(requester: string, instance: string | undefined, result: UnitOpResult): void {
    this.#journal.write({
      kind: 'unit',
      what: `${result.op} ${result.unit || '(unnamed)'}`,
      instance,
      requester,
      ok: result.ok,
      dryRun: result.skipped,
      ...(result.path ? { command: result.path } : {}),
      detail: result.detail,
    });
  }

  /** One audit line into the durable record, before the command's result is known. */
  /** See `#journalUnitOp` for why this takes fields rather than a `Job`. */
  #audit(requester: string, instance: string | undefined, event: AuditEvent): void {
    this.#auditedCommands += event.kind === 'bash' ? 1 : 0;
    this.#journal.write({
      kind: 'audit',
      what: event.kind === 'bash' ? 'bash' : `${event.kind} ${event.tool}`,
      instance,
      requester,
      dryRun: this.#config.dryRun,
      // The FULL command string, in the field the status page already renders
      // as a command. Not summarised, not shell-quoted, not re-parsed — this is
      // a record of what was issued, and anything that "tidied" it would be
      // lying about the bytes.
      ...(event.command ? { command: event.command } : {}),
      detail: event.detail,
    });
  }

  // ── Health, before and after ────────────────────────────────────────────

  /**
   * What is up right now: every configured unit, every configured container.
   *
   * Read-only, so it runs through `probe` and executes even in dry-run — for
   * the same reason every other probe does. A dry run that cannot see the
   * machine reports fiction rather than a prediction.
   *
   * This is a deliberately small check. It does not know whether a service is
   * doing anything useful, only whether systemd and docker still think it is
   * alive. That is enough to catch the class of failure that matters here: a
   * task that edits a unit file and restarts it into a crash loop, or removes a
   * container and does not bring it back.
   */
  async #sampleHealth(): Promise<HealthSample> {
    const units: Record<string, string> = {};
    for (const unit of this.#config.units) {
      if (unit.name === SELF_UNIT) continue;
      const result = await this.#runner.probe(
        [this.#config.systemctlPath, 'is-active', unit.name],
        { timeoutSeconds: 30 },
      );
      // `is-active` exits non-zero for anything that is not active and prints
      // the state either way, so stdout is the answer and the exit code is not.
      units[unit.name] = result.stdout.trim() || (result.ok ? 'active' : 'unknown');
    }

    const containers: Record<string, string> = {};
    for (const instance of this.#config.instances) {
      const result = await this.#runner.probe(
        [this.#config.dockerPath, 'container', 'inspect', '-f', '{{.State.Status}}', instance.container],
        { timeoutSeconds: 30 },
      );
      containers[instance.container] = result.stdout.trim() || 'absent';
    }

    return { units, containers };
  }

  // ── The briefing ────────────────────────────────────────────────────────

  /**
   * What the executor tells the session about the host.
   *
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │ EVERYTHING IN HERE IS GATHERED BY THIS PROCESS. NOTHING IS INGESTED. │
   * │                                                                      │
   * │ These are facts read off the machine with read-only commands — unit  │
   * │ states, container states, HEAD, the list of uncommitted filenames.    │
   * │ There is no file content here, no diff, no PR body, no web page and   │
   * │ no other agent's output, and adding one would quietly convert this    │
   * │ session from "holds everything, reads nothing hostile" into a         │
   * │ prompt-injectable root shell. See host-agent.ts.                      │
   * └──────────────────────────────────────────────────────────────────────┘
   *
   * The dirty-file list is the one that earns its place twice: the standing
   * prompt forbids forcing past a dirty tree, and a prohibition that arrives
   * with the actual filenames attached is one the session can act on instead of
   * discovering the hard way.
   */
  async #briefing(scope: InstanceEntry[], agent: AgentUser): Promise<string> {
    const lines: string[] = [];

    // Who the session is, stated rather than left to be discovered with `id`.
    // Not decoration: a session that believes it is the operator will try
    // things that get refused and then try to work around the refusal, and the
    // fastest way to stop that is to tell it what account it holds and where
    // the list of its grants is written down.
    lines.push(
      `You are running as ${describeAgentUser(agent)}. Your sudo grants are enumerated in ` +
        `${this.#config.repos[0]?.path ?? '<checkout>'}/ops/clawcius-sudoers — read it before ` +
        'assuming something is broken.',
    );
    lines.push('');

    lines.push('Instances (name, container, state directory, waker status file):');
    for (const instance of this.#config.instances) {
      lines.push(
        `  - ${instance.name}: container ${instance.container}, image ${instance.image}, ` +
          `state ${instance.stateDir}`,
      );
    }
    lines.push(
      `Health-checked immediately before this task and again after it: ` +
        `${scope.map((i) => i.name).join(', ') || '(none)'}. That check REPORTS; it does not ` +
        'repair. Nothing here is snapshotted and nothing is rolled back — if you break one ' +
        'of these, it stays broken until a person decides what to do about it.',
    );
    lines.push('');

    const health = await this.#sampleHealth();
    lines.push('Units, as of right now:');
    for (const [name, state] of Object.entries(health.units)) lines.push(`  - ${name}: ${state}`);
    lines.push('Containers, as of right now:');
    for (const [name, state] of Object.entries(health.containers)) lines.push(`  - ${name}: ${state}`);
    lines.push('');

    for (const repo of this.#config.repos) {
      lines.push(`Checkout "${repo.name}" at ${repo.path} (expected branch ${repo.branch}):`);
      const branch = await this.#runner.probe(
        [this.#config.gitPath, '-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { timeoutSeconds: 30 },
      );
      const head = await this.#runner.probe(
        [this.#config.gitPath, '-C', repo.path, 'rev-parse', 'HEAD'],
        { timeoutSeconds: 30 },
      );
      lines.push(`  - HEAD: ${head.stdout.trim() || '(unknown)'} on ${branch.stdout.trim() || '(unknown)'}`);
      const dirty = await readDirty(this.#runner, this.#config, repo);
      if (!dirty.ok) {
        lines.push(`  - git status could not be read: ${dirty.reason}. Treat the tree as dirty.`);
      } else if (dirty.files.length === 0) {
        lines.push('  - working tree is clean');
      } else {
        lines.push(
          `  - ${dirty.files.length} UNCOMMITTED change(s). Do not reset, checkout -f, stash ` +
            'or clean them; on 2026-08-09 files in exactly this state turned out to be real ' +
            'fixes made by hand during an incident:',
        );
        for (const file of dirty.files.slice(0, 40)) lines.push(`      ${file}`);
        if (dirty.files.length > 40) lines.push(`      …and ${dirty.files.length - 40} more`);
      }
      if (repo.buildDirs.length > 0) {
        lines.push(
          `  - if you pull this, build it: npm ci && npm run build in ` +
            `${repo.buildDirs.map((dir) => join(repo.path, dir)).join(', ')} — nothing here ` +
            'compiles on start.',
        );
      }
    }

    lines.push('');
    lines.push(`Executor state directory (do not write here): ${this.#config.stateDir}`);
    lines.push(`Your working directory: ${this.#config.hostAgent.workDir}`);

    // How to install a unit, spelled out with the actual paths, because since
    // 2026-08-12 there is no `sudo install` and a session that discovers that by
    // being refused will spend turns looking for another way round rather than
    // reading the file it was pointed at. See ops/src/units.ts.
    const staging = unitStagingDir(this.#config.hostAgent.workDir);
    const requests = unitRequestDir(this.#config.hostAgent.workDir);
    const results = unitResultDir(this.#config.hostAgent.workDir);
    lines.push('');
    lines.push('Installing or removing a systemd unit — you cannot do this with sudo:');
    lines.push(
      `  1. write the unit's full content to ${join(staging, '<name>.service')}` +
        ' (Write, or a plain shell redirect; not a symlink, and not empty);',
    );
    lines.push(
      `  2. file the request:  printf '%s' '{"op":"install","unit":"<name>.service"}' > ` +
        `${join(requests, '$(date +%s).json.tmp')} && mv that file to the same name without ` +
        '.tmp;',
    );
    lines.push(
      `  3. within a couple of seconds, read the answer at ${join(results, '<same name>.json')}: ` +
        'it says ok true/false and why.',
    );
    lines.push(
      `  Then \`sudo systemctl daemon-reload\` and start or restart the unit by exact name. ` +
        `The executor writes the file itself, as root, to ${this.#config.unitDir}/<name>, mode ` +
        '0644 root:root. It validates the NAME and builds the path — you cannot choose the ' +
        'destination, the mode or the owner, and `{"op":"remove", …}` is the other verb.',
    );
    lines.push(
      'Snapshot script: ' +
        `${this.#config.snapshotScript}; container script: ${this.#config.runContainerScript}.`,
    );

    return lines.join('\n');
  }

  // ── Shutdown ────────────────────────────────────────────────────────────

  stop(): void {
    this.#journal.write({
      kind: 'shutdown',
      what: 'clawcius-ops',
      detail:
        this.#busy
          ? `stopping while "${this.#busy}" was running. There is no queue to drain and no ` +
            'deadline to carry over; the session is killed with this process and the ' +
            'coordinator that asked will not get a reply.'
          : 'stopping while idle.',
    });
  }
}

/**
 * What was up, the last time anybody looked.
 *
 * Deliberately two flat maps of strings rather than anything richer. The only
 * question being asked is "was this the same before and after", and a shape
 * that can answer that and nothing else cannot be quietly repurposed into a
 * health *policy*, which is the thing that grows exceptions until it passes
 * everything.
 */
export type HealthSample = {
  /** unit name → whatever `systemctl is-active` printed. */
  units: Record<string, string>;
  /** container name → `{{.State.Status}}`, or `absent`. */
  containers: Record<string, string>;
};

/**
 * What got worse. Returns prose, one entry per regression, empty if nothing did.
 *
 * The comparison is deliberately asymmetric: only a transition FROM good TO
 * not-good counts. A unit that was already dead before the task stays dead
 * without blaming the task, and a unit the task FIXED is not reported at all.
 *
 * That asymmetry is the difference between a check that gets read and a check
 * that gets turned off. A strict "anything different is a regression" would
 * fire on every deliberate restart — `systemctl is-active` can report
 * `activating` for a second — and the first thing anybody would do about a
 * rollback triggered by a service coming back up correctly is disable the whole
 * mechanism.
 *
 * Exported and pure so the self-test can drive it directly, without docker,
 * without systemd, and without a task.
 */
/**
 * An epoch millisecond as a timestamp, or a phrase, but never a throw.
 *
 * `new Date(undefined).toISOString()` throws `RangeError: Invalid time value`,
 * and `StateStore` admits a pending row on `instance` and `deadlineAt` alone —
 * `armedAt` is not validated. So a `state.json` missing that one field would
 * take the daemon down inside `reportRetiredDeadlines()`, which `index.ts` calls
 * at boot before the mailboxes start, on every restart, forever.
 *
 * "A corrupt state file refuses to start rather than starting empty" is a rule
 * this codebase holds deliberately and tests. This is not that: the file is not
 * corrupt, one optional field on a row that is about to be DELETED is missing,
 * and refusing to boot over it would mean a root daemon in a restart loop it
 * cannot report from. Found by OJ in review of #67.
 */
function describeInstant(at: unknown): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    return 'at an unrecorded time';
  }
  try {
    return `at ${new Date(at).toISOString()}`;
  } catch {
    return 'at an unreadable time';
  }
}

export function compareHealth(before: HealthSample, after: HealthSample): string[] {
  const regressions: string[] = [];

  for (const [unit, was] of Object.entries(before.units)) {
    const now = after.units[unit] ?? 'unknown';
    if (was === 'active' && now !== 'active') {
      regressions.push(`${unit} was active and is now "${now}"`);
    }
  }
  for (const [container, was] of Object.entries(before.containers)) {
    const now = after.containers[container] ?? 'absent';
    if (was === 'running' && now !== 'running') {
      regressions.push(`container ${container} was running and is now "${now}"`);
    }
  }
  return regressions;
}

