/**
 * clawcius-status — a read-only window onto the agents running on this host.
 *
 * ── The security model, in one place ───────────────────────────────────────
 *
 * This service has no authentication, and that is a deliberate design, not an
 * omission. Authentication is delegated to the network:
 *
 *   1. It binds to LOOPBACK ONLY. Never 0.0.0.0, and the bind address is
 *      validated twice — once in the config loader, once here immediately
 *      before `listen`. The property this buys is the failure mode:
 *      `tailscale serve` proxies from localhost, so if tailscaled dies the page
 *      becomes UNREACHABLE rather than becoming PUBLIC. A page bound to
 *      0.0.0.0 and merely firewalled has the opposite failure mode, and you
 *      find out about it from a stranger.
 *
 *      It ALSO listens on unix domain sockets, one per configured instance, so
 *      that the agent containers can reach it — they are on a network with no
 *      gateway and could not otherwise. This does not weaken (1): a unix
 *      socket has no address and no port, the TCP surface is unchanged, and
 *      the reachability comes from a bind mount rather than from routing. It
 *      DOES widen what an agent can see, because the page shows both crews and
 *      an agent could not read the other crew's board before. See `socket.ts`
 *      and the note on `AgentRoot.socketPath`; that widening is the feature.
 *
 *   2. It is READ-ONLY. Every route is GET or HEAD; anything else is refused
 *      before routing. Nothing here writes, deletes, or spawns a process, and
 *      no request parameter reaches a shell — there is no shell. The agent
 *      registry is a live SQLite database owned by another process, so it is
 *      opened in SQLite's readonly mode: that half of the claim is enforced by
 *      the library rather than by there happening to be no INSERT in the file.
 *      See `registry.ts`.
 *
 *   3. Ids from URLs are validated against a strict pattern AND resolved
 *      inside their configured root, independently. See `transcripts.ts`.
 *
 *   4. Every string that reaches the browser is treated as hostile. Transcripts
 *      contain whatever a user typed into Discord, whatever a web page said,
 *      and — once Osmosis Jones runs — whatever text was in a pull request
 *      opened by a stranger on the internet. The API returns JSON, the client
 *      builds DOM nodes with `textContent`, and there is no `innerHTML` with
 *      data anywhere in `public/`. Rendering that content unescaped would be
 *      XSS regardless of the page being private.
 *
 *   5. Credential-shaped strings are redacted server-side on the way out. That
 *      is a mitigation and not a guarantee — see the comment on the pattern
 *      list in `transcripts.ts`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopback, loadStatusConfig } from './config.js';
import { readOjSnapshot } from './oj.js';
import { bindUnixSockets, releaseSocketPath, type SocketOutcome } from './socket.js';
import { isValidSubagentId, TranscriptStore } from './transcripts.js';
import {
  buildAgentOverview,
  buildClawsky,
  buildRoster,
  buildSessionDetail,
  buildSubagentRollup,
} from './views.js';
import { BoardWatcher, RootWatcher, type ChangeEvent } from './watch.js';

const config = loadStatusConfig();
const store = new TranscriptStore(config);

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Static assets, by exact name.
 *
 * An allowlist rather than "serve whatever is under public/". There is no
 * user-supplied path arithmetic to get wrong, no dotfile to leak, and adding a
 * file to the UI is a one-line change — which is a fair trade for a category
 * of bug this service simply does not have.
 */
const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

/**
 * Content-Security-Policy, as tight as a page with no third-party anything can
 * be. `default-src 'none'` means an injection that got past the DOM-building
 * discipline in app.js still has nowhere to send what it found.
 *
 * No 'unsafe-inline' anywhere: the HTML carries no inline script and no inline
 * style, specifically so this header can say so.
 */
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

/**
 * Error bodies say what went wrong without saying where anything lives.
 *
 * Paths are already visible on this page — it is an observability tool for the
 * person who owns the host — but an error path is reachable with a malformed
 * URL, and echoing a resolved filesystem path back to whoever sent one is a
 * habit worth not having.
 */
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

/**
 * The boards, which no directory watch covers.
 *
 * Separate from `RootWatcher` because it answers a different question with a
 * different instrument — see the header on `BoardWatcher`. Its events go to the
 * same subscribers, so a change on the board refreshes the page exactly as a
 * transcript write does.
 */
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

