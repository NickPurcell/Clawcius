/**
 * The executor: one operation at a time, from a fixed verb list, with a
 * deadline on anything that could take an agent off the air.
 *
 * ── Why this is a separate daemon ────────────────────────────────────────
 *
 * `restart clawcius.service` is one of the operations. A process cannot
 * restart itself: systemd sends it SIGTERM, it dies, and whatever it was in
 * the middle of dies with it — including the record of what it was doing and
 * the deadline it had just armed. Folding this into the waker would mean the
 * single most useful operation is the one operation that cannot be performed
 * reliably.
 *
 * The same argument applies with more force to `redeploy`: the waker's agent
 * sessions ARE `docker exec`s into the container being recreated, so a waker
 * running its own redeploy would be tearing down the processes it is made of.
 * The executor has to outlive the things it restarts, so it is a unit of its
 * own, with no Discord connection, no Anthropic credential and no model.
 *
 * ── No model. Ever. ──────────────────────────────────────────────────────
 *
 * There is no LLM in this file and there must never be one. This process runs
 * as root with docker and systemctl. Its entire safety argument is that the
 * set of things it can do is finite, enumerated, and readable in one sitting.
 * A model here would mean the set of things it can do is "whatever the model
 * was talked into", and the party doing the talking is on the other side of
 * the sandbox boundary this is supposed to defend.
 *
 * ── The lock ─────────────────────────────────────────────────────────────
 *
 * One operation at a time. Not a semaphore, not a per-instance lock, not a
 * "these two are independent so they can overlap" optimisation. A rollback of
 * one instance and a redeploy of another both run docker and both take
 * minutes, and reasoning about which pairs are safe to interleave is exactly
 * the sort of reasoning that is right until the day it is not. A second
 * request queues; past `limits.maxQueued` it is refused with a stated reason,
 * because a refusal the agent can read beats a request that silently
 * evaporates.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstanceEntry, OpsConfig, RepoEntry, UnitEntry } from './config.js';
import { Journal, type OpsStatusSnapshot } from './journal.js';
import { StateStore, type PendingCheckin } from './state.js';
import { readIdle } from './idle.js';
import { Runner, render, summarise, type CommandResult } from './runner.js';
import { describeRequest, isDestructive, parseRequest, type OpsRequest } from './request.js';
import { dirtyRefusal, readDirty, runBuild } from './build.js';
import type { RawRequest } from './spool.js';

/**
 * The executor's own unit, which it refuses to restart.
 *
 * Putting it in the config allowlist would be a mistake anyone could make; the
 * failure is that `systemctl restart clawcius-ops` kills the process mid-verb,
 * systemd brings it back with an empty queue, and the operation is simply
 * gone — no failure, no journal entry saying it did not finish, just a request
 * that was accepted and never happened. Refused by name rather than trusted to
 * config, and the operator is told to use systemctl by hand.
 */
const SELF_UNIT = 'clawcius-ops.service';

/** Snapshot tags, exactly as `docker/snapshot.sh` writes them. */
const SNAPSHOT_TAG = /^snap-[0-9]{8}-[0-9]{6}$/;

