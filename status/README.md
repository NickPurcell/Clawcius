# status

A read-only window onto the agents running on this host. It reads Claude Code
transcripts off local disk and shows you what each agent has been doing — which
are alive, which sessions ran when, and, for any session, the tree of subagents
it spawned laid out over a time axis.

It watches every agent instance on the box: Clawcius, Hamachi, whatever comes
next, and Osmosis Jones once that exists.

```
  transcripts on disk                this service              your laptop
  /var/lib/*/agent-home/projects ─→  index + watch  ─loopback─→ tailscale serve ─→ tailnet
                                     (never writes)             (TLS, MagicDNS)
```

## What it shows

**Overview** — every configured agent with a liveness state. `running` if
something was written in the last few minutes, `idle` if it is merely quiet,
`stale` beyond an hour. The distinction is the point: an agent nobody has
spoken to and an agent wedged mid-turn look identical from outside, and this
is the line between them. Plus last activity, session count, subagent count.

**Sessions** — every session for an agent, newest first, with start time,
duration, turn count, tool calls, tokens, transcript size, and cost when the
transcript records one. It usually does not — the SDK-driven sessions on this
host log token usage and no cost at all, and the page shows a dash rather than
inventing `$0.00`.

**Subagent branching** — the headline view. Every subagent a session spawned,
as a tree indented by depth and drawn as a swimlane over the session's time
axis, with its role (`subagent_type`), its task description, start, end and
duration. Hovering a bar gives the detail; clicking a row opens that subagent's
own transcript. This is what makes a run legible: you can see which children ran
in parallel, which one took forty minutes, and which is still going.

**Transcript** — full message content for a session or a subagent, in order,
with tool calls and their results visually distinct from prose. Paginated, for
reasons in *Performance* below.

**Osmosis Jones** — workers by PR, with rounds and verdicts. OJ is not running
yet, so this degrades to a calm "no OJ data yet" rather than an error.

**Live updates** — the page watches the transcript directories and refreshes
itself over SSE, with a heartbeat. If the stream dies the indicator in the
header goes red and says how long it has been silent. That matters more than it
sounds: a status page showing hours-old data behind a green dot is worse than
one showing nothing.

## Security model

This service has no authentication, and that is the design rather than an
omission. Authentication is delegated to the network, and every other control
here assumes that could still fail.

**Loopback only.** It binds `127.0.0.1` and refuses to start on anything that
is not a loopback address — checked in the config loader and again immediately
before `listen`. `tailscale serve` terminates TLS and proxies in from
localhost, so the page is reachable from your tailnet and nowhere else.

The property this buys is the *failure mode*. If tailscaled dies, the page
becomes unreachable. A page bound to `0.0.0.0` and merely firewalled has the
opposite failure mode, and you learn about it from a stranger. `0.0.0.0`, `::`,
`*` and the empty string are all rejected by name.

**Read-only.** Every route is GET or HEAD; anything else gets a 405 before
routing. Nothing writes, deletes, or spawns a process, and no request parameter
reaches a shell — there is no shell.

**Path traversal.** Session, subagent and project ids come from URLs. They are
validated against strict patterns *and* resolved inside their configured root,
independently, so neither check relies on the other. `..` in any position is
rejected by both.

**Everything rendered is treated as hostile.** Transcripts contain what people
typed into Discord, what web pages the agent fetched said, the contents of files
it read — and, once OJ runs, the body of pull requests opened by strangers on
the internet. That is attacker-controlled input.

So: the API returns JSON, and the client builds DOM nodes with `textContent`.
There is no `innerHTML`, no `insertAdjacentHTML`, no template interpolation into
markup anywhere in `public/`. The page being private does not change what a
script tag does once it runs in the browser of the person who owns the host.

The service is served under `Content-Security-Policy: default-src 'none'` with
no `'unsafe-inline'` — which is why the HTML carries no inline script or style.
That is the second layer.

**Secret redaction.** Credential-shaped strings are replaced with `[redacted]`
server-side, on the way out: `ghp_`/`gho_`/`github_pat_`, `xox[baprs]-`,
`sk-ant-`, `sk-`, Discord bot tokens, AWS key ids, `Authorization: Bearer …`,
and whole PEM private-key blocks. This is the third layer and it is a
**mitigation, not a guarantee** — it catches well-known prefixed formats and
cannot catch a password, a bare hex token, or a key format invented after the
list was written. Do not read it as "this page is safe to show someone else".

## Running it

```sh
cd status
npm install
npm run build
npm start                      # reads ./status-config.yaml
```

Or, without a build step, for development:

```sh
npm run dev
```

Then `curl http://127.0.0.1:8477/healthz`.

Configuration is `status-config.yaml` — roots, port, liveness thresholds, OJ
paths, read limits, watch tuning. Every key has a default and the loader
validates types, so a typo fails the boot with the offending key named rather
than rendering a plausible empty page. Override the path with
`STATUS_CONFIG_PATH`.

The roots default to the host side of the mount in `docker/run-container.sh`:

