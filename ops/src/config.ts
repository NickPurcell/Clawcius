/**
 * Ops executor configuration, loaded from `ops-config.yaml`.
 *
 * Same split as the waker and the status page: everything describing *what
 * this service is allowed to do* is version-controllable YAML, with defaults
 * and validation in TypeScript, and there are no secrets in here.
 *
 * ── What this file stopped being on 2026-08-10 ───────────────────────────
 *
 * It used to say, at the top and in bold, that this was **the entire
 * authorization model**: every privileged thing the daemon could do was named
 * here by exact string and nothing from the spool could add to the list.
 *
 * That is no longer true and it must not be read as if it were. The verb list
 * was replaced by a single `task` verb carrying free text, handed to a Claude
 * Code session on the host with a shell and sudo. There is no allowlist in
 * front of prose. What this file holds now is three different kinds of thing,
 * and confusing them is how somebody ends up believing they are protected:
 *
 *   1. **A health manifest.** `units:` and `repos:` no longer gate anything.
 *      They are the things the executor checks the state of before and after
 *      every task, so that a task which quietly breaks a service is caught by
 *      the executor rather than by a person the next morning. Adding a unit
 *      here does not grant anything; removing one does not deny anything. It
 *      only changes what is watched.
 *   2. **Real invariants, still enforced.** The containment assertions — the
 *      state directory out of every spool's reach, one spool per instance, no
 *      spool nested in another — are unchanged and still load-bearing, because
 *      provenance and the durable record still rest on them.
 *   3. **Operational limits.** Rate, size, timeouts, the deadline, the breaker.
 *      These bound how *often* and how *long*, never *what*.
 *
 * The loader is still strict to the point of rudeness about all three, for the
 * old reason: a malformed entry that fails the boot gives you an executor that
 * refuses valid work (annoying, visible), while one that is silently skipped
 * gives you an executor that is quietly not checking something (quiet, and the
 * first you hear of it is the incident).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { VERBS } from './request.js';

/**
 * A systemd unit whose health the executor watches across every task.
 *
 * Until 2026-08-10 this was an allowlist: a unit not named here could not be
 * restarted. It is not that any more — the host agent runs `systemctl` itself
 * and this list does not constrain it. What it does now is decide what
 * `systemctl is-active` is run against before and after every task, so that a
 * task which takes a service down is noticed by the executor, reported, and
 * (for the instances in scope) rolled back.
 *
 * The practical consequence is the opposite of the old one: leaving a unit out
 * of this list does not make it safe, it makes it unwatched.
 */
export type UnitEntry = {
  /** Full unit name including the suffix, e.g. `clawcius.service`. */
  name: string;
  /** Shown in logs and in the wake context. */
  description: string;
};

/**
 * A checkout the executor tells the host agent about, and watches.
 *
 * Also no longer an allowlist. There is no `pull` verb; the host agent runs git
 * itself. What this entry does now is appear in the briefing — path, expected
 * branch, current branch, HEAD, and the list of uncommitted files — so that the
 * session starts out knowing the state of the tree rather than discovering it,
 * and so that the standing rule about never forcing past a dirty tree arrives
 * attached to the actual filenames.
 */
export type RepoEntry = {
  /** Short name the agent uses in a request. */
  name: string;
  /** Absolute path to the checkout on the host. */
  path: string;
  /**
   * Branch this checkout is expected to be on. A pull is refused when HEAD is
   * somewhere else — pulling a detached HEAD or a feature branch by accident
   * is how you deploy something nobody meant to deploy.
   */
  branch: string;
  /**
   * Directories under `path`, each holding a `package.json`, that must be built
   * after anything is pulled into this checkout.
   *
   * The executor no longer runs these itself — there is no `pull` verb and no
   * build step. They are named in the host agent's briefing instead, because
   * the lesson attached to them is worth more than the automation was:
   *
   * Added 2026-08-10. Every unit in this repository starts `node dist/index.js`
   * and not one of them compiles anything, so a pull followed by a restart
   * cheerfully runs the previous build. That is not a hypothetical: the
   * always-on-channels change was merged, pulled and restarted on 2026-08-09
   * and did nothing at all for an hour because `dist/` was stale, with no
   * error anywhere because nothing had failed. An executor exposing `pull` and
   * `restart` as separate verbs with no build between them is a machine for
   * reproducing that in four seconds, on request.
   *
   * Empty means "this checkout is not built", which is a legitimate answer for
   * a repo of scripts and a dangerous one for a repo of TypeScript. The loader
   * does not guess: it defaults to `['.']` and leaves the rest to config.
   */
  buildDirs: string[];
};

/**
 * What one instance is allowed to ask for, when the operator narrows it.
 *
 * Added 2026-08-10, alongside per-instance spools, and off by default — every
 * field null means "no restriction", which is exactly the behaviour every
 * instance had before this existed. An upgrade changes nothing until somebody
 * writes a `mayRequest:` block.
 *
 * The mechanism only became *possible* with per-instance spools. With one
 * shared directory the executor had no idea who had written a file, so there
 * was nothing to restrict: "Hamachi may not redeploy Clawcius" is not a rule
 * you can enforce against an anonymous request. Now the directory a request
 * arrived in names the requester, and this is the allowlist that names what
 * that requester may do with it.
 *
 * Semantics, deliberately boring:
 *
 *   - a field left out entirely means "this kind is not restricted";
 *   - a field present means "exactly these, by exact string equality";
 *   - a field present and empty (`instances: []`) means "none of this kind" —
 *     it is a legitimate way to say an instance may never touch a container,
 *     and it is not confused with absent because the loader distinguishes a
 *     missing key from an empty list.
 *
 * Every name written here is checked against the real lists at boot. A typo in
 * `mayRequest.instances` would otherwise be a silent, total denial of something
 * the operator believed they had granted — and a restriction that fails closed
 * by accident is indistinguishable, from the agent's side, from an executor
 * that is broken.
 *
 * ── What survived the verbs, and what did not ────────────────────────────
 *
 * `verbs` and `instances` still restrict, because there are still verbs and
 * requests still name instances. `units` and `repos` no longer restrict
 * ANYTHING: no request carries a unit or a repo any more, so those two lists
 * describe a shape of request that cannot be filed. They are still parsed and
 * still validated, and their presence produces a deprecation notice in the boot
 * journal rather than a boot failure — same reasoning as the old `spoolDir`
 * key, and the same reason: this unit is `Restart=always` with no start limit
 * and refusing to boot on a stale config key turns a cosmetic problem into a
 * root daemon in a restart loop with every rollback deadline unhonoured.
 *
 * The honest warning that goes with them: an operator who wrote
 * `units: [hamachi.service]` believing it stopped Hamachi restarting its
 * neighbour is now wrong, and would stay wrong silently. That is exactly why
 * the notice exists and why it names the file it is in.
 *
 * And the larger caveat, which applies to `instances` too: `mayRequest` bounds
 * what an instance may *ask for*, not what the host agent may *do*. A task
 * scoped to `hamachi` is still carried out by a session with a shell and sudo,
 * and nothing but the task text and the standing prompt points it at Hamachi
 * rather than at anything else on the box. It is a statement of intent that the
 * journal records, not a boundary.
 */
export type RequestScope = {
  /** Verbs this instance may use at all. */
  verbs: string[] | null;
  /** Instances it may name in `task` / `rollback` / `checkin`, and wake targets. */
  instances: string[] | null;
  /** DEPRECATED and inert: no request carries a unit. */
  units: string[] | null;
  /** DEPRECATED and inert: no request carries a repo. */
  repos: string[] | null;
};

/**
 * An agent instance whose container this executor may recreate.
 *
 * Everything needed to rebuild it is here rather than being derived, because
 * derivation is guessing and this is the code path that destroys a writable
 * layer.
 */
