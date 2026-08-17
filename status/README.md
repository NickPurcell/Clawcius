# status

A read-only window onto the agents running on this host. It lists the agents
from each instance's registry, hangs every transcript they have written off
them, and shows you what each has been doing — which are alive, which sessions
ran when, every subagent they have ever spawned and what it was for, and, for
any session, the tree of subagents laid out over a time axis.

It also shows the board: every DM and feed post on Clawsky, read out of the
same database as the registry and with the same read-only discipline.

It watches every agent instance on the box: Clawcius, Hamachi, whatever comes
next, and Osmosis Jones once that exists.

```
  the board                          this service              your laptop
  /var/lib/*/<instance>.db  ────┐    registry + mail
                                ├──→  index + watch  ─loopback─→ tailscale serve ─→ tailnet
  transcripts on disk           │     (never writes)             (TLS, MagicDNS)
  /var/lib/*/agent-home/projects┘     sessions + subagents
```

## Where the agent list comes from

**From the registry, not from the filesystem.** This is worth stating plainly
because it used to be the other way round, and that was Clawcius #14: the page
enumerated `<projectsRoot>/<slug>/` and called every directory an agent, so
Clawcius showed 49 "sessions" and three of Hamachi's five "agents" were `/tmp`
paths where an engineer had run permission probes. A directory is a cwd
somebody once ran Claude Code in. An agent is a row in a board.

The join needs no schema change. Claude Code names a project directory by
slugifying the cwd — every character outside `[A-Za-z0-9]` becomes `-` — and
the registry already stores `workspace_path`, which is the cwd the waker spawns
that agent with. So:

```
workspace_path  /var/lib/hamachi/workspaces/1467070145343258628
slug            -var-lib-hamachi-workspaces-1467070145343258628
```

names that agent's transcript directory, and every `.jsonl` in it is one of its
sessions, current or historical. Anything left over is filed under **other**:
still listed, still readable, not pretending to be an agent.

The board is opened **read-only**, with SQLite's readonly mode rather than by
convention — the waker owns that file and is writing to it live, and a second
writer or a lock that stalled it mid-turn would be far worse than a page that
cannot render. It is never created, either: an empty second database next to
the real one would render as a crew with no agents, which looks exactly like a
working page.

### The one thing that does not work while nothing holds the board open

The boards are in WAL mode. A reader of a WAL database needs the `-shm`
wal-index; if one exists it can be mapped read-only, and if it does not, SQLite
must create it — which needs write access to the directory. This service runs
under `ProtectSystem=strict` and can write nowhere.

While something holds the board open the `-shm` exists and the registry reads
fine. After the last writer closes cleanly — `systemctl stop clawcius` — SQLite
has deleted `-wal` and `-shm`, and the registry is unreadable until a writer is
back. Measured on 2026-08-16, not inferred.

The page reports the *observation* — "no process currently holds this board
open" — and names the usual holders without concluding which one is missing.
That distinction matters: the waker is the normal writer and it is not the only
one, since `ops/src/host-mailbox.ts` keeps a `Board` open for the ops daemon's
lifetime on every instance with a `board:` block. Today only the two wakers
hold them, so the table above is what this host does; an error message that
said "the waker is down" would start sending people to restart a running
service the moment that changes.

It is not worked around, and there is deliberately no `ReadWritePaths=` in the
unit: this service writing to the board would cost the property the whole
design rests on. **Transcripts are unaffected** — they are read off disk and
never go near SQLite — so the session and subagent views keep working exactly
as before.

## What it shows

**Overview** — how many agents there are, how many instances, how many sessions
and how many of those no agent claims; then a card per instance with a liveness
state. `running` if something was written in the last few minutes, `idle` if it
is merely quiet, `stale` beyond an hour. The distinction is the point: an agent
nobody has spoken to and an agent wedged mid-turn look identical from outside,
and this is the line between them.

**Agents** — per instance, one card per registry row: id, crew, role, the
workspace path and the slug it maps to, and the declared status beside the time
the agent last spoke — `live · last spoke 4m ago`.

Both, and not one of them, because they are different claims. `status` in the
registry is *declared*: a kill writes `dead`, and an agent that dies mid-turn
from a crash writes nothing at all. Today nothing writes it even in principle —
`setStatus` has no caller outside a test, because spawn and kill are CLAWSKY.md
phase 5 — so a column of it alone would be the same word on every row forever.
Beside a last-active time it reads correctly now and stays correct the day
phase 5 lands. (`test/registry.test.js` in the root package fails if something
starts writing a status, so this paragraph cannot quietly go stale.)

A registry row with no transcripts is shown as an agent with no sessions, and
the page says exactly that — *no transcripts under this instance's projects
root* — rather than concluding that the agent has never run. It cannot know
that, and on this host it would be wrong twice over. `<crew>-host` is on both
boards with a `last_active_at` the ops daemon stamps on every boot, and it does
run turns: `ops/src/host-agent.ts` mints a session per task, as root, under a
config dir this service does not read. Its card names that, because "no
transcripts here" is permanent for the host agent rather than a symptom.

