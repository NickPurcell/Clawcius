#!/usr/bin/env python3
"""Integration tests for the daemon around the gateway.

The gateway's own lifecycle is covered in test_gateway.py. What is checked here
is the promise made to whoever has to trust this thing at 4am: that a gateway
which cannot be had costs latency and nothing else, that the cursor cannot be
walked backwards by two writers, and that a cold start does not backfill.
"""

import json
import os
import tempfile
import threading
import time
import unittest
from argparse import Namespace
from pathlib import Path

import fakegateway as fake
import vidbot
from fakegateway import FakeGateway, message, ready


class FakeCLI:
    """Stands in for the `discord` CLI, backed by a list of messages.

    vidbot shells out for every read and every reply, so replacing the binary
    is the honest way to drive the poll path: the code under test is the same
    code that runs in production, argument parsing and all.
    """

    def __init__(self, tmpdir):
        self.dir = Path(tmpdir)
        self.store = self.dir / "messages.json"
        self.replies = self.dir / "replies.json"
        self.store.write_text("[]")
        self.replies.write_text("[]")
        self.path = self.dir / "fake-discord"
        self.path.write_text(SCRIPT.format(store=self.store, replies=self.replies))
        self.path.chmod(0o755)

    def post(self, msg_id, channel, content, author="42"):
        msgs = json.loads(self.store.read_text())
        msgs.append({"id": str(msg_id), "channel_id": channel,
                     "content": content, "author_id": author})
        self.store.write_text(json.dumps(msgs))

    def sent(self):
        return json.loads(self.replies.read_text())


SCRIPT = '''#!/usr/bin/env python3
import json, sys
from pathlib import Path
STORE = Path("{store}")
REPLIES = Path("{replies}")
argv = sys.argv[1:]
while argv and argv[0] in ("-o", "--output"):
    argv = argv[2:]
cmd = argv[0] if argv else ""
if cmd == "whoami":
    print(json.dumps({{"id": "me", "username": "vidbot"}}))
    sys.exit(0)
opts = {{}}
i = 1
while i < len(argv):
    if argv[i].startswith("-"):
        opts[argv[i]] = argv[i + 1] if i + 1 < len(argv) else ""
        i += 2
    else:
        i += 1
if cmd == "read":
    msgs = [m for m in json.loads(STORE.read_text())
            if m["channel_id"] == opts.get("-c")]
    after = opts.get("--after")
    if after:
        msgs = [m for m in msgs if int(m["id"]) > int(after)]
    msgs = msgs[-int(opts.get("-n", "100")):]
    print(json.dumps(list(reversed(msgs))))   # the CLI returns newest-first
    sys.exit(0)
if cmd == "reply":
    rec = json.loads(REPLIES.read_text())
    rec.append({{"channel": opts.get("-c"), "message": opts.get("-m"),
                "file": opts.get("-f"), "text": opts.get("-t")}})
    REPLIES.write_text(json.dumps(rec))
    print(json.dumps({{"id": "reply"}}))
    sys.exit(0)
sys.exit(2)
'''


