#!/usr/bin/env python3
"""Watch Discord channels for Twitter/X links and re-post the videos inline.

Runs as a long-lived daemon. Messages arrive over the gateway websocket, which
gets a video posted about as fast as a human notices the link was pasted; the
REST poll that used to be the only path is still here, as the thing we fall
back to when the socket cannot be had.

The fallback is not decoration. A gateway is a single connection whose failure
modes are quiet -- a zombie socket reports nothing, a disallowed intent looks
exactly like a quiet channel -- so every one of those paths ends at the poll
loop rather than at a stopped bot. vidbot is allowed to be slower than it was.
It is not allowed to be less reliable.

Replies and uploads still go through the `discord` CLI, so auth, rate limits
and upload framing stay in one place. The gateway is receive-only.
"""

import argparse
import json
import logging
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gateway  # noqa: E402  (deliberately after the path fix-up)

# x.com and twitter.com serve the same tweets, and the mirror front-ends
# (fxtwitter, vxtwitter and friends) are what people actually paste when they
# want an embed to work. They all carry the status id in the same position, and
# that id -- not the URL -- is what we dedupe on, so the same tweet posted twice
# under two different hosts is still only uploaded once.
TWEET_RE = re.compile(
    r"https?://(?:www\.)?"
    r"(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)"
    r"/(?:[A-Za-z0-9_]{1,15})/status/(\d+)",
    re.IGNORECASE,
)

# Discord's own ceiling on an unboosted server. The CLI enforces this too, but
# knowing it here lets us re-encode down to fit instead of failing the upload.
DEFAULT_MAX_BYTES = 10 * 1024 * 1024

# After this many failed attempts a tweet is abandoned rather than retried on
# every poll. Videos get deleted and accounts go private; without a cap one
# dead link is retried until the heat death of the universe.
MAX_ATTEMPTS = 3

# How often the health file is rewritten while nothing else changes. Long
# enough that a busy channel is not a write per message, short enough that
# someone reading it during an incident is not reading last hour's numbers.
HEALTH_FLUSH_INTERVAL = 30.0

log = logging.getLogger("vidbot")


def _snowflake(value):
    """Sort key for Discord ids: numeric when it can be, stable when it cannot."""
    try:
        return (0, int(value), "")
    except (TypeError, ValueError):
        return (1, 0, str(value))


class Stopped(Exception):
    """Raised when a signal asks us to shut down mid-work."""


