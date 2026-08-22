#!/usr/bin/env python3
"""Lifecycle tests, driven against a gateway that misbehaves on cue.

Every test here is a failure Discord produces rarely, at a time nobody chose,
and which is invisible from outside -- a zombie socket looks exactly like a
quiet channel. That is precisely the set of behaviours that cannot be checked
by running the bot and watching it, so they are checked here instead.
"""

import logging
import sys
import threading
import time
import unittest

import fakegateway as fake
import gateway
from fakegateway import FakeGateway, message, ready, resumed

logging.basicConfig(level=logging.CRITICAL)


class ClientHarness:
    """Runs a GatewayClient against a fake server on a background thread."""

    def __init__(self, server, **kwargs):
        self.messages = []
        self.states = []
        self.lock = threading.Lock()
        kwargs.setdefault("max_failures", 4)
        self.client = gateway.GatewayClient(
            token="test-token",
            on_message=self._on_message,
            on_state=self._on_state,
            proxy=None,
            gateway_url=server.url,
            **kwargs,
        )
        self.thread = threading.Thread(target=self.client.run, daemon=True)

    def _on_message(self, msg):
        with self.lock:
            self.messages.append(msg)

    def _on_state(self, name, detail):
        with self.lock:
            self.states.append(name)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.client.stop()
        self.thread.join(timeout=5)

    def wait_for(self, predicate, timeout=20, what="condition"):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if predicate():
                    return True
            time.sleep(0.02)
        raise AssertionError(f"timed out waiting for {what}; "
                             f"states={self.states} messages={self.messages}")


