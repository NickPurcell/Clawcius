import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

/** Host-specific variables that must not leak into the container. */
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

const CMDLINE_VISIBLE = new Set([
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]);

/** Prefix for the per-exec env files, so the startup sweep can recognise its own litter and nothing else in the directory. */
const ENV_FILE_PREFIX = 'exec-env-';

export type ContainerConfig = {
  name: string;
  /** In-container path to the claude binary. */
  claudePath: string;
  /** Directory for the per-exec `--env-file`. */
  execEnvDir: string;
};

class EnvFileError extends Error {}

/** Docker `--env-file` format: one unquoted `KEY=VALUE` per line. Throws on a value containing a newline, which the format cannot express. */
function renderEnvFile(entries: ReadonlyArray<readonly [string, string]>): string {
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
    body += `${key}=${value}\n`;
  }
  return body;
}

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

/** Delete env files left behind by a previous run. Returns how many. */
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

/** Build the `spawnClaudeCodeProcess` implementation. */
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

    // Written before the argv is built, because the path has to go in it.
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

    // Unlinked on exit rather than right after spawn: `docker` reads the file itself, some milliseconds after this returns.
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
