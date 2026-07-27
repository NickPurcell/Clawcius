/**
 * Startup checks for things that fail silently at runtime.
 *
 * The sandbox is the motivating case. On Linux the SDK sandbox needs `bwrap`
 * and `socat` on PATH. When they are missing it does not raise — it simply
 * does not apply, and because `autoAllowBashIfSandboxed` only auto-allows when
 * the sandbox is genuinely active, every bash call then blocks on a permission
 * prompt that nothing is there to answer. The agent runs, replies to nothing,
 * and never invokes the discord CLI.
 *
 * That failure surfaces in Discord as a bot that acknowledges mentions and
 * never speaks, which is a long way from its cause. Better to refuse to start.
 *
 * Squid mode adds two more failures with the same signature — an agent that
 * wakes and cannot speak — and both are checked here:
 *
 *   1. Squid is not listening. The sandbox has no route except the bridge, and
 *      the bridge leads to a closed port, so the agent has *zero* egress. It
 *      cannot reach discord.com and therefore cannot reply. Verified on this
 *      VM: with Squid stopped, even an allowlisted domain fails.
 *   2. squid.conf and `sandbox.allowedDomains` disagree. The two lists are
 *      enforced by different proxies — Squid on HTTP/HTTPS, the SDK's own on
 *      SOCKS — so drift between them is a genuine hole in whichever direction
 *      it runs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
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

/** Resolves true if something accepts a TCP connection on the port. */
function portOpen(port: number, host = '127.0.0.1', timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const finish = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * The domains squid.conf actually allows.
 *
 * Squid permits several domains on one `acl` line, so every token after
 * `dstdomain` counts. Comments are stripped first so a commented-out entry is
 * not read as live.
 */
function parseSquidAllowlist(confText: string): string[] {
  const domains: string[] = [];
  for (const rawLine of confText.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    const match = /^acl\s+clawcius_allowed\s+dstdomain\s+(.+)$/.exec(line);
    if (!match?.[1]) continue;
    for (const token of match[1].split(/\s+/)) {
      if (token) domains.push(token);
    }
  }
  return domains;
}

function checkSquidEgress(problems: string[]): Promise<void> {
  const { egress, allowedDomains } = config.agent.sandbox;
  const { confPath, httpProxyPort } = egress;

  if (!existsSync(confPath)) {
    problems.push(
      `sandbox.egress.mode is "squid" but no config exists at ${confPath}.\n` +
        `    Preflight compares that file's allowlist against sandbox.allowedDomains\n` +
        `    and cannot verify the two agree without it.\n` +
        `    Fix:  point sandbox.egress.confPath at the squid.conf you installed.`,
    );
  } else {
    const declared = parseSquidAllowlist(readFileSync(confPath, 'utf8'));
    const inSquid = new Set(declared);
    const inYaml = new Set(allowedDomains);
    const missingFromSquid = [...inYaml].filter((d) => !inSquid.has(d));
    const missingFromYaml = [...inSquid].filter((d) => !inYaml.has(d));

    if (declared.length === 0) {
      problems.push(
        `${confPath} contains no "acl clawcius_allowed dstdomain ..." lines.\n` +
          `    Either it is not the Clawcius config, or the allowlist block was renamed.\n` +
          `    A Squid that allows nothing leaves the agent unable to reach discord.com.`,
      );
    } else if (missingFromSquid.length > 0 || missingFromYaml.length > 0) {
      problems.push(
        `the egress allowlists disagree.\n` +
          (missingFromSquid.length > 0
            ? `    In agent-config.yaml but NOT in squid.conf: ${missingFromSquid.join(', ')}\n` +
              `      -> Squid will deny these; the SDK's SOCKS proxy will allow them.\n`
            : '') +
          (missingFromYaml.length > 0
            ? `    In squid.conf but NOT in agent-config.yaml: ${missingFromYaml.join(', ')}\n` +
              `      -> reachable through Squid, which the YAML claims is blocked.\n`
            : '') +
          `    Both files must list exactly the same domains.\n` +
          `    Edit ${confPath} (allowlist block) to match sandbox.allowedDomains,\n` +
          `    then:  sudo squid -k reconfigure`,
      );
    }
  }

  return portOpen(httpProxyPort).then((open) => {
    if (open) return;
    problems.push(
      `sandbox.egress.mode is "squid" but nothing is listening on 127.0.0.1:${httpProxyPort}.\n` +
        `    The sandbox gives the agent no route except the bridge to this port, so a\n` +
        `    dead proxy means the agent has NO egress at all — including discord.com.\n` +
        `    It would wake on a mention and never be able to reply.\n` +
        `    Check:  systemctl status squid  &&  ss -ltnp | grep ${httpProxyPort}\n` +
        `    Fix:    sudo systemctl enable --now squid\n` +
        `    Or:     set sandbox.egress.mode: sdk in agent-config.yaml.`,
    );
  });
}

export async function preflight(): Promise<void> {
  const problems: string[] = [];

  if (config.agent.runtime === 'container') {
    const name = config.agent.container.name;
    if (!onPath('docker')) {
      problems.push(
        'runtime is "container" but docker is not on PATH.\n' +
          '    Fix:  install docker, or set runtime: host in agent-config.yaml.',
      );
    } else if (!containerRunning(name)) {
      problems.push(
        `runtime is "container" but container "${name}" is ${containerStatus(name)}.\n` +
          '    Every agent turn spawns `docker exec` into it, so nothing can run.\n' +
          '    Fix:  docker/run-container.sh\n' +
          '    Check: docker ps -a --filter name=' + name,
      );
    }
  }

  if (config.agent.sandbox.enabled) {
    const missing = ['bwrap', 'socat'].filter((binary) => !onPath(binary));
    if (missing.length > 0) {
      problems.push(
        `sandbox.enabled is true but ${missing.join(' and ')} ` +
          `${missing.length === 1 ? 'is' : 'are'} not on PATH.\n` +
          `    The SDK sandbox needs both on Linux. Without them it silently does not\n` +
          `    apply, bash calls block on permission prompts, and the agent can never\n` +
          `    reach the discord CLI to reply.\n` +
          `    Fix:  sudo apt-get install -y ${missing.join(' ')}\n` +
          `    Or:   set sandbox.enabled: false in agent-config.yaml — but read\n` +
          `          SETUP.md § Egress first, because that leaves egress uncontrolled.`,
      );
    }

    if (config.agent.sandbox.egress.mode === 'squid') {
      await checkSquidEgress(problems);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Preflight failed:\n\n  - ${problems.join('\n\n  - ')}\n`);
  }
}
