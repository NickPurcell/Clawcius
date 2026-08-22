# vidbot

Watches Discord channels for Twitter/X links and re-posts the video inline,
threaded under the message that carried the link.

## Running

```sh
./vidbotctl start     # idempotent; refuses to start a second copy
./vidbotctl status
./vidbotctl log 40
./vidbotctl stop      # SIGTERM, so the state file is flushed first
```

Configure via environment: `VIDBOT_CHANNELS` (space-separated ids),
`VIDBOT_INTERVAL` (seconds, default 6 — the fallback poll rate),
`VIDBOT_MAX_BYTES` (default 10 MiB, the unboosted-server ceiling — raise to
52428800 at boost tier 2), `VIDBOT_RECONCILE` (default 300).

`DISCORD_TOKEN` must be in the environment: the gateway needs it, and it is
read from there and nowhere else so it cannot appear in a process list or a
log. Without it the daemon logs the fact and polls.

## How messages arrive

Two paths, and the second one is why you can trust the first.

**Gateway.** A websocket to `gateway.discord.gg`, tunnelled through the egress
proxy with `CONNECT`, receiving `MESSAGE_CREATE` as it happens. It is
receive-only: every reply and upload still goes through the `discord` CLI, so
auth, rate limits and upload framing stay in one place. Videos appear in about
the time it takes to download them, rather than that plus up to six seconds.

**Poll.** The original `read --after <id>` cursor loop. It runs as a safety
net every `--reconcile-interval` (300s) while the gateway is healthy, on every
gateway (re)connect to cover the gap, and — at the full `--interval` rate — any
time the socket is not currently carrying events. Every gateway failure path
ends here rather than at a stopped bot.

Because both paths share the cursor and the `done` set, either can deliver a
message and the other will not duplicate it. The cursor only ever moves
forward, so a slow poll batch cannot rewind past what the gateway already
handled.

### The lifecycle, and why it is not three lines

A gateway connection that is merely *open* tells you nothing, so `gateway.py`
tracks the things that distinguish an open socket from a working one:

- **Heartbeats** every `heartbeat_interval`, the first after a random fraction
  of it, each carrying the last sequence number seen.
- **Zombie detection.** If a heartbeat falls due and the previous one was never
  ACKed, the connection is dead while looking perfectly healthy at the TCP
  layer — no error, no close, and no event ever again. It is closed with a
  non-1000 code (so the session stays resumable) and reconnected.
- **RESUME** using `session_id`, `resume_gateway_url` and the last `s`.
  Resuming replays the events missed during the gap; a fresh IDENTIFY replays
  nothing, and a missed event is a silently dropped video.
- **op 7 / op 9**, including the `d: true`/`false` distinction — resumable
  versus forget-the-session-and-re-identify after a short random wait.
- **Close codes.** 4007/4009 invalidate the session, so the reconnect
  identifies instead of resuming. 4004 and 4010-4014 are permanent refusals:
  retrying is a hot loop against a locked door, so they stop the gateway and
  hand the reason up to be reported.
- **Backoff** doubling to a 64s ceiling with jitter, degrading to polling after
  6 consecutive failures and retrying the gateway every 300s thereafter. op 7
  and op 9 after a healthy session are routine housekeeping and do not count
  toward that; a session that dies within 60s of READY does, so a flapping
  gateway still degrades instead of looping forever.

### MESSAGE_CONTENT

`MESSAGE_CONTENT` is a privileged intent. Without it every message arrives with
`content` as an empty string — vidbot sees no links, posts nothing, and looks
exactly like a bot watching a quiet channel. It is checked two ways: IDENTIFY
asks for the intent, so a disabled one is refused outright with close code
4014; and if a run of messages arrives empty with no attachment or embed to
explain it, that is logged as needing a human and written to the health file.
Only someone with the developer portal open can actually fix it.

## Health

`--health <path>` writes the current mode as JSON — `gateway`, `degraded`,
`gateway_reconnecting`, `polling` — with counts and a `needs_human` field.
`vidbotctl health` prints it. This exists because degrading to polling at 4am
is invisible otherwise: the bot still works, so nobody notices it is one
failure away from not working.

## Testing

```sh
python3 test_gateway.py     # lifecycle, against a fake gateway that misbehaves
python3 test_vidbot.py      # fallback, cursor, anchoring, dedupe
```