```
AGENT_HOME=$CLAWCIUS_STATE_DIR/agent-home
-v "$AGENT_HOME:/home/agent/.claude-agent:rw"
-e CLAUDE_CONFIG_DIR=/home/agent/.claude-agent
```

so instance `X` writes its transcripts to `/var/lib/X/agent-home/projects` on
the host. Adding a third instance is a new entry under `agents:` and a matching
`ReadOnlyPaths=` line in the systemd unit.

## SETUP — exposing it on the tailnet

Install the unit:

```sh
sudo cp systemd/clawcius-status.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawcius-status
systemctl status clawcius-status
```

Then publish it to the tailnet — this is the only step that makes the page
reachable from anywhere but the host itself:

```sh
sudo tailscale serve --bg 8477
```

That does three things: it terminates **HTTPS** with a certificate Tailscale
issues for your node, gives the page a **MagicDNS** name
(`https://<hostname>.<tailnet>.ts.net/`), and proxies to `127.0.0.1:8477`. No
port is opened on any public interface, and nothing needs a firewall rule.

Check and undo with:

```sh
tailscale serve status
sudo tailscale serve --bg --https=443 off
```

To reach it from a phone or a laptop, that device only has to be signed into
the same tailnet. If you want it available to other people on the tailnet, that
is `tailscale funnel`'s territory and you should read the redaction caveat above
again first — the honest answer is don't.

## Performance

The transcripts are not small. On this host one session directory is 4.3 MB with
2.6 MB of subagents, from a single Discord channel over one week, and the main
transcript alone is 1.8 MB across 936 lines. Naively parsing all of that on
every request — on a page that refreshes itself over SSE — is a memory leak with
a UI attached.

So the unit of caching is an **index**, not a transcript. For each line the
service keeps its byte offset, length, type and timestamp, and throws the
content away; rendering a page of transcript seeks to those offsets and reads
back only the lines being shown. Two consequences worth knowing:

- **Refreshes are incremental.** JSONL is append-only, so a session that grew by
  one line re-reads one line. A fingerprint of the file's first bytes detects a
  rewrite masquerading as an append and forces a full rebuild.
- **The transcript view is paginated**, both by line count and by a byte
  ceiling, because a single JSONL line can hold an entire file's contents.

The LRU cache size, page size and byte ceiling are all in `status-config.yaml`.

## Failure modes it handles

| Situation | Behaviour |
|---|---|
| Root does not exist yet | Row shows `no data` with an explanation. Not an error — new instances have no projects dir until their first turn. |
| Root unreadable (permissions) | Same, with the reason. Other agents still render. |
| Malformed JSONL line | Skipped, counted, and the count is shown. |
| Half-written trailing line | Not indexed, not counted as malformed. Picked up when complete. |
| Session with no subagents | Says so, in words. |
| In-progress subagent | Bar gets a live marker; end time reads "still running". |
| Transcript rewritten, not appended | Fingerprint mismatch forces a rebuild. |
| Clock skew | Every duration is clamped at zero. Liveness uses mtime only — the same clock as `Date.now()` — never transcript timestamps. |
| SSE stream dies silently | Heartbeat watchdog turns the indicator red and says how long it has been silent. |
| `fs.watch` unavailable or inotify exhausted | Falls back to a rescan; the unwatched roots are listed on `/healthz`. |

### A note on watching

`fs.watch` is set up but not trusted. The agents write their transcripts from
*inside* a gVisor container, into a bind mount whose host side is what this
service watches — and SETUP.md § 6b records that the waker hit precisely this
and found that "gVisor's gofer does not reliably deliver inotify for writes made
inside the sandbox", which is why it carries a 5s sweep of its own.

So `watch.rescanSeconds` defaults to 10 and should be understood as the primary
mechanism here, with `fs.watch` as the fast path when it happens to fire.
Updates are therefore worst-case ~10s, not instant, and that is deliberate.

## Layout

```
status/
  status-config.yaml     roots, port, thresholds, OJ paths
  src/
    index.ts             server, routes, SSE, security headers
    config.ts            typed YAML loader with defaults + validation
    transcripts.ts       discovery, indexing, subagent linkage, redaction
    views.ts             assembles the JSON the UI draws
    oj.ts                Osmosis Jones, absence-tolerant
    watch.ts             fs watching, debounce, rescan fallback
  public/
    index.html  style.css  app.js
```

## API

All read-only, all JSON except the assets.

| Route | Returns |
|---|---|
| `GET /api/overview` | Every agent with liveness and counts |
| `GET /api/agents/:agent/sessions` | Session summaries, newest activity first |
| `GET /api/agents/:agent/sessions/:id` | One session plus its subagent tree |
| `GET /api/agents/:agent/sessions/:id/transcript?from&limit&subagent` | A page of lines |
| `GET /api/oj` | Workers, rounds, verdicts — or the "not yet" message |
| `GET /api/events` | SSE: `hello`, `change`, `heartbeat` |
| `GET /healthz` | Uptime, stream count, unwatched roots |