/**
 * The heartbeat.
 *
 * This is what makes a dead stream visible AS DEAD instead of as a quiet host.
 * The client tracks the interval between heartbeats and marks the page stale
 * when two go missing, so a reader can always tell "nothing is happening" from
 * "this page stopped being told what is happening".
 *
 * Sent as an SSE comment (`: …`) rather than an event, so no client-side
 * handler is needed for it to keep proxies from closing an idle connection —
 * which matters here because `tailscale serve` is exactly such a proxy.
 */
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
    const agents = [];
    for (const agent of store.agents) {
      agents.push(await buildAgentOverview(store, agent, config, now));
    }
    sendJson(response, 200, {
      generatedAt: new Date(now).toISOString(),
      liveness: config.liveness,
      agents,
    });
    return;
  }

  // The board, across every instance: who is on it, and every DM and post.
  //
  // Showing all DMs reverses CLAWSKY.md's "sender + recipient" row, which is a
  // decision the operator took and which is recorded there rather than only
  // here. See the header of `mail.ts` for why it is not a contradiction: that
  // rule constrains what one AGENT may read, and it is enforced in `checkMail`
  // where agents read.
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
    // Same 404 whether the id is malformed or simply not configured. There is
    // nothing to enumerate here, but the habit costs nothing.
    if (!agent) return fail(response, 404, 'no such agent');

    // The instance's roster: its registry agents, each with every session it
    // has had, plus whatever no registry row claims. Still reached at
    // `/sessions` because that is where the sessions are — they now arrive
    // grouped by the agent that had them rather than as one flat list of
    // files (Clawcius #14).
    if (parts[3] === 'sessions' && parts.length === 4) {
      sendJson(response, 200, await buildRoster(store, agent, config, now));
      return;
    }

    // Every subagent this instance has run, grouped by role. Flat and
    // cross-session on purpose — the session view already draws the tree, and
    // the thing it cannot do is find a transcript when you do not know which
    // run it belonged to (Clawcius #22).
    if (parts[3] === 'subagents' && parts.length === 4) {
      sendJson(response, 200, await buildSubagentRollup(store, agent, config, now));
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
        // `subagent` selects a child transcript instead of the parent's. It is
        // validated here and then joined under the session directory, which
        // `resolveWithin` has already confined — two checks, neither relying
        // on the other.
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
    // Both matter behind a proxy: without them an intermediary may buffer the
    // stream and deliver nothing until it closes, which looks precisely like a
    // dead stream — the state the heartbeat exists to distinguish.
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
    // Only reachable if the deployment is missing files it shipped with —
    // worth saying plainly rather than as a bare 404 among the URL typos.
    fail(response, 500, `asset ${asset.file} is missing from the deployment`);
  }
}

/**
 * Outcome of every configured unix socket, filled in at boot and then read
 * only by `/healthz`.
 *
 * A socket that could not be bound is a warning rather than a boot failure
 * (see `bindUnixSockets`), which makes this the only place the state is
 * visible. Without it "the agents cannot reach the page" is a thing you
 * diagnose by strace; with it, it is a field in a JSON document.
 */
let socketOutcomes: SocketOutcome[] = [];

/**
 * The one request listener, shared by every listener socket.
 *
 * Named and hoisted out of `createServer` because there is now more than one
 * server object: the TCP listener plus one per configured unix socket. They
 * are the same process, the same routes and the same transcript store, and
 * nothing here asks which socket a request arrived on — see `socket.ts` for
 * why that is deliberate and what it costs.
 */
const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
  // Read-only, enforced before anything looks at the path. There is no route
  // that mutates, so this is redundant today; it is here so that it stays
  // true if someone adds one without thinking about it.
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    send(response, 405, 'text/plain; charset=utf-8', 'read-only service', { Allow: 'GET, HEAD' });
    return;
  }

  // The base is a placeholder — only the path and query are used, never the
  // host — but URL parsing needs one and a malformed request line should 400
  // rather than throw out of the request handler.
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
      uptimeSeconds: Math.round(process.uptime()),
      agents: config.agents.length,
      streams: streams.size,
      watched: watcher.watchedCount,
      unwatched: Object.fromEntries(watcher.unwatched),
      // One entry per configured socket, listening or not, with the reason.
      // Reported even when every socket is healthy: "which of these is the
      // one my container mounts" is the first question when it is not.
      sockets: socketOutcomes.map((outcome) =>
        outcome.listening
          ? { path: outcome.path, listening: true }
          : { path: outcome.path, listening: false, reason: outcome.reason },
      ),
    });
    return;
  }

  if (url.pathname === '/api/events') {
    handleEvents(request, response);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(url, response).catch((error: unknown) => {
      // Last line of defence. An unhandled rejection in a request handler
      // would otherwise take the process down under Node's default policy,
      // and one bad transcript should not stop the page telling you about the
      // other nineteen.
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

// The second loopback check, immediately before the bind that would matter.
// The config loader already rejects a non-loopback host; this catches the case
// where a future refactor builds the listen options from somewhere else.
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
  for (const agent of config.agents) {
    console.log(`[status]   ${agent.id}: ${agent.projectsRoot}`);
  }
  for (const [scope, reason] of watcher.unwatched) {
    // A warning, not a failure: the rescan timer covers it, and a root that
    // does not exist yet is the normal state of a new instance.
    console.warn(`[status]   not watching ${scope}: ${reason} (falling back to rescan)`);
  }
});

// The unix sockets, after the TCP listener rather than before it, so that a
// slow probe of a stale socket cannot delay the listener that everything else
// depends on. Nothing awaits this; it settles into `socketOutcomes` and is
// reported on /healthz from then on.
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
  // Close the unix listeners too, and unlink what we created. A socket file
  // left behind is what the stale-socket handling in socket.ts exists to
  // recover from; not leaving one is cheaper than recovering from it.
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