class GatewayLifecycleTest(unittest.TestCase):

    def setUp(self):
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.shutdown()

    def server(self, **kwargs):
        server = FakeGateway(**kwargs)
        self.servers.append(server)
        return server

    # -- the happy path --------------------------------------------------

    def test_identify_then_dispatch(self):
        server = self.server(scripts=[[
            ("send", ready()),
            ("send", message("100", "chan-1", "https://x.com/a/status/5")),
        ]])
        with ClientHarness(server) as h:
            h.wait_for(lambda: h.messages, what="a dispatched message")
            self.assertEqual(h.messages[0]["id"], "100")
            self.assertEqual(h.messages[0]["channel_id"], "chan-1")
            self.assertEqual(h.messages[0]["author_id"], "42")
            self.assertIn("x.com", h.messages[0]["content"])
            self.assertIn("ready", h.states)

        identify = server.identifies[0]
        self.assertEqual(identify["token"], "test-token")
        # Without MESSAGE_CONTENT the content field is empty and the bot is
        # blind, so the bit being set is load-bearing rather than incidental.
        self.assertTrue(identify["intents"] & gateway.INTENT_MESSAGE_CONTENT)
        self.assertTrue(identify["intents"] & gateway.INTENT_GUILD_MESSAGES)

    def test_channel_filter_drops_other_channels(self):
        server = self.server(scripts=[[
            ("send", ready()),
            ("send", message("1", "other", "https://x.com/a/status/1")),
            ("send", message("2", "mine", "https://x.com/a/status/2")),
        ]])
        with ClientHarness(server, channels={"mine"}) as h:
            h.wait_for(lambda: h.messages, what="the watched channel's message")
            time.sleep(0.5)
            self.assertEqual([m["id"] for m in h.messages], ["2"])

    def test_fragmented_message_with_interleaved_ping(self):
        """A long content split across frames, with a control frame mid-message.

        This is legal websocket and Discord does it on large payloads. Getting
        it wrong corrupts exactly the field we care about.
        """
        long_url = "https://x.com/someone/status/1234567890 " + "padding " * 50
        server = self.server(scripts=[
            [("send", ready()), ("fragment", message("7", "c", long_url))],
        ])
        with ClientHarness(server) as h:
            h.wait_for(lambda: h.messages, what="the reassembled message")
            self.assertEqual(h.messages[0]["content"], long_url)

    # -- heartbeats ------------------------------------------------------

    def test_heartbeats_are_sent_and_carry_the_sequence(self):
        server = self.server(heartbeat_interval=200, scripts=[[
            ("send", ready()),
            ("send", message("50", "c", "hello")),
            ("sleep", 2.0),
        ]])
        with ClientHarness(server) as h:
            h.wait_for(lambda: len(server.heartbeats) >= 3,
                       what="three heartbeats")
            # The last sequence number seen must ride along on the heartbeat;
            # it is what a RESUME would replay from.
            self.assertIsNotNone(server.heartbeats[-1][1])

    def test_zombie_connection_is_detected_and_resumed(self):
        """The one that matters.

        The server stops ACKing but leaves the socket open. Nothing at the TCP
        layer notices, no error is raised, and events simply stop. The client
        must spot the missing ACK, drop the connection itself, and come back --
        resuming, so the events it missed are replayed rather than skipped.
        """
        server = self.server(heartbeat_interval=200, scripts=[
            [("send", ready()), ("ignore_heartbeat",), ("sleep", 30)],
            [("send", resumed()),
             ("send", message("200", "c", "https://x.com/a/status/9"))],
        ])
        with ClientHarness(server) as h:
            h.wait_for(lambda: h.messages, timeout=25,
                       what="the message replayed after the zombie")
            self.assertEqual(h.messages[0]["id"], "200")

        self.assertEqual(server.connections, 2, "should have reconnected once")
        self.assertEqual(len(server.identifies), 1, "must not re-identify")
        self.assertEqual(len(server.resumes), 1, "must resume")
        self.assertEqual(server.resumes[0]["session_id"], "sess-1")
        self.assertIsNotNone(server.resumes[0]["seq"])

    # -- server-driven reconnects ----------------------------------------

    def test_op7_reconnect_resumes(self):
        server = self.server(scripts=[
            [("send", ready()), ("send", {"op": 7, "d": None})],
            [("send", resumed()), ("send", message("300", "c", "x"))],
        ])
        with ClientHarness(server) as h:
            h.wait_for(lambda: h.messages, what="the post-reconnect message")
            self.assertEqual(len(server.resumes), 1)
            self.assertEqual(len(server.identifies), 1)
            self.assertIn("resumed", h.states)

    def test_op9_resumable_resumes(self):
        server = self.server(scripts=[
            [("send", ready()), ("send", {"op": 9, "d": True})],
            [("send", resumed()), ("send", message("301", "c", "x"))],
        ])
        with ClientHarness(server) as h:
            h.wait_for(lambda: h.messages, what="the post-op9 message")
            self.assertEqual(len(server.resumes), 1)
            self.assertEqual(len(server.identifies), 1)

    def test_op9_not_resumable_reidentifies(self):
        """d:false means the session is gone. Resuming it would be refused
        forever, so the session must actually be forgotten."""
        server = self.server(scripts=[
            [("send", ready()), ("send", {"op": 9, "d": False})],
            [("send", ready("sess-2")), ("send", message("302", "c", "x"))],
        ])
        with ClientHarness(server) as h:
            h.wait_for(lambda: h.messages, timeout=25,
                       what="the message after re-identifying")
            self.assertEqual(len(server.resumes), 0, "must not try to resume")
            self.assertEqual(len(server.identifies), 2)

    def test_socket_dropped_without_close_frame_resumes(self):
        server = self.server(scripts=[
            [("send", ready()), ("drop", None)],
            [("send", resumed()), ("send", message("303", "c", "x"))],
        ])
        with ClientHarness(server) as h:
            h.wait_for(lambda: h.messages, what="recovery from a bare TCP drop")
            self.assertEqual(len(server.resumes), 1)

    def test_session_invalid_close_code_forces_reidentify(self):
        """4007 and 4009 mean the server has dropped the session; a RESUME
        would be refused, so the client must IDENTIFY instead."""
        server = self.server(scripts=[
            [("send", ready()), ("close", (4009, "session timed out"))],
            [("send", ready("sess-3")), ("send", message("304", "c", "x"))],
        ])
        with ClientHarness(server) as h:
            h.wait_for(lambda: h.messages, what="recovery from a 4009")
            self.assertEqual(len(server.resumes), 0)
            self.assertEqual(len(server.identifies), 2)

    def test_connection_that_never_readies_is_abandoned(self):
        """HELLO, IDENTIFY accepted, heartbeats ACKed -- and no READY, ever.
        Everything looks healthy and no event will ever arrive. Without a
        deadline the client would sit here forever and never degrade."""
        original = gateway.HANDSHAKE_TIMEOUT
        gateway.HANDSHAKE_TIMEOUT = 1.0
        try:
            server = self.server(scripts=[[("sleep", 30)],
                                          [("send", ready("sess-9")),
                                           ("send", message("600", "c", "x"))]])
            with ClientHarness(server) as h:
                h.wait_for(lambda: h.messages, timeout=25,
                           what="recovery from a connection that never readied")
                self.assertEqual(h.messages[0]["id"], "600")
        finally:
            gateway.HANDSHAKE_TIMEOUT = original

    # -- the ways this ends ----------------------------------------------

    def test_disallowed_intents_is_fatal_and_names_the_cause(self):
        """4014 is what a missing MESSAGE_CONTENT actually looks like at
        IDENTIFY, and only a human with the developer portal can fix it.
        Retrying is pointless; saying so is the whole value."""
        server = self.server(scripts=[[("close", (4014, "Disallowed intents"))]])
        with ClientHarness(server) as h:
            h.wait_for(lambda: "fatal" in h.states, what="a fatal verdict")
            h.thread.join(timeout=5)
            self.assertFalse(h.thread.is_alive(), "must stop, not retry")
            self.assertIn("MESSAGE_CONTENT", h.client.fatal_reason)
        self.assertEqual(server.connections, 1, "must not reconnect")

    def test_bad_token_is_fatal(self):
        server = self.server(scripts=[[("close", (4004, "Authentication failed"))]])
        with ClientHarness(server) as h:
            h.wait_for(lambda: "fatal" in h.states, what="a fatal verdict")
            self.assertIn("token", h.client.fatal_reason)
        self.assertEqual(server.connections, 1)

    def test_repeated_failure_gives_up_so_the_caller_can_degrade(self):
        """The fallback to polling depends on this returning rather than
        retrying forever. A gateway that never comes back must hand control
        back, not keep the bot hostage."""
        server = self.server()
        server.shutdown()  # nothing is listening now
        with ClientHarness(server, max_failures=3) as h:
            h.wait_for(lambda: "exhausted" in h.states, timeout=30,
                       what="the client to give up")
            h.thread.join(timeout=10)
            self.assertFalse(h.thread.is_alive())

    def test_flapping_connection_still_degrades(self):
        """A gateway that accepts and immediately drops is the nastiest case:
        every attempt 'succeeds'. If a short session reset the failure count
        the client would loop forever and never fall back."""
        scripts = [[("send", ready()), ("drop", None)] for _ in range(8)]
        server = self.server(scripts=scripts)
        with ClientHarness(server, max_failures=3) as h:
            h.wait_for(lambda: "exhausted" in h.states, timeout=30,
                       what="a flapping gateway to be given up on")

    def test_empty_content_run_is_reported_as_needing_a_human(self):
        """Connected, healthy, and blind. Every message arrives with content
        as an empty string, which reads as a quiet channel unless something
        is explicitly looking for it."""
        script = [("send", ready())]
        script += [("send", message(str(400 + i), "c", "")) for i in range(6)]
        server = self.server(scripts=[script])
        with ClientHarness(server) as h:
            h.wait_for(lambda: "content_blind" in h.states,
                       what="the blind-content diagnosis")
            self.assertTrue(h.client.content_blind)

    def test_attachment_only_messages_are_not_mistaken_for_blindness(self):
        """A photo with no caption is empty content and perfectly normal. The
        detector must not cry wolf on a channel full of memes."""
        script = [("send", ready())]
        script += [("send", message(str(500 + i), "c", "",
                                    attachments=[{"id": "a"}])) for i in range(8)]
        server = self.server(scripts=[script])
        with ClientHarness(server) as h:
            h.wait_for(lambda: len(h.messages) >= 8, what="all eight messages")
            time.sleep(0.3)
            self.assertFalse(h.client.content_blind)
            self.assertNotIn("content_blind", h.states)


