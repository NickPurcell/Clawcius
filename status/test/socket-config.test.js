import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadStatusConfig } from '../dist/config.js';

function configFile(yaml) {
  const path = join(mkdtempSync(join(tmpdir(), 'status-sockcfg-')), 'status-config.yaml');
  writeFileSync(path, yaml);
  return path;
}

const BASE = `
server:
  host: 127.0.0.1
  port: 8477
agents:
`;

test('socketPath is read per agent and resolved', () => {
  const config = loadStatusConfig(
    configFile(
      BASE +
        `  - id: clawcius
    projectsRoot: /var/lib/clawcius/agent-home/projects
    socketPath: /var/lib/clawcius/run/status.sock
  - id: hamachi
    projectsRoot: /var/lib/hamachi/agent-home/projects
    socketPath: /var/lib/hamachi/run/status.sock
`,
    ),
  );

  assert.equal(config.agents[0].socketPath, '/var/lib/clawcius/run/status.sock');
  assert.equal(config.agents[1].socketPath, '/var/lib/hamachi/run/status.sock');
});

test('an agent without socketPath gets none, which is what shipped before', () => {
  const config = loadStatusConfig(
    configFile(
      BASE +
        `  - id: oj
    projectsRoot: /var/lib/oj/agent-home/projects
`,
    ),
  );

  assert.equal(config.agents[0].socketPath, null);
});

test('a relative socketPath fails the boot, naming the key', () => {
  // Under ProtectSystem=strict a relative path resolves against a read-only
  // working directory, so the alternative to this error is an EROFS at listen
  // time that says nothing about which line is wrong.
  assert.throws(
    () =>
      loadStatusConfig(
        configFile(
          BASE +
            `  - id: clawcius
    projectsRoot: /var/lib/clawcius/agent-home/projects
    socketPath: run/status.sock
`,
        ),
      ),
    /agents\[0\]\.socketPath must be an absolute path/,
  );
});

test('two instances cannot share one socket path', () => {
  // Otherwise the second is skipped as "in use by a live server", the page
  // comes up looking fine, and one crew's container reaches a socket that is
  // not in a directory it has mounted.
  assert.throws(
    () =>
      loadStatusConfig(
        configFile(
          BASE +
            `  - id: clawcius
    projectsRoot: /var/lib/clawcius/agent-home/projects
    socketPath: /var/lib/shared/status.sock
  - id: hamachi
    projectsRoot: /var/lib/hamachi/agent-home/projects
    socketPath: /var/lib/shared/status.sock
`,
        ),
      ),
    /duplicates agent "clawcius"/,
  );
});

test('the deployed status-config.yaml gives every instance its own socket', () => {
  const config = loadStatusConfig(new URL('../status-config.yaml', import.meta.url).pathname);
  const paths = config.agents.map((agent) => agent.socketPath).filter((path) => path !== null);

  assert.ok(paths.length >= 2, 'both instances have a socket configured');
  assert.equal(new Set(paths).size, paths.length, 'and no two share one');
  for (const agent of config.agents) {
    if (agent.socketPath === null) continue;
    // The socket has to be inside that instance's own state directory, since
    // that is the only part of the host filesystem its container can see.
    assert.ok(
      agent.socketPath.startsWith(`/var/lib/${agent.id}/run/`),
      `${agent.id}'s socket must live in its own run directory, got ${agent.socketPath}`,
    );
  }
});

test('every configured socket directory has a ReadWritePaths= line in the unit', () => {
  const config = loadStatusConfig(new URL('../status-config.yaml', import.meta.url).pathname);
  const unit = readFileSync(new URL('../../systemd/clawcius-status.service', import.meta.url).pathname, 'utf8');

  const writable = unit
    .split('\n')
    .filter((line) => line.startsWith('ReadWritePaths='))
    .map((line) => line.slice('ReadWritePaths='.length).trim())
    // The `-` prefix means "tolerate absence", which these need: the run
    // directories are created by docker/run-container.sh, a different
    // component running at a different time.
    .map((path) => (path.startsWith('-') ? path.slice(1) : path));

  for (const agent of config.agents) {
    if (agent.socketPath === null) continue;
    assert.ok(
      writable.includes(dirname(agent.socketPath)),
      `clawcius-status.service needs "ReadWritePaths=-${dirname(agent.socketPath)}" for ` +
        `agent "${agent.id}", or its socket cannot be created under ProtectSystem=strict`,
    );
  }
});

test('the run directories are declared tolerant of not existing', () => {
  // systemd.exec(5): a ReadWritePaths= path that does not exist fails the namespace setup and the unit never starts.
  const unit = readFileSync(new URL('../../systemd/clawcius-status.service', import.meta.url).pathname, 'utf8');

  for (const line of unit.split('\n')) {
    if (!line.startsWith('ReadWritePaths=')) continue;
    const value = line.slice('ReadWritePaths='.length).trim();
    assert.ok(
      value.startsWith('-'),
      `${line} needs a "-" prefix, or a host without that directory never starts this unit`,
    );
  }
});
