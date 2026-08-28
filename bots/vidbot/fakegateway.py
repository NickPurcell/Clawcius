#!/usr/bin/env python3
"""A Discord gateway that misbehaves on request, for testing the client.

The lifecycle code exists entirely to survive things Discord does rarely and
unpredictably -- a zombie socket, an op 9, a 4014. Waiting for the real gateway
to produce one of those is not a test strategy, so this produces them on
demand, in order, in about a second.
"""

import base64
import json
import socket
import struct
import threading
import time


class FakeGateway:
    """A scriptable gateway. `script` is a list of (event, payload) steps.

    Steps run after IDENTIFY or RESUME is received:
        ("send", obj)          send a gateway payload
        ("close", (code, s))   send a websocket close frame
        ("drop", None)         close the TCP socket with no close frame
        ("sleep", seconds)     wait
        ("ignore_heartbeat",)  stop ACKing -- this is how a zombie is made
        ("fragment", obj)      send a payload split across two frames
    """

    def __init__(self, heartbeat_interval=300, scripts=None):
        self.heartbeat_interval = heartbeat_interval
        self.scripts = list(scripts or [])
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.url = f"ws://127.0.0.1:{self.port}"

        self.connections = 0
        self.identifies = []
        self.resumes = []
        self.heartbeats = []
        self.seq = 0
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def shutdown(self):
        self.stop.set()
        try:
            self.sock.close()
        except OSError:
            pass

    # -- wire ------------------------------------------------------------

    @staticmethod
    def _frame_bytes(opcode, data, fin=True):
        header = bytes([(0x80 if fin else 0x00) | opcode])
        n = len(data)
        if n < 126:
            header += bytes([n])
        elif n < 65536:
            header += b"\x7e" + struct.pack(">H", n)
        else:
            header += b"\x7f" + struct.pack(">Q", n)
        return header + data

    def _recv_frame(self, conn, buf):
        while True:
            if len(buf) >= 2:
                b1, b2 = buf[0], buf[1]
                masked = b2 & 0x80
                length = b2 & 0x7F
                off = 2
                ok = True
                if length == 126:
                    if len(buf) < 4:
                        ok = False
                    else:
                        length = struct.unpack(">H", buf[2:4])[0]
                        off = 4
                elif length == 127:
                    if len(buf) < 10:
                        ok = False
                    else:
                        length = struct.unpack(">Q", buf[2:10])[0]
                        off = 10
                if ok:
                    need = off + (4 if masked else 0) + length
                    if len(buf) >= need:
                        mask = buf[off:off + 4] if masked else b"\0\0\0\0"
                        start = off + (4 if masked else 0)
                        payload = bytes(
                            b ^ mask[i % 4]
                            for i, b in enumerate(buf[start:start + length]))
                        return (b1 & 0x0F, payload, buf[need:])
            chunk = conn.recv(65536)
            if not chunk:
                return (None, b"", buf)
            buf += chunk

    # -- protocol --------------------------------------------------------

    def _serve(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            index = self.connections
            self.connections += 1
            threading.Thread(target=self._handle, args=(conn, index),
                             daemon=True).start()

    def _handle(self, conn, index):
        peer = _Peer(self, conn)
        try:
            self._session(peer, index)
        except (OSError, ValueError):
            pass
        finally:
            peer.close()

    def _session(self, peer, index):
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = peer.conn.recv(4096)
            if not chunk:
                return
            buf += chunk
        buf = buf.partition(b"\r\n\r\n")[2]
        peer.raw(b"HTTP/1.1 101 Switching Protocols\r\n"
                 b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                 b"Sec-WebSocket-Accept: " +
                 base64.b64encode(b"x" * 20) + b"\r\n\r\n")

        peer.send({"op": 10, "t": None, "s": None,
                   "d": {"heartbeat_interval": self.heartbeat_interval}})

        script = self.scripts[index] if index < len(self.scripts) else []
        ack = threading.Event()
        ack.set()
        started = threading.Event()

        def reader():
            nonlocal buf
            while True:
                try:
                    opcode, payload, buf = self._recv_frame(peer.conn, buf)
                except OSError:
                    return
                if opcode is None or opcode == 0x8:
                    return
                if opcode != 0x1:
                    continue
                msg = json.loads(payload)
                op = msg.get("op")
                if op == 2:
                    self.identifies.append(msg["d"])
                    started.set()
                elif op == 6:
                    self.resumes.append(msg["d"])
                    started.set()
                elif op == 1:
                    self.heartbeats.append((index, msg.get("d"), time.time()))
                    if ack.is_set():
                        peer.send({"op": 11, "t": None, "s": None, "d": None})

        threading.Thread(target=reader, daemon=True).start()
        if not started.wait(timeout=15):
            return

        for step in script:
            action = step[0]
            arg = step[1] if len(step) > 1 else None
            if action == "send":
                peer.send(self._stamp(arg))
            elif action == "fragment":
                # Held under the peer lock for its whole length. A real server
                # never interleaves another data frame inside a fragmented
                # message, and a fake that does so tests nothing but itself.
                raw = json.dumps(self._stamp(arg)).encode()
                half = len(raw) // 2
                with peer.lock:
                    peer.frame(0x1, raw[:half], fin=False)
                    time.sleep(0.05)
                    peer.frame(0x9, b"ping-mid-message")  # legal mid-fragment
                    peer.frame(0x0, raw[half:], fin=True)
            elif action == "close":
                code, reason = arg
                peer.frame(0x8, struct.pack(">H", code) + reason.encode())
                time.sleep(0.2)
                return
            elif action == "drop":
                peer.close()
                return
            elif action == "sleep":
                time.sleep(arg)
            elif action == "ignore_heartbeat":
                ack.clear()
        # Nothing left to script: hold the connection open.
        while not self.stop.is_set():
            time.sleep(0.1)

    def _stamp(self, payload):
        self.seq += 1
        payload = dict(payload)
        payload.setdefault("s", self.seq if payload.get("op") == 0 else None)
        return payload


class _Peer:
    """One connection, with a lock so the script thread and the heartbeat
    ACKer cannot tear each other's frames in half."""

    def __init__(self, server, conn):
        self.server = server
        self.conn = conn
        self.lock = threading.RLock()

    def raw(self, data):
        with self.lock:
            self.conn.sendall(data)

    def frame(self, opcode, data, fin=True):
        self.raw(self.server._frame_bytes(opcode, data, fin))

    def send(self, obj):
        self.frame(0x1, json.dumps(obj).encode())

    def close(self):
        try:
            self.conn.close()
        except OSError:
            pass


def ready(session_id="sess-1", user_id="999"):
    return {"op": 0, "t": "READY", "d": {
        "session_id": session_id,
        "resume_gateway_url": None,
        "user": {"id": user_id, "username": "faketest"},
        "guilds": [],
    }}


def resumed():
    return {"op": 0, "t": "RESUMED", "d": {}}


def message(msg_id, channel, content, author="42", **extra):
    d = {"id": msg_id, "channel_id": channel, "content": content,
         "author": {"id": author, "username": "someone"}}
    d.update(extra)
    return {"op": 0, "t": "MESSAGE_CREATE", "d": d}
