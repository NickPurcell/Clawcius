/**
 * Status page configuration, loaded from `status-config.yaml`.
 *
 * Same split as the waker: everything describing *what this service watches*
 * is version-controllable YAML, and there are no secrets here at all — this
 * process reads files and serves HTML, it authenticates to nothing.
 *
 * The validation is deliberately noisy. A status page whose roots are wrong
 * does not crash: it renders an empty, cheerful "no agents" and looks exactly
 * like a healthy host with nothing running. That is the worst possible failure
 * for an observability tool, so anything structurally wrong fails the boot
 * with the offending key named, and anything merely *absent on disk* is
 * reported in the UI as a broken root rather than silently skipped.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parse } from 'yaml';

/**
 * One agent instance to watch.
 *
 * `projectsRoot` is the `projects/` directory inside that instance's
 * CLAUDE_CONFIG_DIR. On this deployment the containers are started by
 * `docker/run-container.sh`, which mounts `$CLAWCIUS_STATE_DIR/agent-home` at
 * `/home/agent/.claude-agent` and sets CLAUDE_CONFIG_DIR to that path — so the
 * host-side transcripts for instance `X` are at
 * `/var/lib/X/agent-home/projects`. The defaults below encode exactly that,
 * but nothing here assumes it: a root is just a directory of
 * `<slugified-cwd>/<sessionId>.jsonl`.
 */
export type AgentRoot = {
  /** Stable, URL-safe id. Used in links and in the SSE payloads. */
  id: string;
  /** Human name for the header. */
  label: string;
  /** Absolute path to the instance's `projects/` directory. */
  projectsRoot: string;
};

export type LivenessConfig = {
  /**
   * Newest transcript write within this many seconds ⇒ "running".
   *
   * Tuned to how Claude Code actually writes: a line lands per message, and a
   * long tool call (a build, a clone, an npm install) can go minutes without
   * one. Too tight and every agent doing real work flickers to "idle".
   */
  runningSeconds: number;
  /**
   * Beyond `runningSeconds` but within this ⇒ "idle" — plausibly just waiting
   * for someone to speak to it. Beyond it ⇒ "stale", which is the interesting
   * state: a wedged agent and an agent nobody has messaged for a day look
   * identical from the outside, and this is the line between them.
   */
  idleSeconds: number;
};

export type OjConfig = {
  /**
   * Root of Osmosis Jones's per-PR worker directories,
   * `<workersRoot>/<owner>__<repo>__<pr>`.
   *
   * OJ is not running yet. Everything about this section is written to be
   * absent-tolerant: a missing root is reported as "no OJ data yet", not as an
   * error, because that is the true state of the world today and will be again
   * every time OJ is stopped.
   */
  workersRoot: string;
  /** Optional JSON state file. Missing is normal; malformed is reported. */
  stateFile: string;
};

export type ServerConfig = {
  /**
   * Loopback only. See the bind check in `index.ts` — this is not a
   * preference, and a non-loopback value is rejected at startup.
   */
  host: string;
  port: number;
};

export type ReadConfig = {
  /** Transcript lines returned per page by the transcript endpoint. */
  pageSize: number;
  /**
   * Hard ceiling on the bytes one page request may read off disk.
   *
   * A single JSONL line can be enormous — a tool result holding a whole file,
   * a base64 image. Paging by line count alone therefore does not bound the
   * response, so the reader stops early once it has read this much and reports
   * a short page.
   */
  maxPageBytes: number;
  /**
   * Characters of message text kept per content block before truncation.
   * The UI is a transcript reader, not an archive; the JSONL on disk is the
   * archive.
   */
  maxBlockChars: number;
  /**
   * How many indexed sessions to hold in memory at once.
   *
   * Indexes are small next to the transcripts they describe (offsets and
   * per-line metadata, never message bodies), but a host with a year of
   * sessions would still accumulate. Least-recently-used beyond this is
   * dropped and rebuilt on demand.
   */
  maxCachedSessions: number;
};

