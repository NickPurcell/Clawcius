/**
 * Ops executor configuration, loaded from `ops-config.yaml`.
 *
 * Same split as the waker and the status page: everything describing *what
 * this service is allowed to do* is version-controllable YAML, with defaults
 * and validation in TypeScript, and there are no secrets in here.
 *
 * This one is different from the other two in a way worth being explicit
 * about. For the waker, config is behaviour. Here, config is **the entire
 * authorization model**. Every privileged thing this daemon can do is named in
 * this file, by exact string, and nothing it reads from the spool can add to
 * that list. A unit name that is not under `units:` cannot be restarted; an
 * instance not under `instances:` cannot be recreated; a repo not under
 * `repos:` cannot be pulled. There is no wildcard, no pattern, no prefix match
 * and no "if it looks like a unit name" — those are the shapes that turn a
 * validated allowlist back into a free-form string, and the input to that
 * string comes from a container that may be reading attacker-written text off
 * the internet.
 *
 * So the loader is strict to the point of rudeness. A malformed entry fails
 * the boot rather than being skipped: a silently dropped allowlist entry gives
 * you an executor that refuses valid work (annoying, visible), but a silently
 * *widened* one gives you an executor that accepts invalid work (quiet, and
 * the first you hear of it is the incident).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parse } from 'yaml';

/**
 * A systemd unit this executor may act on.
 *
 * Matched against the request's `unit` field by exact string equality and
 * nothing else. `name` reaches `systemctl` as one element of an argv array,
 * never as part of a string that a shell will look at.
 */
export type UnitEntry = {
  /** Full unit name including the suffix, e.g. `clawcius.service`. */
  name: string;
  /** Shown in logs and in the wake context. */
  description: string;
};

/**
 * A git checkout this executor may `git pull` in.
 *
 * `path` comes from config and is resolved once at load; the request only ever
 * names the entry, so no path fragment from the spool reaches the filesystem.
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
   * Directories under `path`, each holding a `package.json`, that get
   * `npm ci && npm run build` after a pull and before a redeploy.
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
  /** Directory the agents drop request JSON into. Bind-mounted, hostile. */
  spoolDir: string;
  /**
   * Executor state: journal, breaker, pending check-ins, status JSON.
   *
   * MUST NOT be inside `spoolDir` or any container mount. The breaker lives
   * here, and a breaker the quarantined party can edit is not a breaker.
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
  units: UnitEntry[];
  repos: RepoEntry[];
  instances: InstanceEntry[];
  limits: LimitsConfig;
  idle: IdleConfig;
  deadline: DeadlineConfig;
  breaker: BreakerConfig;
  snapshotVerify: SnapshotVerifyConfig;
};

const DEFAULTS: OpsConfig = {
  dryRun: true,
  spoolDir: '/var/lib/clawcius/run/ops',
  stateDir: '/var/lib/clawcius-ops',
  pollSeconds: 5,
  runContainerScript: '/home/npurcell/clawcius/docker/run-container.sh',
  snapshotScript: '/home/npurcell/clawcius/docker/snapshot.sh',
  systemctlPath: '/usr/bin/systemctl',
  dockerPath: '/usr/bin/docker',
  gitPath: '/usr/bin/git',
  npmPath: '/home/npurcell/.local/share/node/bin/npm',
  units: [],
  repos: [],
  instances: [],
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
    return {
      name,
      container,
      image,
      stateDir: requiredAbsPath(entry['stateDir'], `${at}.stateDir`),
      envFile: requiredAbsPath(entry['envFile'], `${at}.envFile`),
      memory: str(entry['memory'], `${at}.memory`, '2g'),
      wakerStatusFile: requiredAbsPath(entry['wakerStatusFile'], `${at}.wakerStatusFile`),
      wakeSpoolDir: requiredAbsPath(entry['wakeSpoolDir'], `${at}.wakeSpoolDir`),
      wakeChannelId,
      buildRepo,
    };
  });

  const config: OpsConfig = {
    dryRun: bool(root['dryRun'], 'dryRun', DEFAULTS.dryRun),
    spoolDir: absPath(root['spoolDir'], 'spoolDir', DEFAULTS.spoolDir),
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
    units,
    repos,
    instances,
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

  // The state directory holds the circuit breaker. If the agent can write it,
  // the agent can un-quarantine the build that just took it down — which turns
  // the breaker into a suggestion, and the loop it exists to break back on.
  if (isInside(config.stateDir, config.spoolDir)) {
    throw new Error(
      `ops-config.yaml: stateDir (${config.stateDir}) is inside spoolDir ` +
        `(${config.spoolDir}). The spool is written by the agents; the breaker and ` +
        'the journal must not be.',
    );
  }

  for (const instance of instances) {
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
    if (isInside(instance.wakerStatusFile, config.spoolDir)) {
      throw new Error(
        `ops-config.yaml: instances[${instance.name}].wakerStatusFile is inside the ` +
          'ops spoolDir, which the agents write. Same problem.',
      );
    }
    if (isInside(config.stateDir, instance.wakeSpoolDir)) {
      throw new Error(
        `ops-config.yaml: stateDir is inside instances[${instance.name}].wakeSpoolDir, ` +
          'which the container can write.',
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
