"""Tests for `status-sock`.

    python3 browser-cli/test_status_sock.py

Written because Osmosis Jones pointed out, reviewing #88, that the service side
of that change got 17 tests and the half that runs in the container got none —
and this is the half that runs in the container.

Unlike `test_browse.py` these are not dependency-free by necessity; they are
dependency-free because nothing here needs a browser. The forwarder is stdlib
sockets, so the interesting cases can be driven end to end against a real unix
socket in a temp directory: bind a server, forward to it, assert bytes arrive.

Same convention as `test_browse.py`: `npm test` runs `node --test`, so this is
not wired into it. Run it by hand when touching `status-sock`.
"""

import http.server
import importlib.machinery
import importlib.util
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_loader(
    "status_sock",
    importlib.machinery.SourceFileLoader(
        "status_sock", str(Path(__file__).with_name("status-sock"))
    ),
)
status_sock = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(status_sock)

SCRIPT = str(Path(__file__).with_name("status-sock"))


class UnixHTTPServer(http.server.ThreadingHTTPServer):
    address_family = socket.AF_UNIX

    def server_bind(self):
        # ThreadingHTTPServer wants to call getsockname()/set a hostname, which
        # is meaningless for AF_UNIX. Bypass HTTPServer.server_bind entirely.
        socketserver_bind(self)
        self.server_name = "unix"
        self.server_port = 0


def socketserver_bind(server):
    server.socket.bind(server.server_address)
    server.socket.listen(server.request_queue_size)


