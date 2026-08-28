import { execFileSync } from 'node:child_process';
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



export async function preflight(): Promise<void> {
  const problems: string[] = [];
  const name = config().agent.container.name;
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
}
