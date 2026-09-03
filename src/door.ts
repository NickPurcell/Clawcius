/**
 * The login page: a loopback HTTP server the operator reaches over the tailnet.
 *
 * It exists because the Claude Code OAuth client cannot redirect anywhere we
 * control — the CLI has no callback option, the client id is Anthropic's, and a
 * loopback redirect lands on the operator's machine rather than on this box. So
 * the browser half of the flow ends on Anthropic's own code screen and the code
 * comes back through a field here instead of through Discord.
 *
 * Reads never act. Loading the page runs no subprocess and mints no login: it
 * reports the credential on disk and nothing else, so looking at the page can
 * never be the thing that logs the crew out. Only `POST /start` spawns.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialVerdict, type AuthLogin, type SubmitOutcome } from './auth.js';

/** Largest body accepted on any route; a paste code is a few hundred bytes. */
const MAX_BODY = 4096;

/** What the page shows before anything is clicked. */
export type DoorState = {
  crew: string;
  home: string;
  /** False when the credential on disk cannot be refreshed. */
  usable: boolean;
  /** Why not, when it is not. */
  why: string | null;
  /** When the refresh token expires, ISO, or null when the file does not say. */
  refreshExpiresAt: string | null;
  /** A login is waiting for its code, and this is where to authorise. */
  pendingUrl: string | null;
};

/** Read the credential and say what the page should show. Touches no process. */
export function doorState(opts: {
  crew: string;
  home: string;
  pendingUrl: string | null;
  now?: number;
}): DoorState {
  const verdict = credentialVerdict(opts.home, opts.now ?? Date.now());
  return {
    crew: opts.crew,
    home: opts.home,
    usable: !verdict.terminal,
    why: verdict.terminal ? verdict.why : null,
    refreshExpiresAt: refreshExpiry(opts.home),
    pendingUrl: opts.pendingUrl,
  };
}

/** `refreshTokenExpiresAt` as an ISO string, or null when it is absent or unstated. */
function refreshExpiry(home: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(home, '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { refreshTokenExpiresAt?: unknown };
    };
    const at = parsed.claudeAiOauth?.refreshTokenExpiresAt;
    if (typeof at !== 'number' || at <= 0) return null;
    return new Date(at).toISOString();
  } catch {
    return null;
  }
}

/** Whether a credential can run an ordinary turn, which is a stronger question than whether it authenticates. */
export type Verification = {
  loggedIn: boolean | null;
  /** Whether a real turn ran. Null when it was not attempted. */
  turnRan: boolean | null;
  detail: string;
};

export type DoorDeps = {
  crew: string;
  home: string;
  login: AuthLogin;
  /**
   * Run a real turn under the credential and say whether it worked.
   *
   * `auth status` is not enough on its own: `setup-token` asks for
   * `user:inference` alone, where an ordinary login asks for the scopes a turn
   * uses, so a credential can authenticate and still fail at everything the
   * agent does.
   */
  verify: () => Promise<Verification>;
  log: (line: string) => void;
  /** Told when a login lands, so the channel hears about it without anyone typing. */
  onAuthenticated?: (verification: Verification) => void;
};

/** Read a request body, refusing anything larger than a paste code needs. */
async function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let over = false;
    request.on('data', (chunk: Buffer) => {
      if (over) return;
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY) {
        over = true;
        resolve(null);
      }
    });
    request.on('end', () => {
      if (!over) resolve(body);
    });
    request.on('error', () => resolve(null));
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // Nothing here is meant to be framed or sniffed, and the page loads no
    // third-party anything.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(text);
}

/** The handler, separated from the listener so a test can call it directly. */
export function doorHandler(deps: DoorDeps) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    try {
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        response.end(PAGE);
        return;
      }

      // A read. No subprocess runs on this path, so refreshing the page cannot
      // be what starts a login.
      if (method === 'GET' && path === '/state') {
        json(response, 200, doorState({
          crew: deps.crew,
          home: deps.home,
          pendingUrl: deps.login.pendingUrl,
        }));
        return;
      }

      if (method === 'POST' && path === '/start') {
        const started = await deps.login.begin();
        if ('error' in started) {
          deps.log(`could not start a login: ${started.error}`);
          json(response, 503, { error: started.error });
          return;
        }
        deps.log('login started from the page');
        json(response, 200, { url: started.url });
        return;
      }

      if (method === 'POST' && path === '/code') {
        const body = await readBody(request);
        if (body === null) {
          json(response, 413, { error: 'that is too long to be a code' });
          return;
        }
        let code: unknown;
        try {
          code = (JSON.parse(body) as { code?: unknown }).code;
        } catch {
          json(response, 400, { error: 'could not read that' });
          return;
        }
        if (typeof code !== 'string') {
          json(response, 400, { error: 'no code' });
          return;
        }

        const outcome: SubmitOutcome = await deps.login.submit(code);
        if (!outcome.ok) {
          json(response, 400, { ok: false, reason: outcome.reason, detail: outcome.detail });
          return;
        }

        // The credential is in. Whether it is any good is a separate question.
        const verification = await deps.verify();
        deps.log(
          `login landed: loggedIn=${String(verification.loggedIn)} turnRan=${String(verification.turnRan)}`,
        );
        deps.onAuthenticated?.(verification);
        json(response, 200, { ok: true, verification });
        return;
      }

      json(response, 404, { error: 'no' });
    } catch (error) {
      // A handler that throws would otherwise take the daemon with it.
      deps.log(`request failed: ${String(error)}`);
      if (!response.headersSent) json(response, 500, { error: 'something broke here' });
      else response.end();
    }
  };
}

