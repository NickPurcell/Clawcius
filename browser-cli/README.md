# browser-cli

`browse` — drive a headless Chromium from the command line, for the agent.

```
browse screenshot <url> <out.png> [--viewport SPEC ...] [--full-page] [--scale N]
browse text       <url>          # rendered text, after JavaScript has run
browse html       <url>          # serialised DOM, after JavaScript has run
browse probe      <url>          # final URL, status, redirects, hosts contacted
```

**The PNG is the point.** An agent can read an image file directly, so a
screenshot on disk is legible to the thing that asked for it. This is output,
not a debugging artefact.

Clawcius #11 is the argument: `status/` was built end to end without anyone
looking at it, and the one real defect was found by the operator sending a
picture back. Every visual bug in anything an agent builds is otherwise
invisible to it by construction.

## Why not WebFetch

`WebFetch` returns the HTML the server sent. Anything rendered by JavaScript
afterwards is invisible to it, which for a modern page is most of the page.
`browse text` returns what a person would actually see.

And `probe` reports the URL a request *finished* on. A redirect to a login page
renders beautifully and means nothing, so every command reports its final URL
and status, and `probe` reports only that.

## Examples

```bash
BROWSE=/home/npurcell/clawcius/browser-cli/browse

# Did the thing I just shipped survive contact with a phone?
$BROWSE screenshot https://example.ts.net/ /tmp/status.png \
        --viewport phone --viewport desktop --full-page
# -> /tmp/status.phone.png, /tmp/status.desktop.png

# What does this page actually say once its JS has run?
$BROWSE text https://example.com > /tmp/page.txt

# Am I looking at the page, or at its login screen?
$BROWSE probe https://example.com
```

Both viewports above render in **one** browser. Repeating `--viewport` is much
cheaper than invoking `browse` twice.

### Viewports

`--viewport` takes `WIDTHxHEIGHT`, or one of `phone` (390x844), `tablet`
(820x1180), `desktop` (1280x800, the default), `wide` (1920x1080). When more
than one is given, the output name gains the viewport name:
`shot.png` becomes `shot.phone.png` and `shot.desktop.png`.

### Output

Data goes to stdout and diagnostics to stderr, always.

`screenshot` and `probe` return a **record about** a page, so they print a
table at a terminal and switch to JSON when stdout is not one — an agent gets
structured output without passing a flag.

`text` and `html` return the page **itself**, so they never switch: they print
the document whether stdout is a terminal, a pipe or a file. `browse text URL >
page.txt` produces a file containing the page and nothing else. A JSON object
with the page inside an escaped string field is not what anyone redirecting
`text` wants, and that is what an `isatty()`-only rule used to give them.

`--output json` overrides either way, and for `text`/`html` it is how you get
`final_url`, `status` and `blocked` alongside the document.

### Exit codes

A stable contract. An agent branches on these without parsing prose.

| Code | Meaning |
|---|---|
| 0 | fine |
| 1 | the page would not load: DNS, TLS, timeout, refused |
| 2 | chromium or playwright missing, or would not start |
| 3 | bad arguments |
| 4 | another `browse` is already running |
| 5 | a bug in `browse` itself; a traceback is on stderr. Retrying will not help |

Note that **exit 0 does not mean the page was whole.** A 404 stylesheet is a
successful navigation. See below.

## A half-rendered page is the failure mode worth worrying about

A page whose CSS was refused renders as unstyled text and looks like a bug in
the page. A screenshot that fails is harmless; a screenshot that succeeds and
misleads is not.

So every subresource that did not load is reported — in the JSON as `blocked`,
and on stderr in text mode, with the line *"The rendering above is incomplete.
Do not read it as the finished page."*

Two shapes of failure are caught, because a page can produce either. A CONNECT
that Squid refuses never becomes an HTTP response at all and appears as
`net::ERR_TUNNEL_CONNECTION_FAILED`; a plain-HTTP denial comes back as a `403`
the browser is perfectly happy with.

```
$ browse probe http://127.0.0.1:8742/
warning: 3 subresource(s) did not load:
 * stylesheet  net::ERR_TUNNEL_CONNECTION_FAILED  https://nonexistent.invalid/x.css
 * stylesheet  HTTP 404                           http://127.0.0.1:8742/missing.css
   fetch       HTTP 404                           http://127.0.0.1:8742/beacon.json
The 2 marked * affected what the page looks like. The rendering above is
incomplete — do not read it as the finished page.
status      200 OK
final_url   http://127.0.0.1:8742/
title       Local page
hosts       127.0.0.1:8742, nonexistent.invalid
blocked     3
```

**Only the `*` lines earn the loud sentence.** A healthy page may 404 a beacon
or an optional XHR by design, and "do not read this as the finished page"
printed over those is a warning an agent learns to skip — which costs exactly
the case the warning was written for. Everything is still listed, and
everything is still in the JSON with its `resource_type`.

A sub-frame counts. An iframe's navigation is a `document` request just as the
main page's is, so a `403` served into an iframe is reported; only the *main*
document is excluded, because its status is already reported as `status`.

## The navigation log

Every invocation, every navigation and every distinct host the page pulled from
is appended to a JSONL file with a timestamp. `--log` moves it for one run;
`BROWSE_LOG` moves it for good. `docker/run-container.sh` points it at
`$WORKSPACES/.browse/navigation.jsonl`, which is a mounted volume, so it
survives a container recreate.

**This is not for debugging.**

