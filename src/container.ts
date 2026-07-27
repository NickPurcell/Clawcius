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
 */

import { spawn, execFileSync } from 'node:child_process';
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

export type ContainerConfig = {
  name: string;
  /** In-container path to the claude binary. */
  claudePath: string;
};

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
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined || HOST_ONLY.has(key)) continue;
      envArgs.push('-e', `${key}=${value}`);
    }

    const args = [
      'exec',
      '-i',
      ...(options.cwd ? ['-w', options.cwd] : []),
      ...envArgs,
      config.name,
      config.claudePath,
      ...options.args,
    ];

    // `signal` is forwarded by the SDK only after its graceful stdin-EOF window,
    // so handing it straight to spawn() is safe — the child gets a chance to
    // exit cleanly before this force-kills the exec.
    return spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.signal ? { signal: options.signal } : {}),
    }) as unknown as SpawnedProcess;
  };
}