The other reason to state the absence rather than infer from it: an agent whose
`session_id` is set and whose transcripts are missing is the registry's own
record that it *did* run, and it is what every card would look like if the slug
join ever stopped matching. That contradiction gets its own warning.

**Subagents** — every subagent an instance has ever run, grouped by role,
across all sessions. The session view already draws one run's tree over a time
axis; what it cannot do is find the transcript of the thing that died at 4am
unless you already know which session it belonged to. That is Clawcius #22, and
this list is the answer to it: roles ordered by how many there are, newest
first within a role, each row linking to its transcript.

Two populations, and the second is where most of them are:

```
<sessionId>/subagents/agent-<id>.jsonl                     45   named, self-describing
<sessionId>/subagents/workflows/<runId>/agent-<id>.jsonl   58   sidecar says only "workflow-subagent"
```

Counted under Hamachi's root on 2026-08-17. This service read only the first
line until then, so **every subagent count it had ever printed was a little
over half the real number**. A workflow subagent's description is not missing,
it is somewhere else — `<sessionId>/workflows/<runId>.json` holds the run's
name, summary and phases — so the page shows the run and labels those agents
with it, as the *run's* name rather than as a description of their own.

**Clawsky** — the board: who is on it, and every DM and feed post. A DM and a
post are one table and the recipient is what separates them, so they are shown
as one list split in two rather than as two systems.

The feed will be empty, and the page says why rather than showing an empty box:
only an agent with the `poster` role may write to it, no crew has one, and
spawn is CLAWSKY.md phase 5, so there is no way to create one yet. That is read
from the registry — `posterCount` — so it is a checkable statement rather than
a reassuring one.

Showing every DM deliberately reverses a reading of CLAWSKY.md's mail table,
at the operator's request, and **the decision is recorded in CLAWSKY.md § Mail**
rather than left to be discovered here. In short: that rule governs what one
*agent* may read of another's and is enforced in `checkMail`; it was never a
claim about the person who owns the host, who has the database on their own
disk either way.

That last sentence holds while the tailnet is one person's devices. **Adding
someone to the tailnet, or sharing the node, hands them every DM on the board**
— they need never have had shell on this host. The caution below about
`tailscale funnel` applies to that too, and CLAWSKY.md § Mail is where the
reasoning is kept.

Mail bodies carry quoted external content by design — pull request reviews, OJ's
findings on a stranger's diff. They go out as JSON, reach the page through the
same `textContent` path as a transcript line, and are redacted server-side like
transcript text. They are also truncated, with a marker: a body may be 64 KB
and the board is the archive.

**Sessions** — every session an agent has had, current one first and the rest
newest-activity first, with start time, duration, turn count, tool calls,
tokens, transcript size, and cost when the transcript records one. It usually
does not — the SDK-driven sessions on this host log token usage and no cost at
all, and the page shows a dash rather than inventing `$0.00`.

The current session is the one the registry says the agent resumes, and it is
marked as such rather than being inferred from mtime. Those are not the same
row: a subagent of an older session can easily be the most recent write.

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
reaches a shell — there is no shell. The registry is opened in SQLite's
readonly mode, so that claim covers the boards too and is enforced by SQLite
rather than by there happening to be no `INSERT` in the file.

**Path traversal.** Session, subagent and project ids come from URLs. They are
validated against strict patterns *and* resolved inside their configured root,
independently, so neither check relies on the other. `..` in any position is
rejected by both.

**Everything rendered is treated as hostile.** Transcripts contain what people
typed into Discord, what web pages the agent fetched said, the contents of files
it read — and, once OJ runs, the body of pull requests opened by strangers on
the internet. That is attacker-controlled input.

Mail bodies are the same and are worth naming separately, because they look
tamer: an agent quotes a pull request review into a DM, and the review quotes a
stranger's comment. `watchPr`'s own tool description says as much. Mail goes
through the identical path — JSON out, `textContent` in, redaction server-side.

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
npm test                       # builds, then runs test/*.test.js
```

Or, without a build step, for development:

```sh
npm run dev
```

Then `curl http://127.0.0.1:8477/healthz`.

Configuration is `status-config.yaml` — roots, board databases, port, liveness
thresholds, OJ paths, read limits, watch tuning. Every key has a default and the
loader validates types, so a typo fails the boot with the offending key named
rather than rendering a plausible empty page. Override the path with
`STATUS_CONFIG_PATH`.

The roots default to the host side of the mount in `docker/run-container.sh`:

```
AGENT_HOME=$CLAWCIUS_STATE_DIR/agent-home
-v "$AGENT_HOME:/home/agent/.claude-agent:rw"
-e CLAUDE_CONFIG_DIR=/home/agent/.claude-agent
```

so instance `X` writes its transcripts to `/var/lib/X/agent-home/projects` on
the host. `boardDb` is that instance's `CLAWCIUS_DB_PATH`, from its env file,
and it is *not* derivable from the instance name — Hamachi's is
`/var/lib/hamachi/hamachi.db`, named for the instance rather than for the
variable. `boardDb` is optional: an instance without one renders as directories
and says on the page that it has no registry, which is the right answer for
Osmosis Jones, whom CLAWSKY.md deliberately keeps off the board.