export type StatusConfig = {
  server: ServerConfig;
  agents: AgentRoot[];
  liveness: LivenessConfig;
  oj: OjConfig;
  read: ReadConfig;
  watch: {
    /**
     * Coalescing window for filesystem events.
     *
     * An agent turn writes several lines in quick succession and each one is
     * an inotify event; without this the SSE stream becomes a firehose that
     * costs more to render than the data is worth.
     */
    debounceMs: number;
    /**
     * Seconds between SSE heartbeat comments.
     *
     * Without a heartbeat a dead stream is indistinguishable from a quiet one
     * — the page would sit there looking live while showing hours-old data.
     * The client marks the connection dead if it misses two of these, so this
     * value is also the resolution of "is this page still telling the truth".
     */
    heartbeatSeconds: number;
    /**
     * Rescan interval, seconds. 0 disables.
     *
     * Called a fallback everywhere else in this codebase, but on THIS
     * deployment it is very likely the primary mechanism, and the default is
     * set accordingly.
     *
     * The reason is in SETUP.md § 6b: the waker watches a bind-mounted
     * directory written from inside the gVisor container, and found that
     * "gVisor's gofer does not reliably deliver inotify for writes made inside
     * the sandbox" — which is why it carries a 5s sweep alongside its
     * `fs.watch`. This service is in exactly that topology. The agents write
     * their transcripts inside the sandbox to `/home/agent/.claude-agent`; we
     * watch the host side of that same mount at
     * `/var/lib/<instance>/agent-home`. Assuming inotify works here, when the
     * one other component on this host that tried it documented that it does
     * not, would be choosing to be wrong.
     *
     * fs.watch is still set up, because when it does fire the update is
     * instant and free. It is simply not trusted alone — and it has its own
     * independent failure modes regardless of gVisor: recursive watching is
     * emulated on some platforms, inotify watches are a finite per-user
     * resource (`fs.inotify.max_user_watches`) that fails silently when
     * exhausted, and a directory created after the watch was established may
     * never be reported.
     */
    rescanSeconds: number;
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
    },
    {
      id: 'hamachi',
      label: 'Hamachi',
      projectsRoot: '/var/lib/hamachi/agent-home/projects',
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
    maxCachedSessions: 64,
  },
  watch: {
    debounceMs: 400,
    heartbeatSeconds: 15,
    // 10s, not 60s: see the comment on this field. The waker uses 5s for the
    // same reason; a status page can afford to be half as eager.
    rescanSeconds: 10,
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

/**
 * Agent ids appear in URLs and are used to select a configured root. They are
 * therefore held to the same shape the request validator enforces — if the two
 * ever disagree, a legally-configured agent becomes permanently unreachable
 * with a 400 and no obvious cause. Fail at boot instead.
 */
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
      // Relative roots would resolve against the service's working directory,
      // which under systemd is not the one you had in mind when you wrote it.
      throw new ConfigError(`${path}.projectsRoot`, 'must be an absolute path');
    }

    return {
      id,
      label: str(entry['label'], `${path}.label`, id),
      // resolve() also normalises away any `..` in the configured value, so
      // the traversal guard in transcripts.ts compares against a canonical
      // prefix rather than something like `/var/lib/x/../..`.
      projectsRoot: resolve(projectsRoot),
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
    },
  };

  if (config.liveness.idleSeconds <= config.liveness.runningSeconds) {
    throw new Error(
      'status-config.yaml: liveness.idleSeconds must be > liveness.runningSeconds — ' +
        'otherwise the "idle" band is empty and every agent jumps straight from ' +
        'running to stale, which is precisely the alarm this page exists to make meaningful.',
    );
  }

  // The bind address is a security property, not a tuning knob, so it is
  // checked here as well as at listen time. `tailscale serve` proxies from
  // localhost; binding anywhere else publishes every transcript on this host
  // to whatever interface you named, and the page has no authentication of its
  // own because it is not supposed to need any.
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

/**
 * Loopback check.
 *
 * Deliberately an allowlist of the forms that are actually loopback rather
 * than a denylist of `0.0.0.0`: `::`, an empty string and a bare `*` all bind
 * every interface too, and a denylist would have to enumerate them correctly
 * forever.
 */
export function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  // 127.0.0.0/8 in full — 127.0.0.1 is the conventional one but the whole /8
  // is loopback, and someone separating services onto 127.0.0.2 is doing
  // something reasonable.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