class State:
    """Poll cursors and per-tweet attempt counts, persisted across restarts.

    Written atomically. A daemon that is killed during a write should come back
    to the previous good state rather than to a truncated file it cannot parse,
    since the failure mode of an unparseable state file is re-posting every
    video in the channel's recent history.
    """

    def __init__(self, path):
        self.path = Path(path)
        self.cursors = {}   # channel id -> last message id seen
        self.attempts = {}  # status id  -> times we have tried and failed
        self.done = set()   # status ids already posted
        self._load()

    def _load(self):
        if not self.path.exists():
            log.info("no state file at %s, starting cold", self.path)
            return
        try:
            raw = json.loads(self.path.read_text())
        except (OSError, ValueError) as exc:
            # Refuse to silently start cold: that would re-upload history.
            raise SystemExit(
                f"state file {self.path} is unreadable ({exc}). Move it aside "
                f"to start fresh, but expect recent videos to be re-posted."
            )
        self.cursors = dict(raw.get("cursors", {}))
        self.attempts = dict(raw.get("attempts", {}))
        self.done = set(raw.get("done", []))
        log.info(
            "resumed: %d channel cursors, %d tweets already handled",
            len(self.cursors), len(self.done),
        )

    def save(self):
        payload = {
            "cursors": self.cursors,
            "attempts": self.attempts,
            # Bounded so the file cannot grow without limit on a busy channel.
            # Sorted numerically: these are snowflakes, and lexically a
            # 19-digit id sorts after a 20-digit one, so a lexical cap would
            # evict the newest entries the day ids grow a digit. Same hazard
            # as the cursor, one field over.
            "done": sorted(self.done, key=_snowflake)[-5000:],
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        os.replace(tmp, self.path)

    def fingerprint(self):
        """A cheap value that changes whenever something worth persisting does.

        Lives here rather than at the call site so that a field added to State
        has one obvious place to be registered. It deliberately does NOT
        include the cursors: losing cursor progress costs a re-read that `done`
        dedupes, and batching those writes is the entire point of asking.

        Lengths alone are not enough. `attempts` is incremented in place, so
        bumping an existing entry from 1 to 3 moves no length at all -- which
        silently un-persisted the retry cap and let every restart hand a dead
        link a fresh budget. The sum is what catches an increment.
        """
        return (len(self.done), len(self.attempts), sum(self.attempts.values()))

    def should_skip(self, status_id):
        return status_id in self.done or self.attempts.get(status_id, 0) >= MAX_ATTEMPTS


def best_error_line(blob):
    """Pick the most explanatory line out of a tool's output.

    The last line is a poor default: yt-dlp interleaves progress chatter with
    diagnostics, so a failed run often ends on something like "Downloading guest
    token" that says nothing about why it failed. Prefer a line the tool itself
    marked as an error, and only fall back to the tail.
    """
    lines = [ln.strip() for ln in (blob or "").strip().splitlines() if ln.strip()]
    if not lines:
        return "no output"
    for line in reversed(lines):
        if re.search(r"\b(ERROR|error:|Errno|refused|forbidden|timed out)\b",
                     line, re.IGNORECASE):
            return line
    return lines[-1]


def run(cmd, timeout=180, check=True):
    """Run a subprocess, returning completed process; log failures usefully."""
    log.debug("exec: %s", " ".join(str(c) for c in cmd))
    proc = subprocess.run(
        [str(c) for c in cmd],
        capture_output=True, text=True, timeout=timeout,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"{cmd[0]} exited {proc.returncode}: "
            + best_error_line((proc.stderr or "") + "\n" + (proc.stdout or ""))
        )
    return proc


class Discord:
    """Thin wrapper over the `discord` CLI.

    `dry_run` is enforced here rather than at the call sites, because a promise
    of silence is only worth anything if it cannot be forgotten. Gating each
    individual reply on the flag means the guarantee is only as good as the
    next person who adds a reply -- and there were already two, both gated on
    --report-failures alone, which would have posted text into a live channel
    from a copy whose whole purpose was to touch nothing.
    """

    def __init__(self, cli, dry_run=False):
        self.cli = cli
        self.dry_run = dry_run
        self._me = None

    def whoami(self):
        if self._me is None:
            out = run([self.cli, "-o", "json", "whoami"]).stdout
            self._me = json.loads(out)
        return self._me

    def read_after(self, channel, after=None, limit=100):
        """Messages newer than `after`, returned oldest-first.

        The CLI hands back newest-first, which is the wrong order for advancing
        a cursor: we want to process in the order things were said so that a
        crash halfway through leaves the cursor behind the unprocessed tail
        rather than in front of it.
        """
        cmd = [self.cli, "-o", "json", "read", "-c", channel, "-n", str(limit)]
        if after:
            cmd += ["--after", after]
        msgs = json.loads(run(cmd).stdout or "[]")
        return list(reversed(msgs))

    def _refuse(self, what, channel):
        log.info("DRY RUN: suppressed %s in channel %s", what, channel)
        return {"id": "dry-run", "dry_run": True}

    def reply_with_file(self, channel, message_id, path, text=None, max_bytes=None):
        if self.dry_run:
            return self._refuse(f"file upload of {Path(path).name}", channel)
        cmd = [self.cli, "-o", "json", "reply", "-c", channel,
               "-m", message_id, "-f", str(path)]
        if text:
            cmd += ["-t", text]
        if max_bytes:
            cmd += ["--max-upload-bytes", str(max_bytes)]
        # A daemon's post must not hold the agent's follow-up window open.
        cmd.append("--no-nonce")
        # Uploads are slow; give them their own, longer budget.
        return json.loads(run(cmd, timeout=300).stdout)

    def reply_text(self, channel, message_id, text):
        if self.dry_run:
            return self._refuse("text reply", channel)
        return json.loads(run(
            [self.cli, "-o", "json", "reply", "-c", channel,
             "-m", message_id, "-t", text, "--no-nonce"]
        ).stdout)


def fetch_video(url, workdir, max_bytes):
    """Download the video for `url`, returning a path, or None if there is none.

    Prefers a smaller rendition up front rather than downloading 1080p and
    re-encoding it afterwards: the re-encode below is a fallback for when a
    short-but-dense clip still overshoots, not the normal path.
    """
    manifest = Path(workdir) / "downloaded.txt"
    out_tmpl = str(Path(workdir) / "%(id)s.%(ext)s")
    cmd = [
        "yt-dlp",
        "--no-playlist",
        # A quote tweet is a two-entry playlist, the tweet's own video first;
        # --no-playlist leaves it alone.
        "-I", "1",
        "--no-warnings",
        "--no-progress",
        # Sort toward <=720p and smaller files before falling back to best.
        "-S", "res:720,+size",
        "--merge-output-format", "mp4",
        # The final path, after any merge, as yt-dlp reports it.
        "--print-to-file", "after_move:filepath", str(manifest),
        "-o", out_tmpl,
        url,
    ]
    proc = run(cmd, timeout=600, check=False)
    if proc.returncode != 0:
        blob = (proc.stderr or "") + (proc.stdout or "")
        if "No video could be found" in blob or "Unsupported URL" in blob:
            log.info("no video attached to %s", url)
            return None
        raise RuntimeError(best_error_line(blob))

    video = Path(manifest.read_text().splitlines()[0])
    if video.stat().st_size > max_bytes:
        video = shrink(video, max_bytes)
    return video


def shrink(path, max_bytes):
    """Re-encode `path` to land under `max_bytes`, or return it unchanged.

    Targets a total bitrate derived from the clip's duration with headroom for
    container overhead and audio. If it still does not fit we hand back the
    re-encoded file anyway and let the caller report the overflow -- a slightly
    smaller file that still fails is more useful to debug than a silent revert.
    """
    try:
        dur = float(run([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ]).stdout.strip())
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        log.warning("ffprobe failed on %s (%s); uploading as-is", path.name, exc)
        return path

    if dur <= 0:
        return path

    # 92% of the ceiling, minus a 64 kbps audio track, converted to video bits.
    budget_bits = max_bytes * 8 * 0.92
    video_bps = int(budget_bits / dur) - 64_000
    if video_bps < 100_000:
        log.warning("%s is too long to fit in %d bytes", path.name, max_bytes)
        return path

    out = path.with_name(path.stem + "_small.mp4")
    log.info("re-encoding %s to ~%d kbps", path.name, video_bps // 1000)
    try:
        run([
            "ffmpeg", "-y", "-i", str(path),
            "-c:v", "libx264", "-b:v", str(video_bps),
            "-preset", "veryfast", "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", "64k",
            str(out),
        ], timeout=900)
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        log.warning("re-encode failed (%s); uploading original", exc)
        return path
    return out if out.exists() and out.stat().st_size < path.stat().st_size else path


def handle_message(dc, state, channel, msg, args):
    """Process one message: find tweet links, upload any videos behind them."""
    content = msg.get("content") or ""
    seen = []
    for match in TWEET_RE.finditer(content):
        status_id, url = match.group(1), match.group(0)
        if status_id in seen:
            continue
        seen.append(status_id)

        if state.should_skip(status_id):
            log.debug("skipping %s (already handled or abandoned)", status_id)
            continue

        log.info("fetching %s from message %s", url, msg["id"])
        workdir = tempfile.mkdtemp(prefix="vidbot-", dir=args.workdir)
        try:
            video = fetch_video(url, workdir, args.max_bytes)
            if video is None:
                # Nothing to post is a success, not a failure: mark it done so
                # we do not re-check a text-only tweet on every future poll.
                state.done.add(status_id)
                continue

            size = video.stat().st_size
            if size > args.max_bytes:
                log.warning("%s is %d bytes, over the limit; skipping", url, size)
                if args.report_failures:
                    dc.reply_text(
                        channel, msg["id"],
                        f"That video is {size / 1048576:.1f} MB, past the "
                        f"{args.max_bytes / 1048576:.0f} MB upload limit.",
                    )
                state.done.add(status_id)
                continue

            if getattr(args, "dry_run", False):
                # Everything up to the upload, and then nothing. This is what
                # lets a second copy be tested against a live channel while the
                # real daemon is still serving it: same gateway, same download,
                # same decisions, no second video in the channel.
                log.info("DRY RUN: would post %s (%.1f MB) as a reply to %s",
                         status_id, size / 1048576, msg["id"])
                state.done.add(status_id)
                continue
            # `done` is recorded AFTER the upload, so an upload that lands on
            # Discord but reports failure -- the 300s timeout firing on a large
            # file that in fact completed -- is retried and posted twice.
            #
            # That is deliberate, and it is a trade rather than an oversight.
            # Recording the id before the call would make it at-most-once, at
            # the price of turning every genuinely failed upload into a silent
            # loss, which is the failure mode this whole design spent its
            # effort removing. A duplicate is visible and someone can delete
            # it; a video that never arrives is neither.
            #
            # It became reachable when the poll took ownership of the cursor:
            # before that the gateway advanced past the message and nothing
            # ever re-read it, so the same ambiguous failure lost the video
            # instead of duplicating it.
            dc.reply_with_file(channel, msg["id"], video,
                               max_bytes=args.max_bytes + 65536)
            state.done.add(status_id)
            state.attempts.pop(status_id, None)
            log.info("posted %s (%.1f MB)", status_id, size / 1048576)
        except Stopped:
            # Stopped subclasses Exception, and this is the site that matters:
            # it is where the daemon spends minutes inside yt-dlp, so a SIGTERM
            # almost always arrives here. Swallowed, it neither shut the daemon
            # down -- the handler only raises once -- nor left the tweet alone,
            # instead burning a retry on a download that never actually failed.
            raise
        except Exception as exc:
            n = state.attempts.get(status_id, 0) + 1
            state.attempts[status_id] = n
            log.warning("attempt %d/%d for %s failed: %s",
                        n, MAX_ATTEMPTS, status_id, exc)
            if n >= MAX_ATTEMPTS and args.report_failures:
                try:
                    dc.reply_text(channel, msg["id"],
                                  "I could not pull the video from that one.")
                except Exception:
                    log.exception("could not report the failure either")
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


def advance_cursor(state, channel, message_id):
    """Move a channel's cursor forward, and never backward.

    Two paths now write this cursor -- the gateway as events arrive, and the
    poll as it catches up -- and they can interleave. Assigning unconditionally
    would let a poll batch that started before a gateway event finish after it
    and rewind the cursor behind messages already handled, which on the next
    poll re-uploads them.
    """
    current = state.cursors.get(channel)
    try:
        if current is not None and int(message_id) <= int(current):
            return
    except (TypeError, ValueError):
        pass  # a non-numeric cursor is old or corrupt; let the new id win
    state.cursors[channel] = message_id


def anchor_channels(dc, state, args):
    """Cold-start anchoring, for both paths.

    Anchors to the newest message so a restart acts only on what is said from
    now on. Backfilling would spam the channel with videos for links that were
    resolved by hand days ago -- and does so most enthusiastically on a first
    run, which is exactly when someone is watching.
    """
    for channel in args.channels:
        if state.cursors.get(channel) is not None:
            continue
        recent = dc.read_after(channel, limit=1)
        state.cursors[channel] = recent[-1]["id"] if recent else "0"
        log.info("channel %s anchored at %s", channel, state.cursors[channel])
        state.save()


def process(dc, state, channel, msg, args, me_id, advance=True):
    """Handle one message. Only the poll is allowed to move the cursor.

    THE POLL OWNS THE CURSOR. A gateway event handles its message and then
    leaves the cursor alone, so the poll re-reads it later and `state.done`
    throws the duplicate away.

    That looks like redundant work and is in fact the only thing keeping the
    fallback honest. The cursor is a high-water mark and `read_after` only ever
    looks forward, so anything the cursor is dragged over is unreachable
    forever. When the gateway advanced it, the poll became a safety net for a
    TRAILING gap only -- it could catch up after a disconnect, but it could
    never revisit a message the socket had already delivered badly.

    The case that makes this concrete is the one _watch_content exists to
    detect: with MESSAGE_CONTENT disabled, every MESSAGE_CREATE arrives with
    content as an empty string. REST returns the real content -- the intent
    gates the gateway, not the API -- so the poll would have found the link and
    posted the video. Instead the gateway saw no link in an empty string,
    dragged the cursor past the message, and the video was gone: not delayed,
    gone, and still gone after a human fixes the developer portal.

    Detection needed five such messages before it fired. The cursor had already
    passed all five.

    The cost of the fix is re-reading up to one reconcile interval of messages
    after a restart, every one of which is deduped on the tweet status id.
    """
    if msg.get("author_id") == me_id:
        if advance:
            advance_cursor(state, channel, msg["id"])
        return
    # What must survive a crash is `done` and `attempts`: losing those re-posts
    # a video someone has already seen. Losing cursor progress only costs a
    # re-read, which `done` then dedupes -- so the cursor is saved per page by
    # the caller rather than per message.
    #
    # This used to save unconditionally, which was affordable when a pass was
    # one page. Draining lifted that cap and turned a 5000-message catch-up
    # into 5000 whole-state rewrites -- hundreds of megabytes of writes to say
    # nothing changed, since a backlog is mostly messages with no link in them.
    before = state.fingerprint()
    try:
        handle_message(dc, state, channel, msg, args)
    except Stopped:
        raise
    except Exception:
        # One malformed message must never take the daemon down.
        log.exception("unhandled error on message %s", msg.get("id"))
    if advance:
        # After the work, not before: a crash mid-download leaves the cursor
        # behind the message so the next poll retries it.
        advance_cursor(state, channel, msg["id"])
    if state.fingerprint() != before or not advance:
        # Something happened that must not be repeated, or we are on the
        # gateway path where this message is the whole batch.
        state.save()


# One read returns at most this many messages -- it is the CLI's ceiling on
# --limit as well as its default, so a single read cannot catch up on more.
PAGE = 100

# How many pages one pass will walk before giving up and leaving the rest for
# the next one. 50 pages is 5000 messages; past that something is wrong enough
# that grinding through it while holding the poll loop is not the right answer.
MAX_PAGES = 50


def poll_once(dc, state, args, me_id, health=None):
    """One pass over every channel, draining any backlog. Returns the count.

    Reads until it has caught up rather than taking a single page. Since the
    poll took ownership of the cursor, the cursor advances only here -- so one
    page per pass would cap it at 100 messages per --reconcile-interval, which
    at the 300s default is one message every three seconds. Above that rate the
    lag grows without bound and the poll's real job, revisiting messages the
    socket delivered badly, decays with it: a cursor 400 behind does not
    revisit a recent message for twenty minutes.

    Draining is safe because Discord paginates `after` forwards -- it returns
    the OLDEST page after the cursor, so successive reads walk toward the
    present instead of returning the same newest page forever.
    """
    seen = 0
    for channel in args.channels:
        if state.cursors.get(channel) is None:
            anchor_channels(dc, state, args)
            continue
        for _ in range(MAX_PAGES):
            msgs = dc.read_after(channel, after=state.cursors[channel], limit=PAGE)
            if not msgs:
                break
            for msg in msgs:
                process(dc, state, channel, msg, args, me_id)
                seen += 1
            state.save()
            # Inside the page loop, not after the pass: a long drain is exactly
            # the kind of incident someone reads the health file during, and a
            # 50-page catch-up outruns HEALTH_FLUSH_INTERVAL before it returns.
            if health is not None:
                health.tick()
            if len(msgs) < PAGE:
                # Short page: caught up. A full one means there may be more.
                break
        else:
            log.warning("channel %s still behind after %d pages; the rest "
                        "waits for the next pass", channel, MAX_PAGES)
    return seen


class Health:
    """What mode the daemon is in, written where a human can read it.

    The daemon cannot page anyone. When it degrades to polling at four in the
    morning the log says so, but nobody reads a log they have no reason to
    open, so the current mode also lands in a small JSON file next to it. The
    two states this exists to make visible are `degraded` -- gateway gone, poll
    carrying it -- and a MESSAGE_CONTENT problem, which only a human with the
    developer portal open can actually fix.
    """

    def __init__(self, path):
        self.path = Path(path) if path else None
        self.mode = "starting"
        self.detail = ""
        self.needs_human = None
        self.counts = {"gateway_messages": 0, "poll_messages": 0,
                       "reconnects": 0, "degradations": 0}
        self.since = time.time()
        self._last_write = 0.0
        # set_mode is called from the gateway thread and tick from the main
        # loop. Both wrote the same .tmp path, so a shorter payload could land
        # inside a longer one and os.replace would publish the wreckage --
        # exactly during a reconnect storm, which is when someone is most
        # likely to be reading it.
        self._lock = threading.Lock()

    def set_mode(self, mode, detail=""):
        if mode != self.mode:
            self.mode, self.since = mode, time.time()
        self.detail = detail
        self.write()

    def tick(self):
        """Flush the counters if they have gone stale.

        The mode changes rarely and the counters change constantly, so writing
        only on a mode change leaves a file that says `gateway` and zero
        messages while the bot is busily handling them -- which reads as a
        working connection delivering nothing, the exact failure this file
        exists to distinguish. Rate limited so a busy channel is not a write
        per message.
        """
        if time.monotonic() - self._last_write >= HEALTH_FLUSH_INTERVAL:
            self.write()

    def write(self):
        self._last_write = time.monotonic()
        if not self.path:
            return
        with self._lock:
            self._write_locked()

    def _write_locked(self):
        payload = {
            "mode": self.mode,
            "detail": self.detail,
            "since": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.since)),
            "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "needs_human": self.needs_human,
            "counts": self.counts,
        }
        try:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, indent=2))
            os.replace(tmp, self.path)
        except OSError as exc:
            log.debug("could not write health file: %s", exc)


