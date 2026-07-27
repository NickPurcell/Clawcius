/**
 * Startup checks for things that fail silently at runtime.
 *
 * Every check here guards the same signature: an agent that wakes, works, and
 * never speaks. That reads in Discord as a bot ignoring you, which is a long
 * way from its cause — so it is worth refusing to start instead.
 *
 * Three ways to get there:
 *
 *   1. The agent container is not running. Every turn is a `docker exec` into
 *      it, so nothing runs at all.
 *   2. Squid is not running. The agent sits on an `--internal` network whose
 *      only route out is the proxy, so a dead proxy means *zero* egress —
 *      including discord.com. Verified on this VM: with Squid stopped, even an
 *      allowlisted domain fails.
 *   3. The allowlist on disk is not the one in the image. `squid/squid.conf`
 *      is the source; `docker/squid.conf` is the build-context copy baked into
 *      `clawcius-squid`. Editing the source without rebuilding leaves a
 *      running proxy enforcing the *old* list, and the file you are reading
 *      says otherwise.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { config } from './config.js';
import { containerRunning, containerStatus } from './container.js';

function onPath(binary: string): boolean {
  try {
    execFileSync('which', [binary], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Warn when the allowlist source and the build-context copy have drifted.
 *
 * Not fatal: the running proxy is still enforcing *something*, and a stale
 * copy is a much smaller problem than refusing to start. But silently
 * enforcing an allowlist nobody is looking at is how a domain you think you
 * added stays blocked.
 */
function checkSquidConfSync(): void {
  const source = 'squid/squid.conf';
  const buildCopy = 'docker/squid.conf';
  if (!existsSync(source) || !existsSync(buildCopy)) return;

  if (readFileSync(source, 'utf8') !== readFileSync(buildCopy, 'utf8')) {
    process.stderr.write(
      `[preflight] ${source} differs from ${buildCopy}.\n` +
        `[preflight]   The running proxy enforces the copy baked into the image, not the source.\n` +
        `[preflight]   Fix:  cp ${source} ${buildCopy} && docker/up.sh --rebuild\n`,
    );
  }
}

export async function preflight(): Promise<void> {
  const problems: string[] = [];
  const name = config.agent.container.name;
  const proxy = 'clawcius-squid';

  if (!onPath('docker')) {
    problems.push(
      'docker is not on PATH, but the agent runs inside a container.\n' +
        '    Every turn spawns `docker exec`, so no turn can run.\n' +
        '    Fix:  install docker and add this user to the docker group.',
    );
  } else if (!containerRunning(name)) {
    problems.push(
      `the agent container "${name}" is ${containerStatus(name)}.\n` +
        '    Every agent turn spawns `docker exec` into it, so nothing can run.\n' +
        '    Fix:  docker/up.sh\n' +
        `    Check: docker ps -a --filter name=${name}`,
    );
  } else if (!containerRunning(proxy)) {
    problems.push(
      `the egress proxy "${proxy}" is ${containerStatus(proxy)}.\n` +
        '    The agent network has no route out except through it, so the agent\n' +
        '    would wake and be unable to reach Discord at all.\n' +
        '    Fix:  docker/up.sh',
    );
  }

  if (problems.length > 0) {
    throw new Error(`Preflight failed:\n\n  - ${problems.join('\n\n  - ')}\n`);
  }

  checkSquidConfSync();
}
