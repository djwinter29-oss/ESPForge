# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Static-server checks for host/direct/server.py (run from the repository root)."""

import contextlib
import io
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from unittest.mock import patch

from host.direct.server import _DEFAULT_WEB_ROOT, CONTENT_SECURITY_POLICY, DirectHandler, create_server, main


class DirectServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.quiet = patch.object(DirectHandler, "log_message", lambda *_args: None)
        cls.quiet.start()
        cls.server = create_server("127.0.0.1", 0, _DEFAULT_WEB_ROOT)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.quiet.stop()

    def fetch(self, path, method="GET"):
        request = urllib.request.Request(self.base + path, method=method)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, error.read()

    def test_index_is_served_with_hardening_headers(self):
        status, headers, body = self.fetch("/")
        self.assertEqual(status, 200)
        self.assertIn(b"ESPForge", body)
        self.assertEqual(headers["Content-Security-Policy"], CONTENT_SECURITY_POLICY)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_modules_styles_and_favicon_have_browser_types(self):
        for path, expected in (("/js/app.mjs", "text/javascript"), ("/css/direct.css", "text/css"),
                               ("/favicon.svg", "image/svg+xml")):
            status, headers, _ = self.fetch(path)
            self.assertEqual(status, 200, path)
            self.assertTrue(headers["Content-Type"].startswith(expected), (path, headers["Content-Type"]))

    def test_directories_are_not_listed_and_paths_cannot_escape(self):
        self.assertEqual(self.fetch("/js/")[0], 404)
        self.assertEqual(self.fetch("/../server.py")[0], 404)
        self.assertEqual(self.fetch("/%2e%2e/server.py")[0], 404)

    def test_mutating_methods_are_rejected(self):
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            self.assertEqual(self.fetch("/", method)[0], 405, method)


class DirectServerArgumentTests(unittest.TestCase):
    def run_main(self, *argv):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
            main(list(argv))
        return raised.exception.code, stderr.getvalue()

    def test_port_must_be_in_range(self):
        code, message = self.run_main("--port", "0")
        self.assertEqual(code, 2)
        self.assertIn("--port must be between 1 and 65535", message)

    def test_directory_must_contain_index(self):
        with tempfile.TemporaryDirectory() as directory:
            code, message = self.run_main("--directory", directory)
        self.assertEqual(code, 2)
        self.assertIn("must contain index.html", message)

    def test_default_root_is_the_adjacent_web_directory(self):
        self.assertEqual(_DEFAULT_WEB_ROOT, Path(__file__).resolve().parents[1] / "web")
        self.assertTrue((_DEFAULT_WEB_ROOT / "index.html").is_file())


if __name__ == "__main__":
    unittest.main()