def poll_loop(dc, state, args, me_id, health, until=None):
    """The original REST loop. Runs until `until` (monotonic) or forever."""
    while until is None or time.monotonic() < until:
        try:
            health.counts["poll_messages"] += poll_once(
                dc, state, args, me_id, health)
        except Stopped:
            raise
        except Exception:
            # Network blips and CLI hiccups are expected; back off briefly
            # rather than exiting and losing the poll cursor's freshness.
            log.exception("poll failed; backing off")
            time.sleep(min(args.interval * 5, 60))
            # Deliberately no `continue` here: it skipped the --once check
            # below, so a single pass against a broken CLI span forever
            # instead of exiting. Falling through is the whole fix.
        health.tick()
        if args.once:
            return
        time.sleep(args.interval)


def gateway_session(dc, state, args, me_id, health):
    """Run one gateway attempt to its end. Returns why it stopped.

    The gateway owns its own thread and does nothing but put messages on a
    queue. That separation is the point: a video download runs for minutes, and
    a heartbeat that waits behind one is a connection Discord has already
    written off. The socket thread must never do work that can block.
    """
    events = queue.Queue(maxsize=2000)
    reconcile = threading.Event()
    outcome = {"reason": None}

    def on_message(msg):
        try:
            events.put_nowait(msg)
        except queue.Full:
            # Safe to drop: the cursor has not advanced past anything we have
            # not processed, so the reconcile poll picks these up verbatim.
            log.warning("event queue full, dropping to the poll for catch-up")
            reconcile.set()

    connects = {"n": 0}

    def on_state(name, detail):
        if name in ("ready", "resumed"):
            health.set_mode("gateway", detail)
            connects["n"] += 1
            if connects["n"] > 1:
                # The first one is just starting up. Everything after it is a
                # connection that had to be rebuilt, which is the number worth
                # watching: a climbing count means a flaky socket long before
                # it climbs far enough to degrade.
                health.counts["reconnects"] += 1
            # Every (re)connect is a gap in coverage of unknown length. RESUME
            # replays what the gateway buffered, but the buffer is not
            # unbounded and a fresh IDENTIFY replays nothing at all, so the
            # authoritative catch-up is a poll from the cursor.
            reconcile.set()
        elif name == "reconnecting":
            health.set_mode("gateway_reconnecting", detail)
        elif name in ("fatal", "exhausted", "content_blind"):
            outcome["reason"] = detail
            if name in ("fatal", "content_blind"):
                health.needs_human = detail
            reconcile.set()

    client = gateway.GatewayClient(
        token=args.token,
        on_message=on_message,
        on_state=on_state,
        proxy=args.proxy,
        gateway_url=args.gateway_url,
        max_failures=args.gateway_max_failures,
        channels=args.channels,
    )
    thread = threading.Thread(target=client.run, name="gateway", daemon=True)
    thread.start()

    last_reconcile = 0.0
    try:
        while thread.is_alive():
            try:
                msg = events.get(timeout=1.0)
            except queue.Empty:
                msg = None
            if msg is not None:
                health.counts["gateway_messages"] += 1
                # advance=False: the poll owns the cursor. See process().
                process(dc, state, msg["channel_id"], msg, args, me_id,
                        advance=False)

            # While the socket is down -- backing off, reconnecting, or still
            # on its first attempt -- the poll is not a safety net, it is the
            # only path. Poll at the fast interval until the gateway says it
            # is carrying events again, so a reconnect costs no latency at all
            # rather than up to a reconcile interval of it.
            interval = (args.reconcile_interval if client.connected.is_set()
                        else args.interval)
            due = (time.monotonic() - last_reconcile) >= interval
            if reconcile.is_set() or due:
                reconcile.clear()
                last_reconcile = time.monotonic()
                try:
                    health.counts["poll_messages"] += poll_once(
                        dc, state, args, me_id, health)
                except Stopped:
                    raise
                except Exception:
                    log.exception("reconcile poll failed")
            health.tick()
            if client.content_blind:
                break
    finally:
        client.stop()
        thread.join(timeout=10)
        state.save()

    return outcome["reason"] or client.fatal_reason or "gateway stopped"


