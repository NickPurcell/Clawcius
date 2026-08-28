import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parse } from 'yaml';

/** One agent instance to watch. */
export type AgentRoot = {
  /** Stable, URL-safe id. Used in links and in the SSE payloads. */
  id: string;
  /** Human name for the header. */
  label: string;
  /** Absolute path to the instance's `projects/` directory. */
  projectsRoot: string;
  boardDb: string | null;
  socketPath: string | null;
};

export type LivenessConfig = {
  /** Newest transcript write within this many seconds ⇒ "running". */
  runningSeconds: number;
  /** Beyond `runningSeconds` but within this ⇒ "idle" — plausibly just waiting for someone to speak to it. */
  idleSeconds: number;
};

export type OjConfig = {
  workersRoot: string;
  /** Optional JSON state file. Missing is normal; malformed is reported. */
  stateFile: string;
};

export type ServerConfig = {
  /** Loopback only. */
  host: string;
  port: number;
};

export type ReadConfig = {
  /** Transcript lines returned per page by the transcript endpoint. */
  pageSize: number;
  /** Hard ceiling on the bytes one page request may read off disk. */
  maxPageBytes: number;
  /** Characters of message text kept per content block before truncation. */
  maxBlockChars: number;
  maxCachedSessions: number;
};

export type StatusConfig = {
  server: ServerConfig;
  agents: AgentRoot[];
  liveness: LivenessConfig;
  oj: OjConfig;
  read: ReadConfig;
  watch: {
    debounceMs: number;
    heartbeatSeconds: number;
    rescanSeconds: number;
    boardPollSeconds: number;
  };
};

const DEFAULTS: StatusConfig = {
  server: {
    host: '127.0.0.1',
    port: 8477,
  },
  agents: [
    {
      id: 'clawcius',
      label: 'Clawcius',
      projectsRoot: '/var/lib/clawcius/agent-home/projects',
      boardDb: '/var/lib/clawcius/clawcius.db',
      // The host side of `-v "$STATE_RUN:$STATE_RUN:rw"` in
      // docker/run-container.sh, so the container sees this at the same path.
      socketPath: '/var/lib/clawcius/run/status.sock',
    },
    {
      id: 'hamachi',
      label: 'Hamachi',
      projectsRoot: '/var/lib/hamachi/agent-home/projects',
      // `CLAWCIUS_DB_PATH` in .env.hamachi: named for the instance, not the variable.
      boardDb: '/var/lib/hamachi/hamachi.db',
      socketPath: '/var/lib/hamachi/run/status.sock',
    },
  ],
  liveness: {
    runningSeconds: 180,
    idleSeconds: 3600,
  },
  oj: {
    workersRoot: '/var/lib/oj/workers',
    stateFile: '/var/lib/oj/state.json',
  },
  read: {
    pageSize: 60,
    maxPageBytes: 2_000_000,
    maxBlockChars: 20_000,
    // Below the transcript count of one session this degrades sharply, not gradually.
    maxCachedSessions: 256,
  },
  watch: {
    debounceMs: 400,
    heartbeatSeconds: 15,
    rescanSeconds: 10,
    // Same cadence as the rescan. The query is four integers.
    boardPollSeconds: 10,
  },
};

class ConfigError extends Error {
  constructor(path: string, message: string) {
    super(`status-config.yaml: ${path} ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(raw: unknown, path: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new ConfigError(path, 'must be a string');
  return raw;
}

function num(raw: unknown, path: string, fallback: number, min: number, max?: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ConfigError(path, 'must be a number');
  }
  if (raw < min) throw new ConfigError(path, `must be >= ${min}`);
  if (max !== undefined && raw > max) throw new ConfigError(path, `must be <= ${max}`);
  return raw;
}

function section(raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ConfigError(path, 'must be a mapping');
  return raw;
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function agents(raw: unknown): AgentRoot[] {
  if (raw === undefined || raw === null) return DEFAULTS.agents;
  if (!Array.isArray(raw)) throw new ConfigError('agents', 'must be a list');
  if (raw.length === 0) {
    throw new ConfigError(
      'agents',
      'must name at least one agent — an empty list renders an empty page that ' +
        'is indistinguishable from a host with nothing running',
    );
  }

  const seen = new Set<string>();
  const seenSockets = new Map<string, string>();
  return raw.map((entry, index) => {
    const path = `agents[${index}]`;
    if (!isRecord(entry)) throw new ConfigError(path, 'must be a mapping');

    const id = str(entry['id'], `${path}.id`, '');
    if (!AGENT_ID_PATTERN.test(id)) {
      throw new ConfigError(
        `${path}.id`,
        'must be lowercase alphanumeric with . _ - (it appears in URLs)',
      );
    }
    if (seen.has(id)) throw new ConfigError(`${path}.id`, `duplicates an earlier agent id "${id}"`);
    seen.add(id);

    const projectsRoot = str(entry['projectsRoot'], `${path}.projectsRoot`, '');
    if (!projectsRoot) throw new ConfigError(`${path}.projectsRoot`, 'is required');
    if (!isAbsolute(projectsRoot)) {
      // A relative root would resolve against the service's working directory.
      throw new ConfigError(`${path}.projectsRoot`, 'must be an absolute path');
    }

    const boardDb = str(entry['boardDb'], `${path}.boardDb`, '');
    if (boardDb && !isAbsolute(boardDb)) {
      throw new ConfigError(`${path}.boardDb`, 'must be an absolute path');
    }

    // Absolute, and unique per instance: a container only mounts its own run directory.
    const rawSocket = str(entry['socketPath'], `${path}.socketPath`, '');
    if (rawSocket && !isAbsolute(rawSocket)) {
      throw new ConfigError(`${path}.socketPath`, 'must be an absolute path');
    }
    const socketPath = rawSocket ? resolve(rawSocket) : null;

    if (socketPath) {
      const owner = seenSockets.get(socketPath);
      if (owner !== undefined) {
        throw new ConfigError(
          `${path}.socketPath`,
          `duplicates agent "${owner}" — each instance needs its own socket, in its ` +
            'own run directory, because a container only mounts its own',
        );
      }
      seenSockets.set(socketPath, id);
    }

    return {
      id,
      label: str(entry['label'], `${path}.label`, id),
      // resolve() normalises `..` away, so the traversal guard in transcripts.ts compares against a canonical prefix.
      projectsRoot: resolve(projectsRoot),
      boardDb: boardDb ? resolve(boardDb) : null,
      socketPath,
    };
  });
}

export function loadStatusConfig(configPath?: string): StatusConfig {
  const path = resolve(configPath ?? process.env['STATUS_CONFIG_PATH'] ?? 'status-config.yaml');

  if (!existsSync(path)) {
    throw new Error(
      `Status config not found at ${path}. ` +
        'Expected status-config.yaml in the working directory, or set STATUS_CONFIG_PATH.',
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : error}`);
  }

