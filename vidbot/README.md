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
`VIDBOT_INTERVAL` (seconds, default 6), `VIDBOT_MAX_BYTES` (default 10 MiB,
the unboosted-server ceiling — raise to 52428800 at boost tier 2).

## Why polling and not the gateway

A Discord bot normally holds a websocket to `gateway.discord.gg` and has
events pushed to it. That host is not reachable through this container's
egress proxy, so vidbot polls the REST API instead, using the `discord` CLI's
`read --after <id>` as a cursor.

This is not purely a workaround. Reposting a video is not latency-sensitive,
polling has no reconnect/resume state machine to get wrong, and a poll cursor
in a file survives a restart for free where a gateway session does not.

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

## Known blocker

Every Twitter host is refused by the egress proxy at `172.31.250.2:3128`:

```
403  x.com            403  video.twimg.com
403  twitter.com      403  pbs.twimg.com
403  api.twitter.com  403  abs.twimg.com
```

So `yt-dlp` cannot fetch anything and every download fails with
`Tunnel connection failed: 403 Forbidden`. Everything else — polling, dedupe,
link extraction, re-encode, upload, threading, restart recovery — is built and
tested. Allowlisting `x.com` and `video.twimg.com` is sufficient to make it
work; add `twitter.com` for old-style links.

The upload path was verified end-to-end against a synthetic clip by stubbing
`fetch_video`, so the only untested link in the chain is the download itself.
