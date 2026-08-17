"""Tests for the parts of `browse` that do not need a browser.

    python3 browser-cli/test_browse.py

Deliberately browser-free. Chromium only exists after an image rebuild, which
is an operator action, so a suite that needed it could not be run by the person
writing the code — and a test nobody can run is not a test. What is covered
here is the logic that was actually got wrong during development: keyword
collisions in the audit log, double-counted subresources, and viewport parsing.

The repo's `npm test` runs `node --test`, so this is not wired into it. Run it
by hand when touching `browse`; it takes well under a second.
"""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_loader(
    "browse",
    importlib.machinery.SourceFileLoader(
        "browse", str(Path(__file__).with_name("browse"))
    ),
)
browse = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(browse)


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "nested" / "nav.jsonl"
        self.audit = browse.Audit(self.path)

    def tearDown(self):
        self.audit.close()
        self.dir.cleanup()

    def lines(self):
        return [json.loads(l) for l in self.path.read_text().splitlines()]

    def test_creates_parent_directory(self):
        self.assertTrue(self.path.parent.is_dir())

    def test_field_named_kind_does_not_collide(self):
        """Regression. `event()` took the event name as a normal positional
        parameter, so a field called `kind` raised "got multiple values for
        argument 'kind'" from inside a Playwright listener and surfaced as a
        TypeError on an unrelated later call. The `/` in the signature is the
        fix and this is what pins it."""
        self.audit.event("subresource_problem", url="u", reason="r", kind="failed")
        record = self.lines()[0]
        self.assertEqual(record["event"], "subresource_problem")
        self.assertEqual(record["kind"], "failed")

    def test_framing_fields_are_not_overridable(self):
        self.audit.event("start", ts="nonsense", pid="nonsense", event="nonsense")
        record = self.lines()[0]
        self.assertEqual(record["event"], "start")
        self.assertNotEqual(record["ts"], "nonsense")
        self.assertEqual(record["pid"], os.getpid())

    def test_unserialisable_field_does_not_lose_the_line(self):
        self.audit.event("odd", thing=object())
        self.assertEqual(len(self.lines()), 1)

    def test_each_line_is_flushed_immediately(self):
        """The audit must survive the process being killed mid-page."""
        self.audit.event("start", url="x")
        self.assertEqual(len(self.lines()), 1)

    def test_host_recorded_once_then_counted(self):
        for _ in range(3):
            self.audit.saw_host("https://example.com/a")
        self.audit.saw_host("https://example.com/b")
        self.audit.saw_host("https://other.example/c")
        events = [l for l in self.lines() if l["event"] == "host"]
        self.assertEqual([e["host"] for e in events], ["example.com", "other.example"])
        self.assertEqual(self.audit.hosts, {"example.com": 4, "other.example": 1})

    def test_non_network_urls_are_not_hosts(self):
        for url in ("data:text/html,hi", "about:blank", "blob:xyz"):
            self.audit.saw_host(url)
        self.assertEqual(self.audit.hosts, {})

    def test_port_is_part_of_the_host(self):
        self.audit.saw_host("http://127.0.0.1:8731/")
        self.assertIn("127.0.0.1:8731", self.audit.hosts)

    def test_unwritable_log_is_a_validation_error(self):
        with self.assertRaises(browse.BrowseError) as caught:
            browse.Audit("/proc/definitely/not/writable/nav.jsonl")
        self.assertEqual(caught.exception.code, browse.VALIDATION_ERROR)


