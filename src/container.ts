/**
 * Runs the agent inside the persistent gVisor container.
 *
 * The SDK normally spawns `claude` as a local child process. This replaces
 * that with `docker exec -i` into a container that is already running, so the
 * agent lives in a contained machine of its own rather than on the host.
 *
 * That inverts the old containment model. Previously each *bash command* was
 * wrapped in a throwaway bwrap namespace while the agent process itself — and
 * every non-bash tool, Read/Write/WebFetch included — ran unconfined on the
 * host. Now the whole agent is inside gVisor, so the boundary covers every
 * tool, and daemons and cron jobs it starts survive between turns.
 *
 * `docker exec` gives us a plain ChildProcess, which already satisfies the
 * SDK's SpawnedProcess interface (stdin/stdout/killed/exitCode/kill/on), so
 * there is nothing to adapt.
 *
 * ── The environment does NOT go on the command line ────────────────────────
 *
 * It used to. Every variable in the session environment became a literal
 * `-e KEY=VALUE` argument, and that environment contains `DISCORD_TOKEN` and
 * `GITHUB_TOKEN`. `/proc/<pid>/cmdline` is world-readable, so both credentials
 * were legible to every local account on the host — `clawcius-ops`, anything
 * in `clawcius-dev`, any future service account — for the duration of every
 * turn. The host agent read them out of `ps` twice while diagnosing unrelated
 * things, and reported it rather than using it (#53).
 *
 * That also walked straight around a control the sudoers file spends a page
 * justifying: `docker inspect *` was removed on 2026-08-12 so that account
 * could not read another container's `Config.Env`. The grant is still removed.
 * The secrets were readable anyway, through a call that needs no grant at all.
 *
 * So the environment is written to a file and passed as `--env-file`, which is
 * what `docker/run-container.sh` has always done for container *creation*.
 * Only this per-exec path was wrong.
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

/**
 * Host-specific variables that must not leak into the container.
 *
 * PATH is the dangerous one: the host's points at ~/.local/share/node/bin,
 * which does not exist inside the image, so forwarding it makes every command
 * fail with ENOENT. The rest describe the host user's session, not the agent's.
 */
const HOST_ONLY = new Set([
  'PATH',
  'HOME',
  // The agent's timezone is set on the container and is deliberately not the
  // host's. Forwarding this would let whatever the server happens to be set to
  // silently win, and the agent schedules its own recurring work in local time.
  'TZ',
  'PWD',
  'OLDPWD',
  'SHELL',
  'USER',
  'LOGNAME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'NOTIFY_SOCKET',
  'WATCHDOG_PID',
  'WATCHDOG_USEC',
  'INVOCATION_ID',
  'JOURNAL_STREAM',
  'LISTEN_PID',
  'LISTEN_FDS',
]);

/**
 * The ONLY variables that may appear in the `docker exec` command line.
 *
 * ── Read this before adding an `-e` ────────────────────────────────────────
 *
 * This is an allowlist, not a denylist, and that direction is the whole point.
 * A list of secret names has to be *remembered*: it is right until somebody
 * adds `SENTRY_DSN` or a second bot token, forgets to extend it, and ships a
 * credential into `ps` without noticing. An allowlist fails the other way —
 * anything new lands in the env file, which is correct for a secret and merely
 * slightly less convenient for a non-secret. Adding a name here is a diff that
 * says "this is not a credential", which is a claim somebody can review.
 *
 * `ops/src/host-agent.ts` reaches for the same shape from the other end: it
 * refuses to start a session whose environment matches FORBIDDEN_NAME. That is
 * a denylist because it is guarding a passthrough an operator writes by hand;
 * this is a whole environment nobody enumerates, so it gets the allowlist.
 *
 * What is on it and why: the proxy variables are not secrets, and seeing them
 * in `ps` is genuinely useful — "is this exec even pointed at Squid" is a real
 * question with a real answer here. Everything else goes in the file, even the
 * dull half of it, because the alternative is a judgement call per variable
 * and those are exactly the calls that get made wrong at 2am.
 *
 * HOME, TZ and CLAUDE_CONFIG_DIR are not here and do not need to be: they are
 * in HOST_ONLY above, so they never reach this exec at all. The container gets
 * them once at creation from `docker run -e` in docker/run-container.sh, where
 * they are already visible to anyone reading the container's own arguments.
 */