export type InstanceEntry = {
  /** Short name the agent uses in a request, e.g. `clawcius`. */
  name: string;
  /** Docker container name. Passed to docker as one argv element. */
  container: string;
  /** Image the container runs, and the repo snapshots are tagged into. */
  image: string;
  /** `CLAWCIUS_STATE_DIR` for this instance. */
  stateDir: string;
  /** `CLAWCIUS_ENV_FILE` for this instance. */
  envFile: string;
  /** `CLAWCIUS_CONTAINER_MEMORY` for this instance. */
  memory: string;
  /**
   * The waker status file this instance publishes (`status.file` in its
   * agent-config). Read before anything destructive; missing, stale or
   * malformed all mean "busy".
   */
  wakerStatusFile: string;
  /**
   * The instance's wake spool directory — where the executor files the
   * "you were rebuilt, verify and check in" wake after a destructive
   * operation. This is the ONE directory the executor writes into that the
   * agent can also read, and it only ever writes a wake request there.
   */
  wakeSpoolDir: string;
  /**
   * This instance's ops spool — the directory ITS container writes requests
   * into. Defaults to `<stateDir>/run/ops`.
   *
   * ── Why this is per-instance, since 2026-08-10 ──────────────────────────
   *
   * It used to be one top-level `spoolDir`, `/var/lib/clawcius/run/ops`, for
   * the whole executor. That was wrong in a way nobody noticed for a week,
   * because it was only wrong for one of the two agents.
   *
   * `docker/run-container.sh` gives each instance its OWN state directory and
   * bind-mounts only that:
   *
   *     CLAWCIUS_STATE=${CLAWCIUS_STATE_DIR:-/var/lib/clawcius}
   *     WAKE_DIR=$CLAWCIUS_STATE/run
   *     -v "$WAKE_DIR:$WAKE_DIR:rw"
   *
   * For Clawcius that is `/var/lib/clawcius/run`, so the shared spool happened
   * to fall inside the mount and worked. For Hamachi, whose unit sets
   * `CLAWCIUS_STATE_DIR=/var/lib/hamachi`, the mount is `/var/lib/hamachi/run`
   * and `/var/lib/clawcius/run/ops` **does not exist inside the container at
   * all** — verified from inside it on 2026-08-10. Hamachi could not file a
   * single request. The agent the operator talks to most was the one agent
   * locked out of the mechanism built for both of them, and the failure was
   * silent from every angle: the executor saw an empty spool (which is what a
   * quiet night looks like), and the agent's `mv` failed into a shell nobody
   * was reading.
   *
   * The default follows the mount rather than the other way round, so a new
   * instance is reachable by construction: put the spool where the container's
   * bind mount already is, and there is no second thing to remember.
   */
  opsSpoolDir: string;
  /**
   * Optional narrowing of what this instance may ask for. Null means
   * unrestricted, which is the default and the pre-2026-08-10 behaviour.
   */
  mayRequest: RequestScope | null;
  /**
   * Discord channel the post-rebuild wake is addressed to. The agent has to be
   * woken *somewhere*, and a wake with no channel cannot be delivered.
   */
  wakeChannelId: string;
  /**
   * Repo whose HEAD identifies "the build" for the circuit breaker, or empty.
   *
   * With a repo, a rolled-back build is quarantined by commit sha and stays
   * quarantined until someone commits something new — which is the behaviour
   * you want, since the fix for a bad build is a new build. Without one the
   * breaker falls back to the image id, which is coarser but still stops the
   * exact same bytes being redeployed in a loop.
   */
  buildRepo: string;
};

export type LimitsConfig = {
  /** Bytes. A request file larger than this is discarded unread. */
  maxRequestBytes: number;
  /** Request files consumed per sweep. The rest wait for the next one. */
  maxPerSweep: number;
  /**
   * Files allowed to be sitting in the spool at all. Beyond this the spool is
   * treated as flooded: everything is discarded and the event is logged loudly.
   * A container writing thousands of request files is not a scheduling
   * accident.
   */
  maxSpoolFiles: number;
  /** Accepted requests per rolling hour, across all verbs and instances. */
  maxPerHour: number;
  /** Requests waiting behind the lock before new ones are refused outright. */
  maxQueued: number;
  /** Seconds any single privileged command may run before it is killed. */
  commandTimeoutSeconds: number;
  /**
   * Seconds a single build step (`npm ci`, `npm run build`) may run.
   *
   * Separate from `commandTimeoutSeconds` and much larger, because `npm ci` on
   * a cold cache fetches a few hundred packages through the host's proxy and
   * routinely takes longer than a container recreate. A timeout that fires
   * mid-install is the worst possible outcome of this step: it leaves a
   * `node_modules/` that is neither the old tree nor the new one, which is the
   * half-built state the build check exists to keep anything from starting on.
   */
  buildTimeoutSeconds: number;
};

export type IdleConfig = {
  /**
   * A waker status file older than this is treated as busy.
   *
   * Should be comfortably more than the waker's own `status.intervalSeconds`
   * and comfortably less than "long enough that a crashed waker looks idle".
   */
  staleSeconds: number;
  /** How long to wait for an idle turn before giving up on a destructive op. */
  maxWaitMinutes: number;
  /** Poll interval while waiting. */
  pollSeconds: number;
};

export type DeadlineConfig = {
  /** Minutes to wait for a `checkin` after a destructive operation. */
  minutes: number;
  /**
   * Roll back automatically when the deadline passes with no check-in.
   *
   * Turning this off keeps the deadline as pure alerting. Recommended only
   * while `dryRun` is on and you are still watching what it decides.
   */
  autoRollback: boolean;
};

export type BreakerConfig = {
  /**
   * Consecutive failed recoveries before the executor freezes.
   *
   * A "failed recovery" is a destructive operation that missed its check-in
   * deadline. Past this count the executor stops accepting destructive verbs
   * entirely and says so, until a human clears it. The alternative — keep
   * trying — is how a bad build becomes an outage that reinstalls itself every
   * fifteen minutes.
   */
  maxConsecutiveFailedRecoveries: number;
  /**
   * Quarantined builds remembered per instance. A ring, so a long-lived host
   * does not accumulate forever; large enough that a build cannot be forgotten
   * and retried within any plausible session.
   */
  maxQuarantined: number;
};

export type SnapshotVerifyConfig = {
  /** Turn the verifier on. The timer unit runs it; this is the safety catch. */
  enabled: boolean;
  /** Instances whose newest snapshot gets restore-tested. */
  instances: string[];
  /** Seconds a restored throwaway container gets to come up. */
  startTimeoutSeconds: number;
  /**
   * Command run inside the throwaway container to prove it is genuinely up.
   * argv array, no shell. A container that is "running" but whose PID 1 is
   * about to die satisfies `docker run -d` and nothing else.
   */
  probe: string[];
};

/**
 * The host agent: the headless Claude Code session that carries out a task.
 *
 * See ops/src/host-agent.ts for the whole argument. The keys here are the ones
 * an operator has any business changing; everything that is a security decision
 * — which tools are denied, what the standing prompt says, that the session
 * runs as an unprivileged account and never as root, that the account may not
 * be in the docker group, that its environment is built from an allowlist — is
 * in code, on purpose. A YAML key that can widen a session with sudo is a YAML
 * key somebody will widen at 3am.
 *
 * Note the shape of the two keys added on 2026-08-11: `forbiddenGroups` and
 * `secretPaths` can only ever make the checks in `agent-user.ts` STRICTER.
 * There is no key that removes `docker` from the refusal list, and there must
 * never be one.
 */