def run_daemon(dc, state, args, me_id, health):
    """Prefer the gateway; fall back to polling; keep trying to come back.

    Degrading is deliberately not permanent. A gateway that is unreachable now
    is often reachable in ten minutes, and the case that matters most --
    MESSAGE_CONTENT switched on in the portal while the daemon runs -- fixes
    itself here without anyone needing to remember to restart the bot.
    """
    # --once is a test of the poll path and always has been; a single pass over
    # a socket that waits for events to happen is not a meaningful thing to do.
    if args.no_gateway or args.once:
        log.info("polling every %.1fs", args.interval)
        health.set_mode("polling", "gateway disabled")
        return poll_loop(dc, state, args, me_id, health)

    while True:
        reason = gateway_session(dc, state, args, me_id, health)
        health.counts["degradations"] += 1
        log.error("=" * 70)
        log.error("GATEWAY DOWN: %s", reason)
        log.error("falling back to REST polling every %.1fs for %.0fs, then "
                  "retrying the gateway. vidbot is still working, just slower.",
                  args.interval, args.gateway_retry)
        if health.needs_human:
            log.error("THIS NEEDS A HUMAN: %s", health.needs_human)
        log.error("=" * 70)
        health.set_mode("degraded", reason)

        poll_loop(dc, state, args, me_id, health,
                  until=time.monotonic() + args.gateway_retry)
        log.info("retrying the gateway after %.0fs of polling", args.gateway_retry)
        health.set_mode("gateway_retry", "")


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--channel", "-c", dest="channels", action="append",
                    required=True, help="Channel ID to watch. Repeatable.")
    ap.add_argument("--interval", type=float, default=6.0,
                    help="Seconds between polls. Default 6.")
    ap.add_argument("--state", default="~/.vidbot/state.json")
    ap.add_argument("--workdir", default="/tmp",
                    help="Where to stage downloads. Default /tmp.")
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ap.add_argument("--cli", default="/srv/clawcius/current/discord-cli/discord")
    ap.add_argument("--log", default=None, help="Log file. Default stderr.")
    ap.add_argument("--verbose", "-v", action="store_true")
    ap.add_argument("--report-failures", action="store_true",
                    help="Reply in-channel when a video cannot be posted.")
    ap.add_argument("--once", action="store_true",
                    help="Poll a single time and exit. For testing.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Do everything except post. For testing a second "
                         "copy against a channel the real daemon still owns.")
    ap.add_argument("--no-gateway", action="store_true",
                    help="Skip the websocket entirely and poll, as before.")
    ap.add_argument("--gateway-url", default="wss://gateway.discord.gg")
    ap.add_argument("--proxy", default=None,
                    help="HTTPS proxy for the websocket. "
                         "Default: $HTTPS_PROXY.")
    ap.add_argument("--reconcile-interval", type=float, default=300.0,
                    help="Seconds between safety-net polls while the gateway "
                         "is up. Catches anything the socket did not deliver.")
    ap.add_argument("--gateway-retry", type=float, default=300.0,
                    help="Seconds to poll before retrying a failed gateway.")
    ap.add_argument("--gateway-max-failures", type=int, default=6,
                    help="Consecutive gateway failures before degrading.")
    ap.add_argument("--health", default=None,
                    help="Write current mode to this JSON file.")
    return ap