class ProblemTest(unittest.TestCase):
    """A blocked subresource must be reported, and reported once."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.audit = browse.Audit(Path(self.dir.name) / "nav.jsonl")
        self.load = browse.Load("https://example.com")

    def tearDown(self):
        self.audit.close()
        self.dir.cleanup()

    def test_first_reason_wins_for_one_url(self):
        """A 404 stylesheet reports twice: once as the HTTP response and again
        as ERR_ABORTED. Two entries would overstate how broken the page is."""
        browse._record_problem(self.load, self.audit, "/a.css", "HTTP 404", "http_error")
        browse._record_problem(self.load, self.audit, "/a.css", "net::ERR_ABORTED", "failed")
        self.assertEqual(len(self.load.problems), 1)
        self.assertEqual(self.load.problems[0]["reason"], "HTTP 404")

    def test_distinct_urls_are_separate(self):
        browse._record_problem(self.load, self.audit, "/a.css", "HTTP 404", "http_error")
        browse._record_problem(self.load, self.audit, "/b.js", "HTTP 500", "http_error")
        self.assertEqual(len(self.load.problems), 2)

    def test_summary_always_carries_blocked(self):
        """Present even when empty, so a caller reading JSON never has to tell
        "nothing was blocked" apart from "this build does not report it"."""
        summary = browse.load_summary(self.load)
        self.assertEqual(summary["blocked"], [])
        self.assertIn("final_url", summary)
        self.assertIn("status", summary)


class ViewportTest(unittest.TestCase):
    def test_named(self):
        self.assertEqual(browse.parse_viewport("phone"), ("phone", (390, 844)))

    def test_explicit(self):
        self.assertEqual(browse.parse_viewport("1024x768"), ("1024x768", (1024, 768)))

    def test_rejects_nonsense(self):
        for spec in ("", "1024", "axb", "1024x", "-5x10", "1024X768"):
            with self.subTest(spec=spec):
                with self.assertRaises(browse.BrowseError) as caught:
                    browse.parse_viewport(spec)
                self.assertEqual(caught.exception.code, browse.VALIDATION_ERROR)

    def test_suffix_keeps_the_extension(self):
        self.assertEqual(
            browse.suffixed("/tmp/shot.png", "phone"), Path("/tmp/shot.phone.png")
        )

    def test_suffix_survives_a_dotted_directory(self):
        self.assertEqual(
            browse.suffixed("/tmp/v1.2/shot.png", "wide"), Path("/tmp/v1.2/shot.wide.png")
        )


class ProxyTest(unittest.TestCase):
    """Chromium does not read the proxy environment for itself, so getting
    this wrong means no egress at all, not slower egress."""

    def setUp(self):
        self.saved = {
            k: os.environ.pop(k, None)
            for k in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
                      "http_proxy", "https_proxy", "no_proxy")
        }

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_none_when_unset(self):
        self.assertIsNone(browse.proxy_settings())

    def test_https_proxy_wins(self):
        os.environ["HTTP_PROXY"] = "http://plain:3128"
        os.environ["HTTPS_PROXY"] = "http://tls:3128"
        self.assertEqual(browse.proxy_settings()["server"], "http://tls:3128")

    def test_lowercase_is_read(self):
        os.environ["https_proxy"] = "http://lower:3128"
        self.assertEqual(browse.proxy_settings()["server"], "http://lower:3128")

    def test_no_proxy_becomes_bypass(self):
        """Squid denies 127.0.0.0/8 outright, so a loopback page sent through
        the proxy is refused. The bypass is what makes our own pages work."""
        os.environ["HTTPS_PROXY"] = "http://p:3128"
        os.environ["NO_PROXY"] = "localhost,127.0.0.1"
        self.assertEqual(browse.proxy_settings()["bypass"], "localhost,127.0.0.1")


class ProcessTest(unittest.TestCase):
    def test_ppid_of_self(self):
        self.assertEqual(browse._ppid(os.getpid()), os.getppid())

    def test_ppid_of_missing_pid_is_none(self):
        self.assertIsNone(browse._ppid(999999))

    def test_descendants_excludes_unrelated_processes(self):
        """Scoped to descendants because a crew shares this container and this
        uid: killing every chromium owned by uid 1000 would kill a colleague's
        browser mid-page."""
        self.assertNotIn(1, browse.descendants(os.getpid()))

    def test_drain_with_no_children_returns_at_once(self):
        import time
        started = time.monotonic()
        self.assertEqual(browse.drain_zombies(deadline_s=5.0), [])
        self.assertLess(time.monotonic() - started, 1.0)


class ContractTest(unittest.TestCase):
    def test_exit_codes_are_distinct(self):
        codes = [browse.OK, browse.NAV_ERROR, browse.BROWSER_ERROR,
                 browse.VALIDATION_ERROR, browse.BUSY]
        self.assertEqual(len(set(codes)), len(codes))

    def test_exit_codes_are_the_published_values(self):
        """A stable contract: an agent branches on these without parsing prose,
        so they must not be reassigned. Change these and change the README."""
        self.assertEqual((browse.OK, browse.NAV_ERROR, browse.BROWSER_ERROR,
                          browse.VALIDATION_ERROR, browse.BUSY), (0, 1, 2, 3, 4))

    def test_no_sandbox_is_present_and_deliberate(self):
        """Chromium's own sandbox cannot start under gVisor. If someone removes
        this flag, every invocation fails at launch."""
        self.assertIn("--no-sandbox", browse.CHROMIUM_ARGS)

    def test_dev_shm_workaround_is_present(self):
        """/dev/shm is 64 MB here; without this chromium renders blank pages."""
        self.assertIn("--disable-dev-shm-usage", browse.CHROMIUM_ARGS)

    def test_default_wait_is_not_networkidle(self):
        """A page with a blocked subresource never goes idle, so networkidle
        turns a partial render into a timeout."""
        args = browse.build_parser().parse_args(["probe", "https://example.com"])
        self.assertEqual(args.wait_until, "load")

    def test_screenshot_refuses_a_non_image_output(self):
        args = browse.build_parser().parse_args(
            ["screenshot", "https://example.com", "out.txt"]
        )
        args.json = False
        with self.assertRaises(browse.BrowseError) as caught:
            browse.cmd_screenshot(args, None)
        self.assertEqual(caught.exception.code, browse.VALIDATION_ERROR)


if __name__ == "__main__":
    unittest.main(verbosity=2)