export type HostAgentConfig = {
  /**
   * Off is a real setting and it is worth having.
   *
   * With `enabled: false` the daemon still holds every deadline, still watches
   * every spool, still answers `checkin` and still performs a `rollback` — it
   * simply refuses `task` with a stated reason. That is the configuration to
   * put the host in while somebody works out what a task did, and it is
   * strictly better than stopping the unit, which would drop the deadlines.
   */
  enabled: boolean;
  /**
   * The service account the session runs as. Default `clawcius-ops`.
   *
   * ── Why this is a name now, and not a `stat` ──────────────────────────
   *
   * Until 2026-08-11 there was no such key: the session was dropped to
   * whoever owned the checkout, discovered by `stat`ing it, with a comment
   * saying the executor "is not entitled to an opinion about who owns a
   * directory it was pointed at". That reasoning was right for a *build step*
   * and wrong for an identity. On this host the checkout is owned by
   * `npurcell`, `npurcell` is in the `docker` group, and the docker group is
   * root — so the session inherited a root-equivalent identity through a
   * mechanism nobody had to write down, and every other control in this
   * directory was decoration.
   *
   * So the identity is named, deliberately, in a file that gets reviewed. If
   * the account does not exist the executor REFUSES TASKS; it does not fall
   * back to the checkout's owner and it does not fall back to root. See
   * ops/src/agent-user.ts and MIGRATION.md.
   */
  user: string;
  /**
   * Where the user and group databases are read from.
   *
   * These exist so the self-test can drive the real resolution path against
   * fixture files without root, docker or a real `clawcius-ops` account —
   * "fixture the data, not the code" — and because a host whose passwd lives
   * somewhere unusual should fail with a path in the message rather than with
   * "no such user". On a real host they are `/etc/passwd` and `/etc/group`
   * and there is no reason to touch them.
   *
   * Both are read as FILES. A host using nsswitch with LDAP/SSSD will not
   * have its group memberships here and the docker-group assertion would
   * silently pass. That limit is written down in agent-user.ts rather than
   * worked around by shelling out to `getent` from a root daemon.
   */
  passwdPath: string;
  groupPath: string;
  /**
   * EXTRA group names to refuse to run as a member of.
   *
   * Unioned with the built-in list in agent-user.ts (`docker`, `podman`,
   * `lxd`, `sudo`, `wheel`, `root`, `disk`, `shadow`, `adm`), never a
   * replacement for it. This key can only make the check stricter. A key that
   * could take `docker` off the list would be a key somebody takes `docker`
   * off the list with, at 3am, to make a task work.
   */
  forbiddenGroups: string[];
  /**
   * Files and directories the agent account must NOT be able to read.
   *
   * Every instance's `envFile` is added to this automatically — those hold
   * `DISCORD_TOKEN`, and `assertNoSecrets` refusing to put that token in the
   * session's *environment* is worth nothing if the session can `cat` the
   * file it lives in.
   *
   * Checked from mode bits before every task, and a readable secret REFUSES
   * the task. It cannot see POSIX ACLs or a friendlier bind mount of the same
   * inode; it is a check against a `.env` left 0644, not against an adversary.
   */
  secretPaths: string[];
  /**
   * An ssh private key the session uses for git, or empty.
   *
   * Becomes `GIT_SSH_COMMAND=ssh -i <key> -o IdentitiesOnly=yes …` in the
   * session's environment. It is a PATH, on purpose: a read-only deploy key
   * owned by the agent account is a credential scoped to one repository that
   * can be revoked on its own, and it is the alternative to handing a session
   * with a shell the operator's GitHub PAT — which would be a token in the
   * environment, which `assertNoSecrets` refuses anyway. There is deliberately
   * no key here that takes a token. See MIGRATION.md § 5.
   */
  gitSshKey: string;
  /** Absolute path to the `claude` binary. Never looked up on PATH. */
  claudePath: string;
  /**
   * Working directory for the session. NOT the checkout.
   *
   * Claude Code auto-discovers CLAUDE.md and project settings from its working
   * directory, and the checkout is a tree the agents can get commits merged
   * into. Pointing the session at it would let any agent supply standing
   * instructions to a process with sudo, through a route nobody would think to
   * audit. The loader refuses a workDir inside any spool or inside stateDir.
   */
  workDir: string;
  /** Wall-clock ceiling on one task. */
  timeoutMinutes: number;
  /** Dollar ceiling on one task, enforced by the CLI's own --max-budget-usd. */
  maxCostUsd: number;
  /** Model override, or empty for the CLI's default. */
  model: string;
  /**
   * Environment variables passed through by name, on top of the built-in
   * allowlist in host-agent.ts.
   *
   * Anything named here is EXEMPT from the credential-name check, which is the
   * point: it is how an operator says "yes, I mean it", in a file that gets
   * reviewed. `DISCORD_TOKEN` named here would still be a mistake; the check
   * would let it through and the README says why that is the operator's call
   * and not the loader's.
   */
  envPassthrough: string[];
};

export type OpsConfig = {
  /**
   * Log what would be run, run nothing.
   *
   * Ships ON. First deploy of a daemon holding docker and systemctl should be
   * observable before it is trusted, and the log it produces in this mode is
   * exactly the argv it would otherwise have executed — so you can read a
   * week of it and know precisely what you are turning on.
   */
  dryRun: boolean;
  /**
   * Executor state: journal, breaker, pending check-ins, status JSON.
   *
   * MUST NOT be inside any instance's `opsSpoolDir` or any container mount.
   * The breaker lives here, and a breaker the quarantined party can edit is
   * not a breaker.
   */
  stateDir: string;
  /** Sweep interval for the spool, alongside fs.watch. */
  pollSeconds: number;
  /** Absolute path to `docker/run-container.sh`. */
  runContainerScript: string;
  /** Absolute path to `docker/snapshot.sh`. */
  snapshotScript: string;
  /** Absolute path to the `systemctl` binary. */
  systemctlPath: string;
  /** Absolute path to the `docker` binary. */
  dockerPath: string;
  /** Absolute path to the `git` binary. */
  gitPath: string;
  /**
   * Absolute path to the `npm` binary.
   *
   * Its directory is prepended to PATH for build steps, because npm re-execs
   * node and runs `tsc` out of `node_modules/.bin` through `sh`. On this host
   * node is installed under the owner's home and is not on the system PATH at
   * all, so without that the build fails at `npm run build` with "tsc: not
   * found" several minutes after `npm ci` succeeded.
   */
  npmPath: string;
  /**
   * Snapshots retained per instance, passed to `docker/snapshot.sh` as KEEP.
   *
   * Raised from that script's default of 8 because the executor now takes one
   * before EVERY task rather than once a night before a redeploy. At 8, a busy
   * evening of a dozen small tasks would evict every nightly snapshot by
   * morning — the ring is shared, and whoever runs last prunes to their own
   * ceiling. Sized so a night of tasks cannot push out the previous night's
   * backup. It is disk, and the README says so.
   */
  snapshotKeep: number;
  units: UnitEntry[];
  repos: RepoEntry[];
  instances: InstanceEntry[];
  hostAgent: HostAgentConfig;
  limits: LimitsConfig;
  idle: IdleConfig;
  deadline: DeadlineConfig;
  breaker: BreakerConfig;
  snapshotVerify: SnapshotVerifyConfig;
  /**
   * Prose warnings the loader produced but did not fail on.
   *
   * Currently just the deprecated top-level `spoolDir` key. They are returned
   * rather than printed so the daemon can put them in the *journal* at boot —
   * a warning that only ever reaches stdout is a warning nobody reads after
   * the fact, and the whole reason this key is tolerated rather than rejected
   * is that the operator needs a durable record saying it was tolerated.
   */
  deprecations: string[];
};

/**
 * Where an instance's spool goes when config does not say.
 *
 * `<stateDir>/run/ops`, because `<stateDir>/run` is the directory
 * `docker/run-container.sh` already bind-mounts read-write into that
 * instance's container. Deriving it from the mount is the point: it is the
 * one rule that makes a newly added instance able to file a request without
 * anybody remembering a second setting. See `InstanceEntry.opsSpoolDir`.
 */
export function defaultOpsSpoolDir(instanceStateDir: string): string {
  return join(instanceStateDir, 'run', 'ops');
}

