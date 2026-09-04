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
    # Discord paginates differently depending on whether a cursor is given,
    # and the double has to model both or it lies about one of them. Verified
    # against the live API:
    #   with --after : the OLDEST page after the cursor, so a backlog DRAINS
    #                  (cursor 12 back, limit 3 -> the 3 immediately after it)
    #   without      : the NEWEST page, which is what cold-start anchoring
    #                  depends on to avoid backfilling a channel's history
    # The double previously took the newest page in both cases, which modelled
    # a backlog as permanently lossy when in fact it drains -- a regime this
    # design now deliberately enters, since the poll owns the cursor.
    limit = int(opts.get("-n", "100"))
    msgs = msgs[:limit] if after else msgs[-limit:]
    print(json.dumps(list(reversed(msgs))))   # the CLI returns newest-first
    sys.exit(0)
if cmd == "reply":
    rec = json.loads(REPLIES.read_text())
    rec.append({{"channel": opts.get("-c"), "message": opts.get("-m"),
                "file": opts.get("-f"), "text": opts.get("-t"),
                "no_nonce": "--no-nonce" in opts}})
    REPLIES.write_text(json.dumps(rec))
    print(json.dumps({{"id": "reply"}}))
    sys.exit(0)
sys.exit(2)
'''


class DaemonHarness(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cli = FakeCLI(self.tmp.name)
        self.handled = []
        self.seen = []          # (id, content) -- content is what matters here
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
            self.seen.append((msg["id"], msg.get("content") or ""))
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


class DaemonTestCase(DaemonHarness):

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
        dc.reply_with_file("chan", "1", Path(self.tmp.name) / "video.mp4")
        sent = self.cli.sent()
        self.assertEqual(len(sent), 2)
        self.assertTrue(all(r["no_nonce"] for r in sent), "a daemon's post must carry no agent stamp")


class CursorOwnershipTest(DaemonHarness):
    """The poll owns the cursor, so no gateway event can strand a message.

    Regression for the one case where "worst case equals the old behaviour"
    was false. The cursor is a high-water mark and read_after only looks
    forward, so anything it is dragged over is unreachable forever -- which
    made the poll a safety net for a TRAILING gap only, never an interior one.
    """

    def test_empty_content_event_does_not_strand_the_link(self):
        """MESSAGE_CONTENT disabled: the gateway sees "", REST sees the link.

        Driven directly rather than through wall-clock timing. An integration
        version of this is a race the poll usually wins, which makes it pass
        against the bug and prove nothing -- the failure only appears when the
        gateway gets there first, which is what it does in production, where
        the safety net is 300s behind it.

        The intent gates the gateway, not the API, so the poll finds this link
        over REST. The question is only whether the cursor still lets it look.
        """
        args = self.make_args()
        state = vidbot.State(args.state)
        dc = vidbot.Discord(args.cli)
        self.cli.post(1, "chan", "anchor")
        vidbot.anchor_channels(dc, state, args)
        self.assertEqual(state.cursors["chan"], "1")

        self.cli.post(2, "chan", "https://x.com/a/status/777")

        # The gateway delivers it first, blind, exactly as it does with the
        # intent switched off in the developer portal.
        vidbot.process(dc, state, "chan",
                       {"id": "2", "channel_id": "chan", "content": "",
                        "author_id": "42"},
                       args, "me", advance=False)
        self.assertEqual([c for _, c in self.seen if "x.com" in c], [],
                         "precondition: the gateway saw no link, as expected")

        # Now the safety net runs. It must still be able to reach message 2.
        vidbot.poll_once(dc, state, args, "me")

        self.assertTrue([c for _, c in self.seen if "x.com" in c],
                        "the poll could not reach a message the gateway had "
                        f"already stepped over; the video is lost. saw {self.seen}")

    def test_gateway_alone_does_not_move_the_cursor(self):
        """Pins the CALL SITE, not just process().

        Two messages, and the run stops on the SECOND. The first must be
        handled all the way through -- if it stops on the first, Stopped
        propagates out of process() before advance_cursor is reached and the
        test cannot tell the two behaviours apart. It passed against the bug
        for exactly that reason.
        """
        server = self.server(scripts=[[("send", ready()),
                                       ("send", message("500", "chan", "one")),
                                       ("send", message("501", "chan", "two"))]])
        self.cli.post(1, "chan", "anchor")
        args = self.make_args(gateway_url=server.url, reconcile_interval=3600,
                              interval=3600)
        self.stop_after = 2
        thread, state, health = self.run_daemon(args, timeout=25)
        self.assertEqual(self.handled, ["500", "501"])
        self.assertEqual(state.cursors["chan"], "1",
                         "only the poll may advance the cursor; the gateway "
                         "handled 500 to completion and must have left it")

    def test_a_backlog_larger_than_one_page_drains_completely(self):
        """Nothing covered a backlog over the page limit, and the poll now owns
        the cursor, so this regime is entered by design rather than by
        accident.

        The CLI caps --limit at 100, so one read is at most 100 messages. With
        a 300s reconcile interval that is a cursor throughput of one message
        per three seconds unless a pass keeps reading until it has caught up.
        Every message must be handled exactly once and the cursor must reach
        the end.
        """
        args = self.make_args()
        state = vidbot.State(args.state)
        dc = vidbot.Discord(args.cli)
        self.cli.post(1, "chan", "anchor")
        vidbot.anchor_channels(dc, state, args)

        for i in range(2, 252):                      # 250, well over one page
            self.cli.post(i, "chan", f"msg {i}")

        vidbot.poll_once(dc, state, args, "me")

        self.assertEqual(len(self.handled), 250,
                         f"only {len(self.handled)} of 250 drained in one pass")
        self.assertEqual(len(set(self.handled)), 250, "each exactly once")
        self.assertEqual(state.cursors["chan"], "251")

    def test_a_posted_video_is_persisted_immediately(self):
        """The property traded away to stop the write amplification.

        Cursor progress may be batched -- losing it costs a re-read, which
        `done` dedupes. `done` itself may NOT be: losing it re-posts a video
        someone has already seen. So a message that actually changed `done` or
        `attempts` must hit the disk before the next one is touched.
        """
        args = self.make_args()
        state = vidbot.State(args.state)
        saves = []
        real_save = vidbot.State.save
        vidbot.State.save = lambda self: (saves.append(len(self.done)),
                                          real_save(self))[1]
        try:
            # A message that changes nothing must not write.
            vidbot.handle_message = lambda dc, st, c, m, a: None
            vidbot.process(None, state, "chan",
                           {"id": "10", "channel_id": "chan", "content": "hi",
                            "author_id": "42"}, args, "me")
            self.assertEqual(saves, [], "a no-op message must not write state")

            # One that posts a video must write at once.
            vidbot.handle_message = lambda dc, st, c, m, a: st.done.add("777")
            vidbot.process(None, state, "chan",
                           {"id": "11", "channel_id": "chan", "content": "x",
                            "author_id": "42"}, args, "me")
            self.assertEqual(len(saves), 1, "a posted video must be persisted")
            self.assertIn("777", vidbot.State(args.state).done,
                          "and must survive a reload")
        finally:
            vidbot.State.save = real_save

    def test_a_backlog_of_noise_writes_once_per_page_not_once_per_message(self):
        """Draining lifted the one-page cap and multiplied a per-message save
        by fifty. A backlog is mostly messages with no link in them."""
        args = self.make_args()
        state = vidbot.State(args.state)
        dc = vidbot.Discord(args.cli)
        self.cli.post(1, "chan", "anchor")
        vidbot.anchor_channels(dc, state, args)
        for i in range(2, 252):
            self.cli.post(i, "chan", f"noise {i}")

        saves = []
        real_save = vidbot.State.save
        vidbot.State.save = lambda self: (saves.append(1), real_save(self))[1]
        try:
            vidbot.poll_once(dc, state, args, "me")
        finally:
            vidbot.State.save = real_save
        self.assertEqual(len(self.handled), 250)
        self.assertLessEqual(len(saves), 5,
                             f"{len(saves)} writes for 250 no-op messages")

    def test_a_retry_count_survives_a_restart(self):
        """attempts is incremented in place, so a length-based dirty check
        never saw 1 -> 2 and the retry cap did not survive a restart: every
        restart handed a dead link a fresh budget and the three-attempt
        abandonment never fired."""
        args = self.make_args()
        state = vidbot.State(args.state)
        vidbot.handle_message = lambda dc, st, c, m, a: st.attempts.__setitem__(
            "777", st.attempts.get("777", 0) + 1)
        msg = {"id": "5", "channel_id": "chan", "author_id": "42",
               "content": "https://x.com/a/status/777"}
        for _ in range(3):
            vidbot.process(None, state, "chan", dict(msg), args, "me")

        self.assertTrue(state.should_skip("777"))
        reloaded = vidbot.State(args.state)
        self.assertEqual(reloaded.attempts.get("777"), 3,
                         "the increment never reached disk")
        self.assertTrue(reloaded.should_skip("777"),
                        "a restart refreshed the retry budget of a dead link")

    def test_health_is_refreshed_during_a_long_drain(self):
        """The tick landed with no test at all -- deleting it left the whole
        suite green, which is the README's own rule pointed back at me. A long
        catch-up is precisely the incident the health file exists to describe,
        so it must not go stale for the length of one."""
        args = self.make_args()
        state = vidbot.State(args.state)
        dc = vidbot.Discord(args.cli)
        self.cli.post(1, "chan", "anchor")
        vidbot.anchor_channels(dc, state, args)
        for i in range(2, 352):                    # four pages
            self.cli.post(i, "chan", f"noise {i}")

        ticks = []
        health = vidbot.Health(None)
        health.tick = lambda: ticks.append(1)
        vidbot.poll_once(dc, state, args, "me", health)
        self.assertGreaterEqual(len(ticks), 3,
                                "health went unrefreshed across a multi-page "
                                f"drain ({len(ticks)} ticks)")

    def test_a_gateway_handled_message_is_not_posted_twice(self):
        """The poll re-reads what the gateway already did. state.done is what
        makes that safe, and it is the whole reason the cursor can lag."""
        state = vidbot.State(str(Path(self.tmp.name) / "dedupe.json"))
        state.done.add("777")
        self.assertTrue(state.should_skip("777"))


class ShutdownAndOnceTest(DaemonHarness):

    def test_stopped_is_not_swallowed_by_handle_message(self):
        """SIGTERM arrives during a download far more often than anywhere else
        -- that is where the daemon spends minutes inside yt-dlp. Stopped
        subclasses Exception, so the broad handler caught it: the daemon did
        not shut down (the signal handler only raises once) and it burned a
        retry on every link in the message for a download that never failed."""
        vidbot.handle_message = self.real_handle          # the real one
        args = self.make_args()
        state = vidbot.State(args.state)
        dc = vidbot.Discord(args.cli, dry_run=True)

        real_fetch = vidbot.fetch_video
        vidbot.fetch_video = lambda *a, **k: (_ for _ in ()).throw(
            vidbot.Stopped("signal 15"))
        try:
            msg = {"id": "9", "channel_id": "chan", "author_id": "42",
                   "content": "https://x.com/a/status/111 "
                              "https://x.com/b/status/222"}
            with self.assertRaises(vidbot.Stopped):
                vidbot.handle_message(dc, state, "chan", msg, args)
            self.assertEqual(state.attempts, {},
                             "a shutdown must not count as a failed attempt")
        finally:
            vidbot.fetch_video = real_fetch

    def test_a_failed_download_counts_an_attempt(self):
        """The broad handler in handle_message had no test at all.

        I discovered that by deleting it -- while verifying a different test --
        and watching all 26 pass. Without it, a failed download propagates out
        of handle_message instead of being counted, so attempts never reaches
        MAX_ATTEMPTS and the abandonment that exists to stop retrying a dead
        link forever never fires.
        """
        vidbot.handle_message = self.real_handle
        args = self.make_args()
        state = vidbot.State(args.state)
        dc = vidbot.Discord(args.cli, dry_run=True)
        real_fetch = vidbot.fetch_video
        vidbot.fetch_video = lambda *a, **k: (_ for _ in ()).throw(
            RuntimeError("yt-dlp exited 1"))
        try:
            msg = {"id": "9", "channel_id": "chan", "author_id": "42",
                   "content": "https://x.com/a/status/111"}
            for expected in (1, 2, 3):
                vidbot.handle_message(dc, state, "chan", msg, args)
                self.assertEqual(state.attempts.get("111"), expected)
            # Abandoned, so a dead link is not retried until the heat death of
            # the universe.
            self.assertTrue(state.should_skip("111"))
        finally:
            vidbot.fetch_video = real_fetch

    def test_an_ambiguous_upload_failure_retries_rather_than_losing(self):
        """Pins a trade, not an accident.

        `done` is recorded after the upload, so an upload that reached Discord
        but reported failure is retried and posted twice. Moving the id into
        `done` before the call makes it at-most-once and turns every genuinely
        failed upload into a silent loss -- the failure mode this design spent
        its whole effort removing. This test exists so that "fix" fails loudly
        rather than looking like a tidy-up.
        """
        vidbot.handle_message = self.real_handle
        args = self.make_args()
        state = vidbot.State(args.state)
        dc = vidbot.Discord(args.cli)

        real_fetch, real_reply = vidbot.fetch_video, dc.reply_with_file
        blob = Path(self.tmp.name) / "v.mp4"
        blob.write_bytes(b"x" * 32)
        vidbot.fetch_video = lambda *a, **k: blob

        landed = []

        def reply_then_fail(channel, message_id, path, **kw):
            landed.append(message_id)          # it really did reach Discord
            raise RuntimeError("Request to Discord timed out after 300.0s.")

        dc.reply_with_file = reply_then_fail
        try:
            msg = {"id": "2", "channel_id": "chan", "author_id": "42",
                   "content": "https://x.com/a/status/777"}
            vidbot.handle_message(dc, state, "chan", msg, args)
            self.assertEqual(state.attempts.get("777"), 1)
            self.assertNotIn("777", state.done,
                             "an upload reported as failed must stay retryable")
            # The poll re-reads it, which is the whole point of the cursor fix.
            vidbot.handle_message(dc, state, "chan", msg, args)
            self.assertEqual(landed, ["2", "2"], "retried, not silently dropped")
        finally:
            vidbot.fetch_video = real_fetch
            dc.reply_with_file = real_reply

    def test_once_exits_when_the_poll_fails(self):
        """--once against a broken CLI used to spin forever: the except branch
        ended in `continue`, which skipped the --once check below it."""
        args = self.make_args(once=True, interval=0.05, no_gateway=True)
        state = vidbot.State(args.state)
        health = vidbot.Health(None)

        calls = []
        real_poll = vidbot.poll_once

        def broken(*a, **k):
            calls.append(1)
            raise RuntimeError("discord CLI exited 1")

        vidbot.poll_once = broken
        try:
            done = threading.Event()
            threading.Thread(
                target=lambda: (vidbot.poll_loop(None, state, args, "me", health),
                                done.set()), daemon=True).start()
            self.assertTrue(done.wait(timeout=10),
                            "--once did not exit after a failed poll")
            self.assertEqual(len(calls), 1, "it should try exactly once")
        finally:
            vidbot.poll_once = real_poll


class HealthFileTest(unittest.TestCase):

    def test_concurrent_writes_always_publish_parseable_json(self):
        """set_mode runs on the gateway thread and tick on the main loop. They
        shared one .tmp path, so a shorter payload could land inside a longer
        one and os.replace would publish the wreckage -- during a reconnect
        storm, which is exactly when someone is catting it."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        health = vidbot.Health(str(Path(tmp.name) / "health.json"))
        stop = threading.Event()
        bad = []

        def churn(mode, detail):
            while not stop.is_set():
                health.set_mode(mode, detail)

        def read():
            while not stop.is_set():
                try:
                    json.loads(Path(health.path).read_text())
                except FileNotFoundError:
                    pass
                except ValueError:
                    bad.append(1)

        threads = [threading.Thread(target=churn, args=("gateway_reconnecting",
                                                        "in 12.4s"), daemon=True),
                   threading.Thread(target=churn, args=("gateway", ""), daemon=True),
                   threading.Thread(target=read, daemon=True)]
        for t in threads:
            t.start()
        time.sleep(3)
        stop.set()
        for t in threads:
            t.join(timeout=5)
        self.assertEqual(bad, [], f"{len(bad)} unparseable reads of the "
                                  "published health file")


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
        """Deployment checks grep the log for these, so neither may be a
        substring of the other -- otherwise a check for "will post" would
        match the line that says it will not."""
        self.assertNotIn(vidbot.POSTING_DISABLED, vidbot.POSTING_ENABLED)
        self.assertNotIn(vidbot.POSTING_ENABLED, vidbot.POSTING_DISABLED)


YTDLP = '''#!/usr/bin/env python3
"""A yt-dlp that answers a quote tweet the way X really does."""
import json, sys
from pathlib import Path

