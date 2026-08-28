import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parse } from 'yaml';

/** One crew: where its transcripts, board and workspaces live on this host. */
export type AgentRoot = {
  /** URL-safe id, also the SSE scope. */
  id: string;
  label: string;
  /** The instance's `projects/` directory, where Claude Code writes transcripts. */
  projectsRoot: string;
  /** The crew's board (its CLAWCIUS_DB_PATH), or null when the crew has none. */
  boardDb: string | null;
  /** `<workspacesRoot>/<workspace>/<bot>/run/health.json` is a bot's health file. */
  workspacesRoot: string | null;
};

export type ReadConfig = {
  /** Lane entries returned per page, and the ceiling a request may ask for. */
  pageSize: number;
  /** Bytes one page may read off disk before it is cut short. */
  maxPageBytes: number;
  /** Characters kept per content block. */
  maxBlockChars: number;
  /** Transcript indexes held in memory before LRU eviction. */
  maxCachedSessions: number;
};

export type StreamConfig = {
  heartbeatSeconds: number;
  /** Seconds between `tick` frames; a client refetches on each. 0 disables. */
  tickSeconds: number;
};

export type StatusConfig = {
  server: { host: string; port: number };
  agents: AgentRoot[];
  read: ReadConfig;
  stream: StreamConfig;
};

const DEFAULTS: StatusConfig = {
  server: { host: '127.0.0.1', port: 8477 },
  agents: [
    {
      id: 'clawcius',
      label: 'Clawcius',
      projectsRoot: '/var/lib/clawcius/agent-home/projects',
      boardDb: '/var/lib/clawcius/clawcius.db',
      workspacesRoot: '/var/lib/clawcius/workspaces',
    },
    {
      id: 'hamachi',
      label: 'Hamachi',
      projectsRoot: '/var/lib/hamachi/agent-home/projects',
      boardDb: '/var/lib/hamachi/hamachi.db',
      workspacesRoot: '/var/lib/hamachi/workspaces',
    },
  ],
  read: { pageSize: 100, maxPageBytes: 2_000_000, maxBlockChars: 20_000, maxCachedSessions: 256 },
  stream: { heartbeatSeconds: 15, tickSeconds: 10 },
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

/** An absolute path, resolved, or null when the key is absent. */
function absolutePath(raw: unknown, path: string): string | null {
  const value = str(raw, path, '');
  if (!value) return null;
  if (!isAbsolute(value)) throw new ConfigError(path, 'must be an absolute path');
  return resolve(value);
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function agents(raw: unknown): AgentRoot[] {
  if (raw === undefined || raw === null) return DEFAULTS.agents;
  if (!Array.isArray(raw)) throw new ConfigError('agents', 'must be a list');
  if (raw.length === 0) throw new ConfigError('agents', 'must name at least one crew');

  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const path = `agents[${index}]`;
    if (!isRecord(entry)) throw new ConfigError(path, 'must be a mapping');

    const id = str(entry['id'], `${path}.id`, '');
    if (!AGENT_ID_PATTERN.test(id)) {
      throw new ConfigError(`${path}.id`, 'must be lowercase alphanumeric with . _ - (it appears in URLs)');
    }
    if (seen.has(id)) throw new ConfigError(`${path}.id`, `duplicates an earlier agent id "${id}"`);
    seen.add(id);

    const projectsRoot = absolutePath(entry['projectsRoot'], `${path}.projectsRoot`);
    if (!projectsRoot) throw new ConfigError(`${path}.projectsRoot`, 'is required');

    return {
      id,
      label: str(entry['label'], `${path}.label`, id),
      projectsRoot,
      boardDb: absolutePath(entry['boardDb'], `${path}.boardDb`),
      workspacesRoot: absolutePath(entry['workspacesRoot'], `${path}.workspacesRoot`),
    };
  });
}

export function loadStatusConfig(configPath?: string): StatusConfig {
  const path = resolve(configPath ?? process.env['STATUS_CONFIG_PATH'] ?? 'status-config.yaml');

  if (!existsSync(path)) {
    throw new Error(`Status config not found at ${path}; set STATUS_CONFIG_PATH.`);
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : error}`);
  }

  const root = section(parsed, 'root');
  const server = section(root['server'], 'server');
  const read = section(root['read'], 'read');
  const stream = section(root['stream'], 'stream');

  const config: StatusConfig = {
    server: {
      host: str(server['host'], 'server.host', DEFAULTS.server.host),
      port: num(server['port'], 'server.port', DEFAULTS.server.port, 1, 65535),
    },
    agents: agents(root['agents']),
    read: {
      pageSize: num(read['pageSize'], 'read.pageSize', DEFAULTS.read.pageSize, 1, 500),
      maxPageBytes: num(read['maxPageBytes'], 'read.maxPageBytes', DEFAULTS.read.maxPageBytes, 64_000),
      maxBlockChars: num(read['maxBlockChars'], 'read.maxBlockChars', DEFAULTS.read.maxBlockChars, 200),
      maxCachedSessions: num(
        read['maxCachedSessions'],
        'read.maxCachedSessions',
        DEFAULTS.read.maxCachedSessions,
        1,
      ),
    },
    stream: {
      heartbeatSeconds: num(
        stream['heartbeatSeconds'],
        'stream.heartbeatSeconds',
        DEFAULTS.stream.heartbeatSeconds,
        1,
      ),
      tickSeconds: num(stream['tickSeconds'], 'stream.tickSeconds', DEFAULTS.stream.tickSeconds, 0),
    },
  };

  if (!isLoopback(config.server.host)) {
    throw new Error(
      `status-config.yaml: server.host must be a loopback address, got "${config.server.host}"; ` +
        'tailscale serve fronts this service and anything else would expose transcripts.',
    );
  }

  return config;
}

/** `localhost`, `::1`, or anything in 127.0.0.0/8. */
export function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