type Job = {
  raw: RawRequest;
  request: OpsRequest;
  receivedAt: number;
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
    const parsed = parseRequest(raw.body);

    if (!parsed.ok) {
      this.#journal.write({
        kind: 'rejected',
        what: raw.name,
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
        detail: `ignoring unknown field(s): ${request.unknownFields.join(', ')}`,
      });
    }

    this.#journal.write({
      kind: 'request',
      what: describeRequest(request),
      instance: request.instance || undefined,
      detail:
        `from ${raw.name}` + (request.reason ? ` — reason given: ${request.reason}` : ' (no reason given)'),
    });

    const now = Date.now();
    this.#accepted = this.#accepted.filter((at) => now - at < 3_600_000);
    if (this.#accepted.length >= this.#config.limits.maxPerHour) {
      this.#reject(
        request,
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
      this.#handleCheckin(request);
      return;
    }

    if (this.#state.state.frozen && isDestructive(request.verb)) {
      this.#reject(
        request,
        `the executor is FROZEN: ${this.#state.state.frozenReason}. Destructive verbs are ` +
          'refused until a human clears it with ops/unfreeze.sh. Nothing will be retried.',
      );
      return;
    }

    if (this.#queue.length >= this.#config.limits.maxQueued) {
      this.#reject(
        request,
        `${this.#queue.length} operation(s) already queued behind "${this.#busy ?? 'nothing'}" ` +
          `and the queue holds ${this.#config.limits.maxQueued}. Try again once it drains.`,
      );
      return;
    }

    this.#accepted.push(now);
    this.#queue.push({ raw, request, receivedAt: now });

    if (this.#busy) {
      this.#journal.write({
        kind: 'queued',
        what: describeRequest(request),
        instance: request.instance || undefined,
        detail: `waiting behind "${this.#busy}"; ${this.#queue.length} in the queue`,
      });
    }

    void this.#pump();
  }

  #reject(request: OpsRequest, detail: string): void {
    this.#journal.write({
      kind: 'rejected',
      what: describeRequest(request),
      instance: request.instance || undefined,
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
      dryRun: this.#config.dryRun,
      detail:
        `waited ${((Date.now() - job.receivedAt) / 1000).toFixed(1)}s in the queue` +
        (this.#config.dryRun ? '. DRY RUN — nothing will actually be executed.' : ''),
    });

    try {
      await this.#dispatch(job.request);
    } catch (error) {
      // The dispatcher is supposed to convert every failure into a journal
      // entry and return. Reaching here means a bug, and a bug in a daemon
      // holding docker must not take the daemon down — the queue behind it
      // would go with it.
      this.#journal.write({
        kind: 'failed',
        what: this.#busy,
        instance: job.request.instance || undefined,
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
   * The closed switch.
   *
   * Note what is absent: a `default` that does something. The verb has already
   * been checked against the frozen list in `parseRequest`, and TypeScript's
   * exhaustiveness check on the union is the second layer — adding a verb to
   * `VERBS` without handling it here is a compile error, not a runtime
   * surprise.
   */
  async #dispatch(request: OpsRequest): Promise<void> {
    switch (request.verb) {
      case 'restart':
        await this.#doRestart(request);
        return;
      case 'pull':
        await this.#doPull(request);
        return;
      case 'snapshot':
        await this.#doSnapshot(request);
        return;
      case 'redeploy':
        await this.#doRedeploy(request);
        return;
      case 'rollback':
        await this.#doRollback(request, 'requested');
        return;
      case 'wake':
        this.#doWake(request);
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
  // These three are the only places a string from the spool is compared with
  // anything, and all three are exact equality against config. What comes back
  // is the CONFIG ENTRY — every command downstream is built from that object,
  // never from the request. The request selects; it never supplies.

  #resolveUnit(name: string): UnitEntry | null {
    return this.#config.units.find((unit) => unit.name === name) ?? null;
  }

  #resolveRepo(name: string): RepoEntry | null {
    return this.#config.repos.find((repo) => repo.name === name) ?? null;
  }

  #resolveInstance(name: string): InstanceEntry | null {
    return this.#config.instances.find((instance) => instance.name === name) ?? null;
  }

  // ── restart ─────────────────────────────────────────────────────────────

  async #doRestart(request: OpsRequest): Promise<void> {
    if (request.unit === SELF_UNIT) {
      this.#reject(
        request,
        `${SELF_UNIT} is this process. Restarting it from inside itself would kill the ` +
          'operation mid-flight and lose the record of it. Do it by hand on the host.',
      );
      return;
    }

    const unit = this.#resolveUnit(request.unit);
    if (!unit) {
      this.#reject(
        request,
        `"${request.unit}" is not in the units allowlist. Allowed: ` +
          `${this.#config.units.map((entry) => entry.name).join(', ') || '(none configured)'}`,
      );
      return;
    }

    const result = await this.#runner.run([
      this.#config.systemctlPath,
      'restart',
      unit.name,
    ]);
    this.#finish(request, result, `restart ${unit.name} (${unit.description})`);
  }

  // ── pull ────────────────────────────────────────────────────────────────
  //
  // `pull` is "bring this checkout up to date and make it runnable", not
  // "run git pull". The two came apart on 2026-08-09 and cost an hour; see
  // #buildCheckout below and the header of ops/src/build.ts for the whole
  // account. A verb that fetches source and stops, next to a `restart` verb, is
  // an invitation to restart onto a stale dist/ — and unlike a human, an
  // executor accepts that invitation every single time it is offered.

  async #doPull(request: OpsRequest): Promise<void> {
    const repo = this.#resolveRepo(request.repo);
    if (!repo) {
      this.#reject(
        request,
        `"${request.repo}" is not in the repos allowlist. Allowed: ` +
          `${this.#config.repos.map((entry) => entry.name).join(', ') || '(none configured)'}`,
      );
      return;
    }

    // Two probes before touching anything, both read-only, both run even in
    // dry-run — a dry run that cannot see the checkout would report a pull it
    // has no reason to believe would succeed.
    const branch = await this.#runner.probe(
      [this.#config.gitPath, '-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeoutSeconds: 30 },
    );
    if (!branch.ok) {
      this.#fail(request, `cannot read HEAD in ${repo.path}: ${branch.stderr || summarise(branch)}`);
      return;
    }
    const current = branch.stdout.trim();
    if (current !== repo.branch) {
      this.#fail(
        request,
        `${repo.path} is on "${current}", not the configured "${repo.branch}". Refusing to ` +
          'pull: fast-forwarding a branch nobody expected to be checked out is how you ' +
          'deploy something no one meant to deploy.',
      );
      return;
    }

    // The dirty check comes BEFORE the pull, not after git has refused it.
    //
    // Git would stop on its own — it did, on this host, on 2026-08-09, with
    // "Your local changes to the following files would be overwritten by
    // merge: docker/run-container.sh" — and it was right to. But relying on
    // that means the refusal arrives as a non-zero exit and a wall of stderr,
    // in the one situation where what the operator needs is a short list of
    // filenames and an explicit statement that nothing was touched. Checking
    // first also means the failure is identical whether the conflict is in a
    // tracked file git would block on or an untracked one it would happily
    // clobber.
    if (!(await this.#requireCleanTree(request, repo))) return;

    // `--ff-only`. A merge commit created unattended by a root daemon, in a
    // checkout that is about to be deployed, is not something anyone wants to
    // discover later. Diverged means a human looks at it.
    const result = await this.#runner.run(
      [this.#config.gitPath, '-C', repo.path, 'pull', '--ff-only'],
      { timeoutSeconds: 300 },
    );
    this.#finish(request, result, `pull ${repo.name} (${repo.path}, ${repo.branch})`);
    if (!result.ok) return;

    // And then build it, because the source arriving on disk is not the thing
    // any unit runs.
    await this.#buildCheckout(request, repo);
  }

  // ── The dirty tree, and the build ───────────────────────────────────────

  /**
   * Refuse the operation if anything in the checkout is uncommitted.
   *
   * Returns false having already journalled the failure, so callers read as
   * `if (!(await this.#requireCleanTree(...))) return;`.
   *
   * There is no counterpart to this that forces past it. No `force` field on a
   * request, no `allowDirty` key in the config, no second code path. The
   * closest this daemon comes to touching an uncommitted file is reading its
   * name out of `git status --porcelain` and printing it.
   */
  async #requireCleanTree(request: OpsRequest, repo: RepoEntry): Promise<boolean> {
    const dirty = await readDirty(this.#runner, this.#config, repo);
    if (!dirty.ok) {
      // Cannot tell. Treated as a refusal rather than as "probably clean",
      // for the same reason a missing waker status file reads as busy: the
      // unknown state and the dangerous state are the same state, and the only
      // value worth being wrong about in the safe direction is this one.
      this.#fail(request, `${dirty.reason}. Refusing to act on a checkout whose state is unknown.`);
      return false;
    }
    if (dirty.files.length === 0) return true;

    this.#fail(request, dirtyRefusal(repo, dirty.files));
    return false;
  }

  /**
   * `npm ci && npm run build`, as the user who owns the checkout.
   *
   * Returns false having already journalled the failure. Every caller must
   * treat that as fatal to the operation — nothing gets restarted or recreated
   * after a failed build, because the two states a failed build leaves behind
   * are "stale" and "half-written" and starting on either is the failure this
   * step was added to prevent.
   *
   * The dirty-tree check runs here too, not only in `pull`. A redeploy of a
   * checkout with uncommitted edits builds something that HEAD does not
   * describe, and HEAD is precisely what the circuit breaker records as "the
   * build" — so a rollback would quarantine a commit that was never what ran.
   * A breaker that blocks the wrong sha is worse than none, because it also
   * blocks the fix.
   */
  async #buildCheckout(request: OpsRequest, repo: RepoEntry): Promise<boolean> {
    if (!(await this.#requireCleanTree(request, repo))) return false;

    const outcome = await runBuild(this.#runner, this.#config, repo);
    this.#journal.write({
      kind: outcome.ok ? 'build' : 'failed',
      what: `build ${repo.name}`,
      instance: request.instance || undefined,
      ok: outcome.ok,
      dryRun: this.#config.dryRun,
      detail: outcome.detail,
    });
    if (!outcome.ok) {
      process.stderr.write(`[ops] BUILD FAILED for ${repo.name}. Nothing restarted.\n`);
    }
    return outcome.ok;
  }

  // ── snapshot ────────────────────────────────────────────────────────────

  async #doSnapshot(request: OpsRequest): Promise<void> {
    const instance = this.#resolveInstance(request.instance);
    if (!instance) {
      this.#rejectUnknownInstance(request);
      return;
    }

    const result = await this.#snapshotInstance(instance);
    this.#finish(request, result, `snapshot ${instance.name}`);
  }

  /**
   * Commit the instance's writable layer to an image.
   *
   * Not destructive: `docker commit` on a running container does not stop it.
   * This is what makes it usable as the "capture the current good state"
   * step in front of a redeploy.
   */
  async #snapshotInstance(instance: InstanceEntry): Promise<CommandResult> {
    return this.#runner.run([this.#config.snapshotScript], {
      env: {
        CLAWCIUS_CONTAINER: instance.container,
        CLAWCIUS_SNAPSHOT_REPO: this.#imageRepo(instance),
      },
      timeoutSeconds: 900,
    });
  }

  // ── redeploy ────────────────────────────────────────────────────────────

  async #doRedeploy(request: OpsRequest): Promise<void> {
    const instance = this.#resolveInstance(request.instance);
    if (!instance) {
      this.#rejectUnknownInstance(request);
      return;
    }

    // ── Circuit breaker, before anything else ────────────────────────────
    const build = await this.#buildId(instance);
    const quarantined = build ? this.#state.isQuarantined(instance.name, build) : null;
    if (quarantined) {
      this.#journal.write({
        kind: 'breaker',
        what: describeRequest(request),
        instance: instance.name,
        ok: false,
        detail:
          `build ${build.slice(0, 12)} was rolled back on ` +
          `${new Date(quarantined.at).toISOString()} (${quarantined.reason}) and will not be ` +
          'deployed again. Commit a fix — a new build is a different build and goes ' +
          'through. Retrying this one is refused permanently, not backed off.',
      });
      return;
    }

    // ── Build, before anything is destroyed ──────────────────────────────
    //
    // First because it is the cheapest thing that can say no. A failed `tsc`
    // costs a minute; discovering the same failure after the pre-snapshot has
    // committed two gigabytes and the container has been torn down costs the
    // instance. The ordering is asserted in the self-test rather than left to
    // whoever next edits this function.
    //
    // It is worth being precise about what this build does and does not do.
    // `run-container.sh --recreate` starts a container from an image that was
    // built separately; this step does not rebuild that image. What it does
    // rebuild is the host checkout the breaker identifies this deploy by, and
    // that `.claude/` and `discord-cli/` are bind-mounted from — so a redeploy
    // whose checkout has not been built is a deploy of a commit whose compiled
    // form does not exist on the machine. That was the shape of the
    // 2026-08-09 hour, and the fix is not to be clever about which half of it
    // matters.
    const buildRepo = instance.buildRepo ? this.#resolveRepo(instance.buildRepo) : null;
    if (buildRepo) {
      if (!(await this.#buildCheckout(request, buildRepo))) return;
    } else {
      // Not fatal — an instance with no buildRepo has already told the breaker
      // it cannot be identified by a commit, and #buildId says so loudly. But
      // it is said again here, because "nothing was built" is the exact
      // condition this verb was changed to stop happening silently.
      this.#journal.write({
        kind: 'build',
        what: describeRequest(request),
        instance: instance.name,
        detail:
          `${instance.name} has no buildRepo, so NOTHING WAS BUILT before this redeploy. ` +
          'Whatever compiled output is on disk is what will run. Set buildRepo in ' +
          'ops-config.yaml if this instance runs code from a checkout on this host.',
      });
    }

    // ── Capture what we would roll back TO, before changing anything ─────
    //
    // Taken now rather than looked up later on purpose: after the recreate,
    // the newest snapshot of this instance could easily be one taken of the
    // broken build, and rolling back to it would be a very expensive no-op.
    const preSnapshot = await this.#snapshotInstance(instance);
    if (!preSnapshot.ok) {
      this.#fail(
        request,
        `could not snapshot ${instance.name} before recreating it: ` +
          `${preSnapshot.stderr || summarise(preSnapshot)}. Refusing to continue — a ` +
          'destructive operation with no rollback target is not a deployment, it is a ' +
          'coin toss.',
      );
      return;
    }
    const rollbackTag = await this.#newestSnapshotTag(instance);
    if (!rollbackTag && !this.#config.dryRun) {
      this.#fail(
        request,
        `no snapshot images found for ${this.#imageRepo(instance)} even after taking one. ` +
          'Refusing to recreate the container with nothing to go back to.',
      );
      return;
    }

    // ── Wait for an idle turn ────────────────────────────────────────────
    const idle = await this.#waitForIdle(instance, describeRequest(request));
    if (!idle) return;

    const result = await this.#runner.run([this.#config.runContainerScript, '--recreate'], {
      env: this.#instanceEnv(instance),
      timeoutSeconds: 900,
    });

    this.#finish(request, result, `redeploy ${instance.name}`);
    if (!result.ok) return;

    this.#armDeadline(instance, {
      build,
      rollbackTag,
      reason:
        request.reason ||
        `redeploy requested via the ops spool${build ? ` at build ${build.slice(0, 12)}` : ''}`,
      skipped: result.skipped,
    });
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
    request: OpsRequest,
    origin: 'requested' | 'deadline',
    pending?: PendingCheckin,
  ): Promise<void> {
    const instance = this.#resolveInstance(request.instance);
    if (!instance) {
      this.#rejectUnknownInstance(request);
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
        this.#fail(request, `"${tag}" is not a snapshot tag`);
        return;
      }
      const known = await this.#snapshotTags(instance);
      if (!known.includes(tag)) {
        this.#fail(
          request,
          `${repo}:${tag} does not exist on this host. Known snapshots: ` +
            `${known.slice(0, 8).join(', ') || '(none)'}`,
        );
        return;
      }
    } else {
      tag = (await this.#newestSnapshotTag(instance)) ?? '';
      if (!tag) {
        this.#fail(
          request,
          `no snapshot images exist for ${repo}. There is nothing to roll back to — this ` +
            'is exactly the state clawcius-snapshot-verify.timer exists to stop you ' +
            'discovering during an incident.',
        );
        return;
      }
    }

    const idle = await this.#waitForIdle(instance, describeRequest(request));
    if (!idle) return;

    const retag = await this.#runner.run([
      this.#config.dockerPath,
      'tag',
      `${repo}:${tag}`,
      instance.image,
    ]);
    if (!retag.ok) {
      this.#fail(request, `could not tag ${repo}:${tag} as ${instance.image}: ${retag.stderr}`);
      return;
    }

    const result = await this.#runner.run([this.#config.runContainerScript, '--recreate'], {
      env: this.#instanceEnv(instance),
      timeoutSeconds: 900,
    });
    this.#finish(request, result, `rollback ${instance.name} to ${tag}`);

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

  #handleCheckin(request: OpsRequest): void {
    const instance = this.#resolveInstance(request.instance);
    if (!instance) {
      this.#rejectUnknownInstance(request);
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
      ok: true,
      detail:
        `checked in with ${((pending.deadlineAt - Date.now()) / 60000).toFixed(1)} minutes to ` +
        `spare after: ${pending.reason}` +
        (request.detail ? `. It says: ${request.detail}` : '') +
        '. Consecutive failed recoveries reset to 0.',
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
  #doWake(request: OpsRequest): void {
    // A wake is addressed to a channel, and the channel belongs to whichever
    // instance owns that spool. Without a named instance there is nowhere to
    // put the file, so the verb takes the channel and we route by the only
    // instance configured to use it.
    const instance =
      this.#config.instances.find((entry) => entry.wakeChannelId === request.channel) ??
      (this.#config.instances.length === 1 ? this.#config.instances[0] : undefined);

    if (!instance) {
      this.#reject(
        request,
        `channel ${request.channel} does not match any instance's wakeChannelId, and there ` +
          'is more than one instance configured, so there is no unambiguous spool to file ' +
          'it in.',
      );
      return;
    }

    const ok = this.#writeWakeFile(instance, request.channel, request.detail);
    this.#journal.write({
      kind: ok ? 'finished' : 'failed',
      what: describeRequest(request),
      instance: instance.name,
      ok,
      detail: ok
        ? `filed a wake for ${instance.name} in ${instance.wakeSpoolDir}`
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
  async #waitForIdle(instance: InstanceEntry, what: string): Promise<boolean> {
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
          detail: `waiting for an idle turn: ${verdict.reason}`,
        });
      }

      if (Date.now() >= deadline) {
        this.#journal.write({
          kind: 'failed',
          what,
          instance: instance.name,
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
    options: { build: string; rollbackTag: string; reason: string; skipped: boolean },
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
        `You were rebuilt${options.build ? ` from ${options.build.slice(0, 12)}` : ''}.`,
        '',
        `Why: ${options.reason}`,
        '',
        'Your container was recreated, so anything that lived only in its writable layer',
        'is gone: packages installed by hand, crontabs, running daemons. Check the things',
        'you depend on, in this order:',
        '',
        '  1. Can you run a turn at all — you are reading this, so yes.',
        '  2. Is your Claude login intact? `claude auth status`.',
        '  3. Are your cron jobs and daemons back?',
        '  4. Can you reach the network through the proxy?',
        '',
        `Then check in, within ${this.#config.deadline.minutes} minutes of the rebuild:`,
        '',
        `    printf '%s' '{"verb":"checkin","instance":"${instance.name}","detail":"..."}' \\`,
        `      > ${join(this.#config.spoolDir, '$(date +%s)-checkin.tmp')} \\`,
        `      && mv ${join(this.#config.spoolDir, '$(date +%s)-checkin.tmp')} \\`,
        `           ${join(this.#config.spoolDir, '$(date +%s)-checkin.json')}`,
        '',
        'If you do not check in, you will be rolled back to the previous snapshot',
        `(${options.rollbackTag || 'none available'}) automatically, and this build will be`,
        'refused from then on. Say something in the channel either way.',
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
      unit: '',
      repo: '',
      instance: pending.instance,
      tag: SNAPSHOT_TAG.test(pending.rollbackTag) ? pending.rollbackTag : '',
      channel: '',
      reason: `automatic: missed check-in after ${pending.reason}`,
      detail: '',
      unknownFields: [],
    };

    // Straight onto the queue, ahead of nothing and behind whatever is
    // running. The rate limit does not apply — this is the executor's own
    // recovery action, not an agent's request, and letting an agent exhaust
    // the hourly budget to stop a rollback would be a lovely little exploit.
    this.#queue.push({ raw: { name: '(deadline)', body: '' }, request, receivedAt: Date.now() });
    if (this.#busy) {
      this.#journal.write({
        kind: 'queued',
        what: describeRequest(request),
        instance: pending.instance,
        detail: `automatic rollback waiting behind "${this.#busy}"`,
      });
      return;
    }

    // Bypass #pump's normal path so the rollback carries its `pending` context
    // (the build to quarantine, the tag to restore).
    this.#queue.pop();
    this.#busy = describeRequest(request);
    this.#journal.write({
      kind: 'started',
      what: this.#busy,
      instance: pending.instance,
      dryRun: this.#config.dryRun,
      detail: 'automatic rollback after a missed check-in',
    });
    try {
      await this.#doRollback(request, 'deadline', pending);
    } catch (error) {
      this.#journal.write({
        kind: 'failed',
        what: this.#busy,
        instance: pending.instance,
        ok: false,
        detail: `automatic rollback threw: ${String(error)}`,
      });
    } finally {
      this.#busy = null;
      this.#journal.publishStatus();
    }
    void this.#pump();
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

  #finish(request: OpsRequest, result: CommandResult, what: string): void {
    this.#journal.write({
      kind: result.ok ? 'finished' : 'failed',
      what,
      instance: request.instance || undefined,
      ok: result.ok,
      dryRun: result.skipped,
      command: render(result.argv),
      detail:
        `${summarise(result)}` +
        (result.stdout.trim() ? `\nstdout: ${result.stdout.trim().slice(0, 2000)}` : '') +
        (result.stderr.trim() ? `\nstderr: ${result.stderr.trim().slice(0, 2000)}` : ''),
    });
  }

  #fail(request: OpsRequest, detail: string): void {
    this.#journal.write({
      kind: 'failed',
      what: describeRequest(request),
      instance: request.instance || undefined,
      ok: false,
      detail,
    });
  }

  #rejectUnknownInstance(request: OpsRequest): void {
    this.#reject(
      request,
      `"${request.instance}" is not in the instances allowlist. Allowed: ` +
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