const CMDLINE_VISIBLE = new Set([
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]);

/**
 * Prefix for the per-exec env files, so the startup sweep can recognise its
 * own litter and nothing else in the directory.
 */
const ENV_FILE_PREFIX = 'exec-env-';

export type ContainerConfig = {
  name: string;
  /** In-container path to the claude binary. */
  claudePath: string;
  /**
   * Directory for the per-exec `--env-file`.
   *
   * Must be outside every bind mount in `docker/run-container.sh`; see the
   * containment check in `src/agent-config.ts`, which refuses to start
   * otherwise. Created 0700 on first use.
   */
  execEnvDir: string;
};

export class EnvFileError extends Error {}

/**
 * Render the environment in Docker's `--env-file` format.
 *
 * One `KEY=VALUE` per line, no quoting, no escaping — the parser takes the
 * whole remainder of the line as the value verbatim, which is exactly the
 * `-e KEY=VALUE` semantics we are replacing.
 *
 * It has one thing it cannot express: a value containing a newline. The line
 * is the delimiter, so such a value would be silently truncated at the newline
 * and the remainder read as a second variable — or as garbage, if it has no
 * `=`. That is a worse failure than the one being fixed: an agent that runs
 * with a credential quietly cut in half fails somewhere far away from here.
 *
 * So it throws, naming the variable and never its value. `-e` could carry such
 * a value and this cannot; that is a real (if theoretical) capability lost,
 * and losing it loudly is the trade. Carriage return goes the same way: it
 * survives the parse but turns up invisibly at the end of a value, which is a
 * whole evening of debugging for no benefit anyone has asked for.
 */
export function renderEnvFile(entries: ReadonlyArray<readonly [string, string]>): string {
  let body = '';
  for (const [key, value] of entries) {
    if (/[\r\n]/.test(value)) {
      throw new EnvFileError(
        `cannot pass ${key} to the container: its value contains a newline, which Docker's ` +
          '--env-file format cannot represent — the line break is the delimiter, so the value ' +
          'would be truncated at it and the rest read as another variable. Refusing rather ' +
          'than passing half a value. (The value is not logged.)',
      );
    }
    // A key cannot contain these either: `=` would move the split, a leading
    // `#` would make the whole line a comment, and both are silent.
    if (/[\r\n=]/.test(key) || key.startsWith('#') || key === '') {
      throw new EnvFileError(
        `cannot pass ${JSON.stringify(key)} to the container: the name is not representable ` +
          "in Docker's --env-file format.",
      );
    }
    body += `${key}=${value}\n`;
  }
  return body;
}

/**
 * Write one env file and return its path.
 *
 * ── Mode ──────────────────────────────────────────────────────────────────
 * 0600 is passed to `open(2)`, not applied afterwards with `chmod`. A
 * `writeFileSync` followed by a `chmodSync` leaves a window — short, but a
 * window — in which the file exists holding both tokens at whatever the umask
 * allows. This file's entire reason for existing is that a credential was
 * readable to the wrong people; it does not get to be world-readable even for
 * a millisecond.
 *
 * `wx` is O_WRONLY|O_CREAT|O_EXCL: it will not follow a symlink somebody
 * planted at the name, and it will not reuse an existing inode with someone
 * else's permissions. The name is random, so nobody can plant one anyway; the
 * flag costs nothing and does not depend on that staying true.
 *
 * ── Lifetime: one file per exec ───────────────────────────────────────────
 * The alternative is one file per session, written once and reused for every
 * turn. That is fewer writes — a couple of kilobytes per turn against a file
 * that lives for hours. It was rejected for two reasons.
 *
 * The secret's time on disk is the thing being minimised, and per-session
 * turns that from "as long as the exec runs" into "as long as the session
 * lives", which on this deployment is days. Per exec, the file exists exactly
 * while a process holding those same values in its own environment is running,
 * which is a window that was already open.
 *
 * And there is nowhere to hang the other lifetime. `containerSpawner` is
 * handed to the SDK as a function; it is told when a process starts and never
 * told when a session ends. A per-session file would need a disposal hook that
 * does not exist, and the version of that with no hook is a file nobody ever
 * deletes.
 */
