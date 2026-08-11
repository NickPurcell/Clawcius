/**
 * The executor: one task at a time, snapshotted before, audited throughout,
 * rolled back if it goes wrong.
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
 * an agent that could not read it — and not one of them was a verb. A closed
 * set can only hold what somebody imagined in advance, and every gap in it
 * turns the operator into the agent's hands, which is the exact labour this
 * system exists to remove.
 *
 * ── What this file is now: a supervisor, not a rulebook ──────────────────
 *
 * Everything here that was ever about *transport* and *safety* is unchanged,
 * because none of it was ever about the verbs:
 *
 *   - one spool per instance, and provenance that comes from the directory a
 *     file was found in rather than from anything the file says;
 *   - the lock: one operation at a time, a bounded queue, refusals with reasons;
 *   - the durable journal, fsynced before each step proceeds;
 *   - the circuit breaker: quarantine after a rollback, freeze after repeated
 *     failed recoveries, all of it persisted;
 *   - dry-run;
 *   - the idle wait before anything that could kill a live turn;
 *   - the check-in deadline and the automatic rollback on silence.
 *
 * What was deleted is the fixed-verb dispatch and its argument allowlists. What
 * was added is four things, and they are what stands where the verb list stood:
 *
 *   **A snapshot before every task.** `redeploy` used to take one; now every
 *   task does, for every instance in scope. The safety property is no longer
 *   "it can only do approved things", it is "whatever it does to a container
 *   can be undone".
 *
 *   **A rollback after a failed one.** The agent reporting failure, or the
 *   post-task health check finding a unit or a container that was up before and
 *   is not up now, restores the pre-task snapshot without being asked.
 *
 *   **A complete audit.** Every Bash command the session issues is written into
 *   journal.jsonl, in full, as it is issued and before its result is known.
 *   That log is the accountability mechanism now. A command that runs and is
 *   not logged is the failure mode that matters, which is why an unparseable
 *   line in the agent's output stream FAILS THE TASK rather than being skipped.
 *
 *   **A dry-run that cannot act.** Not "asked not to": the Bash tool, and every
 *   other tool that can change the machine, is removed from the session by the
 *   permission system. Verified against the real CLI; see host-agent.ts.
 *
 * ── What is honestly NOT protected against ───────────────────────────────
 *
 * The rollback is container-scoped. `docker commit` captures an agent
 * container's writable layer; it does not capture /etc, the checkout, or
 * anything else on the host. A task that breaks the host filesystem is undone
 * by the VPS snapshot and by git, by a person. That is the deal, it is written
 * down in ops/README.md, and it should not be discovered here.
 *
 * ── The lock ─────────────────────────────────────────────────────────────
 *
 * One operation at a time. Not a semaphore, not per-instance, not "these two
 * are independent so they can overlap". Two host agent sessions with sudo,
 * running concurrently on the same box, is not a scenario anybody should have
 * to reason about — and it is far worse than the two overlapping docker
 * operations this lock was originally written to prevent. A second request
 * queues; past `limits.maxQueued` it is refused with a stated reason, because a
 * refusal the agent can read beats a request that silently evaporates.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstanceEntry, OpsConfig, RepoEntry } from './config.js';
import { Journal, type OpsStatusSnapshot, type TaskSummary } from './journal.js';
import { StateStore, type PendingCheckin } from './state.js';
import { readIdle } from './idle.js';
import { Runner, render, summarise, type CommandResult } from './runner.js';
import { describeRequest, isDestructive, parseRequest, type OpsRequest } from './request.js';
import { readDirty } from './build.js';
import {
  identityOptionsFor,
  runHostAgent,
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
import { ensureDirOwnedBy, type RawRequest } from './spool.js';

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
 * The requester recorded for operations the executor starts by itself.
 *
 * An automatic rollback after a missed check-in is not an agent's request and
 * must not be attributed to one — least of all to the instance it is being
 * performed *on*, which is the reading a naive "requester = instance" would
 * produce. Parenthesised so it cannot collide with a real instance name: the
 * config's NAME_PATTERN forbids brackets.
 */
const SELF_REQUESTER = '(executor)';

/** Snapshot tags, exactly as `docker/snapshot.sh` writes them. */
const SNAPSHOT_TAG = /^snap-[0-9]{8}-[0-9]{6}$/;

/**
 * One unit of work: a validated request, and who filed it.
 *
 * `requester` is carried explicitly through every handler rather than kept in
 * a field on the executor. That is deliberate and it is not style: `intake()`
 * is synchronous and can run while a `#dispatch` is parked on an `await`
 * (fs.watch fires whenever a container writes, and the idle wait can park for
 * half an hour). A "current requester" field would be clobbered by the next
 * arrival and the journal would attribute a redeploy to whoever happened to
 * file something while it was waiting. Passing it down the call chain makes
 * that class of bug unrepresentable.
 */
type Job = {
  raw: RawRequest;
  request: OpsRequest;
  /** The instance whose spool this arrived in, or SELF_REQUESTER. */
  requester: string;
  receivedAt: number;
  /**
   * Set only on the rollback the executor files itself when a check-in
   * deadline passes. Its presence is what makes the job an origin-`deadline`
   * rollback, and it carries the record of what is being rolled back FROM.
   *
   * ── Why this field exists, 2026-08-11 ─────────────────────────────────
   *
   * It used to be a parameter passed straight into `#doRollback`, which
   * worked only on the path where the executor happened to be idle when the
   * deadline fired. If it was busy, the job went on the queue and the context
   * went nowhere: `#pump` later shifted it and `#dispatch` called
   * `#doRollback(job, 'requested')`, hard-coded, so the quarantine, the
   * consecutive-failure count and the freeze — the entire safety accounting,
   * all gated on `origin === 'deadline'` — were skipped. The container was
   * restored and the build that had just failed to come back was left free to
   * be deployed again, defeating the breaker whose only job is to stop that
   * loop.
   *
   * That is not a rare corner. `#waitForIdle` parks an operation for up to
   * thirty minutes, and the incidents where a deadline expires are exactly
   * the incidents where something else is already stuck holding the lock.
   *
   * Found in review of PR #8, where it was pre-existing rather than
   * introduced — but in the dispatch path this change was already rewriting,
   * so it is fixed here rather than filed. Carrying it on the Job means there
   * is now ONE way a rollback reaches `#doRollback`, and the origin is a
   * property of the job rather than of which branch created it.
   */
  deadline?: PendingCheckin;
};

export class Executor {
  #config: OpsConfig;
  #journal: Journal;
  #state: StateStore;
  #runner: Runner;