Squid stopped being a containment boundary on 2026-08-01, when egress went
default-allow; `squid/squid.conf` §5 says so in as many words — it is a kill
switch for named destinations and nothing more. (Most of the repo's prose has
not caught up with that and still says "allowlist" — Clawcius #75.) A browser
widens what "the agent reached a page" can mean, because a page fetches
whatever it likes, from wherever it likes, on the agent's behalf, and none of
that appears in anything the agent typed. A screenshot of one URL can contact
thirty hosts, and that second-order reach is what this file records.

The trade is the one the project already made for the host agent: **no
rollback, but a full record.** So it is written always, in full, line-buffered,
before the process can exit — a run killed mid-page still leaves the hosts it
had already contacted on disk, and a log that cannot be opened refuses the run
rather than browsing unlogged.

### What it is evidence of, exactly

A complete record of what **this tool** contacted. **Not** a record of what the
agent reached, and not an enforcement boundary standing in for one:

- `--log` is an ordinary flag and `BROWSE_LOG` an ordinary variable, so the
  party being recorded picks the destination. `--log /dev/null` browses
  silently.
- the file lives in the workspace, which the agent owns read-write.
- `curl` exists. An agent that wanted no record would not reach for `browse`.

What it gives you is a durable, fail-closed record of where a *cooperating*
agent's browser went. That is worth the volume mount, and it is genuinely the
evidence a later decision about egress would want. It is not proof that nothing
else happened, and **a decision not to narrow egress should not be taken on the
belief that it is.**

```
$ jq -r 'select(.event=="host") | "\(.ts)  \(.host)"' navigation.jsonl
$ jq -r 'select(.event=="navigate") | .url' navigation.jsonl
```

Events: `start`, `browser_started`, `navigate`, `navigation`, `host`,
`subresource_problem`, `screenshot`, `reaped`, `leaked_children`,
`browser_closed`, `error`, `finish`.

## Memory

**Measured 2026-08-16 in the hamachi container under gVisor: ~410 MB peak**,
against a container cap of 2 GB by default (`CLAWCIUS_CONTAINER_MEMORY`; this
instance runs at 3 GB). Taken as the trough in `MemAvailable` across a run,
which is what the OOM killer sees; a naive sum of per-process RSS reports
1.7 GB and is wrong, because it counts chromium's shared mappings once per
renderer.

A three-viewport full-page run measured **409 MB** — the same, because the
three renders share one browser. That is the whole reason `--viewport` repeats
rather than making you invoke `browse` three times.

Two browsers at once would not be slow, it would be an OOM kill somewhere
unrelated, so `browse` takes an exclusive lock and a second invocation **exits
4 immediately** rather than queueing. A queue would look like a hang with no
way to tell how long.

## Leaked processes

The browser is closed in a `finally`, and then checked.

Before that check existed, every invocation left exactly two `chrome-headless`
processes behind as zombies, reparented to pid 1. Not a memory leak — a zombie
holds no pages — but a **PID** leak, and the container runs with
`--pids-limit=512`. Two per run is the tool becoming unusable after a couple of
hundred screenshots, presenting weeks later as some unrelated `fork()` failing.

Chromium's helpers are orphaned when the Playwright driver exits, and pid 1
here is `sleep infinity`, which never calls `wait()`. A process cannot reap
another process's children, so `browse` sets `PR_SET_CHILD_SUBREAPER` before
launching: orphaned descendants reparent to *it* instead of pid 1, and it
waits them. Verified: 2 zombies per run before, 0 after.

That fix is per-tool and does not generalise — any other tool whose children
outlive it leaks pids the same way. The general fix is `docker run --init`:
Clawcius #74.

Anything still *alive* after `close()` is killed and printed loudly, because a
leak cleaned up silently is a leak nobody fixes. All of it is scoped to
descendants of this process — a crew shares this container and this uid, so
"kill every chromium owned by uid 1000" would kill a colleague's browser
mid-page.

## `--no-sandbox`

Normally the flag you stop and argue about. Here it is not one.

Chromium's own sandbox needs user namespaces and seccomp filters that gVisor
does not offer a nested process, so with it on, chromium dies at startup under
`runsc`. What it would have bought is already bought one layer out and more
thoroughly: **this whole container is a gVisor sandbox** on a network with no
gateway, so a compromised renderer escapes into a place that was already
assumed hostile. Turning it off does not widen anything.

Do not "fix" it by giving the container `SYS_ADMIN`.

`--disable-dev-shm-usage` is likewise not a tuning knob. `/dev/shm` is 64 MB
here (Docker's default) and chromium puts renderer shared memory there; without
the flag it does not report a small tmpfs, it renders a blank page.

## Installation

Unlike `discord-cli` and `gws-cli`, this is **not** stdlib-only and the mount
is **not** the install. Chromium is 400 MB of native binary and cannot be a
Python file. Two things must be baked into the image:

```
pip3 install playwright==1.62.0
playwright install --with-deps chromium     # into PLAYWRIGHT_BROWSERS_PATH
```

Both are in `docker/Dockerfile`, so **this needs an image rebuild**, which is
an operator action. `browse` exits 2 with a clear message if chromium is
missing, rather than failing somewhere further in.

`docker/run-container.sh` bind-mounts this directory read-only, so changes to
`browse` itself take effect immediately and need no rebuild.

## Tests

```
python3 browser-cli/test_browse.py
```

Browser-free on purpose: chromium only exists after a rebuild, so a suite that
needed it could not be run by the person writing the code. It covers the logic
that was actually got wrong during development — keyword collisions in the
audit log, double-counted subresources, viewport parsing — and pins the exit
codes and the two chromium flags that must not be removed.

The repo's `npm test` runs `node --test`, so this is not wired into it.

## Scope

Read-only rendering. There is no `click`, no `fill`, no cookie jar and no login
— that is Clawcius #11's scope note and it is deliberate. This is "look at what
I built", not a browsing agent.
