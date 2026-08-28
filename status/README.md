# Clawsky status page

One page, read-only, showing what every agent on this host has been doing. It
reads Claude Code transcripts and each crew's board off local disk and writes
nothing. It binds loopback only and is published to the tailnet with
`tailscale serve`.

## What the page shows

A crew switch (Clawcius / Hamachi) at the top, then a horizontal timeline for
the selected crew: one row per registry agent, coordinator first, with each
subagent nested under the agent that spawned it. A row is filled where the
agent was working and empty where it was idle. Working means a tool call in
flight or tokens streaming; the spans come from transcript line timestamps —
two lines further apart than `IDLE_GAP_MS` (90 s, `src/timeline.ts`) are idle
time, and a tool call bridges any gap to its result. The view defaults to the
last three hours; the range buttons, the wheel (ctrl+wheel zooms), dragging
and the arrow buttons move it. Subagent rows appear only while their activity
is in view or their lane is open.

Below the agents: one row per bot, read from
`<workspacesRoot>/.bots/<name>/health.json` (a bot `bots/supervise.sh` runs)
or `<workspacesRoot>/<workspace>/<bot>/run/health.json` (a bot an agent runs
from its workspace), its span running from `since` to `updated`, red when
`needs_human` is set. In the top bar: the age
of the newest `clawcius-agent` image tagged `snap-YYYYMMDD-HHMMSS` (red past
48 h; "no docker" when the CLI cannot answer).

Each row has a checkbox. Checked rows open as lanes below the timeline, the
width split evenly, each showing that agent's I/O in time order. Entries are
labelled by origin, not by transcript role:

| Label | What it is |
|---|---|
| `Discord · <author>` | one message from the bundle the waker delivered |
| `Mail from <agent>` | a colleague's DM, delivered as a mail wake |
| `Reminder (self)`, `Schedule`, `PR watch` | an armed condition firing, told apart by its subject |
| `System` | mail from `system` or `deploy`, a compaction, a resume or skill preamble |
| `Prompt` | a typed user turn that is none of the above |
| `Assistant` | text the model wrote; `Thinking` is collapsed |
| `Tool: <name>` | a tool call, its result collapsed underneath; `reacted 👀` for a Discord reaction |
| `→ <recipient>: <subject>` / `← <author>: <subject>` | rows of the crew's `mail` table, merged in by `sent_at` |

Agents are named from the registry (`agents` table): a coordinator is
"<Crew> coordinator", any other agent is the crew label plus its id without
the crew prefix ("Hamachi engineer1"). A subagent is its recorded description,
else its type, else "subagent".

Scrolling a lane moves the cursor line on the timeline to the entry at the
top of the viewport. Moving the timeline scrolls every lane to that time.
The page refetches on each SSE `tick`; with "follow" on, the view tracks now
and lanes stay at their newest entry.

Text is redacted before it leaves the server (private keys, GitHub, Slack,
Anthropic, Discord and AWS tokens, Authorization headers) and every content
block is cut at `read.maxBlockChars`.

## Running it

```sh
cd status && npm ci && npm run build && npm start     # or: npm run dev
sudo cp systemd/clawcius-status.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now clawcius-status
sudo tailscale serve --bg 8477
```

`npm test` builds and runs `test/*.test.js`; `npm run typecheck` type-checks.
`scripts/build-info.mjs` writes `src/build-info.ts` before every build, and the
service prints that build line first thing on boot and reports it on
`/healthz`. Set `STATUS_CONFIG_PATH` to use a config elsewhere than
`./status-config.yaml`.

The service needs read access to each crew's `projectsRoot`, `boardDb` and
`workspacesRoot`, and the docker CLI for the snapshot age. A board in WAL mode
is readable only while a writer (the crew's waker) holds it open, because a
read-only reader cannot create the `-shm` index; the page says so in one line.

## API

All routes are `GET`; anything else is `405`.

| Route | Returns |
|---|---|
| `/` | the page (`/app.js`, `/style.css` beside it) |
| `/api/board` | `{ crews: [{id, label}], snapshot }` — `snapshot` is `{available, tag, createdAt, ageSeconds, stale}` |
| `/api/crews/<crew>/timeline` | `{ crew, label, error, rows, bots }`; a row is `{id, name, role, depth, parent, status, spans: [[start, end]], lastTs, lines}` |
| `/api/crews/<crew>/lane?row=<id>&from=<n>&limit=<n>` | `{ row, total, from, nextFrom, entries, error }`; `at=<ms>` instead of `from` starts at the first line stamped at or after that instant |
| `/api/events` | SSE: `hello` `{heartbeatSeconds, tickSeconds, crews}`, then `tick` and `heartbeat` frames |
| `/healthz` | `{ ok, build, uptimeSeconds, crews, streams }` |

A row id is `a:<registry id>` or `s:<subagent id>`. A lane entry is
`{key, ts, kind, label, text, detail, isError, truncated}`; `key` is
`n<line>.<block>` for transcript content and `m<id>` for a mail row, so a
client can dedupe across pages. The tail page (`from` = `total`) returns no
lines and any mail newer than the last line.

## Configuration (`status-config.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `server.host` | `127.0.0.1` | must be loopback |
| `server.port` | `8477` | |
| `agents[].id` | | URL-safe crew id |
| `agents[].label` | id | the crew's name on the page |
| `agents[].projectsRoot` | | absolute path to the crew's `agent-home/projects` |
| `agents[].boardDb` | none | the crew's board; without it no agents are listed |
| `agents[].workspacesRoot` | none | the crew's workspaces; bots' `health.json` files are looked for under it |
| `read.pageSize` | `100` | lane lines per page, and the most a request may ask for |
| `read.maxPageBytes` | `2000000` | bytes one page may read off disk |
| `read.maxBlockChars` | `20000` | characters kept per content block |
| `read.maxCachedSessions` | `256` | transcript indexes held in memory |
| `stream.heartbeatSeconds` | `15` | SSE heartbeat |
| `stream.tickSeconds` | `10` | SSE `tick` interval; `0` disables |

## Security

`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src
'self'; connect-src 'self'` — no inline script or style, nothing from a CDN,
so the page works on the tailnet with no route out. Every value the server
returns is placed with `textContent`. The service refuses any non-loopback
bind, sends `Cache-Control: no-store`, and runs under the hardened unit in
`systemd/clawcius-status.service`.
