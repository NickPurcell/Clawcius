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

import contextlib
import importlib.util
import io
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

    def test_rejects_degenerate_and_absurd_sizes(self):
        """`isdigit()` is true of "0", so 0x0 parsed happily and became a
        playwright traceback; a fat-fingered 100000 is an OOM in a 2 GB
        container rather than an error."""
        for spec in ("0x0", "1024x0", "0x768", "100000x100", "100x100000"):
            with self.subTest(spec=spec):
                with self.assertRaises(browse.BrowseError) as caught:
                    browse.parse_viewport(spec)
                self.assertEqual(caught.exception.code, browse.VALIDATION_ERROR)

    def test_accepts_the_bounds(self):
        self.assertEqual(browse.parse_viewport("1x1")[1], (1, 1))
        big = f"{browse.MAX_VIEWPORT}x{browse.MAX_VIEWPORT}"
        self.assertEqual(browse.parse_viewport(big)[1],
                         (browse.MAX_VIEWPORT, browse.MAX_VIEWPORT))

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


class LockScopeTest(unittest.TestCase):
    """Regression. `single_browser_lock()` used to `yield` inside the `try`
    whose `except OSError` diagnoses the lock, so every OSError raised by the
    command body came back as "cannot take the browser lock" with a hint
    pointing at /tmp and exit 3 for "bad arguments". A screenshot to an
    unwritable path blamed the lock and sent the reader to the wrong file.
    Both the pre-flight mkdir and playwright's own `page.screenshot(path=...)`
    raise OSError, so this was the common case."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.saved = browse.LOCK_PATH
        browse.LOCK_PATH = Path(self.dir.name) / "lock"

    def tearDown(self):
        browse.LOCK_PATH = self.saved
        self.dir.cleanup()

    def test_oserror_from_the_body_is_not_swallowed(self):
        with self.assertRaises(FileNotFoundError):
            with browse.single_browser_lock():
                raise FileNotFoundError(2, "No such file or directory")

    def test_browse_error_from_the_body_keeps_its_code(self):
        with self.assertRaises(browse.BrowseError) as caught:
            with browse.single_browser_lock():
                raise browse.BrowseError("nope", browse.NAV_ERROR)
        self.assertEqual(caught.exception.code, browse.NAV_ERROR)

    def test_lock_is_released_even_when_the_body_raises(self):
        with contextlib.suppress(FileNotFoundError):
            with browse.single_browser_lock():
                raise FileNotFoundError(2, "boom")
        with browse.single_browser_lock():
            pass  # re-acquirable, so the fd was closed

    def test_unopenable_lock_is_still_diagnosed(self):
        browse.LOCK_PATH = Path("/proc/definitely/not/writable/lock")
        with self.assertRaises(browse.BrowseError) as caught:
            with browse.single_browser_lock():
                pass
        self.assertIn("browser lock", caught.exception.message)


class OutputModeTest(unittest.TestCase):
    """Regression. `--output auto` resolved on isatty() alone, so
    `browse text URL > page.txt` wrote a JSON object with the page inside an
    escaped string field — the opposite of what the README promises and the
    single most likely thing anyone will type."""

    def test_text_never_auto_switches_to_json(self):
        for command in ("text", "html"):
            with self.subTest(command=command):
                self.assertFalse(browse.wants_json(command, "auto", False))
                self.assertFalse(browse.wants_json(command, "auto", True))

    def test_records_do_auto_switch_into_a_pipe(self):
        for command in ("probe", "screenshot"):
            with self.subTest(command=command):
                self.assertTrue(browse.wants_json(command, "auto", False))
                self.assertFalse(browse.wants_json(command, "auto", True))

    def test_explicit_flag_wins_everywhere(self):
        for command in ("text", "html", "probe", "screenshot"):
            for isatty in (True, False):
                with self.subTest(command=command, isatty=isatty):
                    self.assertTrue(browse.wants_json(command, "json", isatty))
                    self.assertFalse(browse.wants_json(command, "text", isatty))

    def test_every_command_is_classified(self):
        """A new command must be a deliberate choice, not a default."""
        documents = {"text", "html"}
        self.assertEqual(
            set(browse.COMMANDS), browse.AUTO_JSON_COMMANDS | documents
        )


class WarningVolumeTest(unittest.TestCase):
    """A warning that fires on healthy pages is one an agent learns to skip,
    which costs exactly the case the warning was written for."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.audit = browse.Audit(Path(self.dir.name) / "nav.jsonl")
        self.load = browse.Load("https://example.com")

    def tearDown(self):
        self.audit.close()
        self.dir.cleanup()

    def warn(self, **kwargs):
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            browse.warn_about_problems(self.load, **kwargs)
        return buf.getvalue()

    def test_a_broken_stylesheet_is_loud(self):
        browse._record_problem(self.load, self.audit, "/a.css", "HTTP 404",
                               "http_error", "stylesheet")
        self.assertIn("do not read it as the finished page", self.warn().lower())

    def test_a_failed_beacon_is_reported_but_not_loud(self):
        browse._record_problem(self.load, self.audit, "/beacon", "HTTP 404",
                               "http_error", "xhr")
        out = self.warn()
        self.assertIn("/beacon", out)
        self.assertNotIn("do not read it as the finished page", out.lower())
        self.assertIn("should be complete", out)

    def test_nothing_at_all_says_nothing(self):
        self.assertEqual(self.warn(), "")

    def test_redirect_note_can_be_suppressed(self):
        """probe prints the whole chain itself a few lines later."""
        self.load.redirects = ["https://example.com/old"]
        browse._record_problem(self.load, self.audit, "/a.css", "HTTP 404",
                               "http_error", "stylesheet")
        self.assertIn("redirected from", self.warn(show_redirect=True))
        self.assertNotIn("redirected from", self.warn(show_redirect=False))

    def test_resource_type_is_carried_into_the_record(self):
        browse._record_problem(self.load, self.audit, "/a.css", "HTTP 404",
                               "http_error", "stylesheet")
        self.assertEqual(self.load.problems[0]["resource_type"], "stylesheet")

    def test_subframe_documents_count_as_rendering(self):
        """An iframe's 403 is a plain-HTTP denial that changes the page."""
        self.assertIn("document", browse.RENDERING_TYPES)