POSTING_ENABLED = "posting ENABLED -- replies and uploads will go to Discord"
POSTING_DISABLED = "DRY RUN -- will not post; no reply or upload will be sent"


def posting_banner(dc):
    """What this daemon will actually do, asked of the object that does it.

    Read off `dc.dry_run` rather than off the parsed flag on purpose. The
    guard now lives inside Discord, so a wiring mistake -- as opposed to a
    logic one -- would leave a daemon that connects, reads, matches links,
    downloads, advances cursors and logs contentedly while posting nothing:
    every symptom of health except the one that matters. A banner taken from
    the flag would agree with the flag and prove nothing; taken from the
    object, it is evidence about the thing that will refuse the upload.
    """
    return POSTING_DISABLED if dc.dry_run else POSTING_ENABLED


def main():
    args = build_parser().parse_args()

    args.state = os.path.expanduser(args.state)
    args.proxy = args.proxy or os.environ.get("HTTPS_PROXY") or \
        os.environ.get("https_proxy")
    # Read once, from the environment only. It is never an argument, so it
    # cannot end up in a process list, and never logged, so it cannot end up
    # in a file someone pastes into a channel.
    args.token = os.environ.get("DISCORD_TOKEN", "")
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        filename=args.log,
    )

    def stop(signum, _frame):
        raise Stopped(f"signal {signum}")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    if not args.token and not args.no_gateway:
        log.error("DISCORD_TOKEN is not set; the gateway needs it. Polling.")
        args.no_gateway = True

    state = State(args.state)
    health = Health(args.health)
    dc = Discord(args.cli, dry_run=args.dry_run)
    me = dc.whoami()
    me_id = str(me.get("id") or me.get("user_id") or "")
    log.info("vidbot up as %s, watching %s (%s)",
             me.get("username", "?"), ",".join(args.channels),
             "polling every %.1fs" % args.interval if args.no_gateway
             else "gateway, polling every %.0fs as a safety net"
                  % args.reconcile_interval)
    # Its own line, above debug level, every start. The one piece of state
    # whose failure mode is a daemon that looks completely healthy.
    if dc.dry_run:
        log.warning("%s", posting_banner(dc))
    else:
        log.info("%s", posting_banner(dc))

    # Anchor before either path starts. A gateway that connects first would
    # deliver live messages while the cursor was still unset, and the cold
    # start would then anchor ahead of them and lose them.
    anchor_channels(dc, state, args)

    try:
        run_daemon(dc, state, args, me_id, health)
    except Stopped as exc:
        log.info("shutting down (%s)", exc)
        health.set_mode("stopped", str(exc))
    finally:
        state.save()
        log.info("state saved to %s", args.state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