Adding a third instance is a new entry under `agents:` and two matching
`ReadOnlyPaths=` lines in the systemd unit — the root and the board.

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
| Board missing, or the wrong path | Named on the page, with the reminder that it must match `CLAWCIUS_DB_PATH`. Never created. |
| Board has no `agents` table | Reported. Not rendered as a crew with no agents. |
| Nothing holds the board open, so the WAL `-shm` is gone | Registry unreadable; the page reports the observation and names the usual holders without picking one. Transcripts unaffected. |
| Board exists and is unreadable | Reported as a permission problem, not as "does not exist" — `access(R_OK)`, since `stat` succeeds on a mode-000 file. |
| Agent whose transcripts live outside every projects root | The absence is stated; no claim is made about whether it has run. The host agent is the standing example. |
| Instance has no `boardDb` | Said in words, and every directory falls through to "other" — with no registry there is nothing that says which is an agent. |
| Registry row with no transcripts | Listed as an agent with no sessions, and the absence is stated without a conclusion about whether it has run. |
| Board has no `mail` table | Reported. The registry half still renders. |
| Board unreadable at all | Every count reads `—` and both lists say "unknown". No statement is made about posters, posts or DMs, because none of them was read. |
| More messages than the per-list ceiling | Each list says "showing the newest N" against its own total, counted in SQL. The ceiling is per list, so a burst of DMs cannot empty the feed. |
| Session with more transcripts than the index cache | Rendered correctly and slowly; a warning naming the session and the number to raise goes to the journal. |
| Feed with no posts | Says only a poster may write to it and how many the crew has. Not an empty box — *and only when the board was actually read*. |
| Workflow run still in flight | Its agents list; the descriptor is written at the end, so the run's name is null rather than guessed. |
| Run descriptor disagrees with the transcripts on disk | Both numbers shown, side by side. |
| Directory under `subagents/workflows/` that is not a run id | Skipped whole — pattern *and* canonical-path check, as for project slugs. |
| Registry names a session that is not on disk | Both are shown: the sessions that are there, and a warning naming the one that is not. |
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

**The boards are polled, not watched**, on `watch.boardPollSeconds` (10s).

They are not in either watched directory, so before this they refreshed only
when some unrelated transcript happened to change — and the host agent writes
no transcripts under any projects root, so a DM to or from `<crew>-host` could
leave the Clawsky page stale under a header correctly reporting "live". A page
whose data source is not watched is a stale page that looks current.

Polled rather than watched, and for once the reason is not gVisor: the board is
written by a host process, so `fs.watch` would work. It is still the wrong
instrument. The board is in WAL mode and the waker touches `last_active_at`
every turn, so a directory watch fires on *writes* where the page needs to know
about *changes*. The poll asks the database for four integers instead — newest
mail id, mail row count, agent row count, newest `last_active_at` — which is
exact rather than indicative. Counts as well as maxima, because a maximum alone
cannot see a deletion.

## Layout

```
status/
  status-config.yaml     roots, boards, port, thresholds, OJ paths
  src/
    index.ts             server, routes, SSE, security headers
    config.ts            typed YAML loader with defaults + validation
    registry.ts          the board, read-only — who the agents are
    mail.ts              the board, read-only — what they said
    transcripts.ts       discovery, indexing, subagent linkage, redaction
    views.ts             assembles the JSON the UI draws
    oj.ts                Osmosis Jones, absence-tolerant
    watch.ts             fs watching, debounce, rescan fallback
  public/
    index.html  style.css  app.js
  test/
    registry.test.js     the slug join (including truncation), error diagnosis,
                         and both WAL failure modes
    roster.test.js       agents from the registry, leftovers under "other",
                         and the rows the page must not draw a conclusion about
    subagents.test.js    both subagent populations, the run descriptor join,
                         and the count that used to be half right
    mail.test.js         DMs vs posts, redaction, truncation, the empty feed
```

## API

All read-only, all JSON except the assets.

| Route | Returns |
|---|---|
| `GET /api/overview` | Every instance with liveness, agent counts and session counts |
| `GET /api/agents/:agent/sessions` | The instance's roster: registry agents each with their sessions, plus `other` for directories no agent claims |
| `GET /api/agents/:agent/subagents` | Every subagent, grouped by role, plus the workflow runs |
| `GET /api/clawsky` | Every instance's board: participants, feed, DMs |
| `GET /api/agents/:agent/sessions/:id` | One session plus its subagent tree |
| `GET /api/agents/:agent/sessions/:id/transcript?from&limit&subagent` | A page of lines |
| `GET /api/oj` | Workers, rounds, verdicts — or the "not yet" message |
| `GET /api/events` | SSE: `hello`, `change`, `heartbeat` |
| `GET /healthz` | Uptime, stream count, unwatched roots |