The lifecycle tests drive a scriptable fake gateway (`fakegateway.py`) that
produces zombies, op 7/9, close codes and mid-message fragmentation on cue.
Waiting for the real gateway to produce one of those is not a test strategy.

`--dry-run` does everything except post, which is how a second copy is tested
against a channel the real daemon still owns.

## A test is not evidence until it has been seen to fail

Write the test, then **reintroduce the bug and watch the test fail.** A test
that has only ever passed tells you nothing: it is equally consistent with
"the code is correct" and "the test does not touch the code".

This is not a general principle someone thought sounded good. Every line of it
was paid for during the gateway work, in two days:

- Six regression tests were written for six real bugs. **Four of them passed
  against the bug they were written for.** One raced the safety-net poll and
  the poll usually won. One asserted on message ids, which cannot distinguish
  "seen with its link" from "seen empty" — the entire distinction the bug was
  about. One stopped the daemon on the *first* message, so the shutdown
  exception propagated before the line under test was ever reached.
- The `--dry-run` guard was silent by luck rather than by design: two failure
  replies were gated on a different flag that happened to default off. Tests
  covered the safe direction and not the live one.
- `reply_with_file` had never once executed with posting enabled — not against
  Discord, not even against the fake CLI. The guard's falling-through direction
  was uncovered in every mode.
- While verifying one of the above, the broad `except` in `handle_message` was
  deleted by accident and **the entire suite still passed.** That is not a weak
  test; it is a whole path — failure counting and the 3-attempt abandonment —
  with no coverage at all, found only because something else broke it first.

### The procedure

**Mutate a copy, never the working tree.**

```sh
rm -rf /tmp/mut && mkdir /tmp/mut && cp *.py /tmp/mut/
cd /tmp/mut
# delete or invert exactly the line the fix added, then:
python3 -m unittest test_vidbot.TheTest.the_case   # must FAIL
```

The copy is not tidiness. Mutating the real file and restoring it afterwards
is how a half-applied edit survives: a deletion that took out one line more
than intended left `except Exception as exc:` missing from `handle_message`,
the restore copied the damage back over the good file, and the suite went on
reporting green over a daemon that could no longer count a failed download.

Two failure modes to watch for, both of which happened here:

- **The mutation silently did not apply.** A string that no longer matches
  makes the test "pass" against unmutated code. Assert the file actually
  changed before running anything.
- **The mutation applied and the test still passed.** That is the finding.
  The test is measuring something other than what its name claims, and the
  bug it was written for can come back freely.

Prefer driving the code directly over timing-dependent integration tests. The
cursor regression above is deterministic and runs in 0.3s precisely because it
calls `process()` and `poll_once()` in sequence instead of standing up a
daemon and hoping the gateway wins a race against the poll — which it does in
production, and did not on a loaded test machine.

## State

`run/state.json`, written atomically, holds three things:

- `cursors` — last message id seen per channel
- `done` — status ids already posted (capped at 5000)
- `attempts` — failure counts; a tweet is abandoned after 3

Dedupe is keyed on the **tweet status id**, not the URL, so the same tweet
posted as `x.com`, `twitter.com` and `fxtwitter.com` is uploaded once.

On a cold start the daemon anchors to the newest message and only acts on what
is said afterwards. It deliberately does not backfill; doing so would dump a
week of videos into the channel on first run.

If the state file is corrupt the daemon **exits** rather than starting cold,
because starting cold silently would re-post recent history.

## Size handling

`yt-dlp` is asked to prefer <=720p and smaller renditions up front. If the
result still exceeds the limit, `shrink()` re-encodes to a bitrate computed
from the clip duration (92% of the ceiling, less a 64 kbps audio track). If it
still does not fit, the upload is skipped rather than attempted and rejected.

## History

The egress proxy used to refuse every Twitter host with a 403, so `yt-dlp`
could not fetch anything and the whole chain was built against a stubbed
`fetch_video`. That was allowlisted and the download path has worked in
production since.

`gateway.discord.gg` was believed unreachable for the same reason, which is why
this polled for its first month. It is reachable: `CONNECT` to the proxy
returns `200 Connection established` and the TLS upgrade returns `101`.
