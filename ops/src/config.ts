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
 *      journal, the audit, every board and every waker status file outside the
 *      one directory each container can write — are load-bearing, because the
 *      durable record and the only remaining access control rest on them. They
 *      were rewritten on 2026-08-16: they used to name the two spools inside
 *      that mount, and they now name the mount, which is simpler and strictly
 *      wider.
 *   3. **Operational limits.** Timeouts, and nothing else since the spools
 *      went. These bound how *long*, never *what*.
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
 * Where an instance's Clawsky board is, and whose it is.
 *
 * The board is the SQLite file the instance's waker writes its registry and
 * mail tables into. The executor opens it to give the host agent a mailbox —
 * see `ops/src/board.ts` — and that is the only reason the ops config knows
 * anything about it.
 */
export type BoardEntry = {
  /** The instance's `CLAWCIUS_DB_PATH`. Never created; opened or refused. */
  db: string;
  /** The instance's `clawsky.crew`. The host agent registers as `<crew>-host`. */
  crew: string;
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
   * This instance's Clawsky board, or null for "the host agent has no mailbox
   * on this instance".
   *
   * Both fields are required when the block is present and neither is guessed,
   * because both can only be got right by matching something written
   * elsewhere. `db` must be the same file as that instance's
   * `CLAWCIUS_DB_PATH` — which lives in its env file, not here — and `crew`
   * must be its `clawsky.crew` from `agent-config.yaml`. A wrong `db` would
   * open a second, empty database that looks exactly like a mailbox nobody is
   * writing to; a wrong `crew` would register the host agent into a crew whose
   * coordinator is not the one asking. Neither failure is visible from the
   * outside, so neither gets a default.
   *
   * Absent is the shipped state, and it is inert: no row is created, and a
   * coordinator that DMs `<crew>-host` is told there is no such recipient.
   */
  board: BoardEntry | null;
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
   * Executor state: journal, audit, freeze flag, status JSON.
   *
   * MUST NOT be inside `<stateDir>/run` for any instance — the one directory
   * `docker/run-container.sh` bind-mounts read-write into a container. The
   * journal is the record of what was done to this host, and a record written
   * by the party it is about is not a record.
   */
  stateDir: string;
  /** Poll interval for the host mailboxes, alongside fs.watch. */
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
   * Where this project's systemd unit files are installed. `/etc/systemd/system`.
   *
   * A setting since 2026-08-12 because unit installation moved out of sudo and
   * into the executor (ops/src/units.ts), and the self-test has to be able to
   * point it at a temporary directory — the alternative is a suite that cannot
   * exercise the code that writes to /etc at all, which is the code most worth
   * exercising.
   *
   * It is NOT a knob for choosing where a task may write. The destination of
   * every install is `join(unitDir, <validated unit name>)`; nothing a task says
   * reaches this value, and the loader refuses a unitDir inside a checkout,
   * inside the host agent's working directory, inside stateDir or inside any
   * instance's state directory — all of which are trees the agent account can
   * write, and any of which would turn "the executor installs units as root"
   * back into "the agent chooses the bytes AND the path".
   */
  unitDir: string;
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
  unitDir: '/etc/systemd/system',
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
    const buildRepo = str(entry['buildRepo'], `${at}.buildRepo`, '');
    if (buildRepo && !repos.some((repo) => repo.name === buildRepo)) {
      throw new OpsConfigError(
        `${at}.buildRepo`,
        `("${buildRepo}") names no entry under repos:. The breaker identifies a ` +
          'build by that checkout\'s HEAD, so it has to be one this executor knows about.',
      );
    }
    const stateDir = requiredAbsPath(entry['stateDir'], `${at}.stateDir`);

    // Absent is "no mailbox", which is what an upgrade gets: the host agent
    // stays reachable only through the spool until somebody writes down where
    // the board is. Present means both fields, and neither has a default —
    // see `InstanceEntry.board` for why guessing either one fails invisibly.
    const boardRaw = entry['board'];
    let board: BoardEntry | null = null;
    if (boardRaw !== undefined && boardRaw !== null) {
      const boardSection = section(boardRaw, `${at}.board`);
      const crew = str(boardSection['crew'], `${at}.board.crew`, '');
      if (!NAME_PATTERN.test(crew)) {
        throw new OpsConfigError(
          `${at}.board.crew`,
          `("${crew}") must be the instance's clawsky.crew from its agent-config.yaml, ` +
            'lowercase. The host agent registers as <crew>-host and only that crew\'s ' +
            'coordinator can reach it, so a crew nobody is in is a mailbox nobody can use.',
        );
      }
      board = { db: requiredAbsPath(boardSection['db'], `${at}.board.db`), crew };
    }

    return {
      name,
      container,
      image,
      stateDir,
      envFile: requiredAbsPath(entry['envFile'], `${at}.envFile`),
      memory: str(entry['memory'], `${at}.memory`, '2g'),
      wakerStatusFile: requiredAbsPath(entry['wakerStatusFile'], `${at}.wakerStatusFile`),
      buildRepo,
      board,
    };
  });

  // ── Keys the spools left behind ─────────────────────────────────────────
  //
  // Reported, not refused. `clawcius-ops.service` is Restart=always with no
  // start limit, so a config the loader rejects is not one loud failure — it is
  // a root daemon in a five-second restart loop. That was the argument for
  // tolerating the legacy `spoolDir:` key when spools became per-instance, and
  // it is the same argument now that there are none.
  //
  // But an operator whose file still says `mayRequest:` believes an instance is
  // restricted, and it is not — there is no longer a request for it to
  // restrict. Silence there would be a person believing they are protected,
  // which is a good deal worse than a stale key. So every retired key is named,
  // once, in journal.jsonl, next to the operations it does not govern.
  const RETIRED_TOP_LEVEL = ['spoolDir'] as const;
  const RETIRED_PER_INSTANCE = [
    'opsSpoolDir',
    'wakeSpoolDir',
    'wakeChannelId',
    'mayRequest',
  ] as const;

  /**
   * The caps that bounded a directory an agent could write.
   *
   * These are the ones it would be easiest to drop in silence, and the ones
   * where silence costs most: `maxPerHour: 20` read as "this host is rate
   * limited", and nothing replaces it — `runMailTask` says so itself, that it
   * is not a rate limit and nothing is counted or delayed. A person whose file
   * still carries that line believes in a control that does not exist, which is
   * exactly the case the rest of this block was written for.
   */
  const RETIRED_LIMITS = [
    'maxRequestBytes',
    'maxPerSweep',
    'maxSpoolFiles',
    'maxPerHour',
    'maxQueued',
  ] as const;

  const deprecations: string[] = [];

  for (const key of RETIRED_TOP_LEVEL) {
    if (root[key] === undefined || root[key] === null) continue;
    deprecations.push(
      `the top-level "${key}" key is RETIRED and is being IGNORED. The ops request spool it ` +
        'named was removed on 2026-08-16, along with the wake spool the executor answered ' +
        'into. A task now arrives as a DM to <crew>-host from that crew\'s coordinator and ' +
        'the answer is a DM back. Nothing has been deleted from disk; delete the key.',
    );
  }

  for (const key of RETIRED_LIMITS) {
    if (limits[key] === undefined || limits[key] === null) continue;
    deprecations.push(
      `limits.${key} is RETIRED and is being IGNORED. ` +
        (key === 'maxPerHour'
          ? 'It capped accepted operations per rolling hour across every verb and instance. ' +
            'NOTHING REPLACES IT: a task by DM is refused while another is running and is ' +
            'not counted or delayed otherwise, so this host is not rate limited. If that ' +
            'matters, it is a change to make deliberately rather than a key to leave lying ' +
            'here reading like one.'
          : key === 'maxQueued'
            ? 'It bounded the queue, and there is no queue — a second task is refused in the ' +
              'turn that asked rather than made to wait.'
            : 'It bounded the ops spool, which was removed on 2026-08-16 along with the ' +
              'wake spool. There is no file to size-cap, sweep or flood.') +
        ' Delete the key; the only limits left are commandTimeoutSeconds and ' +
        'buildTimeoutSeconds.',
    );
  }

  for (const [index, raw] of list(root['instances'], 'instances').entries()) {
    const entry = section(raw, `instances[${index}]`);
    const label = str(entry['name'], `instances[${index}].name`, String(index));
    for (const key of RETIRED_PER_INSTANCE) {
      if (entry[key] === undefined || entry[key] === null) continue;
      deprecations.push(
        `instances[${label}].${key} is RETIRED and is being IGNORED. ` +
          (key === 'mayRequest'
            ? 'It narrowed what this instance could file into its ops spool, and there is no ' +
              'ops spool. The rule standing in its place is that only a coordinator may DM ' +
              'the host agent — enforced in src/mail.ts where the DM is delivered, and again ' +
              'in ops/src/host-mailbox.ts against the committed row.'
            : key === 'wakeChannelId'
              ? 'It addressed the wake file the executor wrote after a destructive task, and ' +
                'there is no wake file. The executor answers the coordinator that asked, by DM.'
              : 'Nothing reads or writes the directory it names. Nothing has been deleted ' +
                'from disk; delete the key.'),
      );
    }
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
    unitDir: absPath(root['unitDir'], 'unitDir', DEFAULTS.unitDir),
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

  // ── Containment: nothing privileged inside a container's bind mount ─────
  //
  // `docker/run-container.sh` gives each container THREE read-write mounts of
  // the host filesystem, all three derived from that instance's state
  // directory:
  //
  //     CLAWCIUS_STATE=${CLAWCIUS_STATE_DIR:-/var/lib/clawcius}
  //     -v "$CLAWCIUS_STATE/workspaces:…:rw"     the agent's worktrees
  //     -v "$CLAWCIUS_STATE/run:…:rw"            what the spools lived in
  //     -v "$CLAWCIUS_STATE/agent-home:…:rw"     its Claude config and login
  //
  // Every check below is the same question asked of a different file: is this
  // thing, which a root process trusts, somewhere the least trusted process on
  // the machine can rewrite?
  //
  // Until 2026-08-16 these were written against `opsSpoolDir` and
  // `wakeSpoolDir` — two directories inside ONE of those three — so a path that
  // was agent-writable but not in either of them passed. Both keys went with
  // the spools. Naming all three mounts instead is simpler and strictly wider:
  // a `board.db` under `workspaces/` used to pass, and that file holds the role
  // column `roleOf()` reads, which is the only access control left on running
  // commands on this host.
  //
  // They are DERIVED rather than configured because the script derives them the
  // same way, from one variable, and a second setting to keep in step is a
  // setting that eventually is not. The read-only mounts — the skills
  // directory, discord-cli, gws-cli, the service-account key — are not here,
  // and their omission is deliberate rather than an oversight: a file the agent
  // cannot write is not a file it can lie with. `src/agent-config.ts` names
  // them anyway, because the thing it is protecting there is a credential
  // rather than a claim, and a read-only mount shared by BOTH deployments hands
  // one instance's token to the other.
  //
  // Written as an explicit loop over pairs rather than anything clever, because
  // the reader of this function at 3am is trying to answer "can the agent reach
  // this" and every abstraction between them and the answer costs more than it
  // saves.

  const mounts = instances.flatMap((instance) =>
    (['run', 'workspaces', 'agent-home'] as const).map(
      (child) => [instance.name, join(instance.stateDir, child)] as const,
    ),
  );

  for (const [name, mount] of mounts) {
    // The state directory holds the journal, the audit and the freeze. If the
    // agent can write it, the record of what was done to this host is written
    // by the party it was done on behalf of.
    if (isInside(config.stateDir, mount)) {
      throw new Error(
        `ops-config.yaml: stateDir (${config.stateDir}) is inside ${mount}, which ` +
          `docker/run-container.sh bind-mounts read-write into ${name}'s container. The ` +
          'journal and the audit must not be written by the party they are about.',
      );
    }

    // Same argument, for the board. A root daemon opens that file by name,
    // reads rows out of it and runs a Claude Code session with a shell on
    // whatever they say. Inside the mount it would be a database the container
    // can rewrite in place — every registry role in it, including which agents
    // are coordinators, and therefore the only access control left on running
    // commands on this host. `ops/src/board.ts` also refuses a path that is not
    // a regular file; this catches the misconfiguration before anything is
    // opened at all.
    for (const instance of instances) {
      if (instance.board && isInside(instance.board.db, mount)) {
        throw new Error(
          `ops-config.yaml: instances[${instance.name}].board.db (${instance.board.db}) ` +
            `is inside ${mount}, which ${name}'s container writes. The board decides who ` +
            'is a coordinator, and a coordinator is the only agent that may run commands ' +
            'on this host. It must live outside every mount, next to wakerStatusFile.',
        );
      }

      // Same argument, at the sharpest point — and checked against EVERY
      // instance's mount, not just the file's own. Instance A's status file
      // under B's mount means B can declare A idle whenever it likes. The two
      // state directories are siblings under /var/lib, so a fat-fingered path
      // lands in the neighbour rather than nowhere.
      if (isInside(instance.wakerStatusFile, mount)) {
        throw new Error(
          `ops-config.yaml: instances[${instance.name}].wakerStatusFile ` +
            `(${instance.wakerStatusFile}) is inside ${mount}, which is bind-mounted ` +
            `read-write into ${name}'s container. The executor believes that file when it ` +
            'decides whether destroying a container would interrupt a live turn.',
        );
      }
    }
  }

  // ── The host agent's working directory ──────────────────────────────────
  //
  // Three things it must not be, each because of a specific failure:
  //
  //   - inside a container's mount: the session writes freely in its own
  //     working directory as its own service account, and the mount is
  //     group-writable by the uid the containers run as, so the two would be
  //     sharing a directory across the sandbox boundary in both directions;
  //   - inside stateDir, or containing it: stateDir is 0750 root-owned and
  //     holds the journal. The session must not need to traverse it to work,
  //     and must not be able to reach it by accident. (With sudo it can reach
  //     it anyway. That is in the README's honest list, and it is not a reason
  //     to make the easy path easier.)
  //   - inside a checkout: Claude Code auto-discovers CLAUDE.md and project
  //     settings from its working directory, so a workDir inside a tree the
  //     agents get commits merged into is a standing-instructions channel into
  //     a process with sudo.
  for (const [name, mount] of mounts) {
    if (
      isInside(config.hostAgent.workDir, mount) ||
      isInside(mount, config.hostAgent.workDir)
    ) {
      throw new Error(
        `ops-config.yaml: hostAgent.workDir (${config.hostAgent.workDir}) and ${mount} — ` +
          `the directory bind-mounted read-write into ${name}'s container — contain one ` +
          'another. The host agent session writes into its working directory; a container ' +
          'that shares it can put anything it likes in front of a process with sudo.',
      );
    }
  }
  if (
    isInside(config.hostAgent.workDir, config.stateDir) ||
    isInside(config.stateDir, config.hostAgent.workDir)
  ) {
    throw new Error(
      `ops-config.yaml: hostAgent.workDir (${config.hostAgent.workDir}) and stateDir ` +
        `(${config.stateDir}) contain one another. stateDir holds the journal and the ` +
        'audit, and is 0750 root-owned; the host agent runs as an unprivileged service ' +
        'account and must not have it as a working directory.',
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

  // ── Where units are installed ───────────────────────────────────────────
  //
  // Added 2026-08-12 with ops/src/units.ts, which took unit installation out of
  // the sudoers file and gave it to the executor. The whole value of that move
  // is that the DESTINATION is computed by root and cannot be influenced by the
  // task: `join(unitDir, <validated name>)`. That argument collapses the moment
  // unitDir is somewhere the agent account can already write — it would be
  // handing the session a root-owned 0644 write into a tree it controls, which
  // is a strictly worse version of the rule that was just deleted. So a unitDir
  // inside any of these is refused at boot rather than discovered later.
  for (const [label, dir] of [
    ['hostAgent.workDir', config.hostAgent.workDir],
    ['stateDir', config.stateDir],
    ...config.repos.map((repo) => [`repos[${repo.name}].path`, repo.path] as const),
    ...config.instances.map((instance) => [`instances[${instance.name}].stateDir`, instance.stateDir] as const),
  ] as ReadonlyArray<readonly [string, string]>) {
    if (isInside(config.unitDir, dir)) {
      throw new Error(
        `ops-config.yaml: unitDir (${config.unitDir}) is inside ${label} (${dir}). Unit files ` +
          'are written there by the executor as root, mode 0644, and the point of doing that ' +
          'in code rather than through a sudo rule is that the destination is not something a ' +
          'task can choose. A unitDir inside a tree the agent account can already write gives ' +
          'that back, with root ownership attached.',
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
