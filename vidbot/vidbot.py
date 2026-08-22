#!/usr/bin/env python3
"""Watch Discord channels for Twitter/X links and re-post the videos inline.

Runs as a long-lived daemon. It polls over the REST API rather than holding a
gateway websocket, which is both sufficient here -- a few seconds of latency on
a video repost is not worth a persistent socket -- and necessary, since
gateway.discord.gg is not reachable from this container.

All Discord traffic goes through the `discord` CLI rather than raw HTTP, so
auth, rate-limit handling and upload framing stay in one place.
"""

import argparse
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

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

log = logging.getLogger("vidbot")


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
            "done": sorted(self.done)[-5000:],
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        os.replace(tmp, self.path)

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
    """Thin wrapper over the `discord` CLI."""

    def __init__(self, cli):
        self.cli = cli
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

    def reply_with_file(self, channel, message_id, path, text=None, max_bytes=None):
        cmd = [self.cli, "-o", "json", "reply", "-c", channel,
               "-m", message_id, "-f", str(path)]
        if text:
            cmd += ["-t", text]
        if max_bytes:
            cmd += ["--max-upload-bytes", str(max_bytes)]
        # Uploads are slow; give them their own, longer budget.
        return json.loads(run(cmd, timeout=300).stdout)

    def reply_text(self, channel, message_id, text):
        return json.loads(run(
            [self.cli, "-o", "json", "reply", "-c", channel,
             "-m", message_id, "-t", text]
        ).stdout)


def fetch_video(url, workdir, max_bytes):
    """Download the video for `url`, returning a path, or None if there is none.

    Prefers a smaller rendition up front rather than downloading 1080p and
    re-encoding it afterwards: the re-encode below is a fallback for when a
    short-but-dense clip still overshoots, not the normal path.
    """
    out_tmpl = str(Path(workdir) / "%(id)s.%(ext)s")
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        # Sort toward <=720p and smaller files before falling back to best.
        "-S", "res:720,+size",
        "--merge-output-format", "mp4",
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

    files = [p for p in Path(workdir).iterdir() if p.is_file()]
    if not files:
        return None
    video = max(files, key=lambda p: p.stat().st_size)
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

            dc.reply_with_file(channel, msg["id"], video,
                               max_bytes=args.max_bytes + 65536)
            state.done.add(status_id)
            state.attempts.pop(status_id, None)
            log.info("posted %s (%.1f MB)", status_id, size / 1048576)
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


def poll_once(dc, state, args, me_id):
    for channel in args.channels:
        cursor = state.cursors.get(channel)
        if cursor is None:
            # Cold start: anchor to the newest message and only act on what is
            # said from now on. Backfilling would spam the channel with videos
            # for links that were resolved by hand days ago.
            recent = dc.read_after(channel, limit=1)
            state.cursors[channel] = recent[-1]["id"] if recent else "0"
            log.info("channel %s anchored at %s", channel, state.cursors[channel])
            state.save()
            continue

        msgs = dc.read_after(channel, after=cursor)
        for msg in msgs:
            if msg.get("author_id") == me_id:
                state.cursors[channel] = msg["id"]
                continue
            try:
                handle_message(dc, state, channel, msg, args)
            except Stopped:
                raise
            except Exception:
                # One malformed message must never take the daemon down.
                log.exception("unhandled error on message %s", msg.get("id"))
            state.cursors[channel] = msg["id"]
            state.save()
        if msgs:
            state.save()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--channel", "-c", dest="channels", action="append",
                    required=True, help="Channel ID to watch. Repeatable.")
    ap.add_argument("--interval", type=float, default=6.0,
                    help="Seconds between polls. Default 6.")
    ap.add_argument("--state", default="~/.vidbot/state.json")
    ap.add_argument("--workdir", default="/tmp",
                    help="Where to stage downloads. Default /tmp.")
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ap.add_argument("--cli", default="/home/npurcell/clawcius/discord-cli/discord")
    ap.add_argument("--log", default=None, help="Log file. Default stderr.")
    ap.add_argument("--verbose", "-v", action="store_true")
    ap.add_argument("--report-failures", action="store_true",
                    help="Reply in-channel when a video cannot be posted.")
    ap.add_argument("--once", action="store_true",
                    help="Poll a single time and exit. For testing.")
    args = ap.parse_args()

    args.state = os.path.expanduser(args.state)
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

    state = State(args.state)
    dc = Discord(args.cli)
    me = dc.whoami()
    me_id = str(me.get("id") or me.get("user_id") or "")
    log.info("vidbot up as %s, watching %s every %.1fs",
             me.get("username", "?"), ",".join(args.channels), args.interval)

    try:
        while True:
            try:
                poll_once(dc, state, args, me_id)
            except Stopped:
                raise
            except Exception:
                # Network blips and CLI hiccups are expected; back off briefly
                # rather than exiting and losing the poll cursor's freshness.
                log.exception("poll failed; backing off")
                time.sleep(min(args.interval * 5, 60))
            if args.once:
                break
            time.sleep(args.interval)
    except Stopped as exc:
        log.info("shutting down (%s)", exc)
    finally:
        state.save()
        log.info("state saved to %s", args.state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