const DEFAULTS: OpsConfig = {
  dryRun: true,
  stateDir: '/var/lib/clawcius-ops',
  pollSeconds: 5,
  runContainerScript: '/home/npurcell/clawcius/docker/run-container.sh',
  snapshotScript: '/home/npurcell/clawcius/docker/snapshot.sh',
  systemctlPath: '/usr/bin/systemctl',
  dockerPath: '/usr/bin/docker',
  gitPath: '/usr/bin/git',
  npmPath: '/home/npurcell/.local/share/node/bin/npm',
  snapshotKeep: 24,
  units: [],
  repos: [],
  instances: [],
  hostAgent: {
    enabled: true,
    user: 'clawcius-ops',
    passwdPath: '/etc/passwd',
    groupPath: '/etc/group',
    forbiddenGroups: [],
    secretPaths: [],
    gitSshKey: '',
    claudePath: '/usr/local/bin/claude',
    workDir: '/var/lib/clawcius-host-agent',
    timeoutMinutes: 30,
    maxCostUsd: 10,
    model: '',
    envPassthrough: [],
  },
  limits: {
    maxRequestBytes: 16 * 1024,
    maxPerSweep: 8,
    maxSpoolFiles: 64,
    maxPerHour: 20,
    maxQueued: 8,
    commandTimeoutSeconds: 600,
    buildTimeoutSeconds: 1800,
  },
  idle: {
    staleSeconds: 90,
    maxWaitMinutes: 30,
    pollSeconds: 10,
  },
  deadline: {
    minutes: 15,
    autoRollback: true,
  },
  breaker: {
    maxConsecutiveFailedRecoveries: 2,
    maxQuarantined: 32,
  },
  snapshotVerify: {
    enabled: true,
    instances: [],
    startTimeoutSeconds: 60,
    probe: ['/bin/sh', '-c', 'test -x /usr/local/bin/claude'],
  },
  deprecations: [],
};

export class OpsConfigError extends Error {
  constructor(path: string, message: string) {
    super(`ops-config.yaml: ${path} ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new OpsConfigError(path, 'must be a mapping');
  return raw;
}

function str(raw: unknown, path: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new OpsConfigError(path, 'must be a string');
  return raw;
}

/** A string that must actually be there — no empty-string-as-absent. */
function requiredStr(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new OpsConfigError(path, 'is required and must be a non-empty string');
  }
  return raw;
}

function bool(raw: unknown, path: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') throw new OpsConfigError(path, 'must be true or false');
  return raw;
}

function num(raw: unknown, path: string, fallback: number, min: number, max?: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new OpsConfigError(path, 'must be a number');
  }
  if (raw < min) throw new OpsConfigError(path, `must be >= ${min}`);
  if (max !== undefined && raw > max) throw new OpsConfigError(path, `must be <= ${max}`);
  return raw;
}

function list(raw: unknown, path: string): unknown[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new OpsConfigError(path, 'must be a list');
  return raw;
}

function strList(raw: unknown, path: string, fallback: string[]): string[] {
  if (raw === undefined || raw === null) return fallback;
  if (!Array.isArray(raw)) throw new OpsConfigError(path, 'must be a list');
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new OpsConfigError(`${path}[${index}]`, 'must be a string');
    }
    return entry;
  });
}

/**
 * A list of strings where "absent" and "empty" must stay distinguishable.
 *
 * `strList` cannot express this: it folds a missing key into its fallback, so
 * `[]` and "not written down" arrive identical. For `mayRequest` that
 * difference is the whole meaning — absent is "unrestricted", empty is "none
 * at all" — and collapsing the two would turn a config that grants everything
 * into one that grants nothing, or the reverse, depending on which way the
 * fallback pointed.
 */
function strListOrNull(raw: unknown, path: string): string[] | null {
  if (raw === undefined || raw === null) return null;
  return strList(raw, path, []);
}

/**
 * An absolute path from config, resolved once.
 *
 * Relative paths are rejected rather than resolved against cwd. This process
 * is started by systemd with a WorkingDirectory that is nobody's idea of a
 * base for `/etc`-adjacent things, and a config that quietly means something
 * different depending on how it was launched is a bad property for the file
 * that decides what root may destroy.
 */
function absPath(raw: unknown, path: string, fallback: string): string {
  const value = str(raw, path, fallback);
  if (!isAbsolute(value)) throw new OpsConfigError(path, 'must be an absolute path');
  return resolve(value);
}

function requiredAbsPath(raw: unknown, path: string): string {
  const value = requiredStr(raw, path);
  if (!isAbsolute(value)) throw new OpsConfigError(path, 'must be an absolute path');
  return resolve(value);
}

/**
 * Names the agent is allowed to say.
 *
 * Deliberately narrower than what the underlying systems accept. Docker will
 * happily take a container name with a dot in it and systemd takes far
 * stranger unit names than this, but every character class allowed here is one
 * more thing to reason about when the string is attacker-influenced. The
 * allowlist is exact-match anyway, so this only constrains what an operator
 * may put in the config — and if a name genuinely needs a character outside
 * this set, widening it should be a diff someone reads.
 */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** Unit names carry a type suffix, so they get one extra allowance: the dot. */
const UNIT_PATTERN = /^[a-z][a-z0-9@.-]{0,95}\.(service|timer|socket|target|path)$/;
/** Image references: repo[:tag]. No registry host, no digest — we build these. */
const IMAGE_PATTERN = /^[a-z][a-z0-9._/-]{0,95}(:[a-zA-Z0-9._-]{1,64})?$/;
/** Discord snowflakes. */
const CHANNEL_PATTERN = /^[0-9]{5,25}$/;

function checkName(value: string, path: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw new OpsConfigError(
      path,
      `("${value}") must be a short lowercase name matching ${String(NAME_PATTERN)} — ` +
        'requests are matched against it by exact string equality',
    );
  }
  return value;
}

/**
 * Account names this loader will accept for `hostAgent.user`.
 *
 * Narrower than what `useradd` allows, for the same reason `NAME_PATTERN` is
 * narrower than what docker allows: the string ends up in refusal messages, in
 * the boot banner and in `id`-style advice printed for a human to paste, and
 * every character class permitted here is one more thing to think about. It
 * is never interpolated into a command by this daemon — the drop is
 * `setuid(2)` on a numeric uid — but the sudoers file is written against it by
 * hand, and a username with a comma or a colon in it would silently change the
 * meaning of that file.
 *
 * `root` is NOT rejected here. It is rejected in `resolveAgentUser`, by uid,
 * because that catches the account whose name is `toor` as well and because
 * rejecting it at load time would fail the boot of a `Restart=always` unit —
 * see the long note in agent-user.ts about why that is the wrong failure shape
 * for this service.
 */
const AGENT_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

function agentUserName(raw: unknown): string {
  const value = str(raw, 'hostAgent.user', DEFAULTS.hostAgent.user);
  if (!AGENT_USER_PATTERN.test(value)) {
    throw new OpsConfigError(
      'hostAgent.user',
      `("${value}") must be a plain account name matching ${String(AGENT_USER_PATTERN)}. ` +
        'It names the unprivileged service account the host agent session runs as; see ' +
        'MIGRATION.md for how to create it.',
    );
  }
  return value;
}

/**
 * Is `child` inside `parent`? Both must already be resolved.
 *
 * Used for the containment assertions below, and written as a prefix test on
 * the resolved paths *with* a trailing separator, because the naive
 * `startsWith(parent)` says `/var/lib/clawcius-ops` is inside
 * `/var/lib/clawcius` — which is exactly the kind of near-miss this file is
 * supposed to catch rather than commit.
 */
export function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * The old top-level `spoolDir:` key, mapped onto the instance that owns it.
 *
 * ── Why this is an alias and not an error ────────────────────────────────
 *
 * The choice was between refusing to boot with a message telling the operator
 * exactly what to write, and accepting the old key as a deprecated alias. This
 * is the alias, and the reason is the shape of the failure rather than a
 * preference for leniency.
 *
 * `clawcius-ops.service` is `Restart=always` with `StartLimitIntervalSec=0`
 * and `StartLimitBurst=0` — never give up — because it holds the rollback
 * deadlines and a dead executor is how a broken rebuild becomes a permanent
 * outage. A config the loader rejects therefore does not produce one loud
 * failure: it produces a root daemon in a five-second restart loop, with every
 * armed deadline unhonoured for as long as it lasts. That is precisely the
 * shape of #7 (`MemoryDenyWriteExecute` in clawcius-status.service, SIGTRAP,
 * restart loop) and it is the shape this repository has already agreed not to
 * ship again.
 *
 * The executor is also *running right now*, in dry-run, with the old key on
 * disk. `pull` updates the checkout — including `ops-config.yaml` — without
 * restarting this daemon, so the new file lands under a process that will not
 * read it until a person restarts it. Making that restart the moment it dies
 * is a bad trade for a cosmetic key rename.
 *
 * What is NOT tolerated is ambiguity. The old key is accepted only when
 * exactly one configured instance can be shown to own that directory — that
 * is, it lies inside that instance's `stateDir`. If no instance owns it, or
 * two do, the boot fails with the exact lines to write, because an
 * unattributable spool is the precise thing this change exists to abolish:
 * provenance is the feature, and guessing at it would be worse than the shared
 * spool was.
 *
 * Mutates the matched entry's `opsSpoolDir`, so the instance carries on
 * watching the same directory it was watching before the upgrade. Returns the
 * deprecation notice for the boot journal.
 *
 * ── `explicit` — added 2026-08-11, because "written down" is not "default" ──
 *
 * `explicit` is the set of instance names whose `opsSpoolDir` was actually
 * present in the YAML. It has to be passed in, because by the time this runs
 * the value has already been resolved through `absPath(..., default)` and an
 * explicitly written default is byte-identical to an absent key.
 *
 * Review of PR #8 found what that cost. The disagreement check used to read
 * `opsSpoolDir !== <the derived default> && opsSpoolDir !== legacy`, so an
 * operator who wrote the default out by hand — `opsSpoolDir:
 * /var/lib/clawcius/run/ops`, which is a perfectly ordinary thing to do while
 * moving off the old key — and left a stale top-level `spoolDir` pointing
 * somewhere else in the same stateDir got neither the failure nor their own
 * value: the first conjunct was false, the throw was skipped, and the line
 * below silently overwrote what they had written with the legacy path.
 *
 * The consequence is precisely the failure this release exists to end, with an
 * extra step. `docker/run-container.sh` hard-codes the container's spool to
 * `<stateDir>/run/ops` and that path is not in the config, so the executor
 * would end up watching the old directory while the container wrote the new
 * one, and every request would vanish silently in both directions. No
 * containment check catches it — both paths are legal, they simply are not the
 * same path.
 *
 * So the rule is now the one the README always claimed: an explicit
 * `opsSpoolDir` that disagrees with the legacy key fails the boot, whatever its
 * value happens to be, and an explicit one is never overwritten.
 */
function migrateLegacySpoolDir(
  root: Record<string, unknown>,
  instances: InstanceEntry[],
  explicit: ReadonlySet<string>,
): string[] {
  const raw = root['spoolDir'];
  if (raw === undefined || raw === null) return [];

  const legacy = absPath(raw, 'spoolDir', '');

  const owners = instances.filter(
    (instance) =>
      isInside(legacy, instance.stateDir) || legacy === instance.opsSpoolDir,
  );

  const remedy = instances
    .map(
      (instance) =>
        `      - name: ${instance.name}\n        opsSpoolDir: ${instance.opsSpoolDir}`,
    )
    .join('\n');

  if (owners.length === 0) {
    throw new Error(
      `ops-config.yaml: the top-level "spoolDir" key (${legacy}) is deprecated, and this ` +
        'one cannot be attributed to any configured instance — it is not inside any ' +
        "instance's stateDir. Since 2026-08-10 each instance has its own spool and the " +
        'directory a request arrives in is what identifies the requester, so a spool ' +
        'belonging to nobody has no meaning. Delete the key and, if the default is not ' +
        'what you want, set opsSpoolDir per instance:\n' +
        `${remedy}\n` +
        '(The default is <stateDir>/run/ops, which is inside the bind mount ' +
        'docker/run-container.sh already gives each container.)',
    );
  }

  if (owners.length > 1) {
    throw new Error(
      `ops-config.yaml: the deprecated top-level "spoolDir" (${legacy}) is inside the ` +
        `stateDir of more than one instance (${owners.map((o) => o.name).join(', ')}). ` +
        'It cannot be attributed, and attributing it by guessing would defeat the reason ' +
        'spools are per-instance now. Delete the key and set opsSpoolDir explicitly:\n' +
        `${remedy}`,
    );
  }

  const owner = owners[0]!;
  const wouldBe = defaultOpsSpoolDir(owner.stateDir);

  if (explicit.has(owner.name)) {
    // The operator wrote both keys. If they disagree, that is two answers to
    // one question and the one case where silence is indefensible: whichever
    // the loader picked, the other would look like it had been honoured.
    //
    // Tested against "was it written" and not against "is it the default",
    // because those are different questions and only the first one is about
    // the operator's intent. See the header.
    if (owner.opsSpoolDir !== legacy) {
      throw new Error(
        `ops-config.yaml: the deprecated top-level "spoolDir" (${legacy}) and ` +
          `instances[${owner.name}].opsSpoolDir (${owner.opsSpoolDir}) name different ` +
          'directories. Delete the top-level key; the per-instance one is the only one ' +
          'that can say whose spool it is. (This fails even when the per-instance value ' +
          'is the default written out by hand: an explicit key means the operator meant ' +
          'it, and quietly replacing it is how the executor ends up watching a directory ' +
          'no container writes.)',
      );
    }
    // Written twice, identically. Nothing to migrate; the deprecation notice
    // below still goes into the journal.
  } else {
    owner.opsSpoolDir = legacy;
  }

  return [
    `the top-level "spoolDir" key is DEPRECATED. ${legacy} has been attributed to ` +
      `instance "${owner.name}", which is the only instance whose stateDir contains it, ` +
      'so that instance keeps watching exactly the directory it watched before this ' +
      'upgrade and no behaviour changed for it. Every other instance now has its own ' +
      'spool. Replace the key with:\n' +
      `    instances:\n      - name: ${owner.name}\n        opsSpoolDir: ${legacy}\n` +
      `  or delete it entirely to take the default (${wouldBe}).`,
  ];
}

export function loadOpsConfig(configPath?: string): OpsConfig {
  const path = resolve(configPath ?? process.env['OPS_CONFIG_PATH'] ?? 'ops-config.yaml');

  if (!existsSync(path)) {
    throw new Error(
      `Ops config not found at ${path}. ` +
        'Expected ops-config.yaml in the working directory, or set OPS_CONFIG_PATH.',
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : error}`);
  }