CONF = json.loads(Path("{conf}").read_text())

argv, opts, url = sys.argv[1:], {{}}, None
i = 0
while i < len(argv):
    if argv[i] == "--print-to-file":
        opts["--print-to-file"] = argv[i + 1:i + 3]
        i += 3
    elif argv[i].startswith("-") and i + 1 < len(argv) and not argv[i + 1].startswith("-"):
        opts[argv[i]] = argv[i + 1]
        i += 2
    else:
        url = url or (None if argv[i].startswith("-") else argv[i])
        i += 1

entries = [("own", CONF["own"]), ("quoted", CONF["quoted"])]
if opts.get("-I") == "1" and CONF["honour_selection"]:
    entries = entries[:1]

written = []
for name, size in entries:
    if not size:          # a text-only tweet: exit 0 having written nothing
        continue
    path = Path(opts["-o"].replace("%(id)s", name).replace("%(ext)s", "mp4"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\\0" * size)
    written.append(path)

if "--print-to-file" in opts:
    template, dest = opts["--print-to-file"]
    assert template == "after_move:filepath", template
    Path(dest).write_text("".join(str(p) + chr(10) for p in written))
sys.exit(0)
'''


class QuoteTweetTest(unittest.TestCase):
    """The double is a real binary on PATH rather than a patched vidbot.run, so
    these drive the argv that production builds, flags and all.
    """

    def fetch(self, own=1000, quoted=9000, honour_selection=True):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        bindir = Path(tmp.name) / "bin"
        bindir.mkdir()
        conf = Path(tmp.name) / "conf.json"
        conf.write_text(json.dumps({"own": own, "quoted": quoted,
                                    "honour_selection": honour_selection}))
        fake = bindir / "yt-dlp"
        fake.write_text(YTDLP.format(conf=conf))
        fake.chmod(0o755)

        path = os.environ["PATH"]
        self.addCleanup(os.environ.__setitem__, "PATH", path)
        os.environ["PATH"] = f"{bindir}{os.pathsep}{path}"

        self.workdir = Path(tmp.name) / "work"
        self.workdir.mkdir()
        return vidbot.fetch_video("https://x.com/v/status/2095387856332005501",
                                  str(self.workdir), 100_000_000)

    def test_the_tweets_own_video_is_the_one_returned(self):
        video = self.fetch()
        self.assertEqual(video.name, "own.mp4")
        self.assertEqual(video.stat().st_size, 1000)

    def test_only_the_first_entry_is_downloaded_at_all(self):
        self.fetch()
        got = sorted(p.name for p in self.workdir.iterdir())
        self.assertEqual(got, ["downloaded.txt", "own.mp4"])

    def test_the_larger_wrong_entry_still_loses_when_both_land(self):
        video = self.fetch(honour_selection=False)
        self.assertIn("quoted.mp4", [p.name for p in self.workdir.iterdir()],
                      "the double was meant to write both")
        self.assertEqual(video.name, "own.mp4")

    def test_a_tweet_with_no_video_is_still_none(self):
        video = self.fetch(own=0, quoted=0)
        self.assertIsNone(video)


class CursorTest(unittest.TestCase):
    """The cursor now has two writers, so it needs to be monotonic."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = vidbot.State(str(Path(self.tmp.name) / "state.json"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_own_message_from_the_gateway_does_not_move_the_cursor(self):
        """Even the bot's own post must not advance it from the socket, or the
        upload it just made would strand every message before it."""
        args = Namespace(channels=["chan"], workdir="/tmp", max_bytes=1,
                         cli="/bin/true", report_failures=False, dry_run=False)
        msg = {"id": "900", "channel_id": "chan", "content": "", "author_id": "me"}
        vidbot.process(None, self.state, "chan", msg, args, "me", advance=False)
        self.assertNotIn("chan", self.state.cursors)

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
