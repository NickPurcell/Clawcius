#!/usr/bin/env python3
"""A minimal Discord Gateway client: enough websocket to receive events, and
the whole of the connection lifecycle.

There is no dependency here on purpose. The websocket we need is one frame
shape in each direction -- masked text out, text/close/ping in -- and writing
those forty lines buys us the thing a library would hide: a read loop that
wakes on a deadline we choose, so a heartbeat is never queued behind a large
frame or a slow download.

The lifecycle is the actual substance. A gateway connection that is merely
"open" tells you nothing: the failure mode that matters is the ZOMBIE, where
TCP is perfectly healthy, the socket stays open, and no event will ever arrive
again. The only evidence is a heartbeat that was never ACKed, so that is what
this tracks and acts on. Everything else -- RESUME over re-IDENTIFY, the op 9
`d` flag, the close-code table -- exists to make a reconnect replay the events
we missed rather than silently skip them.
"""

import base64
import json
import logging
import os
import random
import select
import socket
import ssl
import struct
import threading
import time
from urllib.parse import urlparse

log = logging.getLogger("vidbot.gateway")

# GUILDS is not optional even though we never read a guild event: without it
# the gateway sends no guild context and MESSAGE_CREATE for a guild channel
# never arrives. MESSAGE_CONTENT (1<<15) is privileged: without it every
# message arrives with an empty content field. See _watch_content().
INTENT_GUILDS = 1 << 0
INTENT_GUILD_MESSAGES = 1 << 9
INTENT_MESSAGE_CONTENT = 1 << 15
INTENTS = INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT

# Ops we send or dispatch on.
OP_DISPATCH = 0
OP_HEARTBEAT = 1
OP_IDENTIFY = 2
OP_RESUME = 6
OP_RECONNECT = 7
OP_INVALID_SESSION = 9
OP_HELLO = 10
OP_HEARTBEAT_ACK = 11

# Close codes Discord will never let us back in for. Retrying these is not
# resilience, it is a hot loop against a permanent refusal, so they end the
# gateway attempt entirely and hand the caller a reason to report upward.
FATAL_CLOSE_CODES = {
    4004: "authentication failed -- the token is wrong",
    4010: "invalid shard",
    4011: "sharding required",
    4012: "invalid API version",
    4013: "invalid intents",
    4014: "disallowed intents -- MESSAGE_CONTENT is not enabled for this "
          "application in the Discord developer portal",
}

# Close codes that invalidate the session: reconnect, but IDENTIFY fresh rather
# than RESUME, because the server has forgotten the session we would resume.
SESSION_INVALID_CLOSE_CODES = {4007, 4009}

# Discord permits one IDENTIFY per 5s per max_concurrency bucket. Exceeding it
# is a 4008 and, repeated, a token reset. RESUME is not rate limited this way.
IDENTIFY_INTERVAL = 5.0

# How long a connection gets to produce READY or RESUMED before we treat it as
# broken. Generous: Discord is slow under load and a needless reconnect costs
# more than a wait.
HANDSHAKE_TIMEOUT = 60.0

# A frame larger than this is not something Discord sent us, so refusing it is
# cheaper than discovering the memory ceiling the hard way.
MAX_FRAME_BYTES = 16 * 1024 * 1024


class GatewayError(Exception):
    """A connection-level failure. Retryable unless `fatal` is set.

    `graceful` marks the ones that are not really failures at all: op 7 and
    op 9 are the server doing routine housekeeping, and Discord sends them to
    healthy bots on an ordinary day. Counting those toward the degrade
    threshold would have vidbot drop to polling for no reason at all.
    """

    def __init__(self, message, fatal=False, session_invalid=False,
                 graceful=False):
        super().__init__(message)
        self.fatal = fatal
        self.session_invalid = session_invalid
        self.graceful = graceful