  const root = section(parsed, 'root');
  const limits = section(root['limits'], 'limits');
  const idle = section(root['idle'], 'idle');
  const deadline = section(root['deadline'], 'deadline');
  const breaker = section(root['breaker'], 'breaker');
  const verify = section(root['snapshotVerify'], 'snapshotVerify');
  const agent = section(root['hostAgent'], 'hostAgent');

  const units: UnitEntry[] = list(root['units'], 'units').map((raw, index) => {
    const entry = section(raw, `units[${index}]`);
    const name = requiredStr(entry['name'], `units[${index}].name`);
    if (!UNIT_PATTERN.test(name)) {
      throw new OpsConfigError(
        `units[${index}].name`,
        `("${name}") must be a full systemd unit name with a type suffix, ` +
          `matching ${String(UNIT_PATTERN)}`,
      );
    }
    return {
      name,
      description: str(entry['description'], `units[${index}].description`, name),
    };
  });

  const repos: RepoEntry[] = list(root['repos'], 'repos').map((raw, index) => {
    const entry = section(raw, `repos[${index}]`);
    const at = `repos[${index}]`;
    const path = requiredAbsPath(entry['path'], `${at}.path`);
    // Relative, and checked to stay inside the checkout. `buildDirs` names a
    // subdirectory of a checkout the operator has already authorised — it is
    // not a second way to nominate a directory for a root process to run npm
    // in. An absolute entry, or one that climbs out with `..`, is a config
    // typo at best and a widening of the allowlist at worst, so it fails the
    // boot with the offending value named rather than being normalised.
    const buildDirs = strList(entry['buildDirs'], `${at}.buildDirs`, ['.']).map((dir, at2) => {
      const where = `${at}.buildDirs[${at2}]`;
      if (isAbsolute(dir)) {
        throw new OpsConfigError(where, `("${dir}") must be relative to the checkout`);
      }
      const resolved = resolve(path, dir);
      if (!isInside(resolved, path)) {
        throw new OpsConfigError(
          where,
          `("${dir}") resolves to ${resolved}, which is outside the checkout at ${path}`,
        );
      }
      return dir;
    });
    return {
      name: checkName(requiredStr(entry['name'], `${at}.name`), `${at}.name`),
      path,
      branch: requiredStr(entry['branch'], `${at}.branch`),
      buildDirs,
    };
  });

