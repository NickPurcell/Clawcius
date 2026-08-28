// FIRST, and it must stay first.
import './build-banner.js';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_INFO } from './build-info.js';
import { isLoopback, loadStatusConfig, type AgentRoot } from './config.js';
import { readLane } from './lane-read.js';
import { readSnapshot } from './snapshot.js';
import { buildTimeline } from './timeline.js';
import { TranscriptStore } from './transcripts.js';

const config = loadStatusConfig();
const store = new TranscriptStore(config);

/** A crew's timeline is reused for this long, so the lane requests that follow one share its build. */
const TIMELINE_CACHE_MS = 3000;
const timelines = new Map<string, { at: number; built: ReturnType<typeof buildTimeline> }>();

function timelineFor(crew: AgentRoot, now: number): ReturnType<typeof buildTimeline> {
  const cached = timelines.get(crew.id);
  if (cached && now - cached.at < TIMELINE_CACHE_MS) return cached.built;
  const built = buildTimeline(store, crew, now);
  timelines.set(crew.id, { at: now, built });
  built.catch(() => timelines.delete(crew.id));
  return built;
}

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

/** No third-party anything, no inline script or style, and never cached. */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
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

// ── Streams ─────────────────────────────────────────────────────────────────

const streams = new Set<ServerResponse>();

function broadcast(event: string, payload: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const stream of streams) stream.write(frame);
}

const heartbeat = setInterval(() => broadcast('heartbeat', { at: Date.now() }), config.stream.heartbeatSeconds * 1000);
heartbeat.unref();

const tick =
  config.stream.tickSeconds > 0
    ? setInterval(() => broadcast('tick', { at: Date.now() }), config.stream.tickSeconds * 1000)
    : null;
tick?.unref();

function handleEvents(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });
  response.write(
    `event: hello\ndata: ${JSON.stringify({
      at: Date.now(),
      heartbeatSeconds: config.stream.heartbeatSeconds,
      tickSeconds: config.stream.tickSeconds,
      crews: config.agents.map((agent) => agent.id),
    })}\n\n`,
  );
  streams.add(response);
  request.on('close', () => streams.delete(response));
}

// ── Routing ─────────────────────────────────────────────────────────────────

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function handleApi(url: URL, response: ServerResponse): Promise<void> {
  const now = Date.now();
  const parts = url.pathname.split('/').filter((part) => part.length > 0);

  if (url.pathname === '/api/board') {
    sendJson(response, 200, {
      generatedAt: new Date(now).toISOString(),
      crews: config.agents.map((agent) => ({ id: agent.id, label: agent.label })),
      snapshot: await readSnapshot(now),
    });
    return;
  }

  // /api/crews/<crew>/timeline and /api/crews/<crew>/lane?row=&from=|at=&limit=
  if (parts[0] === 'api' && parts[1] === 'crews' && typeof parts[2] === 'string') {
    const crew = store.agent(parts[2]);
    if (!crew) return fail(response, 404, 'no such crew');

    if (parts[3] === 'timeline' && parts.length === 4) {
      const { timeline } = await timelineFor(crew, now);
      sendJson(response, 200, timeline);
      return;
    }

    if (parts[3] === 'lane' && parts.length === 4) {
      const rowId = url.searchParams.get('row');
      if (!rowId) return fail(response, 400, 'row is required');
      const { sources } = await timelineFor(crew, now);
      const source = sources.get(rowId);
      if (!source) return fail(response, 404, 'no such row');

      const limit = intParam(url.searchParams.get('limit'), config.read.pageSize, 1, config.read.pageSize);
      const at = url.searchParams.get('at');
      const position =
        at !== null
          ? { at: intParam(at, 0, 0, Number.MAX_SAFE_INTEGER) }
          : { from: intParam(url.searchParams.get('from'), 0, 0, Number.MAX_SAFE_INTEGER) };
      try {
        sendJson(response, 200, await readLane(store, crew, source, position, limit));
      } catch (error) {
        fail(response, 503, `lane could not be read: ${error instanceof Error ? error.message : 'unknown'}`);
      }
      return;
    }
  }

  fail(response, 404, 'no such endpoint');
}

async function handleAsset(pathname: string, response: ServerResponse): Promise<void> {
  const asset = ASSETS[pathname];
  if (!asset) return fail(response, 404, 'not found');
  try {
    send(response, 200, asset.type, await readFile(join(PUBLIC_DIR, asset.file)));
  } catch {
    fail(response, 500, `asset ${asset.file} is missing from the deployment`);
  }
}

const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    send(response, 405, 'text/plain; charset=utf-8', 'read-only service', { Allow: 'GET, HEAD' });
    return;
  }

  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    fail(response, 400, 'malformed request');
    return;
  }

  if (url.pathname === '/healthz') {
    sendJson(response, 200, {
      ok: true,
      build: BUILD_INFO,
      uptimeSeconds: Math.round(process.uptime()),
      crews: config.agents.length,
      streams: streams.size,
    });
    return;
  }

  if (url.pathname === '/api/events') {
    handleEvents(request, response);
    return;
  }

  const handler = url.pathname.startsWith('/api/') ? handleApi(url, response) : handleAsset(url.pathname, response);
  handler.catch((error: unknown) => {
    console.error('[status] request failed:', error);
    if (!response.headersSent) fail(response, 500, 'internal error');
    else response.end();
  });
};

const server = createServer(handleRequest);

if (!isLoopback(config.server.host)) {
  throw new Error(`refusing to bind ${config.server.host}: this service is loopback-only`);
}

server.listen(config.server.port, config.server.host, () => {
  console.log(
    `[status] listening on http://${config.server.host}:${config.server.port} ` +
      `(loopback only — expose with: tailscale serve --bg ${config.server.port})`,
  );
});

function shutdown(signal: string): void {
  console.log(`[status] ${signal} — closing`);
  clearInterval(heartbeat);
  if (tick) clearInterval(tick);
  // SSE connections never end on their own; `server.close()` alone would wait for them.
  for (const stream of streams) stream.end();
  streams.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