class _WebSocket:
    """RFC 6455 client, only as much of it as the gateway uses.

    Reads are byte-buffered rather than frame-blocking: `pump()` takes a
    deadline, returns whatever complete messages have arrived by then, and
    leaves a partial frame in the buffer for next time. That is what lets the
    caller keep its heartbeat schedule while a large READY payload is still
    in flight.
    """

    def __init__(self, sock):
        self.sock = sock
        self._buf = b""
        self._frag_op = None
        self._frag = b""
        self.closed = False
        self.close_code = None
        self.close_reason = ""

    # -- construction ----------------------------------------------------

    @classmethod
    def connect(cls, url, proxy=None, timeout=30):
        parsed = urlparse(url)
        host = parsed.hostname
        port = parsed.port
        path = parsed.path or "/"
        query = "v=10&encoding=json"
        path = f"{path}?{query}" if "?" not in path else f"{path}&{query}"

        # ws:// is not something Discord offers; it exists so the lifecycle can
        # be driven against a local fake server, which is the only way to test
        # zombies, op 9 and close codes without waiting for Discord to produce
        # one.
        secure = parsed.scheme != "ws"
        if not port:
            port = 443 if secure else 80

        if proxy and secure:
            sock = cls._connect_via_proxy(host, port, proxy, timeout)
        else:
            sock = socket.create_connection((host, port), timeout=timeout)

        if secure:
            ctx = ssl.create_default_context()
            sock = ctx.wrap_socket(sock, server_hostname=host)

        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"User-Agent: DiscordBot (vidbot, 2.0)\r\n"
            f"\r\n"
        )
        sock.sendall(request.encode())

        head, rest = cls._read_http_head(sock)
        status = head.split("\r\n", 1)[0]
        if "101" not in status:
            sock.close()
            raise GatewayError(f"websocket upgrade refused: {status}")

        ws = cls(sock)
        ws._buf = rest
        # Blocking with a timeout, not non-blocking: select() tells us when to
        # read, and the timeout is only a backstop for the case where TLS needs
        # more bytes than select promised. A partial read is harmless because
        # framing is parsed out of the buffer, not off the wire.
        sock.settimeout(10)
        return ws

    @staticmethod
    def _connect_via_proxy(host, port, proxy, timeout):
        p = urlparse(proxy if "//" in proxy else "http://" + proxy)
        sock = socket.create_connection((p.hostname, p.port or 3128),
                                        timeout=timeout)
        req = (f"CONNECT {host}:{port} HTTP/1.1\r\n"
               f"Host: {host}:{port}\r\n")
        if p.username:
            token = base64.b64encode(
                f"{p.username}:{p.password or ''}".encode()).decode()
            req += f"Proxy-Authorization: Basic {token}\r\n"
        sock.sendall((req + "\r\n").encode())
        head, rest = _WebSocket._read_http_head(sock)
        status = head.split("\r\n", 1)[0]
        if " 200 " not in status:
            sock.close()
            raise GatewayError(f"proxy refused CONNECT: {status}")
        if rest:
            # A proxy that speaks before the tunnel is established is one we do
            # not understand; better to fail than to feed it into the TLS
            # handshake and get an inscrutable error.
            sock.close()
            raise GatewayError("proxy sent data before the tunnel opened")
        return sock

    @staticmethod
    def _read_http_head(sock):
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise GatewayError("connection closed during HTTP handshake")
            buf += chunk
            if len(buf) > 65536:
                raise GatewayError("HTTP response head too large")
        head, _, rest = buf.partition(b"\r\n\r\n")
        return head.decode("latin-1"), rest

    # -- sending ---------------------------------------------------------

    def send_json(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode())

    def _send_frame(self, opcode, data):
        mask = os.urandom(4)
        n = len(data)
        header = bytes([0x80 | opcode])
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += b"\xfe" + struct.pack(">H", n)
        else:
            header += b"\xff" + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(header + mask + masked)

    def close(self, code=1000, reason=""):
        """Send a close frame and drop the socket.

        The code matters: 1000 tells Discord the session is finished and it
        discards it, so a reconnect can only IDENTIFY. Any 4000-range code
        leaves the session resumable, which is why every internally-triggered
        reconnect here uses 4000.
        """
        if self.closed:
            return
        self.closed = True
        try:
            self._send_frame(0x8, struct.pack(">H", code) + reason.encode())
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    # -- receiving -------------------------------------------------------

    def pump(self, timeout):
        """Read for at most `timeout` seconds; return complete JSON messages.

        Raises GatewayError if the peer closes. Returning an empty list means
        the deadline passed with nothing complete, which is the normal case.
        """
        out = []
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            # Parse first: bytes may already be buffered from the last call,
            # or left over from the HTTP handshake.
            while True:
                msg = self._next_message()
                if msg is None:
                    break
                out.append(msg)
            remaining = deadline - time.monotonic()
            if out or remaining <= 0:
                return out
            if not self._read_some(remaining):
                return out

    def _pending(self):
        """Decrypted bytes TLS is holding that select() cannot see."""
        pending = getattr(self.sock, "pending", None)
        return pending() if pending else 0

    def _read_some(self, timeout):
        """Block up to `timeout` for bytes. False if nothing arrived."""
        try:
            ready, _, _ = select.select([self.sock], [], [], timeout)
        except (OSError, ValueError):
            raise GatewayError("socket went away")
        # An SSL socket can hold a decrypted record that select() cannot see,
        # so pending() is checked as a second source of readiness. Without this
        # the loop can sleep on a deadline while a whole frame sits in the TLS
        # buffer.
        if not ready and not self._pending():
            return False
        try:
            chunk = self.sock.recv(65536)
        except socket.timeout:
            return False
        except ssl.SSLWantReadError:
            return False
        except OSError as exc:
            raise GatewayError(f"read failed: {exc}")
        if not chunk:
            raise GatewayError("connection closed by peer")
        self._buf += chunk
        # Drain whatever else TLS already decrypted, so one select() wake does
        # not leave three frames sitting unread.
        while self._pending():
            try:
                more = self.sock.recv(65536)
            except (socket.timeout, ssl.SSLWantReadError):
                break
            if not more:
                break
            self._buf += more
        return True

    def _next_message(self):
        """Pop one complete application message, or None if incomplete."""
        while True:
            frame = self._next_frame()
            if frame is None:
                return None
            fin, opcode, payload = frame

            if opcode == 0x8:  # close
                code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else 1006
                reason = payload[2:].decode("utf-8", "replace")
                self.close_code, self.close_reason = code, reason
                self.closed = True
                try:
                    self.sock.close()
                except OSError:
                    pass
                raise GatewayError(f"gateway closed: {code} {reason}".strip(),
                                   fatal=code in FATAL_CLOSE_CODES,
                                   session_invalid=code in SESSION_INVALID_CLOSE_CODES)
            if opcode == 0x9:  # ping -> pong with the same payload
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong; the gateway's own liveness is op 11
                continue

            if opcode == 0x0:  # continuation
                if self._frag_op is None:
                    raise GatewayError("continuation frame with nothing to continue")
                self._frag += payload
            else:
                if self._frag_op is not None:
                    raise GatewayError("new data frame while a message was fragmented")
                self._frag_op, self._frag = opcode, payload

            if not fin:
                continue
            message_op, data = self._frag_op, self._frag
            self._frag_op, self._frag = None, b""
            if message_op != 0x1:
                # We never negotiate compression, so a binary frame means the
                # gateway is speaking a dialect we did not ask for. Guessing at
                # it would be worse than reconnecting.
                raise GatewayError(f"unexpected binary frame (opcode {message_op})")
            try:
                return json.loads(data)
            except ValueError as exc:
                raise GatewayError(f"gateway sent unparseable JSON: {exc}")

    def _next_frame(self):
        """Pop one raw frame off the buffer, or None if it is not all here."""
        buf = self._buf
        if len(buf) < 2:
            return None
        b1, b2 = buf[0], buf[1]
        fin = bool(b1 & 0x80)
        opcode = b1 & 0x0F
        if b2 & 0x80:
            raise GatewayError("server sent a masked frame")
        length = b2 & 0x7F
        offset = 2
        if length == 126:
            if len(buf) < 4:
                return None
            length = struct.unpack(">H", buf[2:4])[0]
            offset = 4
        elif length == 127:
            if len(buf) < 10:
                return None
            length = struct.unpack(">Q", buf[2:10])[0]
            offset = 10
        if length > MAX_FRAME_BYTES:
            raise GatewayError(f"refusing a {length} byte frame")
        if len(buf) < offset + length:
            return None
        payload = buf[offset:offset + length]
        self._buf = buf[offset + length:]
        return fin, opcode, payload