  #busy: string | null = null;
  #queue: Job[] = [];
  /** Epoch ms of each accepted request, for the rolling-hour cap. */
  #accepted: number[] = [];
  #deadlineTimers = new Map<string, NodeJS.Timeout>();
  #lastVerify: { at: number; ok: boolean; detail: string } | null = null;
  /** The last task, for the status page. The journal holds every one of them. */
  #lastTask: TaskSummary | null = null;
  /** Bash invocations audited since boot. A counter the status page can show. */
  #auditedCommands = 0;
  #stopped = false;

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
      queued: this.#queue.length,
      frozen: state.frozen,
      frozenReason: state.frozenReason,
      dryRun: this.#config.dryRun,
      spools: this.#config.instances.map((instance) => ({
        instance: instance.name,
        dir: instance.opsSpoolDir,
        restricted: instance.mayRequest !== null,
      })),
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
   * Re-arm deadlines that were running when the process last stopped.
   *
   * A deadline already past is not quietly forgiven. The executor was down
   * while an instance was supposed to be checking in; the honest reading is
   * that it did not, and the whole point of persisting the deadline is that a
   * restart during the recovery window must not become a way to skip the
   * recovery.
   */
  restoreDeadlines(): void {
    const now = Date.now();
    for (const pending of this.#state.state.pending) {
      const remaining = pending.deadlineAt - now;
      if (remaining <= 0) {
        this.#journal.write({
          kind: 'deadline-missed',
          what: `checkin ${pending.instance}`,
          instance: pending.instance,
          requester: SELF_REQUESTER,
          detail:
            `deadline expired at ${new Date(pending.deadlineAt).toISOString()} while the ` +
            'executor was not running. Treating it as missed rather than forgiven — the ' +
            'instance had that whole window to check in and the record says it did not.',
        });
        void this.#enqueueDeadlineExpiry(pending);
        continue;
      }
      this.#armTimer(pending);
      this.#journal.write({
        kind: 'deadline-armed',
        what: `checkin ${pending.instance}`,
        instance: pending.instance,
        requester: SELF_REQUESTER,
        detail:
          `restored across a restart; ${(remaining / 60000).toFixed(1)} minutes left of the ` +
          `original deadline (${pending.reason})`,
      });
    }
  }

  // ── Intake ──────────────────────────────────────────────────────────────

  /**
   * Called by the spool for each request file.
   *
   * Everything here is refusal logic. The order matters: cheap structural
   * checks first, so a malformed flood costs a JSON parse and not a config
   * lookup, and the rate limit last among the pre-checks, so that a run of
   * garbage does not consume the hourly budget that a real request needs.
   */
  intake(raw: RawRequest): void {
    // Every journal entry below carries `requester`, which is the directory
    // this file was found in and not anything the file said about itself. It
    // is recorded even on the rejection paths — especially there. "Something
    // wrote malformed JSON into the ops spool" was, until 2026-08-10, the
    // entire content of that log line; which agent's container is producing
    // garbage aimed at a root process is not a detail.
    const requester = raw.requester;
    const parsed = parseRequest(raw.body);

    if (!parsed.ok) {
      this.#journal.write({
        kind: 'rejected',
        what: raw.name,
        requester,
        detail: `${parsed.reason}. Discarded.`,
      });
      return;
    }

    const request = parsed.request;

    if (request.unknownFields.length > 0) {
      // Not a rejection. Ignoring an unknown field is the safe behaviour and
      // saying so is how a typo in a field name stops being invisible — an
      // agent that writes `"units"` and gets a silent success would keep doing
      // it. Logged, never acted on.
      this.#journal.write({
        kind: 'request',
        what: describeRequest(request),
        requester,
        detail: `ignoring unknown field(s): ${request.unknownFields.join(', ')}`,
      });
    }

    this.#journal.write({
      kind: 'request',
      what: describeRequest(request),
      instance: request.instance || undefined,
      requester,
      detail:
        `filed by ${requester} as ${raw.name}` +
        (request.reason ? ` — reason given: ${request.reason}` : ' (no reason given)'),
    });

    const job: Job = { raw, request, requester, receivedAt: Date.now() };

    // ── The per-instance restriction, before the rate limit ──────────────
    //
    // Before, so an out-of-scope request does not spend an hour's budget. The
    // budget exists to stop a looping agent starving a working one, and an
    // agent looping on requests it is not allowed to make is exactly the case
    // where the working one must still get through.
    const outOfScope = this.#outOfScope(job);
    if (outOfScope) {
      this.#reject(job, outOfScope);
      return;
    }

    const now = Date.now();
    this.#accepted = this.#accepted.filter((at) => now - at < 3_600_000);
    if (this.#accepted.length >= this.#config.limits.maxPerHour) {
      this.#reject(
        job,
        `rate limit: ${this.#config.limits.maxPerHour} operations per rolling hour, ` +
          'and this hour is full',
      );
      return;
    }

    // `checkin` is answered inline and never queues. It is the reply to
    // something the executor itself asked for, it runs no command, and making
    // it wait behind a long redeploy is how an instance misses a deadline it
    // actually met.
    if (request.verb === 'checkin') {
      this.#accepted.push(now);
      this.#handleCheckin(job);
      return;
    }

    if (this.#state.state.frozen && isDestructive(request.verb)) {
      this.#reject(
        job,
        `the executor is FROZEN: ${this.#state.state.frozenReason}. Tasks and rollbacks are ` +
          'refused until a human clears it with ops/unfreeze.sh. Nothing will be retried. ' +
          'checkin and wake still work, so an instance that is alive can still say so.',
      );
      return;
    }

    if (this.#queue.length >= this.#config.limits.maxQueued) {
      this.#reject(
        job,
        `${this.#queue.length} operation(s) already queued behind "${this.#busy ?? 'nothing'}" ` +
          `and the queue holds ${this.#config.limits.maxQueued}. Try again once it drains.`,
      );
      return;
    }

    this.#accepted.push(now);
    this.#queue.push(job);

    if (this.#busy) {
      this.#journal.write({
        kind: 'queued',
        what: describeRequest(request),
        instance: request.instance || undefined,
        requester,
        detail: `waiting behind "${this.#busy}"; ${this.#queue.length} in the queue`,
      });
    }

    void this.#pump();
  }

  // ── The per-instance restriction ────────────────────────────────────────

  /**
   * Is this request outside what its requester is allowed to ask for?
   *
   * Returns the refusal text, or null to allow. Absent config means allow —
   * `mayRequest` is null for every instance unless somebody writes one, which
   * is the behaviour every instance had before this existed. An upgrade of a
   * running privileged daemon does not change what it accepts.
   *
   * It is worth being clear about what this is and is not. It is NOT a new
   * security boundary: an agent that can write its spool can already restart
   * the waker and recreate its own container, and the allowlists, the rate
   * limit and the deadline are what bound that. This is the narrower,
   * genuinely useful thing that per-instance spools made possible for the
   * first time — saying "this instance may maintain itself and nothing else".
   * With one shared spool it could not have been expressed, because there was
   * no `this instance` to attach it to.
   *
   * The four lists are checked independently and only where the verb actually
   * carries that field, so `mayRequest: { instances: [self] }` restricts
   * redeploy/snapshot/rollback/checkin and leaves `pull` alone. `wake` is
   * checked again in #doWake against the instance the channel resolves to,
   * because the target of a wake is not known until then.
   */
  #outOfScope(job: Job): string | null {
    const instance = this.#config.instances.find((entry) => entry.name === job.requester);
    const scope = instance?.mayRequest;
    if (!scope) return null;

    const { request } = job;

    if (scope.verbs && !scope.verbs.includes(request.verb)) {
      return this.#scopeRefusal(job, 'verb', request.verb, scope.verbs);
    }
    if (request.instance && scope.instances && !scope.instances.includes(request.instance)) {
      return this.#scopeRefusal(job, 'instance', request.instance, scope.instances);
    }

    // A task with no named instance takes EVERY instance into scope — that is
    // the fail-safe default described on #scopeOf. For an instance the operator
    // has deliberately restricted to a subset, that default would quietly hand
    // it the whole host, which is the one shape of request where "unnamed"
    // means "wider than allowed" rather than "narrower and slower". So it is
    // refused, with the fix in the message.
    if (request.verb === 'task' && !request.instance && scope.instances) {
      return (
        `out of scope: "${job.requester}" is restricted to instance(s) ` +
        `${scope.instances.join(', ') || '(none)'} and filed a task naming no instance. An ` +
        'unnamed task takes every configured instance into scope — it is snapshotted, ' +
        'idle-waited and rolled back across all of them — so for a restricted instance that ' +
        'would be wider than what it is allowed, not narrower. Refile it with ' +
        `"instance": "${scope.instances[0] ?? '<one you are allowed>'}". Nothing was run.`
      );
    }

    // mayRequest.units and mayRequest.repos are not checked, because no request
    // carries a unit or a repo any more. They are reported as deprecated at
    // boot rather than silently satisfied here; see config.ts.
    return null;
  }

  #scopeRefusal(job: Job, kind: string, value: string, allowed: string[]): string {
    return (
      `out of scope: "${job.requester}" may not name ${kind} "${value}". Its ` +
      `mayRequest.${kind}s in ops-config.yaml allows: ` +
      `${allowed.join(', ') || '(none — this instance is denied every ' + kind + ')'}. ` +
      'This is a per-instance restriction the operator configured, not an allowlist ' +
      'gap: the target may well be allowed for a different instance. Nothing was run.'
    );
  }

  #reject(job: Job, detail: string): void {
    this.#journal.write({
      kind: 'rejected',
      what: describeRequest(job.request),
      instance: job.request.instance || undefined,
      requester: job.requester,
      detail,
    });
  }

  // ── The lock ────────────────────────────────────────────────────────────

  async #pump(): Promise<void> {
    if (this.#busy || this.#stopped) return;
    const job = this.#queue.shift();
    if (!job) return;

    this.#busy = describeRequest(job.request);
    this.#journal.write({
      kind: 'started',
      what: this.#busy,
      instance: job.request.instance || undefined,
      requester: job.requester,
      dryRun: this.#config.dryRun,
      detail:
        `waited ${((Date.now() - job.receivedAt) / 1000).toFixed(1)}s in the queue` +
        (this.#config.dryRun ? '. DRY RUN — nothing will actually be executed.' : ''),
    });

    try {
      await this.#dispatch(job);
    } catch (error) {
      // The dispatcher is supposed to convert every failure into a journal
      // entry and return. Reaching here means a bug, and a bug in a daemon
      // holding docker must not take the daemon down — the queue behind it
      // would go with it.
      this.#journal.write({
        kind: 'failed',
        what: this.#busy,
        instance: job.request.instance || undefined,
        requester: job.requester,
        ok: false,
        detail: `unhandled error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      });
    } finally {
      this.#busy = null;
      // Republish now that the lock is free. Without this the status file
      // keeps saying the executor is mid-operation until the next event, which
      // on a quiet host can be hours — a status page confidently reporting a
      // redeploy that finished at lunchtime.
      this.#journal.publishStatus();
    }

    void this.#pump();
  }

  // ── Dispatch ────────────────────────────────────────────────────────────

  /**
   * Four cases, and the switch is still closed.
   *
   * `task` is the one that carries free text; the other three are plumbing that
   * survived the cull because none of them is a capability the host agent would
   * do better, and two of them must keep working when the host agent does not.
   * The reasoning per verb is in request.ts next to VERBS.
   *
   * Note what is still absent: a `default` that does something. TypeScript's
   * exhaustiveness check on the union is the second layer — adding a verb to
   * `VERBS` without handling it here is a compile error, not a runtime surprise.
   */
  async #dispatch(job: Job): Promise<void> {
    switch (job.request.verb) {
      case 'task':
        await this.#doTask(job);
        return;
      case 'rollback':
        // The origin comes off the job, never off which branch queued it.
        // See the `deadline` field on Job for the incident this shape exists
        // to make unrepresentable.
        await this.#doRollback(
          job,
          job.deadline ? 'deadline' : 'requested',
          job.deadline,
        );
        return;
      case 'wake':
        this.#doWake(job);
        return;
      case 'checkin':
        // Handled in intake, before the queue. Unreachable, and left as a
        // throw rather than a no-op so that a future refactor that routes it
        // here finds out immediately.
        throw new Error('checkin must be handled in intake, not dispatched');
    }
  }

  // ── Allowlist resolution ────────────────────────────────────────────────
  //
  // What is left of it. `instance` is still compared by exact string equality
  // against config, and what reaches a command is the CONFIG ENTRY — every
  // docker argv downstream is built from that object, never from the request.
  // The request selects; it never supplies.
  //
  // That rule is intact for `rollback` and for the snapshot/restore paths,
  // which are the only places a request's string still reaches an argv. It
  // does not and cannot apply to a task, which is prose.

  #resolveRepo(name: string): RepoEntry | null {
    return this.#config.repos.find((repo) => repo.name === name) ?? null;
  }

  #resolveInstance(name: string): InstanceEntry | null {
    return this.#config.instances.find((instance) => instance.name === name) ?? null;
  }

  /**
   * The service account the host agent runs as, resolved fresh.
   *
   * Public so `index.ts` can print it in the boot banner and so the self-test
   * can assert on the refusals without starting a task. Deliberately NOT
   * memoised: see #doTask for why a cached answer would miss the exact change
   * this check exists to catch.
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

  // ── task ────────────────────────────────────────────────────────────────

  /**
   * Which instances a task is allowed to disturb, and therefore which ones get
   * snapshotted, idle-waited, health-checked and rolled back.
   *
   * A named instance narrows it to that one. NO named instance means ALL of
   * them, and that default is the expensive one on purpose. "Which containers
   * might this sentence disturb" has no answer — the sentence is prose and the
   * session has a shell — and the only safe reading of "no answer" is the same
   * one `readIdle` uses for a missing waker status file: assume the dangerous
   * case. Naming an instance is how an agent buys a cheap, fast task; the cost
   * of not naming one is a couple of `docker commit`s and a wait for both
   * agents to go idle.
   */
  #scopeOf(request: OpsRequest): InstanceEntry[] {
    if (request.instance) {
      const one = this.#resolveInstance(request.instance);
      return one ? [one] : [];
    }
    return [...this.#config.instances];
  }

  /**
   * Hand a task to a Claude Code session on the host and supervise it.
   *
   * The order of the steps is the design, and every one of them is here because
   * of something that has actually gone wrong on this host:
   *
   *   1. refuse if disabled or if the owner cannot be determined — a session
   *      run as root would leave root-owned files behind exactly the way the
   *      2026-08-09 `npm ci` did, only now for anything it touches;
   *   2. sample health BEFORE, so that "this was already broken" and "this task
   *      broke it" are distinguishable afterwards. Without a baseline the check
   *      would blame every task for every pre-existing failure and would be
   *      turned off within a week;
   *   3. snapshot every instance in scope, and record the tag to go back to.
   *      Taken now rather than looked up later for the same reason `redeploy`
   *      took one first: afterwards, the newest snapshot could easily be one
   *      taken of the broken state;
   *   4. wait for an idle turn on every instance in scope, because a task may
   *      recreate a container and every live session is a `docker exec` into
   *      one;
   *   5. run the session, auditing every command as it is issued;
   *   6. sample health AFTER, compare, and roll back if anything regressed or
   *      the agent reported failure;
   *   7. arm a check-in deadline for each instance the task actually touched —
   *      which the audit can answer, because it holds every command.
   */
  async #doTask(job: Job): Promise<void> {
    const { request } = job;

    if (!this.#config.hostAgent.enabled) {
      this.#reject(
        job,
        'hostAgent.enabled is false in ops-config.yaml, so tasks are refused. Deadlines, ' +
          'check-ins and rollbacks still work — this is the setting to leave the host in ' +
          'while somebody works out what the last task did, and it is strictly better than ' +
          'stopping the unit, which would drop every armed deadline.',
      );
      return;
    }

    if (request.instance && !this.#resolveInstance(request.instance)) {
      this.#rejectUnknownInstance(job);
      return;
    }

    // ── Who is this session, and is that account still contained? ────────
    //
    // Re-resolved from /etc/passwd and /etc/group here, for every task, rather
    // than cached from boot. That is the whole reason the check lives at task
    // time: the membership it exists to catch — `usermod -aG docker
    // clawcius-ops`, typed to make something work — is added to a RUNNING host,
    // and a boot-time check on a unit that stays up for weeks would not see it
    // until the next restart. Costs two small file reads per task.
    const agent = this.#resolveAgent();
    if (!agent.ok) {
      this.#fail(job, `${agent.reason}\n\nThe host agent was not started.`);
      return;
    }
    const problems = agentProblems(agent.user, identityOptionsFor(this.#config));
    if (problems.length > 0) {
      this.#fail(
        job,
        `refusing to run a task as ${describeAgentUser(agent.user)}:\n\n` +
          problems.map((problem) => `  * ${problem}`).join('\n\n') +
          '\n\nSince 2026-08-11 the containment story for this service is that the session ' +
          'runs as an unprivileged account of its own. The sudoers scoping, the root-owned ' +
          'journal and the claim that it holds no credential are all downstream of that one ' +
          'fact and none of them survive without it. Nothing was run; the executor is still ' +
          'holding its deadlines and will still perform rollbacks and check-ins.',
      );
      return;
    }
    for (const warning of agentWarnings(agent.user, identityOptionsFor(this.#config))) {
      this.#journal.write({
        kind: 'request',
        what: describeRequest(request),
        requester: job.requester,
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

    const scope = this.#scopeOf(request);
    const before = await this.#sampleHealth();

    // ── Snapshot everything in scope, before anything happens ────────────
    const rollbackTags = new Map<string, string>();
    for (const instance of scope) {
      const snapshot = await this.#snapshotInstance(instance);
      if (!snapshot.ok) {
        this.#fail(
          job,
          `could not snapshot ${instance.name} before starting the task: ` +
            `${snapshot.stderr || summarise(snapshot)}. REFUSING to run it — a task with a ` +
            'shell and no rollback target is not a deployment, it is a coin toss. Since ' +
            '2026-08-10 the ability to undo is what replaced the verb allowlist, so this is ' +
            'not a formality that can be skipped when it is inconvenient.',
        );
        return;
      }
      const tag = await this.#newestSnapshotTag(instance);
      if (!tag && !this.#config.dryRun) {
        this.#fail(
          job,
          `no snapshot images exist for ${this.#imageRepo(instance)} even after taking one. ` +
            'Refusing to run a task with nothing to go back to.',
        );
        return;
      }
      if (tag) rollbackTags.set(instance.name, tag);
    }

    // ── Wait for an idle turn on everything in scope ─────────────────────
    for (const instance of scope) {
      if (!(await this.#waitForIdle(job, instance, describeRequest(request)))) return;
    }

    // ── Run it ───────────────────────────────────────────────────────────
    const commands: string[] = [];
    const startedAt = Date.now();
    let outcome: HostAgentOutcome;
    try {
      outcome = await runHostAgent({
        config: this.#config,
        agent: agent.user,
        task: request.task,
        requester: job.requester,
        briefing: await this.#briefing(scope, agent.user),
        onAudit: (event) => {
          if (event.kind === 'bash') commands.push(event.command);
          this.#audit(job, event);
        },
        onLog: (line) => process.stdout.write(`[ops] ${line}\n`),
      });
    } catch (error) {
      // Includes the credential assertion in host-agent.ts, which throws rather
      // than warning. Nothing was started, so nothing needs rolling back — but
      // the snapshots were taken and are kept, because a snapshot nobody needed
      // costs disk and a snapshot somebody needed and did not have costs an
      // instance.
      this.#fail(job, `the host agent was not started: ${String(error)}`);
      return;
    }

    this.#lastTask = {
      at: startedAt,
      requester: job.requester,
      instance: request.instance || '(all)',
      what: describeRequest(request),
      commands: outcome.commands.length,
      turns: outcome.turns,
      costUsd: outcome.costUsd,
      ok: outcome.ok,
      dryRun: outcome.dryRun,
      sessionId: outcome.sessionId,
    };

    // ── Was the audit complete? ──────────────────────────────────────────
    //
    // Checked before the outcome is believed, and it FAILS the task. Every
    // command the session ran arrived through the stream that produced this
    // count, so a line that could not be parsed is a command that may have run
    // without being recorded. Since 2026-08-10 the audit is what stands where
    // the verb allowlist stood; an audit with an admitted hole in it is not a
    // smaller version of the same thing, it is the absence of the only control
    // there is.
    const auditBroken = outcome.unparsedLines > 0;

    // The agent is told to say "failed" plainly and first when it fails. This
    // is a heuristic over model prose and it is deliberately in plain sight
    // rather than buried: it only ever moves the verdict towards failure, and
    // the cost of a false positive is an unnecessary rollback to a snapshot
    // taken sixty seconds earlier.
    const saidFailed = /\bfailed\b/i.test(outcome.resultText.slice(0, 400));

    const after = await this.#sampleHealth();
    const regressions = compareHealth(before, after);

    const ok = outcome.ok && !auditBroken && !saidFailed && regressions.length === 0;

    this.#journal.write({
      kind: ok ? 'finished' : 'failed',
      what: describeRequest(request),
      instance: request.instance || undefined,
      requester: job.requester,
      ok,
      dryRun: outcome.dryRun,
      detail:
        `host agent session ${outcome.sessionId}: ${outcome.reason} — ${outcome.detail} ` +
        `${outcome.commands.length} command(s), ${outcome.turns} turn(s), ` +
        `$${outcome.costUsd.toFixed(4)}, ${(outcome.durationMs / 1000).toFixed(1)}s` +
        (outcome.denials ? `, ${outcome.denials} call(s) refused by the permission system` : '') +
        (auditBroken
          ? `\nAUDIT INCOMPLETE: ${outcome.unparsedLines} unparseable line(s) in the output ` +
            'stream. The task is failed for this on its own. A command that runs and is not ' +
            'logged is the one failure this design cannot tolerate.'
          : '') +
        (saidFailed && outcome.ok
          ? '\nThe agent exited cleanly but its report says "failed", which is taken at its ' +
            'word.'
          : '') +
        (regressions.length
          ? `\nHEALTH REGRESSED: ${regressions.join('; ')}`
          : '') +
        `\nreport: ${outcome.resultText.slice(0, 4000) || '(none)'}`,
    });

    // ── Roll back, if it went wrong ──────────────────────────────────────
    let rolledBack: string[] = [];
    if (!ok && !outcome.dryRun) {
      rolledBack = await this.#restoreAll(job, scope, rollbackTags);
    }

    this.#reportBack(job, request, outcome, regressions, rolledBack, ok);

    if (!ok) {
      // Only a rollback that actually happened counts towards the breaker. A
      // task that failed harmlessly — a typo, a refusal, an agent that decided
      // the request was unsafe — must not push the executor towards a freeze,
      // or two bad sentences in a row would take the whole mechanism offline.
      if (rolledBack.length > 0) {
        this.#noteRecoveryFailure(`a task was rolled back: ${describeRequest(request)}`);
      }
      return;
    }

    if (outcome.dryRun) return;

    // ── Arm a deadline for whatever it actually touched ──────────────────
    for (const instance of this.#touched(scope, request, outcome.commands)) {
      this.#armDeadline(instance, {
        build: await this.#buildId(instance),
        rollbackTag: rollbackTags.get(instance.name) ?? '',
        reason:
          request.reason ||
          `a task filed by ${job.requester} touched ${instance.name}: ` +
            describeRequest(request),
        requester: job.requester,
        skipped: false,
      });
    }
  }

  /**
   * Which instances did the task actually touch?
   *
   * Answered from the audit, which is the point of having one. A named instance
   * always counts. Beyond that, any instance whose container name, image or
   * script appears in any command the session ran is treated as touched, and
   * therefore owes a check-in.
   *
   * This is a substring match over shell text, which is to say it is
   * over-broad: `echo "not touching hamachi-agent"` counts. That is the right
   * direction to be wrong in. A false positive costs one wake and one check-in;
   * a false negative is an instance that was recreated with nobody waiting to
   * hear whether it came back, which is the failure the deadline exists for.
   */
  #touched(scope: InstanceEntry[], request: OpsRequest, commands: string[]): InstanceEntry[] {
    const haystack = commands.join('\n');
    return scope.filter((instance) => {
      if (request.instance === instance.name) return true;
      return (
        haystack.includes(instance.container) ||
        haystack.includes(instance.image) ||
        haystack.includes(this.#config.runContainerScript) ||
        haystack.includes(this.#config.snapshotScript)
      );
    });
  }

  /** One audit line into the durable record, before the command's result is known. */
  #audit(job: Job, event: AuditEvent): void {
    this.#auditedCommands += event.kind === 'bash' ? 1 : 0;
    this.#journal.write({
      kind: 'audit',
      what: event.kind === 'bash' ? 'bash' : `${event.kind} ${event.tool}`,
      instance: job.request.instance || undefined,
      requester: job.requester,
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
          `state ${instance.stateDir}, ops spool ${instance.opsSpoolDir}`,
      );
    }
    lines.push(
      `In scope for this task (snapshotted before it started, health-checked after, and ` +
        `rolled back if it fails): ${scope.map((i) => i.name).join(', ') || '(none)'}.`,
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
    lines.push(
      'Snapshot script: ' +
        `${this.#config.snapshotScript}; container script: ${this.#config.runContainerScript}.`,
    );

    return lines.join('\n');
  }

  // ── Snapshots and restores ──────────────────────────────────────────────

  /**
   * Commit the instance's writable layer to an image.
   *
   * Not destructive: `docker commit` on a running container does not stop it,
   * which is what makes it usable as the "capture the current good state" step
   * in front of everything.
   *
   * `KEEP` is passed explicitly. `docker/snapshot.sh` defaults to 8, which was
   * sized for one snapshot a night before a redeploy. Since 2026-08-10 one is
   * taken before EVERY task, and at 8 a busy evening would evict the previous
   * night's backup by morning — the retention ring is shared between this and
   * the nightly timer, and whoever runs last prunes to their own ceiling.
   */
  async #snapshotInstance(instance: InstanceEntry): Promise<CommandResult> {
    return this.#runner.run([this.#config.snapshotScript], {
      env: {
        CLAWCIUS_CONTAINER: instance.container,
        CLAWCIUS_SNAPSHOT_REPO: this.#imageRepo(instance),
        KEEP: String(this.#config.snapshotKeep),
      },
      timeoutSeconds: 900,
    });
  }

  /**
   * Put every in-scope instance back to the snapshot taken before the task.
   *
   * Returns the names actually restored. Deliberately does NOT wait for an idle
   * turn: the idle wait already happened before the task, and a container that
   * a failed task has just wedged may never report idle again — which would
   * turn "roll back on failure" into "roll back unless the failure was bad
   * enough to matter". A live turn lost during a rollback is the cost of the
   * task having failed, not a reason to leave the instance broken.
   *
   * A restore that itself fails is journalled and does not stop the others.
   * One broken instance is a bad night; two, because the loop gave up on the
   * first, is a worse one.
   */
  async #restoreAll(
    job: Job,
    scope: InstanceEntry[],
    tags: Map<string, string>,
  ): Promise<string[]> {
    const restored: string[] = [];
    for (const instance of scope) {
      const tag = tags.get(instance.name);
      if (!tag) {
        this.#journal.write({
          kind: 'failed',
          what: `rollback ${instance.name}`,
          instance: instance.name,
          requester: SELF_REQUESTER,
          ok: false,
          detail:
            'the task failed and there is no pre-task snapshot tag for this instance, so ' +
            'there is nothing to restore. This should be unreachable — the task is refused ' +
            'when the pre-task snapshot fails — and if you are reading it, find out why.',
        });
        continue;
      }
      const result = await this.#restoreSnapshot(instance, tag);
      this.#journal.write({
        kind: result.ok ? 'finished' : 'failed',
        what: `rollback ${instance.name} to ${tag}`,
        instance: instance.name,
        requester: SELF_REQUESTER,
        ok: result.ok,
        dryRun: result.skipped,
        command: render(result.argv),
        detail:
          `automatic: restoring the snapshot taken before "${describeRequest(job.request)}" ` +
          `failed. ${summarise(result)}` +
          (result.stderr.trim() ? `\nstderr: ${result.stderr.trim().slice(0, 2000)}` : ''),
      });
      if (result.ok) restored.push(instance.name);
    }
    return restored;
  }

  /** Retag a snapshot as the live image and recreate the container from it. */
  async #restoreSnapshot(instance: InstanceEntry, tag: string): Promise<CommandResult> {
    const repo = this.#imageRepo(instance);
    const retag = await this.#runner.run([
      this.#config.dockerPath,
      'tag',
      `${repo}:${tag}`,
      instance.image,
    ]);
    if (!retag.ok) return retag;
    return this.#runner.run([this.#config.runContainerScript, '--recreate'], {
      env: this.#instanceEnv(instance),
      timeoutSeconds: 900,
    });
  }

  /**
   * Count one failed recovery, and freeze if that was one too many.
   *
   * Shared by the missed-deadline path and the rolled-back-task path, because
   * they are the same event from the breaker's point of view: something was
   * done, it did not work, and the machine put it back. Repeating that is how a
   * bad night becomes an outage that reinstalls itself on a timer.
   */
  #noteRecoveryFailure(what: string): void {
    const failures = this.#state.recordRecoveryFailure();
    if (failures < this.#config.breaker.maxConsecutiveFailedRecoveries) return;
    const why =
      `${failures} consecutive failed recoveries (ceiling ` +
      `${this.#config.breaker.maxConsecutiveFailedRecoveries}); the last was: ${what}. ` +
      'Something is wrong that another task cannot fix, and continuing would mean ' +
      'reinstalling the outage on a timer. Stopped.';
    this.#state.freeze(why);
    this.#journal.write({
      kind: 'frozen',
      what: 'executor frozen',
      requester: SELF_REQUESTER,
      ok: false,
      detail: why,
    });
    process.stderr.write(
      `[ops] ══ FROZEN ══ ${why}\n` +
        '[ops] Tasks and rollbacks are refused until ops/unfreeze.sh is run on the host.\n',
    );
  }

  // ── Reporting back ──────────────────────────────────────────────────────

  /**
   * Tell the agent that filed the task what happened, through its wake spool.
   *
   * This is the whole reason the host agent holds no Discord token. It says
   * nothing to anybody; it hands its report to the executor, the executor files
   * a wake into the requesting instance's own spool, and the sandboxed agent —
   * which has the token, and is the thing the operator is actually talking to —
   * does the talking.
   *
   * The report text is model output that was produced while reading a task an
   * agent wrote. Whoever renders it downstream owes it the same suspicion as
   * `reason` and `detail`, and it is delivered as a wake prompt rather than as
   * anything structured for exactly that reason.
   */
  #reportBack(
    job: Job,
    request: OpsRequest,
    outcome: HostAgentOutcome,
    regressions: string[],
    rolledBack: string[],
    ok: boolean,
  ): void {
    const instance = this.#resolveInstance(job.requester);
    if (!instance) return; // filed by the executor itself; nobody to tell.

    this.#fileWake(
      instance,
      [
        `Your ops task ${ok ? 'SUCCEEDED' : 'FAILED'}${outcome.dryRun ? ' (DRY RUN — nothing was executed)' : ''}.`,
        '',
        `Task, as you filed it: ${describeRequest(request)}`,
        `Session ${outcome.sessionId}: ${outcome.commands.length} command(s), ` +
          `${outcome.turns} turn(s), $${outcome.costUsd.toFixed(4)}, ` +
          `${(outcome.durationMs / 1000).toFixed(1)}s.`,
        ...(regressions.length ? ['', `Health regressed: ${regressions.join('; ')}`] : []),
        ...(rolledBack.length
          ? [
              '',
              `ROLLED BACK: ${rolledBack.join(', ')} — restored to the snapshot taken before ` +
                'this task started. Anything the task changed inside those containers is gone. ' +
                'Anything it changed on the HOST filesystem is NOT rolled back; that is the ' +
                "VPS snapshot's job and a person's decision.",
            ]
          : []),
        '',
        'The host agent reported:',
        '',
        outcome.resultText.slice(0, 6000) || '(it produced no report)',
        '',
        'Every command it ran is in the ops journal, in full. If you are about to tell the',
        'operator what happened, tell them what it actually did, not what you asked for.',
      ].join('\n'),
    );
  }

  // ── rollback ────────────────────────────────────────────────────────────

  /**
   * Restore a snapshot image and recreate the container.
   *
   * `origin` distinguishes an operator/agent request from the automatic one
   * fired by a missed deadline, because the two have different consequences:
   * the automatic path quarantines the build it is replacing and counts
   * towards the breaker, and deliberately does NOT arm a new deadline. A
   * deadline whose expiry triggers another rollback is a loop with a timer on
   * it, and this daemon exists partly to make sure that loop cannot start.
   */
  async #doRollback(
    job: Job,
    origin: 'requested' | 'deadline',
    pending?: PendingCheckin,
  ): Promise<void> {
    const { request } = job;
    const instance = this.#resolveInstance(request.instance);
    if (!instance) {
      this.#rejectUnknownInstance(job);
      return;
    }

    const repo = this.#imageRepo(instance);
    let tag = request.tag;

    if (tag) {
      // Belt and braces over `parseRequest`: the shape was checked there, and
      // here we check the thing actually exists. Both matter — the pattern
      // stops a hostile string reaching docker, the existence check stops a
      // well-formed tag for an image nobody ever built taking the container
      // down and leaving it down.
      if (!SNAPSHOT_TAG.test(tag)) {
        this.#fail(job, `"${tag}" is not a snapshot tag`);
        return;
      }
      const known = await this.#snapshotTags(instance);
      if (!known.includes(tag)) {
        this.#fail(
          job,
          `${repo}:${tag} does not exist on this host. Known snapshots: ` +
            `${known.slice(0, 8).join(', ') || '(none)'}`,
        );
        return;
      }
    } else {
      tag = (await this.#newestSnapshotTag(instance)) ?? '';
      if (!tag) {
        this.#fail(
          job,
          `no snapshot images exist for ${repo}. There is nothing to roll back to — this ` +
            'is exactly the state clawcius-snapshot-verify.timer exists to stop you ' +
            'discovering during an incident.',
        );
        return;
      }
    }

    const idle = await this.#waitForIdle(job, instance, describeRequest(request));
    if (!idle) return;

    const retag = await this.#runner.run([
      this.#config.dockerPath,
      'tag',
      `${repo}:${tag}`,
      instance.image,
    ]);
    if (!retag.ok) {
      this.#fail(job, `could not tag ${repo}:${tag} as ${instance.image}: ${retag.stderr}`);
      return;
    }

    const result = await this.#runner.run([this.#config.runContainerScript, '--recreate'], {
      env: this.#instanceEnv(instance),
      timeoutSeconds: 900,
    });
    this.#finish(job, result, `rollback ${instance.name} to ${tag}`);

    if (origin !== 'deadline') return;

    // ── The automatic path ───────────────────────────────────────────────
    if (pending?.build) {
      this.#state.quarantine(
        instance.name,
        pending.build,
        `missed its check-in deadline after: ${pending.reason}`,
      );
      this.#journal.write({
        kind: 'breaker',
        what: `quarantine ${instance.name}`,
        instance: instance.name,
        requester: SELF_REQUESTER,
        detail:
          `build ${pending.build.slice(0, 12)} will not be deployed again. It was rolled ` +
          'back once; a build that has already failed to come back does not get a second ' +
          'attempt at taking the instance down.',
      });
    }

    const failures = this.#state.recordRecoveryFailure();
    if (failures >= this.#config.breaker.maxConsecutiveFailedRecoveries) {
      const why =
        `${failures} consecutive failed recoveries (ceiling ` +
        `${this.#config.breaker.maxConsecutiveFailedRecoveries}). Something is wrong that ` +
        'redeploying cannot fix, and continuing would mean reinstalling the outage on a ' +
        'timer. Stopped.';
      this.#state.freeze(why);
      this.#journal.write({
        kind: 'frozen',
        what: 'executor frozen',
        instance: instance.name,
        requester: SELF_REQUESTER,
        ok: false,
        detail: why,
      });
      process.stderr.write(
        `[ops] ══ FROZEN ══ ${why}\n` +
          `[ops] Destructive verbs are refused until ops/unfreeze.sh is run on the host.\n`,
      );
    }

    // Report, and do not arm anything. The instance gets told what happened;
    // nobody is waiting on an answer, because the answer would only be able to
    // trigger another rollback.
    this.#fileWake(
      instance,
      [
        `You were ROLLED BACK to snapshot ${tag}.`,
        '',
        `Why: you did not check in within the deadline after: ${pending?.reason ?? 'a rebuild'}.`,
        '',
        'The build you were running has been quarantined and will not be deployed again.',
        'No new deadline is armed — this is a report, not a request for a reply.',
        '',
        'Verify you are actually working, then say so in the channel. If the rollback did',
        'not fix it, do not ask for another redeploy: look at the host.',
      ].join('\n'),
    );
  }

  // ── checkin ─────────────────────────────────────────────────────────────

  #handleCheckin(job: Job): void {
    const { request } = job;
    const instance = this.#resolveInstance(request.instance);
    if (!instance) {
      this.#rejectUnknownInstance(job);
      return;
    }

    const pending = this.#state.disarm(instance.name);
    if (!pending) {
      // Not an error. An agent checking in when nobody asked is a healthy
      // instinct and costs nothing; saying so keeps the journal honest about
      // which check-ins actually closed a deadline.
      this.#journal.write({
        kind: 'request',
        what: `checkin ${instance.name}`,
        instance: instance.name,
        requester: job.requester,
        detail: `no deadline was armed for ${instance.name}; noted and ignored`,
      });
      return;
    }

    const timer = this.#deadlineTimers.get(instance.name);
    if (timer) clearTimeout(timer);
    this.#deadlineTimers.delete(instance.name);

    this.#state.recordRecoverySuccess();
    this.#journal.write({
      kind: 'deadline-met',
      what: `checkin ${instance.name}`,
      instance: instance.name,
      requester: job.requester,
      ok: true,
      detail:
        `checked in with ${((pending.deadlineAt - Date.now()) / 60000).toFixed(1)} minutes to ` +
        `spare after: ${pending.reason}` +
        (request.detail ? `. It says: ${request.detail}` : '') +
        '. Consecutive failed recoveries reset to 0.' +
        // Worth saying out loud rather than leaving to whoever compares two
        // fields. A check-in is an instance answering for ITSELF: "I came back
        // up." One instance vouching for another's recovery is not obviously
        // wrong — an operator may want exactly that — but it is not what the
        // deadline asked for, and before per-instance spools it was
        // unobservable. It is not refused here; `mayRequest.instances` is the
        // place to refuse it, deliberately, per instance.
        (job.requester !== instance.name && job.requester !== SELF_REQUESTER
          ? ` NOTE: this check-in was filed by ${job.requester}, not by ${instance.name} ` +
            'itself. The deadline is closed, but the instance that was rebuilt has not ' +
            'actually said anything.'
          : ''),
    });
  }

  // ── wake ────────────────────────────────────────────────────────────────

  /**
   * Forward a wake into the instance's existing wake spool.
   *
   * This verb exists so that the ops spool is genuinely one queue with a verb
   * list rather than a second queue next to the old one — and it is the only
   * verb that touches the waker's directory. It runs no command and grants no
   * privilege: the waker already accepts wake files written by the agent, so
   * relaying one adds nothing the agent could not do itself. The rate limit
   * and concurrency cap on the waker side still apply, unchanged.
   */
  #doWake(job: Job): void {
    const { request } = job;
    // A wake is addressed to a channel, and the channel belongs to whichever
    // instance owns that spool. Without a named instance there is nowhere to
    // put the file, so the verb takes the channel and we route by the only
    // instance configured to use it.
    const instance =
      this.#config.instances.find((entry) => entry.wakeChannelId === request.channel) ??
      (this.#config.instances.length === 1 ? this.#config.instances[0] : undefined);

    if (!instance) {
      this.#reject(
        job,
        `channel ${request.channel} does not match any instance's wakeChannelId, and there ` +
          'is more than one instance configured, so there is no unambiguous spool to file ' +
          'it in.',
      );
      return;
    }

    // The second scope check, and the only verb that needs one.
    //
    // `wake` names a channel, not an instance, so the target does not exist as
    // a field at intake time — it is discovered here, by routing. Checking only
    // at intake would leave `mayRequest.instances` with a hole exactly the
    // shape of "wake the other agent", which is the one thing a restricted
    // instance most obviously should not be able to do: a wake starts a turn
    // in somebody else's agent with attacker-influenced text in the prompt.
    const scope = this.#config.instances.find((entry) => entry.name === job.requester)
      ?.mayRequest;
    if (scope?.instances && !scope.instances.includes(instance.name)) {
      this.#reject(
        job,
        `out of scope: "${job.requester}" may not wake ${instance.name} (channel ` +
          `${request.channel} routes to it). Its mayRequest.instances allows: ` +
          `${scope.instances.join(', ') || '(none)'}. Checked here rather than at intake ` +
          'because a wake names a channel and the target instance is only known after ' +
          'routing.',
      );
      return;
    }

    const ok = this.#writeWakeFile(instance, request.channel, request.detail);
    this.#journal.write({
      kind: ok ? 'finished' : 'failed',
      what: describeRequest(request),
      instance: instance.name,
      requester: job.requester,
      ok,
      detail: ok
        ? `filed a wake for ${instance.name} in ${instance.wakeSpoolDir}, on behalf of ` +
          `${job.requester}`
        : `could not write into ${instance.wakeSpoolDir}`,
    });
  }

  // ── Idle waiting ────────────────────────────────────────────────────────

  /**
   * Block until the instance reports no turns in flight, or give up.
   *
   * Giving up ABANDONS the operation. It does not proceed anyway after a
   * polite wait, and it does not queue itself for later — both of those are
   * ways of turning "we decided not to interrupt anyone" into "we interrupted
   * someone, eventually". The agent can ask again.
   */
  async #waitForIdle(job: Job, instance: InstanceEntry, what: string): Promise<boolean> {
    const deadline = Date.now() + this.#config.idle.maxWaitMinutes * 60_000;
    let waited = 0;
    let lastReason = '';

    for (;;) {
      const verdict = readIdle(instance.wakerStatusFile, this.#config.idle.staleSeconds);
      if (verdict.idle) {
        if (waited > 0) {
          this.#journal.write({
            kind: 'idle-wait',
            what,
            instance: instance.name,
            requester: job.requester,
            detail: `idle after waiting ${(waited / 60).toFixed(1)} minutes — ${verdict.reason}`,
          });
        }
        return true;
      }

      if (verdict.reason !== lastReason) {
        lastReason = verdict.reason;
        this.#journal.write({
          kind: 'idle-wait',
          what,
          instance: instance.name,
          requester: job.requester,
          detail: `waiting for an idle turn: ${verdict.reason}`,
        });
      }

      if (Date.now() >= deadline) {
        this.#journal.write({
          kind: 'failed',
          what,
          instance: instance.name,
          requester: job.requester,
          ok: false,
          detail:
            `gave up after ${this.#config.idle.maxWaitMinutes} minutes waiting for ` +
            `${instance.name} to be idle (${verdict.reason}). ABANDONED, not deferred — ` +
            'recreating the container over a live turn would kill it mid-conversation, and ' +
            'a request that quietly waits forever is worse than one that says no.',
        });
        return false;
      }

      await sleep(this.#config.idle.pollSeconds * 1000);
      waited += this.#config.idle.pollSeconds;
    }
  }

  // ── Deadlines ───────────────────────────────────────────────────────────

  #armDeadline(
    instance: InstanceEntry,
    options: {
      build: string;
      rollbackTag: string;
      reason: string;
      /** Who asked for the operation this deadline is attached to. */
      requester: string;
      skipped: boolean;
    },
  ): void {
    if (options.skipped) {
      // Dry run. Nothing was rebuilt, so there is nothing to verify and
      // nobody to check in. Arming a deadline here would schedule a rollback
      // of a container that was never touched, which is the one way a dry run
      // could do damage.
      this.#journal.write({
        kind: 'deadline-armed',
        what: `checkin ${instance.name}`,
        instance: instance.name,
        requester: options.requester,
        dryRun: true,
        detail:
          `DRY RUN — would have armed a ${this.#config.deadline.minutes}-minute check-in ` +
          `deadline and filed a wake to ${instance.wakeChannelId}. Nothing armed.`,
      });
      return;
    }

    const pending: PendingCheckin = {
      instance: instance.name,
      deadlineAt: Date.now() + this.#config.deadline.minutes * 60_000,
      reason: options.reason,
      build: options.build,
      rollbackTag: options.rollbackTag,
      fromRollback: false,
      armedAt: Date.now(),
    };
    this.#state.arm(pending);
    this.#armTimer(pending);

    this.#journal.write({
      kind: 'deadline-armed',
      what: `checkin ${instance.name}`,
      instance: instance.name,
      requester: options.requester,
      detail:
        `${this.#config.deadline.minutes} minutes to check in, or roll back to ` +
        `${options.rollbackTag || '(no target!)'}. ` +
        (this.#config.deadline.autoRollback
          ? 'Auto-rollback is ON.'
          : 'Auto-rollback is OFF — a miss will only be reported.'),
    });

    this.#fileWake(
      instance,
      [
        `A host task touched you${options.build ? ` at build ${options.build.slice(0, 12)}` : ''}.`,
        '',
        `Why: ${options.reason}`,
        '',
        'The executor cannot tell exactly what changed — a task is free text carried out by',
        'a session with a shell, and what it did is in the ops journal, in full, command by',
        'command. What it CAN tell is that something it ran named your container, so if your',
        'container was recreated, anything that lived only in its writable layer is gone:',
        'packages installed by hand, crontabs, running daemons. Check the things you depend',
        'on, in this order:',
        '',
        '  1. Can you run a turn at all — you are reading this, so yes.',
        '  2. Is your Claude login intact? `claude auth status`.',
        '  3. Are your cron jobs and daemons back?',
        '  4. Can you reach the network through the proxy?',
        '',
        `Then check in, within ${this.#config.deadline.minutes} minutes of the rebuild:`,
        '',
        // The instance's OWN spool, which since 2026-08-10 is a different
        // directory for each of them. This text used to name the single
        // shared `spoolDir` — which meant that the one instruction sent to an
        // agent that had just been rebuilt, at the exact moment it most needed
        // to answer, pointed Hamachi at a path that does not exist inside
        // Hamachi's container. It would have failed the deadline for a reason
        // it could not have diagnosed and been rolled back for it.
        `    printf '%s' '{"verb":"checkin","instance":"${instance.name}","detail":"..."}' \\`,
        `      > ${join(instance.opsSpoolDir, '$(date +%s)-checkin.tmp')} \\`,
        `      && mv ${join(instance.opsSpoolDir, '$(date +%s)-checkin.tmp')} \\`,
        `           ${join(instance.opsSpoolDir, '$(date +%s)-checkin.json')}`,
        '',
        'If you do not check in, you will be rolled back automatically to the snapshot taken',
        `immediately BEFORE that task ran (${options.rollbackTag || 'none available'}), and`,
        'this build will be refused from then on. Say something in the channel either way.',
      ].join('\n'),
    );
  }

  #armTimer(pending: PendingCheckin): void {
    const existing = this.#deadlineTimers.get(pending.instance);
    if (existing) clearTimeout(existing);

    const delay = Math.max(0, pending.deadlineAt - Date.now());
    const timer = setTimeout(() => {
      this.#deadlineTimers.delete(pending.instance);
      void this.#enqueueDeadlineExpiry(pending);
    }, delay);
    // Not unref'd. This timer is the only thing standing between a broken
    // rebuild and an instance that stays broken, and a process that would
    // otherwise exit should not exit while one is armed.
    this.#deadlineTimers.set(pending.instance, timer);
  }

  /**
   * A deadline passed. Take the lock like everything else and roll back.
   *
   * Routed through the same queue rather than acting immediately, because the
   * lock is the thing that makes "one operation at a time" true, and an
   * automatic operation that ignores it would be the one case where two docker
   * operations overlap — during an incident, which is the worst time for it.
   */
  async #enqueueDeadlineExpiry(pending: PendingCheckin): Promise<void> {
    const still = this.#state.pendingFor(pending.instance);
    if (!still) return; // Checked in while we were getting here. Nothing to do.
    this.#state.disarm(pending.instance);

    this.#journal.write({
      kind: 'deadline-missed',
      what: `checkin ${pending.instance}`,
      instance: pending.instance,
      requester: SELF_REQUESTER,
      ok: false,
      detail:
        `no check-in within ${this.#config.deadline.minutes} minutes of: ${pending.reason}. ` +
        (this.#config.deadline.autoRollback
          ? `Rolling back to ${pending.rollbackTag || 'the newest snapshot'}.`
          : 'deadline.autoRollback is OFF, so this is a report only. Nothing will be ' +
            'rolled back and the instance stays as it is.'),
    });

    if (!this.#config.deadline.autoRollback) {
      this.#state.recordRecoveryFailure();
      return;
    }

    const request: OpsRequest = {
      verb: 'rollback',
      task: '',
      instance: pending.instance,
      tag: SNAPSHOT_TAG.test(pending.rollbackTag) ? pending.rollbackTag : '',
      channel: '',
      reason: `automatic: missed check-in after ${pending.reason}`,
      detail: '',
      unknownFields: [],
    };

    // Attributed to the executor, not to the instance it is being performed
    // on. That distinction only became expressible with per-instance spools,
    // and it is the one that matters most in this path: a rollback nobody
    // asked for is a different event from a rollback an agent requested, and
    // the journal is now able to say which it was reading.
    const job: Job = {
      raw: { name: '(deadline)', body: '', requester: SELF_REQUESTER },
      request,
      requester: SELF_REQUESTER,
      receivedAt: Date.now(),
      // The context travels WITH the job: the build to quarantine, the tag to
      // restore, and — by its presence — the fact that this is a deadline
      // rollback and not a requested one. Until 2026-08-11 this was a
      // parameter on a direct call, and the queued case lost all of it.
      deadline: pending,
    };

    // Straight onto the queue, ahead of nothing and behind whatever is
    // running. The rate limit does not apply — this is the executor's own
    // recovery action, not an agent's request, and letting an agent exhaust
    // the hourly budget to stop a rollback would be a lovely little exploit.
    // The scope check does not apply either, for the same reason: an instance
    // restricted to itself must still be recoverable by the daemon.
    this.#queue.push(job);
    if (this.#busy) {
      this.#journal.write({
        kind: 'queued',
        what: describeRequest(request),
        instance: pending.instance,
        requester: SELF_REQUESTER,
        detail:
          `automatic rollback waiting behind "${this.#busy}". It keeps its deadline ` +
          'origin while it waits, so the build being rolled back is still quarantined ' +
          'when it runs.',
      });
    }

    // And then through the ordinary lock, like everything else. There is no
    // second path any more: the branch that used to run the rollback inline
    // was the only one that passed the origin through, which is exactly why
    // the queued one silently stopped quarantining.
    await this.#pump();
  }

  // ── Docker/git introspection (read-only, always executed) ───────────────

  /** `clawcius-agent` from `clawcius-agent:latest`. */
  #imageRepo(instance: InstanceEntry): string {
    const colon = instance.image.lastIndexOf(':');
    return colon > 0 ? instance.image.slice(0, colon) : instance.image;
  }

  /**
   * What identifies "this build" for the circuit breaker.
   *
   * The checkout's HEAD where one is configured, because that is what a human
   * means by a build and because a fix is a new sha. Otherwise the image id,
   * which is coarser — it will not distinguish two deploys of the same image —
   * but still stops the identical bytes being redeployed in a loop.
   *
   * An empty string means "cannot identify", and the breaker skips. Loud in
   * the journal, because a breaker that cannot name a build cannot quarantine
   * one.
   */
  async #buildId(instance: InstanceEntry): Promise<string> {
    if (instance.buildRepo) {
      const repo = this.#resolveRepo(instance.buildRepo);
      if (repo) {
        const head = await this.#runner.probe(
          [this.#config.gitPath, '-C', repo.path, 'rev-parse', 'HEAD'],
          { timeoutSeconds: 30 },
        );
        if (head.ok && head.stdout.trim()) return head.stdout.trim();
      }
    }

    const image = await this.#runner.probe(
      [this.#config.dockerPath, 'image', 'inspect', '-f', '{{.Id}}', instance.image],
      { timeoutSeconds: 30 },
    );
    if (image.ok && image.stdout.trim()) return image.stdout.trim();

    this.#journal.write({
      kind: 'breaker',
      what: `build-id ${instance.name}`,
      instance: instance.name,
      detail:
        'could not determine a build identity from either the checkout or the image. The ' +
        'circuit breaker cannot quarantine what it cannot name, so a failure of this ' +
        'deploy will be rolled back but the build will NOT be blocked from being ' +
        'retried. Fix buildRepo in ops-config.yaml.',
    });
    return '';
  }

  /** Snapshot tags for an instance, newest first. */
  async #snapshotTags(instance: InstanceEntry): Promise<string[]> {
    const repo = this.#imageRepo(instance);
    const result = await this.#runner.probe(
      [this.#config.dockerPath, 'images', repo, '--format', '{{.Tag}}'],
      { timeoutSeconds: 60 },
    );
    if (!result.ok) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      // The pattern is the filter, not a convenience: it is what stops a tag
      // someone created by hand — or an image name that happens to sort
      // high — being restored over a working container.
      .filter((tag) => SNAPSHOT_TAG.test(tag))
      .sort()
      .reverse();
  }

  async #newestSnapshotTag(instance: InstanceEntry): Promise<string> {
    const tags = await this.#snapshotTags(instance);
    return tags[0] ?? '';
  }

  /**
   * The environment `docker/run-container.sh` reads.
   *
   * Every value is a config field. None of it comes from the request, which is
   * the same rule as everywhere else in this file — the request chose *which*
   * instance, and the instance's own config supplied everything about it.
   */
  #instanceEnv(instance: InstanceEntry): Record<string, string> {
    return {
      CLAWCIUS_CONTAINER: instance.container,
      CLAWCIUS_IMAGE: instance.image,
      CLAWCIUS_ENV_FILE: instance.envFile,
      CLAWCIUS_STATE_DIR: instance.stateDir,
      CLAWCIUS_CONTAINER_MEMORY: instance.memory,
    };
  }

  // ── Wake filing ─────────────────────────────────────────────────────────

  #fileWake(instance: InstanceEntry, prompt: string): void {
    if (this.#config.dryRun) {
      process.stdout.write(
        `[ops] DRY-RUN would file a wake for ${instance.name} in ${instance.wakeSpoolDir}:\n` +
          `${prompt.replace(/^/gm, '[ops]   ')}\n`,
      );
      return;
    }
    this.#writeWakeFile(instance, instance.wakeChannelId, prompt);
  }

  /**
   * Write one wake request the waker will pick up.
   *
   * Temp-then-rename, because the waker sweeps this directory on a timer and
   * `fs.watch` fires on create: a file written in place can be read while it
   * is still short, and the waker would report it as malformed and drop it.
   * The rename is atomic within the directory, so the waker only ever sees a
   * complete file.
   */
  #writeWakeFile(instance: InstanceEntry, channel: string, prompt: string): boolean {
    try {
      mkdirSync(instance.wakeSpoolDir, { recursive: true, mode: 0o770 });
      const stamp = `${Date.now()}-ops`;
      const temp = join(instance.wakeSpoolDir, `.${stamp}.tmp`);
      const final = join(instance.wakeSpoolDir, `${stamp}.json`);
      writeFileSync(temp, `${JSON.stringify({ channel, prompt }, null, 2)}\n`, { mode: 0o640 });
      renameSync(temp, final);
      return true;
    } catch (error) {
      process.stderr.write(
        `[ops] could not file a wake for ${instance.name}: ${String(error)}\n`,
      );
      return false;
    }
  }

  // ── Outcome logging ─────────────────────────────────────────────────────

  #finish(job: Job, result: CommandResult, what: string): void {
    this.#journal.write({
      kind: result.ok ? 'finished' : 'failed',
      what,
      instance: job.request.instance || undefined,
      requester: job.requester,
      ok: result.ok,
      dryRun: result.skipped,
      command: render(result.argv),
      detail:
        `${summarise(result)}` +
        (result.stdout.trim() ? `\nstdout: ${result.stdout.trim().slice(0, 2000)}` : '') +
        (result.stderr.trim() ? `\nstderr: ${result.stderr.trim().slice(0, 2000)}` : ''),
    });
  }

  #fail(job: Job, detail: string): void {
    this.#journal.write({
      kind: 'failed',
      what: describeRequest(job.request),
      instance: job.request.instance || undefined,
      requester: job.requester,
      ok: false,
      detail,
    });
  }

  #rejectUnknownInstance(job: Job): void {
    this.#reject(
      job,
      `"${job.request.instance}" is not in the instances allowlist. Allowed: ` +
        `${this.#config.instances.map((entry) => entry.name).join(', ') || '(none configured)'}`,
    );
  }

  // ── Shutdown ────────────────────────────────────────────────────────────

  stop(): void {
    this.#stopped = true;
    for (const timer of this.#deadlineTimers.values()) clearTimeout(timer);
    this.#deadlineTimers.clear();
    // The deadlines themselves are on disk and are re-armed on the next boot,
    // including any that expired while we were gone.
    this.#journal.write({
      kind: 'shutdown',
      what: 'clawcius-ops',
      detail:
        `stopping with ${this.#queue.length} queued and ` +
        `${this.#state.state.pending.length} deadline(s) armed. Deadlines are persisted and ` +
        'will be honoured on the next start, including any that pass while we are down.',
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