class DaemonTestCase(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cli = FakeCLI(self.tmp.name)
        self.handled = []
        self.stop_after = None
        self.servers = []
        self.threads = []
        self.tearing_down = threading.Event()

        # The daemon only ever stops on a signal, so tests need the same exit:
        # once teardown starts, the next Discord read raises Stopped and every
        # loop unwinds through the path production actually uses.
        real_read = vidbot.Discord.read_after

        def guarded_read(inner, *a, **kw):
            if self.tearing_down.is_set():
                raise vidbot.Stopped("teardown")
            return real_read(inner, *a, **kw)

        self.real_read = real_read
        vidbot.Discord.read_after = guarded_read

        # Stand in for handle_message so no test ever reaches yt-dlp. What is
        # under test is which messages arrive and in what order, not what
        # happens to the video afterwards.
        self.real_handle = vidbot.handle_message

        def fake_handle(dc, state, channel, msg, args):
            self.handled.append(msg["id"])
            if self.stop_after and len(self.handled) >= self.stop_after:
                raise vidbot.Stopped("test finished")

        vidbot.handle_message = fake_handle

    def tearDown(self):
        self.tearing_down.set()
        for thread in self.threads:
            thread.join(timeout=10)
        vidbot.handle_message = self.real_handle
        vidbot.Discord.read_after = self.real_read
        for server in self.servers:
            server.shutdown()
        self.tmp.cleanup()

    def server(self, **kwargs):
        server = FakeGateway(**kwargs)
        self.servers.append(server)
        return server

    def make_args(self, **overrides):
        args = Namespace(
            channels=["chan"], interval=0.1, workdir=self.tmp.name,
            max_bytes=10 * 1024 * 1024, cli=str(self.cli.path),
            report_failures=False, once=False, no_gateway=False,
            gateway_url="ws://127.0.0.1:1", proxy=None,
            reconcile_interval=0.5, gateway_retry=1.0,
            gateway_max_failures=2, token="test-token",
            state=str(Path(self.tmp.name) / "state.json"), health=None,
        )
        for key, value in overrides.items():
            setattr(args, key, value)
        return args

    def run_daemon(self, args, timeout=30, then_post=()):
        """Anchor, then post, then start -- in that order.

        Anchoring is what stops a cold start backfilling, so anything posted
        before it is by definition history the daemon must ignore. A test that
        posts first and starts second is testing nothing at all.
        """
        state = vidbot.State(args.state)
        health = vidbot.Health(args.health)
        dc = vidbot.Discord(args.cli)
        vidbot.anchor_channels(dc, state, args)
        for post in then_post:
            self.cli.post(*post)
        error = {}

        def target():
            try:
                vidbot.run_daemon(dc, state, args, "me", health)
            except vidbot.Stopped:
                pass
            except Exception as exc:  # surfaced by the assertion below
                error["exc"] = exc

        thread = threading.Thread(target=target, daemon=True)
        self.threads.append(thread)
        thread.start()
        thread.join(timeout=timeout)
        if error:
            raise error["exc"]
        return thread, state, health

    # -- the promise -----------------------------------------------------

    def test_dead_gateway_degrades_to_polling_and_keeps_working(self):
        """The requirement that matters. No gateway anywhere, and the bot
        still picks up every message -- late, but picked up."""
        self.cli.post(1, "chan", "anchor")
        args = self.make_args()
        self.stop_after = 2

        thread, state, health = self.run_daemon(args, then_post=[
            (2, "chan", "https://x.com/a/status/111"),
            (3, "chan", "https://x.com/a/status/222"),
        ])
        self.assertFalse(thread.is_alive(), "daemon should have stopped")
        self.assertEqual(self.handled, ["2", "3"])
        # Not "degraded": the poll takes over from the first failed connect,
        # not from the moment the client gives up, so both messages land while
        # the gateway is still working through its backoff. That is the point
        # -- there is no window in which nothing is watching the channel.
        self.assertIn(health.mode, ("gateway_reconnecting", "degraded"))
        # 2, not 3: the run was stopped part-way through message 3, and the
        # cursor deliberately stays behind an unfinished message so a restart
        # retries it rather than stepping over it.
        self.assertEqual(state.cursors["chan"], "2")

    def test_gateway_delivers_without_waiting_for_a_poll(self):
        server = self.server()
        self.cli.post(1, "chan", "anchor")
        args = self.make_args(gateway_url=server.url,
                              reconcile_interval=3600,  # no poll can help here
                              interval=3600)
        self.stop_after = 1

        # Only the socket ever mentions this message; the fake CLI has no
        # record of it, so a poll could not possibly find it.
        server.scripts = [[("send", ready()),
                           ("send", message("77", "chan",
                                            "https://x.com/a/status/777"))]]
        thread, state, health = self.run_daemon(args)
        self.assertEqual(self.handled, ["77"])
        self.assertEqual(health.mode, "gateway")

    def test_reconcile_poll_catches_what_the_socket_missed(self):
        """A healthy gateway that simply never mentions a message. The safety
        net poll is the only thing standing between that and a lost video."""
        server = self.server(scripts=[[("send", ready())]])
        self.cli.post(1, "chan", "anchor")
        args = self.make_args(gateway_url=server.url, reconcile_interval=0.5)
        self.stop_after = 1

        thread, state, health = self.run_daemon(
            args, then_post=[(9, "chan", "https://x.com/a/status/999")])
        self.assertEqual(self.handled, ["9"])

    def test_gateway_recovers_after_degrading(self):
        """Degrading is not a one-way door: a gateway that comes back is used
        again without anyone restarting the bot."""
        server = self.server(scripts=[[
            ("send", ready()),
            ("send", message("88", "chan", "https://x.com/a/status/888")),
        ]])
        self.cli.post(1, "chan", "anchor")
        # Start pointed at nothing, then hand it a live gateway on the retry.
        args = self.make_args(gateway_url="ws://127.0.0.1:1",
                              gateway_retry=0.5, interval=0.2,
                              reconcile_interval=3600)
        self.stop_after = 1

        def flip():
            time.sleep(3.0)
            args.gateway_url = server.url

        threading.Thread(target=flip, daemon=True).start()
        thread, state, health = self.run_daemon(args, timeout=40)
        self.assertEqual(self.handled, ["88"])
        self.assertEqual(health.mode, "gateway")
        self.assertGreaterEqual(health.counts["degradations"], 1)

    def test_own_messages_are_skipped_but_advance_the_cursor(self):
        self.cli.post(1, "chan", "anchor")
        args = self.make_args()
        self.stop_after = 1

        thread, state, health = self.run_daemon(args, then_post=[
            (2, "chan", "https://x.com/a/status/1", "me"),
            (3, "chan", "https://x.com/a/status/2"),
        ])
        self.assertEqual(self.handled, ["3"], "must not process its own post")
        # The cursor sits at 2, not 3: the run was stopped mid-message, and
        # leaving the cursor behind an unfinished message is what makes the
        # restart retry it instead of losing it.
        self.assertEqual(state.cursors["chan"], "2")

    def test_own_message_still_advances_the_cursor(self):
        """Skipping vidbot's own upload must not leave the cursor stuck behind
        it, or every poll would re-read the same message forever."""
        state = vidbot.State(str(Path(self.tmp.name) / "cursor.json"))
        args = self.make_args()
        msg = {"id": "500", "channel_id": "chan", "content": "", "author_id": "me"}
        vidbot.process(None, state, "chan", msg, args, "me")
        self.assertEqual(state.cursors["chan"], "500")
        self.assertEqual(self.handled, [])

    def test_cold_start_does_not_backfill(self):
        """Anchoring exists because a restart once re-uploaded a channel's
        recent history. Nothing already said may be touched."""
        for i in range(1, 6):
            self.cli.post(i, "chan", f"https://x.com/a/status/{i}")
        args = self.make_args()
        state = vidbot.State(args.state)
        dc = vidbot.Discord(args.cli)
        vidbot.anchor_channels(dc, state, args)

        self.assertEqual(state.cursors["chan"], "5")
        vidbot.poll_once(dc, state, args, "me")
        self.assertEqual(self.handled, [], "a cold start must handle nothing")

    def test_restart_resumes_from_the_saved_cursor(self):
        self.cli.post(1, "chan", "anchor")
        args = self.make_args()
        state = vidbot.State(args.state)
        dc = vidbot.Discord(args.cli)
        vidbot.anchor_channels(dc, state, args)
        state.save()

        # Said while the daemon was down.
        self.cli.post(2, "chan", "https://x.com/a/status/1")
        reloaded = vidbot.State(args.state)
        self.assertEqual(reloaded.cursors["chan"], "1")
        vidbot.poll_once(dc, reloaded, args, "me")
        self.assertEqual(self.handled, ["2"])


class DryRunTest(unittest.TestCase):
    """--dry-run must mean no writes at all, not "no video uploads".

    The observer that proves the gateway works runs against live channels with
    real people in them, so silence is the entire basis on which it is allowed
    to exist. It was previously only enforced on the upload: both failure
    replies were gated on --report-failures alone, and the two flags together
    would have posted text into a channel from a copy meant to touch nothing.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cli = FakeCLI(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_dry_run_suppresses_every_write(self):
        dc = vidbot.Discord(str(self.cli.path), dry_run=True)
        dc.reply_text("chan", "1", "a failure report")
        dc.reply_with_file("chan", "1", Path(self.tmp.name) / "video.mp4")
        self.assertEqual(self.cli.sent(), [], "dry run must post nothing")

    def test_dry_run_still_reads(self):
        """Silence is about writes. A dry run that cannot read is not a test
        of anything."""
        dc = vidbot.Discord(str(self.cli.path), dry_run=True)
        self.cli.post(1, "chan", "hello")
        self.assertEqual(len(dc.read_after("chan")), 1)

    def test_without_dry_run_it_really_does_post(self):
        """The guard has to be the flag, not a broken code path."""
        dc = vidbot.Discord(str(self.cli.path), dry_run=False)
        dc.reply_text("chan", "1", "hi")
        self.assertEqual(len(self.cli.sent()), 1)


class PostingWiringTest(unittest.TestCase):
    """That the flag ARRIVES correctly, which is a different claim from the
    guard working.

    Moving the silence guard inside Discord bought safety at the cost of a new
    failure mode: dry_run True in production through a wiring mistake gives a
    daemon that connects, reads, matches, downloads, advances cursors and logs
    happily while posting nothing. Every symptom of health except the only one
    that counts. The tests below walk real argv through the real parser into a
    real Discord, because the parser and the vidbotctl wrapper are what changed
    tonight -- not the class the other tests pin.
    """

    BASE = ["-c", "123"]

    def build(self, extra=()):
        args = vidbot.build_parser().parse_args(self.BASE + list(extra))
        return vidbot.Discord(args.cli, dry_run=args.dry_run)

    def test_production_argv_posts(self):
        """No --dry-run anywhere in the real production argument list."""
        dc = self.build(["--interval", "6", "--reconcile-interval", "300",
                         "--health", "/tmp/h.json", "--max-bytes", "10485760"])
        self.assertFalse(dc.dry_run)
        self.assertEqual(vidbot.posting_banner(dc), vidbot.POSTING_ENABLED)

    def test_bare_argv_posts(self):
        dc = self.build()
        self.assertFalse(dc.dry_run, "posting must be the default")
        self.assertIn("ENABLED", vidbot.posting_banner(dc))

    def test_dry_run_argv_does_not_post(self):
        dc = self.build(["--dry-run"])
        self.assertTrue(dc.dry_run)
        self.assertEqual(vidbot.posting_banner(dc), vidbot.POSTING_DISABLED)

    def test_banner_reads_the_object_not_the_flag(self):
        """If the banner were taken from args it would agree with args and
        prove nothing. It has to describe the thing that refuses the upload."""
        dc = self.build()
        dc.dry_run = True          # as a wiring mistake would leave it
        self.assertEqual(vidbot.posting_banner(dc), vidbot.POSTING_DISABLED)

    def test_the_two_banners_are_distinguishable_by_grep(self):
        """install.sh asserts on these strings, so they must not be
        substrings of one another."""
        self.assertNotIn(vidbot.POSTING_DISABLED, vidbot.POSTING_ENABLED)
        self.assertNotIn(vidbot.POSTING_ENABLED, vidbot.POSTING_DISABLED)


class CursorTest(unittest.TestCase):
    """The cursor now has two writers, so it needs to be monotonic."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = vidbot.State(str(Path(self.tmp.name) / "state.json"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_cursor_only_moves_forward(self):
        vidbot.advance_cursor(self.state, "c", "100")
        self.assertEqual(self.state.cursors["c"], "100")
        vidbot.advance_cursor(self.state, "c", "200")
        self.assertEqual(self.state.cursors["c"], "200")
        # A poll batch that started before the gateway event finishes after it.
        vidbot.advance_cursor(self.state, "c", "150")
        self.assertEqual(self.state.cursors["c"], "200",
                         "a late writer must not rewind the cursor")

    def test_snowflakes_compare_numerically_not_lexically(self):
        """Snowflakes change length. String comparison puts a 19-digit id
        before a 20-digit one, which would rewind the cursor by months."""
        vidbot.advance_cursor(self.state, "c", "9999999999999999999")
        vidbot.advance_cursor(self.state, "c", "10000000000000000000")
        self.assertEqual(self.state.cursors["c"], "10000000000000000000")

    def test_non_numeric_cursor_is_replaced(self):
        self.state.cursors["c"] = "garbage"
        vidbot.advance_cursor(self.state, "c", "100")
        self.assertEqual(self.state.cursors["c"], "100")


if __name__ == "__main__":
    unittest.main(verbosity=2)