/** Listen on loopback. `tailscale serve` is what makes it reachable. */
export function startDoor(deps: DoorDeps, port: number): Server {
  const server = createServer((request, response) => {
    void doorHandler(deps)(request, response);
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/**
 * The page, inline because it is one file and shipping it as an asset would put
 * a second path in the deploy that can go missing.
 */
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude login</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.55 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.2rem}
 h1{font-size:1.3rem;margin:0 0 .2rem}
 .sub{opacity:.65;font-size:.85rem;margin:0 0 1.6rem}
 .card{border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:.7rem;padding:1rem 1.1rem;margin:0 0 1rem}
 .ok{border-left:3px solid #2e7d32}.bad{border-left:3px solid #c62828}
 button{font:inherit;padding:.6rem 1.1rem;border-radius:.5rem;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}
 button:disabled{opacity:.45;cursor:default}
 input{font:inherit;width:100%;padding:.6rem;border-radius:.5rem;border:1px solid color-mix(in srgb,currentColor 35%,transparent);background:transparent;color:inherit;box-sizing:border-box}
 code{font-size:.85em;word-break:break-all;opacity:.8}
 a{color:inherit}
 .step{display:none}.step.on{display:block}
</style></head><body>
<h1>Claude login</h1>
<p class="sub" id="who">reading the credential…</p>

<div class="card" id="state"></div>

<div class="card step on" id="s1">
  <p>Nothing has started. This page has run nothing so far.</p>
  <button id="go">Start a login</button>
</div>

<div class="card step" id="s2">
  <p><a id="link" href="#" target="_blank" rel="noreferrer noopener">Open the Claude authorisation page</a>, approve it, and paste the code it gives you back here.</p>
  <p><input id="code" placeholder="paste the code" autocomplete="off" spellcheck="false"></p>
  <p><button id="send">Finish</button></p>
</div>

<div class="card step" id="s3"><p id="done"></p></div>

<script>
const $=id=>document.getElementById(id);
const show=id=>{for(const s of document.querySelectorAll('.step'))s.classList.remove('on');$(id).classList.add('on')};
async function load(){
  const s=await (await fetch('state')).json();
  $('who').textContent=s.crew+' · '+s.home;
  $('state').className='card '+(s.usable?'ok':'bad');
  $('state').innerHTML=s.usable
    ?'<b>The credential looks usable.</b>'+(s.refreshExpiresAt?' Refresh token good until <code>'+s.refreshExpiresAt+'</code>.':'')
    :'<b>The crew cannot authenticate.</b> '+s.why;
  if(s.pendingUrl){$('link').href=s.pendingUrl;show('s2')}
}
$('go').onclick=async()=>{
  $('go').disabled=true;$('go').textContent='starting…';
  const r=await fetch('start',{method:'POST'});const b=await r.json();
  if(!r.ok){$('go').disabled=false;$('go').textContent='Start a login';$('done').textContent=b.error;show('s3');return}
  $('link').href=b.url;show('s2');
};
$('send').onclick=async()=>{
  $('send').disabled=true;$('send').textContent='checking…';
  const r=await fetch('code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:$('code').value.trim()})});
  const b=await r.json();
  if(!r.ok||!b.ok){$('send').disabled=false;$('send').textContent='Finish';$('done').textContent=(b.detail||b.error||'that did not take');show('s3');await load();return}
  const v=b.verification;
  $('done').textContent=v.turnRan===true
    ?'Authenticated, and a real turn ran under it. The crew is back.'
    :'Authenticated, but a test turn did not run: '+v.detail;
  show('s3');
};
load();
</script></body></html>`;