class FrameCodecTest(unittest.TestCase):
    """The frame writer, checked against the shapes the length encoding picks."""

    def test_masking_and_length_encodings(self):
        import struct as _struct

        class Recorder:
            def __init__(self):
                self.data = b""

            def sendall(self, b):
                self.data += b

        for size in (5, 125, 126, 300, 70000):
            rec = Recorder()
            ws = gateway._WebSocket(rec)
            payload = b"y" * size
            ws._send_frame(0x1, payload)
            raw = rec.data
            self.assertEqual(raw[0], 0x81)
            self.assertTrue(raw[1] & 0x80, "client frames must be masked")
            length = raw[1] & 0x7F
            if size < 126:
                self.assertEqual(length, size)
                offset = 2
            elif size < 65536:
                self.assertEqual(length, 126)
                self.assertEqual(_struct.unpack(">H", raw[2:4])[0], size)
                offset = 4
            else:
                self.assertEqual(length, 127)
                self.assertEqual(_struct.unpack(">Q", raw[2:10])[0], size)
                offset = 10
            mask = raw[offset:offset + 4]
            body = raw[offset + 4:]
            self.assertEqual(len(body), size)
            self.assertEqual(
                bytes(b ^ mask[i % 4] for i, b in enumerate(body)), payload)


if __name__ == "__main__":
    unittest.main(verbosity=2, buffer=False)