class GatewayClient:
    """Owns one gateway session and every reconnect that follows it.

    Runs on its own thread. Message dispatch goes out through `on_message`;
    connection state goes out through `on_state`, which is how the caller
    learns it should be polling instead.
    """

    def __init__(self, token, on_message, on_state=None, proxy=None,
                 gateway_url="wss://gateway.discord.gg",
                 max_failures=6, backoff_ceiling=64.0, channels=None):
        self._token = token
        self.on_message = on_message
        self.on_state = on_state or (lambda state, detail: None)
        self.proxy = proxy
        self.gateway_url = gateway_url
        self.max_failures = max_failures
        self.backoff_ceiling = backoff_ceiling
        self.channels = set(channels or ())

        self.stop_event = threading.Event()
        self.connected = threading.Event()

        # Session continuity. Held across reconnects; cleared only when the
        # server tells us the session is gone.
        self.session_id = None
        self.resume_url = None
        self.last_seq = None

        self._ws = None
        self._last_identify = 0.0
        self._failures = 0
        self._ready_at = None
        self.user_id = None
        self.fatal_reason = None

        # MESSAGE_CONTENT arriving empty is the failure that looks like
        # success. 4014 catches the usual case at IDENTIFY, but a mismatch
        # between what the portal grants and what we asked for can still leave
        # us connected and blind, so the content itself is watched too.
        self._empty_content = 0
        self._content_seen = False
        self.content_blind = False

    # -- public ----------------------------------------------------------

    def stop(self):
        self.stop_event.set()
        ws = self._ws
        if ws:
            ws.close(1000, "shutting down")

    def run(self):
        """Connect, and keep reconnecting, until stopped or out of patience."""
        while not self.stop_event.is_set():
            graceful = False
            try:
                self._session()
            except GatewayError as exc:
                graceful = exc.graceful
                if exc.session_invalid:
                    log.warning("gateway session invalidated: %s", exc)
                    self._forget_session()
                if exc.fatal:
                    code = self._ws.close_code if self._ws else None
                    self.fatal_reason = FATAL_CLOSE_CODES.get(code, str(exc))
                    log.error("gateway refused us permanently: %s", self.fatal_reason)
                    self.connected.clear()
                    self.on_state("fatal", self.fatal_reason)
                    return
                # stop() closes the socket underneath the reader, so a failed
                # read during shutdown is the shutdown working. Logging it as a
                # warning trains people to ignore warnings.
                if not self.stop_event.is_set():
                    log.warning("gateway connection lost: %s", exc)
            except Exception as exc:  # noqa: BLE001 - a live socket, anything goes
                if not self.stop_event.is_set():
                    log.warning("gateway connection failed: %s", exc)
            finally:
                self.connected.clear()
                if self._ws:
                    self._ws.close(4000, "reconnecting")
                    self._ws = None

            if self.stop_event.is_set():
                return

            # A session that carried events for a while is evidence the gateway
            # works, so it clears the failure count. A session that came up and
            # died in seconds is a flap and must still count toward giving up,
            # or a connect/drop loop would never degrade to polling. The clock
            # runs from READY, not from the connect attempt: a connect that
            # hangs for a minute and then fails is not a healthy session.
            healthy = bool(self._ready_at
                           and (time.monotonic() - self._ready_at) > 60)
            self._ready_at = None
            if healthy:
                self._failures = 0

            if graceful and healthy:
                # Routine housekeeping after a good long session. Straight back
                # in, and nothing held against the gateway's record.
                delay = 0.5 + random.random()
                log.info("server asked for a reconnect; back in %.1fs", delay)
            else:
                self._failures += 1
                if self._failures >= self.max_failures:
                    log.error("gateway failed %d times in a row; giving up on it",
                              self._failures)
                    self.on_state("exhausted",
                                  f"{self._failures} consecutive failures")
                    return
                # Jittered, so a gateway that drops every client at once does
                # not get all of them back in a synchronised herd. Clamped
                # AFTER the jitter, or the 1.5x upper jitter would push the
                # real ceiling to 96s while the constant claimed 64s.
                delay = (2 ** (self._failures - 1)) * (0.5 + random.random())
                delay = min(self.backoff_ceiling, delay)
                log.info("reconnecting in %.1fs (attempt %d/%d)",
                         delay, self._failures + 1, self.max_failures)

            self.on_state("reconnecting", f"in {delay:.1f}s")
            if self.stop_event.wait(delay):
                return

    # -- one connection --------------------------------------------------

    def _session(self):
        resuming = bool(self.session_id and self.last_seq is not None)
        url = (self.resume_url if resuming else self.gateway_url) or self.gateway_url
        log.info("connecting to %s (%s)", url, "resume" if resuming else "identify")

        self._ws = _WebSocket.connect(url, proxy=self.proxy)
        ws = self._ws

        hello = self._await_op(ws, OP_HELLO, timeout=20)
        interval = hello["d"]["heartbeat_interval"] / 1000.0

        if resuming:
            ws.send_json({"op": OP_RESUME, "d": {
                "token": self._token,
                "session_id": self.session_id,
                "seq": self.last_seq,
            }})
        else:
            self._identify(ws)

        # The first heartbeat goes out after a random fraction of the interval,
        # as the docs ask: every bot that reconnects after an outage would
        # otherwise heartbeat in lockstep forever.
        next_beat = time.monotonic() + interval * random.random()
        awaiting_ack = False
        handshake_deadline = time.monotonic() + HANDSHAKE_TIMEOUT

        while not self.stop_event.is_set():
            now = time.monotonic()

            # A socket that takes HELLO, accepts an IDENTIFY and then never
            # says READY is the zombie's cousin: heartbeats are ACKed, nothing
            # errors, and no event ever arrives. Without a deadline this loop
            # would sit there forever and the failure count would never move,
            # so the gateway could never be given up on.
            if not self.connected.is_set() and now > handshake_deadline:
                raise GatewayError(
                    f"no READY or RESUMED within {HANDSHAKE_TIMEOUT:.0f}s")

            if now >= next_beat:
                if awaiting_ack:
                    # The zombie. TCP is fine, the socket is open, and nothing
                    # will ever arrive again. Non-1000 so the session survives
                    # and the reconnect can RESUME the events we are missing.
                    raise GatewayError(
                        "heartbeat was never ACKed -- connection is a zombie")
                ws.send_json({"op": OP_HEARTBEAT, "d": self.last_seq})
                awaiting_ack = True
                next_beat = now + interval

            for payload in ws.pump(max(0.0, min(next_beat - time.monotonic(), 5.0))):
                op = payload.get("op")
                if payload.get("s") is not None:
                    self.last_seq = payload["s"]

                if op == OP_DISPATCH:
                    self._dispatch(payload)
                elif op == OP_HEARTBEAT_ACK:
                    awaiting_ack = False
                elif op == OP_HEARTBEAT:
                    # The server can ask for one out of band; answer at once
                    # and reset the schedule so we do not double up.
                    ws.send_json({"op": OP_HEARTBEAT, "d": self.last_seq})
                    awaiting_ack = True
                    next_beat = time.monotonic() + interval
                elif op == OP_RECONNECT:
                    raise GatewayError("server asked us to reconnect (op 7)",
                                       graceful=True)
                elif op == OP_INVALID_SESSION:
                    if payload.get("d") is True:
                        raise GatewayError("session invalid but resumable (op 9)",
                                           graceful=True)
                    self._forget_session()
                    # d:false means re-IDENTIFY, and the docs ask for a short
                    # random wait first so a fleet does not stampede.
                    if self.stop_event.wait(1 + random.random() * 4):
                        raise GatewayError("stopped")
                    raise GatewayError("session invalid, must re-identify (op 9)",
                                       graceful=True)
                elif op == OP_HELLO:
                    log.debug("unexpected second HELLO, ignoring")

        ws.close(1000, "shutting down")

    def _identify(self, ws):
        wait = IDENTIFY_INTERVAL - (time.monotonic() - self._last_identify)
        if wait > 0:
            log.debug("holding %.1fs for the identify rate limit", wait)
            if self.stop_event.wait(wait):
                raise GatewayError("stopped while waiting to identify")
        self._last_identify = time.monotonic()
        ws.send_json({"op": OP_IDENTIFY, "d": {
            "token": self._token,
            "intents": INTENTS,
            "properties": {"os": "linux", "browser": "vidbot", "device": "vidbot"},
        }})

    def _await_op(self, ws, want, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for payload in ws.pump(deadline - time.monotonic()):
                if payload.get("op") == want:
                    return payload
                log.debug("waiting for op %s, got op %s", want, payload.get("op"))
        raise GatewayError(f"timed out waiting for op {want}")

    # -- dispatch --------------------------------------------------------

    def _dispatch(self, payload):
        event = payload.get("t")
        data = payload.get("d") or {}

        if event == "READY":
            self.session_id = data.get("session_id")
            resume = data.get("resume_gateway_url")
            self.resume_url = resume or self.gateway_url
            user = data.get("user") or {}
            self.user_id = str(user.get("id") or "")
            log.info("gateway ready as %s (%s), %d guilds",
                     user.get("username", "?"), self.user_id,
                     len(data.get("guilds") or []))
            self._ready_at = time.monotonic()
            self.connected.set()
            self.on_state("ready", self.user_id)
            return

        if event == "RESUMED":
            log.info("gateway resumed at seq %s; missed events replayed",
                     self.last_seq)
            self._ready_at = time.monotonic()
            self.connected.set()
            self.on_state("resumed", str(self.last_seq))
            return

        if event != "MESSAGE_CREATE":
            return

        channel = str(data.get("channel_id") or "")
        content = data.get("content") or ""

        # Logged before the channel filter and by length rather than by value:
        # a message vidbot does not care about is still evidence that the
        # socket is live and that MESSAGE_CONTENT is actually arriving, which
        # is the one thing that cannot be inferred from a quiet log.
        log.debug("MESSAGE_CREATE %s in %s, %d chars of content",
                  data.get("id"), channel, len(content))

        if self.channels and channel not in self.channels:
            return

        self._watch_content(data, content)

        author = data.get("author") or {}
        self.on_message({
            "id": str(data.get("id") or ""),
            "channel_id": channel,
            "content": content,
            "author_id": str(author.get("id") or ""),
        })

    def _watch_content(self, data, content):
        """Notice the intent failure that presents as everything working.

        Without MESSAGE_CONTENT every message arrives with content as an empty
        string. Messages that are genuinely only an attachment or an embed look
        the same, so a single empty one proves nothing -- it takes a run of
        them, with nothing else in the message to explain it.
        """
        if self.content_blind or self._content_seen:
            return
        if content.strip():
            self._content_seen = True
            self._empty_content = 0
            return
        if data.get("attachments") or data.get("embeds") or data.get("sticker_items"):
            return
        self._empty_content += 1
        if self._empty_content >= 5:
            self.content_blind = True
            log.error("%d messages in a row arrived with empty content and "
                      "nothing to explain it. MESSAGE_CONTENT is almost "
                      "certainly not enabled for this application; vidbot "
                      "cannot see links and is blind on the gateway.",
                      self._empty_content)
            self.on_state("content_blind", "MESSAGE_CONTENT appears disabled")

    def _forget_session(self):
        self.session_id = None
        self.resume_url = None
        self.last_seq = None