class ContractTest(unittest.TestCase):
    def test_exit_codes_are_distinct(self):
        codes = [browse.OK, browse.NAV_ERROR, browse.BROWSER_ERROR,
                 browse.VALIDATION_ERROR, browse.BUSY, browse.INTERNAL_ERROR]
        self.assertEqual(len(set(codes)), len(codes))

    def test_exit_codes_are_the_published_values(self):
        """A stable contract: an agent branches on these without parsing prose,
        so they must not be reassigned. Change these and change the README."""
        self.assertEqual((browse.OK, browse.NAV_ERROR, browse.BROWSER_ERROR,
                          browse.VALIDATION_ERROR, browse.BUSY,
                          browse.INTERNAL_ERROR), (0, 1, 2, 3, 4, 5))

    def test_an_unexpected_error_does_not_masquerade_as_a_failed_page(self):
        """Regression. Only BrowseError and KeyboardInterrupt were handled, so
        any other exception left a traceback and exit 1 — which the contract
        defines as "the page would not load". The code easiest to reach by
        accident must not be the one that lies."""
        boom = lambda args, audit: 1 / 0            # noqa: E731
        saved = browse.COMMANDS["probe"]
        browse.COMMANDS["probe"] = boom
        try:
            with contextlib.redirect_stderr(io.StringIO()) as err:
                code = browse.main(
                    ["--output", "text", "--log", os.devnull,
                     "probe", "https://example.com"]
                )
        finally:
            browse.COMMANDS["probe"] = saved
        self.assertEqual(code, browse.INTERNAL_ERROR)
        self.assertIn("ZeroDivisionError", err.getvalue())

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

    def test_screenshot_refuses_a_degenerate_scale(self):
        for scale in ("0", "-1", "99"):
            with self.subTest(scale=scale):
                args = browse.build_parser().parse_args(
                    ["screenshot", "https://example.com", "o.png",
                     "--scale", scale]
                )
                args.json = False
                with self.assertRaises(browse.BrowseError) as caught:
                    browse.cmd_screenshot(args, None)
                self.assertEqual(caught.exception.code, browse.VALIDATION_ERROR)

    def test_a_repeated_viewport_renders_once(self):
        """Otherwise it loads the page twice to write the same filename."""
        specs = ["phone", "desktop", "phone"]
        deduped = list(dict(browse.parse_viewport(v) for v in specs).items())
        self.assertEqual([name for name, _ in deduped], ["phone", "desktop"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
