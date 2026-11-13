# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Static-server checks for host/direct/server.py (run from the repository root)."""

import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from unittest.mock import Mock, patch

from host.direct.server import (
    _DEFAULT_WEB_ROOT, CONTENT_SECURITY_POLICY, DirectHandler, build_site, create_server, git, identity, main,
    verify_site,
)


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

    def fetch(self, path, method="GET", body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, method=method, data=data,
                                         headers={"Content-Type": "application/json", **(headers or {})})
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

    def test_console_capability_assets_and_origin_fence(self):
        status, _, body = self.fetch("/api/console/capabilities")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"available": True})
        for path in ("/console.html", "/css/console.css", "/js/console.mjs"):
            self.assertEqual(self.fetch(path)[0], 200, path)
        for headers in ({"Origin": "https://foreign.example"}, {"Host": "foreign.example"}):
            self.assertEqual(self.fetch("/api/console", "POST", {"ipv4": "192.168.1.9"}, headers)[0], 403)
        self.assertEqual(self.fetch("/api/console", "PATCH")[0], 405)

    def test_console_requires_a_private_reported_target_and_strict_packet(self):
        with patch.object(self.server.console, "open", return_value="opaque-session") as connect:
            for body in ({}, {"ipv4": "127.0.0.1"}, {"ipv4": "8.8.8.8"}, {"ipv4": "0.0.0.1"},
                         {"ipv4": "192.168.1.9", "port": 80}, {"ipv4": True}):
                self.assertEqual(self.fetch("/api/console", "POST", body)[0], 400, body)
            connect.assert_not_called()
            status, _, body = self.fetch("/api/console", "POST", {"ipv4": "192.168.1.9"})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"session": "opaque-session", "ipv4": "192.168.1.9"})
            connect.assert_called_once_with("192.168.1.9")
        self.assertEqual(self.fetch("/api/console?session=ignored")[0], 409)
        with patch.object(self.server.console, "write", return_value=5) as write:
            status, _, body = self.fetch("/api/console/input", "POST", {"data": "aGVscA0="},
                                         {"X-Console-Session": "owned"})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"written": 5})
            write.assert_called_once_with("owned", b"help\r")
            self.assertEqual(self.fetch("/api/console/input", "POST", {"data": "%%%"},
                                         {"X-Console-Session": "owned"})[0], 400)
            self.assertEqual(write.call_count, 1)
        self.assertEqual(self.fetch("/api/console", "PUT", {"data": "aA=="})[0], 405)

    def test_release_server_runs_without_checkout_or_host_dependencies(self):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copyfile(source / "server.py", root / "server.py")
            shutil.copyfile(source.parent / "python/src/espforge/dashboard/console.py", root / "console_bridge.py")
            shutil.copytree(source / "web", root / "web")
            script = """
import json, runpy, threading, urllib.request
module = runpy.run_path("server.py")
server = module["create_server"]("127.0.0.1", 0, module["_DEFAULT_WEB_ROOT"])
thread = threading.Thread(target=server.serve_forever)
thread.start()
try:
    base = f"http://127.0.0.1:{server.server_address[1]}"
    for path in ("/console.html", "/js/console.mjs", "/js/ui/console-session.mjs"):
        with urllib.request.urlopen(base + path, timeout=2) as response:
            assert response.status == 200 and response.read()
    with urllib.request.urlopen(base + "/api/console/capabilities", timeout=2) as response:
        assert json.load(response) == {"available": True}
finally:
    server.shutdown()
    server.server_close()
    thread.join()
"""
            result = subprocess.run([sys.executable, "-I", "-c", script], cwd=root, timeout=10,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


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


class DirectVersionTests(unittest.TestCase):
    def test_git_identity_tracks_tags_commits_and_dirty_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git(root, "init")

            def commit():
                git(root, "-c", "user.name=Version test", "-c", "user.email=version@example.invalid",
                    "-c", "commit.gpgSign=false", "commit", "--allow-empty", "--no-verify", "-m", "Version fixture")

            commit()
            sha = git(root, "rev-parse", "HEAD")
            self.assertEqual(identity(root), (f"0.0.0-dev.1+g{sha[:12]}", sha, False))
            git(root, "tag", "v1.2.3")
            self.assertEqual(identity(root), (f"1.2.3+g{sha[:12]}", sha, False))
            commit()
            sha = git(root, "rev-parse", "HEAD")
            git(root, "tag", "v2.0.0-rc.1")
            git(root, "tag", "v2.0.0+build")
            self.assertEqual(identity(root), (f"1.2.4-dev.1+g{sha[:12]}", sha, False))
            (root / "draft.txt").write_text("draft", encoding="utf-8")
            self.assertEqual(identity(root), (f"1.2.4-dev.1+g{sha[:12]}.dirty", sha, True))

    def test_missing_git_reports_debug_identity_explicitly(self):
        stderr = io.StringIO()
        with patch("host.direct.server.git", side_effect=FileNotFoundError("git")), contextlib.redirect_stderr(stderr):
            self.assertEqual(identity(Path(".")), ("0.0.0-debug", "unknown", False))
        self.assertIn("Git identity unavailable", stderr.getvalue())

    def test_build_preserves_source_assets_and_detects_mismatched_identity(self):
        source = (_DEFAULT_WEB_ROOT / "index.html").read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "site"
            build_site(_DEFAULT_WEB_ROOT, output, "1.2.3", "a" * 40, False)
            self.assertEqual(verify_site(output, "1.2.3"),
                             {"version": "1.2.3", "commit": "a" * 40, "dirty": False})
            for path in _DEFAULT_WEB_ROOT.rglob("*"):
                if path.is_file() and path.name != "index.html" and "__pycache__" not in path.parts:
                    self.assertEqual(path.read_bytes(), (output / path.relative_to(_DEFAULT_WEB_ROOT)).read_bytes())
            with self.assertRaises(RuntimeError):
                verify_site(output, "1.2.4")
            metadata = output / "build.json"
            metadata.write_text(json.dumps({"version": "1.2.4", "commit": "a" * 40, "dirty": False}),
                                encoding="utf-8")
            with self.assertRaises(RuntimeError):
                verify_site(output, "1.2.4")
        self.assertEqual((_DEFAULT_WEB_ROOT / "index.html").read_bytes(), source)

    def test_staging_rejects_invalid_versions_and_source_overlap(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "site"
            for version in ("01.2.3", "1.2.3-alpha..1", "1.2.3-01", "1.2.3+bad..metadata", "<script>"):
                with self.subTest(version=version), self.assertRaises(ValueError):
                    build_site(_DEFAULT_WEB_ROOT, output, version, "unknown", False)
            for output in (_DEFAULT_WEB_ROOT, _DEFAULT_WEB_ROOT / "stage", _DEFAULT_WEB_ROOT.parent):
                with self.subTest(output=output), self.assertRaises(ValueError):
                    build_site(_DEFAULT_WEB_ROOT, output, "1.2.3", "unknown", False)

    def test_checkout_server_uses_a_temporary_versioned_copy(self):
        staged = []
        server = Mock()
        server.serve_forever.side_effect = KeyboardInterrupt

        def create(bind, port, directory):
            self.assertEqual(verify_site(directory, "1.2.4-dev.1+gabcdef.dirty")["dirty"], True)
            staged.append(directory)
            return server

        with patch("host.direct.server.identity", return_value=("1.2.4-dev.1+gabcdef.dirty", "a" * 40, True)), \
                patch("host.direct.server.create_server", side_effect=create), contextlib.redirect_stdout(io.StringIO()):
            main([])
        self.assertFalse(staged[0].exists())
        server.server_close.assert_called_once()

    def test_prebuilt_server_preserves_release_identity_without_git(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "site"
            build_site(_DEFAULT_WEB_ROOT, output, "1.2.3", "a" * 40, False)
            page = (output / "index.html").read_bytes()
            server = Mock()
            server.serve_forever.side_effect = KeyboardInterrupt
            with patch("host.direct.server.identity", side_effect=AssertionError("Must not query Git")), \
                    patch("host.direct.server.create_server", return_value=server) as create, \
                    contextlib.redirect_stdout(io.StringIO()):
                main(["--directory", str(output)])
            self.assertEqual(create.call_args.args[2], output)
            self.assertEqual((output / "index.html").read_bytes(), page)


if __name__ == "__main__":
    unittest.main()
