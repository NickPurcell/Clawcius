# browser-cli

`browse` — drive a headless Chromium from the command line, for the agent.

```
browse screenshot <url> <out.png> [--viewport SPEC ...] [--full-page] [--scale N]
browse text       <url>          # rendered text, after JavaScript has run
browse html       <url>          # serialised DOM, after JavaScript has run
browse probe      <url>          # final URL, status, redirects, hosts contacted
```

**The PNG is the point.** You can read an image file, so a screenshot on disk
is how you look at what you built before you say it is done.

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

`python3 -m unittest discover -s browser-cli -p 'test_*.py'`; the one test that needs
Chromium skips where it is missing. CI runs them.

## Scope

Read-only rendering. There is no `click`, no `fill`, no cookie jar and no login
— that is Clawcius #11's scope note and it is deliberate. This is "look at what
I built", not a browsing agent.