  /**
   * Instances whose `opsSpoolDir` was actually written in the file.
   *
   * Kept beside the entries rather than on them: the resolved value cannot
   * answer "was this written down", because an explicitly written default is
   * identical to an absent key, and `migrateLegacySpoolDir` has to be able to
   * tell those apart. Same distinction `strListOrNull` exists to preserve for
   * `mayRequest`, for the same reason — absence means something.
   */
  const explicitOpsSpoolDir = new Set<string>();

  const instances: InstanceEntry[] = list(root['instances'], 'instances').map((raw, index) => {
    const at = `instances[${index}]`;
    const entry = section(raw, at);
    const name = checkName(requiredStr(entry['name'], `${at}.name`), `${at}.name`);
    const container = checkName(
      requiredStr(entry['container'], `${at}.container`),
      `${at}.container`,
    );
    const image = requiredStr(entry['image'], `${at}.image`);
    if (!IMAGE_PATTERN.test(image)) {
      throw new OpsConfigError(`${at}.image`, `("${image}") is not a plain repo[:tag] reference`);
    }
    const wakeChannelId = requiredStr(entry['wakeChannelId'], `${at}.wakeChannelId`);
    if (!CHANNEL_PATTERN.test(wakeChannelId)) {
      throw new OpsConfigError(`${at}.wakeChannelId`, 'must be a Discord channel id (digits)');
    }
    const buildRepo = str(entry['buildRepo'], `${at}.buildRepo`, '');
    if (buildRepo && !repos.some((repo) => repo.name === buildRepo)) {
      throw new OpsConfigError(
        `${at}.buildRepo`,
        `("${buildRepo}") names no entry under repos:. The breaker identifies a ` +
          'build by that checkout\'s HEAD, so it has to be one this executor knows about.',
      );
    }
    const stateDir = requiredAbsPath(entry['stateDir'], `${at}.stateDir`);

    // The spool defaults from the state directory rather than being required,
    // because the default is the only value that is right by construction:
    // `<stateDir>/run` is what run-container.sh bind-mounts. An operator who
    // writes it out by hand can still get it wrong — and the containment
    // checks below are what catch that — but nobody has to write it out at
    // all for a new instance to be able to talk to this daemon.
    const opsSpoolDir = absPath(
      entry['opsSpoolDir'],
      `${at}.opsSpoolDir`,
      defaultOpsSpoolDir(stateDir),
    );
    if (entry['opsSpoolDir'] !== undefined && entry['opsSpoolDir'] !== null) {
      explicitOpsSpoolDir.add(name);
    }

    // Absent is unrestricted. That is the pre-2026-08-10 behaviour and it is
    // what an upgrade gets, deliberately: this change ships a *mechanism*, and
    // a mechanism that silently starts refusing requests on a running
    // privileged daemon is not a mechanism, it is an outage with a changelog.
    const scopeRaw = entry['mayRequest'];
    let mayRequest: RequestScope | null = null;
    if (scopeRaw !== undefined && scopeRaw !== null) {
      const scope = section(scopeRaw, `${at}.mayRequest`);
      mayRequest = {
        verbs: strListOrNull(scope['verbs'], `${at}.mayRequest.verbs`),
        instances: strListOrNull(scope['instances'], `${at}.mayRequest.instances`),
        units: strListOrNull(scope['units'], `${at}.mayRequest.units`),
        repos: strListOrNull(scope['repos'], `${at}.mayRequest.repos`),
      };

      // Checked against the real allowlists, now for verbs/units/repos and
      // below in the cross-field pass for instances (which are still being
      // built at this point). A name that matches nothing would be a silent
      // total denial — the operator writes `mayRequest.units:
      // [clawcius.serivce]`, believes they granted a restart, and every
      // restart is refused with a message that reads like a config problem
      // somewhere else entirely.
      for (const verb of mayRequest.verbs ?? []) {
        if (!(VERBS as readonly string[]).includes(verb)) {
          throw new OpsConfigError(
            `${at}.mayRequest.verbs`,
            `("${verb}") is not a verb. Known verbs: ${VERBS.join(', ')}`,
          );
        }
      }
      for (const unit of mayRequest.units ?? []) {
        if (!units.some((candidate) => candidate.name === unit)) {
          throw new OpsConfigError(
            `${at}.mayRequest.units`,
            `("${unit}") names no entry under units:. A restriction that names nothing ` +
              'refuses everything, and does it in a way that reads like a bug elsewhere.',
          );
        }
      }
      for (const repo of mayRequest.repos ?? []) {
        if (!repos.some((candidate) => candidate.name === repo)) {
          throw new OpsConfigError(
            `${at}.mayRequest.repos`,
            `("${repo}") names no entry under repos:`,
          );
        }
      }
    }

    return {
      name,
      container,
      image,
      stateDir,
      envFile: requiredAbsPath(entry['envFile'], `${at}.envFile`),
      memory: str(entry['memory'], `${at}.memory`, '2g'),
      wakerStatusFile: requiredAbsPath(entry['wakerStatusFile'], `${at}.wakerStatusFile`),
      wakeSpoolDir: requiredAbsPath(entry['wakeSpoolDir'], `${at}.wakeSpoolDir`),
      wakeChannelId,
      buildRepo,
      opsSpoolDir,
      mayRequest,
    };
  });

  const deprecations = migrateLegacySpoolDir(root, instances, explicitOpsSpoolDir);

  // ── mayRequest.units / mayRequest.repos: parsed, validated, inert ────────
  //
  // Accepted rather than rejected, for the same reason the old `spoolDir` key
  // is: this unit is Restart=always with no start limit and holds the rollback
  // deadlines, so a config the loader refuses is not one loud error, it is a
  // root daemon in a five-second restart loop with every armed deadline
  // unhonoured. But an operator who wrote these believes they restrict
  // something, and since 2026-08-10 they restrict nothing at all — there is no
  // request that carries a unit or a repo. Silence there would be a person
  // believing they are protected, which is worse than the key.
  for (const instance of instances) {
    const dead = (['units', 'repos'] as const).filter(
      (key) => instance.mayRequest?.[key] !== null && instance.mayRequest?.[key] !== undefined,
    );
    if (dead.length === 0) continue;
    deprecations.push(
      `instances[${instance.name}].mayRequest.${dead.join(' and .')} no longer restricts ` +
        'anything and is being IGNORED. The verbs that named a unit (restart) and a repo ' +
        '(pull) were deleted on 2026-08-10; a task is free text and there is no allowlist in ' +
        'front of it. If the intent was "this instance may only look after itself", the key ' +
        `that still does that is mayRequest.instances: [${instance.name}] — and read the ` +
        'trust model section of ops/README.md first, because it bounds what this instance may ' +
        'ASK for and not what the host agent may DO.',
    );
  }