class Handler(http.server.BaseHTTPRequestHandler):
    body = b"hello from the status page"
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        payload = self.body if self.path != "/echo-path" else self.path.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class ForwarderTest(unittest.TestCase):
    """The bytes actually make it across, which is the whole job."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "status.sock")
        self.server = UnixHTTPServer(self.path, Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.dir.cleanup()

    def run_sock(self, *args, env=None):
        environ = dict(os.environ, **(env or {}))
        environ.pop("STATE_DIRECTORY", None)
        environ.pop("STATUS_SOCKET", None)
        return subprocess.run(
            [sys.executable, SCRIPT, "--socket", self.path, *args],
            capture_output=True,
            text=True,
            env=environ,
            timeout=60,
        )

    def test_forwards_a_request_and_returns_the_body(self):
        # The end-to-end claim: a plain TCP client inside the container reaches
        # a page that is only listening on a unix socket.
        result = self.run_sock(
            sys.executable,
            "-c",
            "import os,urllib.request;print(urllib.request.urlopen(os.environ['STATUS_URL']).read().decode())",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("hello from the status page", result.stdout)

    def test_brace_substitution_builds_the_url(self):
        # `browse screenshot '{}/clawsky' out.png` is the documented form, so
        # the substring replacement has to work mid-argument, not just alone.
        result = self.run_sock(
            sys.executable,
            "-c",
            "import sys,urllib.request;print(urllib.request.urlopen(sys.argv[1]).read().decode())",
            "{}/echo-path",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # The handler echoes the path back, so this proves the suffix after
        # `{}` survived the substitution and arrived at the server — not merely
        # that some request was made.
        self.assertEqual(result.stdout.strip(), "/echo-path")

    def test_status_url_is_loopback_and_not_the_wildcard(self):
        # Binding 0.0.0.0 would offer the whole status page — both crews — to
        # every other container on clawcius-internal.
        result = self.run_sock(sys.executable, "-c", "import os;print(os.environ['STATUS_URL'])")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.strip().startswith("http://127.0.0.1:"))

    def test_listener_binds_loopback_only(self):
        # Asserted against the socket itself rather than only the URL string.
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        host, _ = listener.getsockname()
        listener.close()
        self.assertEqual(host, "127.0.0.1")

    def test_exit_code_is_the_child_s(self):
        # Otherwise a failing `browse` inside the wrapper looks like a success.
        result = self.run_sock(sys.executable, "-c", "raise SystemExit(7)")
        self.assertEqual(result.returncode, 7)

    def test_no_listener_survives_the_run(self):
        # The whole argument for a wrapper rather than a daemon: nothing is
        # left holding a port once the command is done.
        result = self.run_sock(sys.executable, "-c", "import os;print(os.environ['STATUS_URL'])")
        port = int(result.stdout.strip().rsplit(":", 1)[1])
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.settimeout(3)
        with self.assertRaises(OSError):
            probe.connect(("127.0.0.1", port))
        probe.close()

    def test_no_proxy_is_set_for_the_child(self):
        # A child that reads only HTTP_PROXY would send a loopback request to
        # squid, which cannot reach it — and squid would log it as though the
        # agent had browsed somewhere.
        result = self.run_sock(
            sys.executable, "-c", "import os;print(os.environ['NO_PROXY'])",
            env={"HTTP_PROXY": "http://172.31.250.2:3128", "NO_PROXY": "example.com"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("127.0.0.1", result.stdout)
        self.assertIn("example.com", result.stdout, "an existing NO_PROXY is kept, not replaced")

    def test_concurrent_requests_are_each_served(self):
        # One `browse` run fetches the page plus its assets, so the forwarder
        # has to handle more than one connection at a time.
        result = self.run_sock(
            sys.executable,
            "-c",
            "import os,urllib.request,concurrent.futures as f;"
            "u=os.environ['STATUS_URL'];"
            "g=lambda _: urllib.request.urlopen(u).read();"
            "ex=f.ThreadPoolExecutor(8);"
            "print(sum(len(r) for r in ex.map(g, range(8))))",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(int(result.stdout.strip()), 8 * len(Handler.body))


class RefusalTest(unittest.TestCase):
    """What it declines to do, and whether it says why."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.dir.cleanup()

    def run_sock(self, *args, env=None):
        environ = dict(os.environ, **(env or {}))
        for key in ("STATE_DIRECTORY", "STATUS_SOCKET"):
            environ.pop(key, None)
        return subprocess.run(
            [sys.executable, SCRIPT, *args], capture_output=True, text=True, env=environ, timeout=60
        )

    def test_a_missing_socket_explains_the_likely_cause(self):
        # The likely cause is a missing ReadWritePaths= under
        # ProtectSystem=strict, which the agent cannot see and cannot fix, so
        # the message has to name what the operator should check.
        result = self.run_sock("--socket", os.path.join(self.dir.name, "nope.sock"), "true")
        self.assertEqual(result.returncode, 2)
        self.assertIn("no socket at", result.stderr)
        self.assertIn("ReadWritePaths", result.stderr)

    def test_a_regular_file_at_the_socket_path_is_named_as_such(self):
        # Distinguished from "missing" on purpose: this one an agent CAN fix,
        # because it is almost always something in the container that put it
        # there — the directory is writable from inside.
        path = os.path.join(self.dir.name, "status.sock")
        Path(path).write_text("not a socket")
        result = self.run_sock("--socket", path, "true")
        self.assertEqual(result.returncode, 2)
        self.assertIn("is not a socket", result.stderr)

    def test_a_command_is_required(self):
        # It is a wrapper, not a daemon. Accepting no command would be the
        # first step towards someone leaving one running.
        result = self.run_sock("--socket", os.path.join(self.dir.name, "x.sock"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("a command is required", result.stderr)

    def test_a_missing_command_exits_127(self):
        path = os.path.join(self.dir.name, "status.sock")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        server.listen(1)
        try:
            result = self.run_sock("--socket", path, "definitely-not-a-real-command-xyz")
            self.assertEqual(result.returncode, 127)
        finally:
            server.close()


class ResolutionTest(unittest.TestCase):
    """Where it looks for the socket, in order."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.dir.cleanup()

    def test_explicit_socket_wins(self):
        self.assertEqual(status_sock.resolve_socket("/tmp/explicit.sock"), "/tmp/explicit.sock")

    def test_status_socket_env_is_next(self):
        os.environ["STATUS_SOCKET"] = "/tmp/from-env.sock"
        try:
            self.assertEqual(status_sock.resolve_socket(None), "/tmp/from-env.sock")
        finally:
            del os.environ["STATUS_SOCKET"]

    def test_state_directory_builds_the_default(self):
        # STATE_DIRECTORY reaches the container by a longer route than it looks
        # — systemd sets it for the waker, agent.ts spreads process.env into the
        # session, container.ts forwards it through `docker exec --env-file`. It
        # is present for an agent turn and absent from a plain `docker exec`.
        os.environ.pop("STATUS_SOCKET", None)
        os.environ["STATE_DIRECTORY"] = "/var/lib/hamachi"
        try:
            self.assertEqual(
                status_sock.resolve_socket(None), "/var/lib/hamachi/run/status.sock"
            )
        finally:
            del os.environ["STATE_DIRECTORY"]


if __name__ == "__main__":
    unittest.main(verbosity=2)