function writeEnvFile(dir: string, entries: ReadonlyArray<readonly [string, string]>): string {
  const body = renderEnvFile(entries);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${ENV_FILE_PREFIX}${process.pid}-${randomBytes(8).toString('hex')}`);
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return path;
}

/**
 * Delete env files left behind by a previous run. Returns how many.
 *
 * ── What happens to orphans ───────────────────────────────────────────────
 * The unlink below is tied to the child's exit, and a SIGKILL of the waker
 * takes both processes without running it. So orphans are possible and this is
 * the answer to them: they are cleared at startup, not on a timer, and they
 * are not cleared by anything else.
 *
 * The window is therefore "from a hard kill until the next start", which for a
 * `Restart=always` unit is seconds, and during it the file is 0600 in a 0700
 * directory under a 0750 state directory — the exposure it replaces was
 * world-readable and permanent, so this is the right side of the trade even at
 * its worst. What it must not do is accumulate: an orphan per crash forever is
 * a pile of live credentials nobody is looking at.
 *
 * Safe to run unconditionally at startup because this process has not spawned
 * anything yet, so no file matching the prefix can be in use by it, and the
 * directory is per-instance — two wakers sharing one would already be sharing
 * a container name and a database.
 */
export function sweepEnvFiles(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // Nothing has ever run here.
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(ENV_FILE_PREFIX)) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      // Someone else's, or already gone. Not worth failing a startup over.
    }
  }
  return removed;
}

/** Is the container up and accepting exec? */
export function containerRunning(name: string): boolean {
  try {
    const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** Human-readable container state, for preflight messages and `!status`. */
export function containerStatus(name: string): string {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Status}}', name], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'absent';
  }
}

/**
 * Build the `spawnClaudeCodeProcess` implementation.
 *
 * `options.command` is the host path to the SDK's bundled binary, which is
 * meaningless inside the container — it is replaced with the image's own copy.
 * Everything else (args, cwd, env, signal) passes through.
 */
export function containerSpawner(config: ContainerConfig) {
  return (options: SpawnOptions): SpawnedProcess => {
    // Two buckets, and the default is the file. See CMDLINE_VISIBLE.
    const envArgs: string[] = [];
    const fileEntries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined || HOST_ONLY.has(key)) continue;
      if (CMDLINE_VISIBLE.has(key)) envArgs.push('-e', `${key}=${value}`);
      else fileEntries.push([key, value]);
    }

    // Written before the argv is built, because the path has to go in it. A
    // throw from here (an unrepresentable value) aborts the spawn entirely and
    // surfaces as a session error — which is the intent: a turn that cannot
    // carry its environment intact should not be a turn.
    const envFile = writeEnvFile(config.execEnvDir, fileEntries);

    const args = [
      'exec',
      '-i',
      ...(options.cwd ? ['-w', options.cwd] : []),
      ...envArgs,
      '--env-file',
      envFile,
      config.name,
      config.claudePath,
      ...options.args,
    ];

    let child;
    try {
      // `signal` is forwarded by the SDK only after its graceful stdin-EOF
      // window, so handing it straight to spawn() is safe — the child gets a
      // chance to exit cleanly before this force-kills the exec.
      child = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      unlinkQuietly(envFile);
      throw error;
    }

    // Unlinked on exit rather than immediately after spawn: `docker` reads the
    // file itself, some milliseconds after this returns, and deleting it first
    // is a race that would show up as an occasional turn starting with no
    // credentials at all. Both events, because a failed spawn emits `error`
    // and never `exit`; unlink is idempotent enough for the overlap.
    child.once('exit', () => unlinkQuietly(envFile));
    child.once('error', () => unlinkQuietly(envFile));

    return child as unknown as SpawnedProcess;
  };
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never landed. The startup sweep is the backstop.
  }
}
