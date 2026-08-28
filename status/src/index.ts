// FIRST, and it must stay first.
import './build-banner.js';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_INFO } from './build-info.js';
import { isLoopback, loadStatusConfig } from './config.js';
import { readOjSnapshot } from './oj.js';
import { probeAll, processIdentity, targetsFor } from './reach.js';
import { bindUnixSockets, releaseSocketPath, type SocketOutcome } from './socket.js';
import { isValidProjectSlug, isValidSubagentId, TranscriptStore } from './transcripts.js';
import {
  buildInstanceOverview,
  buildClawsky,
  buildRoster,
  buildSessionDetail,
  buildSubagentRollup,
} from './views.js';
import { BoardWatcher, RootWatcher, type ChangeEvent } from './watch.js';

const config = loadStatusConfig();
const store = new TranscriptStore(config);

/** The paths whose readability decides whether this page can answer anything. */
const reachTargets = targetsFor(config);

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

/** Content-Security-Policy, as tight as a page with no third-party anything can be. */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // The page shows an entire host's agent activity; it has no business in
  // anyone's search index or in a browser's shared cache.
  'Cache-Control': 'no-store',
};

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extra,
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function fail(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

// ── Watching ────────────────────────────────────────────────────────────────

const watcher = new RootWatcher(
  [
    ...config.agents.map((agent) => ({ scope: agent.id, root: agent.projectsRoot })),
    { scope: 'oj', root: config.oj.workersRoot },
  ],
  config.watch.debounceMs,
  config.watch.rescanSeconds,
);
watcher.start();

const boardWatcher = new BoardWatcher(
  config.agents
    .filter((agent) => agent.boardDb !== null)
    .map((agent) => ({ scope: agent.id, dbPath: agent.boardDb as string })),
  config.watch.boardPollSeconds,
);
boardWatcher.start();

/** Open SSE clients. Held so shutdown can close them rather than drop them. */
const streams = new Set<ServerResponse>();

const publishChange = (event: ChangeEvent): void => {
  const frame = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
  for (const stream of streams) {
    // No error handling around the write on purpose: a client that has gone
    // away emits 'close', which removes it from the set. Writing to a dead
    // socket is a no-op, not a throw.
    stream.write(frame);
  }
};

watcher.subscribe(publishChange);
boardWatcher.subscribe(publishChange);

const heartbeat = setInterval(() => {
  const frame = `: heartbeat ${Date.now()}\n\nevent: heartbeat\ndata: ${JSON.stringify({
    at: Date.now(),
    watched: watcher.watchedCount,
  })}\n\n`;
  for (const stream of streams) stream.write(frame);
}, config.watch.heartbeatSeconds * 1000);
heartbeat.unref();

// ── Routing ─────────────────────────────────────────────────────────────────

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function handleApi(url: URL, response: ServerResponse): Promise<void> {
  const now = Date.now();
  const path = url.pathname;

  if (path === '/api/overview') {
    const instances = [];
    for (const agent of store.agents) {
      instances.push(await buildInstanceOverview(store, agent, config, now));
    }
    sendJson(response, 200, {
      generatedAt: new Date(now).toISOString(),
      liveness: config.liveness,
      instances,
    });
    return;
  }

  if (path === '/api/clawsky') {
    sendJson(response, 200, {
      generatedAt: new Date(now).toISOString(),
      instances: store.agents.map((agent) => buildClawsky(agent, config)),
    });
    return;
  }

  if (path === '/api/oj') {
    sendJson(response, 200, await readOjSnapshot(config.oj));
    return;
  }

  // /api/agents/<agentId>/sessions[/<sessionId>[/transcript]]
  const parts = path.split('/').filter((part) => part.length > 0);
  if (parts[0] === 'api' && parts[1] === 'agents' && typeof parts[2] === 'string') {
    const agent = store.agent(parts[2]);
    // Same 404 whether the id is malformed or simply not configured.
    if (!agent) return fail(response, 404, 'no such agent');

    if (parts[3] === 'sessions' && parts.length === 4) {
      sendJson(response, 200, await buildRoster(store, agent, config, now));
      return;
    }

    if (parts[3] === 'subagents' && parts.length === 4) {
      const slug = url.searchParams.get('slug');
      if (slug !== null && !isValidProjectSlug(slug)) {
        return fail(response, 400, 'malformed slug');
      }
      sendJson(
        response,
        200,
        await buildSubagentRollup(store, agent, config, now, { projectSlug: slug }),
      );
      return;
    }

    if (parts[3] === 'sessions' && typeof parts[4] === 'string') {
      const sessionId = parts[4];
      const session = await store.findSession(agent, sessionId);
      if (!session) return fail(response, 404, 'no such session');

      if (parts.length === 5) {
        sendJson(response, 200, await buildSessionDetail(store, session, config, now));
        return;
      }

      if (parts[5] === 'transcript' && parts.length === 6) {
        // `subagent` selects a child transcript instead of the parent's.
        const subagent = url.searchParams.get('subagent');
        let target = session.transcriptPath;

        if (subagent !== null) {
          if (!isValidSubagentId(subagent)) return fail(response, 400, 'invalid subagent id');
          const refs = await store.subagents(session);
          const ref = refs.find((candidate) => candidate.agentId === subagent);
          if (!ref) return fail(response, 404, 'no such subagent in this session');
          target = ref.path;
        }

        const from = intParam(url.searchParams.get('from'), 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = intParam(
          url.searchParams.get('limit'),
          config.read.pageSize,
          1,
          config.read.pageSize,
        );

        try {
          const page = await store.page(target, from, limit);
          sendJson(response, 200, {
            agent: agent.id,
            sessionId: session.sessionId,
            subagent,
            ...page,
          });
        } catch (error) {
          fail(
            response,
            503,
            `transcript could not be read: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        }
        return;
      }
    }
  }

  fail(response, 404, 'no such endpoint');
}

function handleEvents(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });

  // An immediate frame so the client can start its heartbeat clock without
  // waiting a full interval to find out whether the stream works at all.
  response.write(
    `event: hello\ndata: ${JSON.stringify({
      at: Date.now(),
      heartbeatSeconds: config.watch.heartbeatSeconds,
      agents: config.agents.map((agent) => agent.id),
    })}\n\n`,
  );

  streams.add(response);
  request.on('close', () => {
    streams.delete(response);
  });
}

async function handleAsset(pathname: string, response: ServerResponse): Promise<void> {
  const asset = ASSETS[pathname];
  if (!asset) return fail(response, 404, 'not found');
  try {
    const body = await readFile(join(PUBLIC_DIR, asset.file));
    send(response, 200, asset.type, body);
  } catch {
    fail(response, 500, `asset ${asset.file} is missing from the deployment`);
  }
}

let socketOutcomes: SocketOutcome[] = [];

/** `/healthz` — what this process is, and what it can currently reach. */
async function handleHealth(response: ServerResponse): Promise<void> {
  const reach = await probeAll(reachTargets);
  sendJson(response, 200, {
    ok: true,
    build: BUILD_INFO,
    uptimeSeconds: Math.round(process.uptime()),
    agents: config.agents.length,
    streams: streams.size,
    watched: watcher.watchedCount,
    unwatched: Object.fromEntries(watcher.unwatched),
    // Who the answers below are about. "not readable" is only actionable next
    // to "by whom".
    identity: processIdentity(),
    reach,
    unreachable: reach.filter((result) => !result.ok).length,
    // One entry per configured socket, listening or not, with the reason.
    sockets: socketOutcomes.map((outcome) =>
      outcome.listening
        ? // `dropped` is connections refused because the per-socket
          // maxConnections cap was already reached.
          { path: outcome.path, listening: true, dropped: outcome.dropped }
        : { path: outcome.path, listening: false, reason: outcome.reason },
    ),
  });
}

const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
  // Read-only, enforced before anything looks at the path.
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    send(response, 405, 'text/plain; charset=utf-8', 'read-only service', { Allow: 'GET, HEAD' });
    return;
  }

  // The base is a placeholder: only the path and query are used, never the host.
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    fail(response, 400, 'malformed request');
    return;
  }

  if (url.pathname === '/healthz') {
    handleHealth(response).catch((error: unknown) => {
      console.error('[status] /healthz failed:', error);
      if (!response.headersSent) fail(response, 500, 'internal error');
      else response.end();
    });
    return;
  }

  if (url.pathname === '/api/events') {
    handleEvents(request, response);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(url, response).catch((error: unknown) => {
      console.error('[status] request failed:', error);
      if (!response.headersSent) fail(response, 500, 'internal error');
      else response.end();
    });
    return;
  }

  handleAsset(url.pathname, response).catch(() => {
    if (!response.headersSent) fail(response, 500, 'internal error');
    else response.end();
  });
};

const server = createServer(handleRequest);

// Loopback is also enforced by the config loader; this is the check at the bind itself.
if (!isLoopback(config.server.host)) {
  throw new Error(
    `refusing to bind ${config.server.host}: this service is loopback-only by design`,
  );
}

server.listen(config.server.port, config.server.host, () => {
  console.log(
    `[status] listening on http://${config.server.host}:${config.server.port} ` +
      `(loopback only — expose with: tailscale serve --bg ${config.server.port})`,
  );
  console.log(`[status]   this process is ${processIdentity()}`);
  void probeAll(reachTargets).then((results) => {
    for (const result of results) {
      const line =
        `[status]   ${result.scope} ${result.what}: ${result.path} — ` +
        `${result.ok ? 'OK' : 'UNREACHABLE'}: ${result.detail}`;
      if (result.ok) console.log(line);
      else console.warn(line);
    }
    const bad = results.filter((result) => !result.ok).length;
    if (bad > 0) {
      console.warn(
        `[status]   ${bad} of ${results.length} configured path(s) UNREACHABLE — the page ` +
          'will render those sections empty, which looks exactly like a quiet host. ' +
          'Re-probed on every /healthz.',
      );
    }
  }).catch((error: unknown) => {
    console.error('[status] boot reachability report failed:', error);
  });

  for (const [scope, reason] of watcher.unwatched) {
    console.warn(`[status]   not watching ${scope}: ${reason} (falling back to rescan)`);
  }
});

// The unix sockets, after the TCP listener, so a slow probe of a stale socket cannot delay it.
const socketPaths = config.agents
  .map((agent) => agent.socketPath)
  .filter((path): path is string => path !== null);

void bindUnixSockets(socketPaths, handleRequest).then((outcomes) => {
  socketOutcomes = outcomes;
  for (const outcome of outcomes) {
    if (outcome.listening) {
      console.log(`[status]   also listening on ${outcome.path} (unix socket, not a network)`);
    } else {
      console.warn(`[status]   NOT listening on ${outcome.path}: ${outcome.reason}`);
    }
  }
}).catch((error: unknown) => {
  console.error('[status] binding unix sockets failed:', error);
  console.error('[status] the TCP listener is unaffected; no container can reach the page.');
});

function shutdown(signal: string): void {
  console.log(`[status] ${signal} — closing`);
  clearInterval(heartbeat);
  watcher.stop();
  boardWatcher.stop();
  // SSE connections are long-lived by definition, so `server.close()` alone
  // would wait forever for them. Ending them explicitly is what makes a
  // `systemctl restart` take a moment rather than a TimeoutStopSec.
  for (const stream of streams) stream.end();
  streams.clear();
  // Close the unix listeners too, and unlink what we created.
  for (const outcome of socketOutcomes) {
    if (!outcome.listening) continue;
    outcome.server.close();
    releaseSocketPath(outcome.path);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