  const root = section(parsed, 'root');
  const server = section(root['server'], 'server');
  const liveness = section(root['liveness'], 'liveness');
  const oj = section(root['oj'], 'oj');
  const read = section(root['read'], 'read');
  const watch = section(root['watch'], 'watch');

  const config: StatusConfig = {
    server: {
      host: str(server['host'], 'server.host', DEFAULTS.server.host),
      port: num(server['port'], 'server.port', DEFAULTS.server.port, 1, 65535),
    },
    agents: agents(root['agents']),
    liveness: {
      runningSeconds: num(
        liveness['runningSeconds'],
        'liveness.runningSeconds',
        DEFAULTS.liveness.runningSeconds,
        1,
      ),
      idleSeconds: num(
        liveness['idleSeconds'],
        'liveness.idleSeconds',
        DEFAULTS.liveness.idleSeconds,
        1,
      ),
    },
    oj: {
      workersRoot: str(oj['workersRoot'], 'oj.workersRoot', DEFAULTS.oj.workersRoot),
      stateFile: str(oj['stateFile'], 'oj.stateFile', DEFAULTS.oj.stateFile),
    },
    read: {
      pageSize: num(read['pageSize'], 'read.pageSize', DEFAULTS.read.pageSize, 1, 500),
      maxPageBytes: num(
        read['maxPageBytes'],
        'read.maxPageBytes',
        DEFAULTS.read.maxPageBytes,
        64_000,
      ),
      maxBlockChars: num(
        read['maxBlockChars'],
        'read.maxBlockChars',
        DEFAULTS.read.maxBlockChars,
        200,
      ),
      maxCachedSessions: num(
        read['maxCachedSessions'],
        'read.maxCachedSessions',
        DEFAULTS.read.maxCachedSessions,
        1,
      ),
    },
    watch: {
      debounceMs: num(watch['debounceMs'], 'watch.debounceMs', DEFAULTS.watch.debounceMs, 0),
      heartbeatSeconds: num(
        watch['heartbeatSeconds'],
        'watch.heartbeatSeconds',
        DEFAULTS.watch.heartbeatSeconds,
        1,
      ),
      rescanSeconds: num(
        watch['rescanSeconds'],
        'watch.rescanSeconds',
        DEFAULTS.watch.rescanSeconds,
        0,
      ),
      boardPollSeconds: num(
        watch['boardPollSeconds'],
        'watch.boardPollSeconds',
        DEFAULTS.watch.boardPollSeconds,
        0,
      ),
    },
  };

  if (config.liveness.idleSeconds <= config.liveness.runningSeconds) {
    throw new Error(
      'status-config.yaml: liveness.idleSeconds must be > liveness.runningSeconds — ' +
        'otherwise the "idle" band is empty and every agent jumps straight from ' +
        'running to stale, which is precisely the alarm this page exists to make meaningful.',
    );
  }

  if (!isLoopback(config.server.host)) {
    throw new Error(
      `status-config.yaml: server.host must be a loopback address, got "${config.server.host}". ` +
        'This service is fronted by `tailscale serve`, which connects over loopback. ' +
        'Binding elsewhere — 0.0.0.0 above all — would expose unauthenticated transcripts ' +
        'to that interface, and would keep them exposed when Tailscale is down, which is ' +
        'exactly the failure the loopback bind is there to make impossible.',
    );
  }

  return config;
}

/** Loopback check. */
export function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  // The whole 127.0.0.0/8, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