  const config: OpsConfig = {
    dryRun: bool(root['dryRun'], 'dryRun', DEFAULTS.dryRun),
    stateDir: absPath(root['stateDir'], 'stateDir', DEFAULTS.stateDir),
    pollSeconds: num(root['pollSeconds'], 'pollSeconds', DEFAULTS.pollSeconds, 1, 3600),
    runContainerScript: absPath(
      root['runContainerScript'],
      'runContainerScript',
      DEFAULTS.runContainerScript,
    ),
    snapshotScript: absPath(root['snapshotScript'], 'snapshotScript', DEFAULTS.snapshotScript),
    systemctlPath: absPath(root['systemctlPath'], 'systemctlPath', DEFAULTS.systemctlPath),
    dockerPath: absPath(root['dockerPath'], 'dockerPath', DEFAULTS.dockerPath),
    gitPath: absPath(root['gitPath'], 'gitPath', DEFAULTS.gitPath),
    npmPath: absPath(root['npmPath'], 'npmPath', DEFAULTS.npmPath),
    snapshotKeep: num(root['snapshotKeep'], 'snapshotKeep', DEFAULTS.snapshotKeep, 1, 500),
    units,
    repos,
    instances,
    hostAgent: {
      enabled: bool(agent['enabled'], 'hostAgent.enabled', DEFAULTS.hostAgent.enabled),
      user: agentUserName(agent['user']),
      passwdPath: absPath(agent['passwdPath'], 'hostAgent.passwdPath', DEFAULTS.hostAgent.passwdPath),
      groupPath: absPath(agent['groupPath'], 'hostAgent.groupPath', DEFAULTS.hostAgent.groupPath),
      forbiddenGroups: strList(
        agent['forbiddenGroups'],
        'hostAgent.forbiddenGroups',
        DEFAULTS.hostAgent.forbiddenGroups,
      ),
      // Absolute, because a relative "secret path" would resolve against
      // whatever working directory systemd happened to give this unit, and a
      // check that silently points at the wrong file reads as a pass.
      secretPaths: strList(
        agent['secretPaths'],
        'hostAgent.secretPaths',
        DEFAULTS.hostAgent.secretPaths,
      ).map((path, index) => {
        if (!isAbsolute(path)) {
          throw new OpsConfigError(`hostAgent.secretPaths[${index}]`, 'must be an absolute path');
        }
        return resolve(path);
      }),
      gitSshKey: agent['gitSshKey']
        ? absPath(agent['gitSshKey'], 'hostAgent.gitSshKey', DEFAULTS.hostAgent.gitSshKey)
        : DEFAULTS.hostAgent.gitSshKey,
      claudePath: absPath(agent['claudePath'], 'hostAgent.claudePath', DEFAULTS.hostAgent.claudePath),
      workDir: absPath(agent['workDir'], 'hostAgent.workDir', DEFAULTS.hostAgent.workDir),
      timeoutMinutes: num(
        agent['timeoutMinutes'],
        'hostAgent.timeoutMinutes',
        DEFAULTS.hostAgent.timeoutMinutes,
        1,
        720,
      ),
      maxCostUsd: num(agent['maxCostUsd'], 'hostAgent.maxCostUsd', DEFAULTS.hostAgent.maxCostUsd, 0.01, 1000),
      model: str(agent['model'], 'hostAgent.model', DEFAULTS.hostAgent.model),
      envPassthrough: strList(
        agent['envPassthrough'],
        'hostAgent.envPassthrough',
        DEFAULTS.hostAgent.envPassthrough,
      ),
    },
    limits: {
      maxRequestBytes: num(
        limits['maxRequestBytes'],
        'limits.maxRequestBytes',
        DEFAULTS.limits.maxRequestBytes,
        64,
        1024 * 1024,
      ),
      maxPerSweep: num(limits['maxPerSweep'], 'limits.maxPerSweep', DEFAULTS.limits.maxPerSweep, 1, 1000),
      maxSpoolFiles: num(
        limits['maxSpoolFiles'],
        'limits.maxSpoolFiles',
        DEFAULTS.limits.maxSpoolFiles,
        1,
        10000,
      ),
      maxPerHour: num(limits['maxPerHour'], 'limits.maxPerHour', DEFAULTS.limits.maxPerHour, 1, 1000),
      maxQueued: num(limits['maxQueued'], 'limits.maxQueued', DEFAULTS.limits.maxQueued, 0, 1000),
      commandTimeoutSeconds: num(
        limits['commandTimeoutSeconds'],
        'limits.commandTimeoutSeconds',
        DEFAULTS.limits.commandTimeoutSeconds,
        5,
        7200,
      ),
      buildTimeoutSeconds: num(
        limits['buildTimeoutSeconds'],
        'limits.buildTimeoutSeconds',
        DEFAULTS.limits.buildTimeoutSeconds,
        30,
        14400,
      ),
    },
    idle: {
      staleSeconds: num(idle['staleSeconds'], 'idle.staleSeconds', DEFAULTS.idle.staleSeconds, 5, 3600),
      maxWaitMinutes: num(
        idle['maxWaitMinutes'],
        'idle.maxWaitMinutes',
        DEFAULTS.idle.maxWaitMinutes,
        0,
        1440,
      ),
      pollSeconds: num(idle['pollSeconds'], 'idle.pollSeconds', DEFAULTS.idle.pollSeconds, 1, 600),
    },
    deadline: {
      minutes: num(deadline['minutes'], 'deadline.minutes', DEFAULTS.deadline.minutes, 1, 1440),
      autoRollback: bool(
        deadline['autoRollback'],
        'deadline.autoRollback',
        DEFAULTS.deadline.autoRollback,
      ),
    },
    breaker: {
      maxConsecutiveFailedRecoveries: num(
        breaker['maxConsecutiveFailedRecoveries'],
        'breaker.maxConsecutiveFailedRecoveries',
        DEFAULTS.breaker.maxConsecutiveFailedRecoveries,
        1,
        100,
      ),
      maxQuarantined: num(
        breaker['maxQuarantined'],
        'breaker.maxQuarantined',
        DEFAULTS.breaker.maxQuarantined,
        1,
        10000,
      ),
    },
    snapshotVerify: {
      enabled: bool(verify['enabled'], 'snapshotVerify.enabled', DEFAULTS.snapshotVerify.enabled),
      instances: strList(
        verify['instances'],
        'snapshotVerify.instances',
        DEFAULTS.snapshotVerify.instances,
      ),
      startTimeoutSeconds: num(
        verify['startTimeoutSeconds'],
        'snapshotVerify.startTimeoutSeconds',
        DEFAULTS.snapshotVerify.startTimeoutSeconds,
        5,
        3600,
      ),
      probe: strList(verify['probe'], 'snapshotVerify.probe', DEFAULTS.snapshotVerify.probe),
    },
    deprecations,
  };

  // ── Cross-field checks ──────────────────────────────────────────────────
  // Everything below is a property that cannot be expressed per-key, and each
  // one is here because getting it wrong is quiet rather than loud.

  for (const set of [
    { label: 'units', names: units.map((u) => u.name) },
    { label: 'repos', names: repos.map((r) => r.name) },
    { label: 'instances', names: instances.map((i) => i.name) },
  ]) {
    const seen = new Set<string>();
    for (const name of set.names) {
      if (seen.has(name)) {
        throw new OpsConfigError(set.label, `has two entries named "${name}"`);
      }
      seen.add(name);
    }
  }

  for (const name of config.snapshotVerify.instances) {
    if (!instances.some((instance) => instance.name === name)) {
      throw new OpsConfigError(
        'snapshotVerify.instances',
        `("${name}") names no entry under instances:`,
      );
    }
  }

  // ── Containment, now across every spool ─────────────────────────────────
  //
  // These used to be written against the one shared `spoolDir`. Every one of
  // them has to hold for EACH instance's spool now, and the ones that are new
  // exist because per-instance spools introduce failure modes a single spool
  // could not have: two instances sharing a directory (provenance gone), one
  // instance's spool containing another's (provenance forged), and a spool
  // that swallows a wake spool (the executor eating the waker's queue).
  //
  // Written as an explicit loop over pairs rather than anything clever,
  // because the reader of this function at 3am is trying to answer "can the
  // agent reach the breaker" and every abstraction between them and the answer
  // costs more than it saves.

  for (const instance of instances) {
    // The state directory holds the circuit breaker. If the agent can write
    // it, the agent can un-quarantine the build that just took it down — which
    // turns the breaker into a suggestion, and turns the loop it exists to
    // break back on.
    if (isInside(config.stateDir, instance.opsSpoolDir)) {
      throw new Error(
        `ops-config.yaml: stateDir (${config.stateDir}) is inside ` +
          `instances[${instance.name}].opsSpoolDir (${instance.opsSpoolDir}). That spool ` +
          'is written by that agent; the breaker and the journal must not be.',
      );
    }
    if (isInside(config.stateDir, instance.wakeSpoolDir)) {
      throw new Error(
        `ops-config.yaml: stateDir is inside instances[${instance.name}].wakeSpoolDir, ` +
          'which the container can write.',
      );
    }

    // Same argument, at the sharpest point. A waker status file the container
    // can write is a container that can declare itself idle and be recreated
    // mid-turn — or, worse, declare itself idle to get a rollback moving.
    if (isInside(instance.wakerStatusFile, instance.wakeSpoolDir)) {
      throw new Error(
        `ops-config.yaml: instances[${instance.name}].wakerStatusFile is inside its ` +
          'wakeSpoolDir, which is bind-mounted read-write into the container. The ' +
          'executor believes that file when it decides whether destroying the ' +
          'container would interrupt a live turn.',
      );
    }

    for (const other of instances) {
      // Any spool, not just its own. Instance A writing instance B's status
      // file is the same hole with an extra step, and on this host the two
      // state directories are siblings under /var/lib, so a fat-fingered path
      // lands in the neighbour rather than nowhere.
      if (isInside(instance.wakerStatusFile, other.opsSpoolDir)) {
        throw new Error(
          `ops-config.yaml: instances[${instance.name}].wakerStatusFile is inside ` +
            `instances[${other.name}].opsSpoolDir, which that agent writes. Same problem.`,
        );
      }

      if (instance === other) continue;

      // The same argument as the two checks above, for the pairing they both
      // missed. Added 2026-08-11, after review of PR #8 pointed out that the
      // coverage was asymmetric: a status file was checked against its OWN
      // wake spool and against ANY ops spool, but never against another
      // instance's wake spool — which is bind-mounted read-write into that
      // other container exactly like the ops spool is.
      //
      // So instance A's status file sitting under B's wake spool meant B's
      // agent could create or overwrite it and declare A idle whenever it
      // liked: A gets recreated mid-turn, or a rollback of A proceeds over a
      // live conversation. The check that would have caught it was three lines
      // away and written for precisely this, which is the usual shape of a
      // coverage gap — the loop's own comment says "a fat-fingered path lands
      // in the neighbour" and then only looked in half the neighbourhood.
      if (isInside(instance.wakerStatusFile, other.wakeSpoolDir)) {
        throw new Error(
          `ops-config.yaml: instances[${instance.name}].wakerStatusFile is inside ` +
            `instances[${other.name}].wakeSpoolDir (${other.wakeSpoolDir}), which is ` +
            `bind-mounted read-write into ${other.name}'s container. ${other.name} could ` +
            `then declare ${instance.name} idle, and the executor believes that file when ` +
            'it decides whether destroying a container would interrupt a live turn.',
        );
      }

      // Two instances, one spool: the exact thing this release exists to end.
      // The directory a request arrives in is now the only evidence of who
      // filed it, so a shared spool does not merely blur provenance, it
      // fabricates it — every request from either agent would be attributed,
      // confidently and wrongly, to whichever entry the loop happened to see
      // first.
      if (instance.opsSpoolDir === other.opsSpoolDir) {
        throw new Error(
          `ops-config.yaml: instances[${instance.name}] and instances[${other.name}] ` +
            `share opsSpoolDir (${instance.opsSpoolDir}). The spool a request arrives ` +
            'in is what identifies the requester, so sharing one does not blur ' +
            'provenance — it invents it. Give each instance its own.',
        );
      }
      if (isInside(instance.opsSpoolDir, other.opsSpoolDir)) {
        throw new Error(
          `ops-config.yaml: instances[${instance.name}].opsSpoolDir ` +
            `(${instance.opsSpoolDir}) is inside instances[${other.name}].opsSpoolDir ` +
            `(${other.opsSpoolDir}). ${other.name} could then write requests that arrive ` +
            `attributed to ${instance.name}, which is forgery with extra steps.`,
        );
      }
    }

    for (const other of instances) {
      // A spool that contains a wake spool means the executor sweeps the
      // waker's queue: wake files are a different schema, so every one of them
      // would be consumed, rejected as malformed and DELETED — the ops spool
      // unlinks before it parses. The agent would lose wakes it never knew it
      // had. The reverse nesting hands the waker the ops requests.
      if (isInside(other.wakeSpoolDir, instance.opsSpoolDir)) {
        throw new Error(
          `ops-config.yaml: instances[${other.name}].wakeSpoolDir ` +
            `(${other.wakeSpoolDir}) is inside instances[${instance.name}].opsSpoolDir ` +
            `(${instance.opsSpoolDir}). The ops spool unlinks every file it sweeps ` +
            'before parsing it, so this would silently eat wakes.',
        );
      }
      if (isInside(instance.opsSpoolDir, other.wakeSpoolDir)) {
        throw new Error(
          `ops-config.yaml: instances[${instance.name}].opsSpoolDir ` +
            `(${instance.opsSpoolDir}) is inside instances[${other.name}].wakeSpoolDir ` +
            `(${other.wakeSpoolDir}). The waker sweeps that directory and would consume ` +
            'ops requests as malformed wakes.',
        );
      }
    }

    // Checked here rather than in the instance loop above because the instance
    // list does not exist yet while it is being built.
    for (const target of instance.mayRequest?.instances ?? []) {
      if (!instances.some((candidate) => candidate.name === target)) {
        throw new OpsConfigError(
          `instances[${instance.name}].mayRequest.instances`,
          `("${target}") names no entry under instances:. A restriction that names ` +
            'nothing refuses everything.',
        );
      }
    }
  }

  // ── The host agent's working directory ──────────────────────────────────
  //
  // Three things it must not be, each because of a specific failure:
  //
  //   - inside a spool: the session writes freely in its own working
  //     directory, and a spool it can write is a spool it can file requests
  //     into — forging a request from whichever instance owns that directory,
  //     which is the one thing provenance is supposed to make impossible. The
  //     spools are group-writable by the uid the containers run as, so this
  //     stayed true across the 2026-08-11 change of identity;
  //   - inside stateDir, or containing it: stateDir is 0750 root-owned and
  //     holds the journal, the breaker and the deadlines. The session must not
  //     need to traverse it to work, and must not be able to reach it by
  //     accident. (With sudo it can reach it anyway. That is in the README's
  //     honest list, and it is not a reason to make the easy path easier.)
  //   - inside a checkout: Claude Code auto-discovers CLAUDE.md and project
  //     settings from its working directory, so a workDir inside a tree the
  //     agents get commits merged into is a standing-instructions channel into
  //     a process with sudo.
  for (const instance of config.instances) {
    for (const [label, dir] of [
      ['opsSpoolDir', instance.opsSpoolDir],
      ['wakeSpoolDir', instance.wakeSpoolDir],
    ] as const) {
      if (isInside(config.hostAgent.workDir, dir) || isInside(dir, config.hostAgent.workDir)) {
        throw new Error(
          `ops-config.yaml: hostAgent.workDir (${config.hostAgent.workDir}) and ` +
            `instances[${instance.name}].${label} (${dir}) contain one another. The host ` +
            'agent session writes into its working directory as its own service account; a ' +
            'spool it can write is a spool it can forge a request into.',
        );
      }
    }
  }
  if (
    isInside(config.hostAgent.workDir, config.stateDir) ||
    isInside(config.stateDir, config.hostAgent.workDir)
  ) {
    throw new Error(
      `ops-config.yaml: hostAgent.workDir (${config.hostAgent.workDir}) and stateDir ` +
        `(${config.stateDir}) contain one another. stateDir holds the journal, the circuit ` +
        'breaker and the armed deadlines, and is 0750 root-owned; the host agent runs as an ' +
        'unprivileged service account and must not have it as a working directory.',
    );
  }
  for (const repo of config.repos) {
    if (isInside(config.hostAgent.workDir, repo.path)) {
      throw new Error(
        `ops-config.yaml: hostAgent.workDir (${config.hostAgent.workDir}) is inside the ` +
          `checkout repos[${repo.name}].path (${repo.path}). Claude Code reads CLAUDE.md and ` +
          'project settings from its working directory, so this would let anything merged ' +
          'into that repository supply standing instructions to a session with sudo.',
      );
    }
  }

  if (config.snapshotVerify.probe.length === 0) {
    throw new OpsConfigError(
      'snapshotVerify.probe',
      'must have at least one element — an empty probe would report every ' +
        'restore as healthy, which is worse than not running the verifier',
    );
  }

  return config;
}
