#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Serve the standalone ESPForge Direct dashboard on a local secure context (localhost)."""

from __future__ import annotations

import argparse
import base64
from functools import partial
import html
import importlib.util
import ipaddress
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit


_SOURCE_ROOT = Path(__file__).resolve().parent
_DEFAULT_WEB_ROOT = _SOURCE_ROOT / "web"
_CONSOLE_SOURCE = _SOURCE_ROOT / "console_bridge.py"
if not _CONSOLE_SOURCE.is_file():
    _CONSOLE_SOURCE = _SOURCE_ROOT.parent / "python/src/espforge/dashboard/console.py"
_CONSOLE_SPEC = importlib.util.spec_from_file_location("espforge_console_bridge", _CONSOLE_SOURCE)
if _CONSOLE_SPEC is None or _CONSOLE_SPEC.loader is None:
    raise RuntimeError("Console bridge module is unavailable")
_CONSOLE_MODULE = importlib.util.module_from_spec(_CONSOLE_SPEC)
_CONSOLE_SPEC.loader.exec_module(_CONSOLE_MODULE)
_PRIVATE_NETWORKS = tuple(ipaddress.IPv4Network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_NUMBER = r"(?:0|[1-9][0-9]*)"
_PRERELEASE = r"(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
_VERSION = re.compile(
    rf"{_NUMBER}\.{_NUMBER}\.{_NUMBER}(?:-{_PRERELEASE}(?:\.{_PRERELEASE})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
_TAG_DESCRIPTION = re.compile(rf"v({_NUMBER})\.({_NUMBER})\.({_NUMBER})-([0-9]+)-g[0-9a-f]+")
_VERSION_MARKER = 'aria-label="Host application version">0.0.0-debug</span>'

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(root), *args], check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()


def identity(root: Path) -> tuple[str, str, bool]:
    """Derive a tagged or development version, with commit and working-tree identity."""
    try:
        commit = git(root, "rev-parse", "HEAD")
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        print(f"Git identity unavailable; using debug version: {error}", file=sys.stderr)
        return "0.0.0-debug", "unknown", False
    dirty = bool(git(root, "status", "--porcelain", "--untracked-files=normal"))
    description = git(root, "describe", "--tags", "--long", "--always",
                      "--match", "v[0-9]*.[0-9]*.[0-9]*", "--exclude", "v*-*", "--exclude", "v*+*")
    if re.fullmatch(r"[0-9a-f]+", description):
        version = f"0.0.0-dev.{git(root, 'rev-list', '--count', 'HEAD')}"
    else:
        match = _TAG_DESCRIPTION.fullmatch(description)
        if match is None:
            raise RuntimeError(f"Unsupported version tag in Git description: {description}")
        major, minor, patch, height = map(int, match.groups())
        version = f"{major}.{minor}.{patch}" if height == 0 else f"{major}.{minor}.{patch + 1}-dev.{height}"
    return f"{version}+g{commit[:12]}" + (".dirty" if dirty else ""), commit, dirty


def verify_site(output: Path, expected: str | None = None) -> dict:
    """Check page/build identity consistency and, when supplied, an expected version."""
    metadata = json.loads((output / "build.json").read_text(encoding="utf-8"))
    if (not isinstance(metadata, dict) or not isinstance(metadata.get("version"), str)
            or _VERSION.fullmatch(metadata["version"]) is None
            or not isinstance(metadata.get("commit"), str) or not isinstance(metadata.get("dirty"), bool)):
        raise ValueError("Invalid Direct build identity")
    page = (output / "index.html").read_text(encoding="utf-8")
    label = f'aria-label="Host application version" title="{html.escape(metadata["commit"], quote=True)}">'
    version = metadata["version"]
    if (expected is not None and version != expected) or page.count(f"{label}{html.escape(version)}</span>") != 1:
        raise RuntimeError("Direct dashboard version differs from its build identity")
    if _VERSION_MARKER in page:
        raise RuntimeError("Direct dashboard still contains its source version marker")
    return metadata


def build_site(source: Path, output: Path, version: str, commit: str, dirty: bool) -> None:
    """Stamp a standalone static copy without changing the source dashboard."""
    if _VERSION.fullmatch(version) is None:
        raise ValueError(f"Invalid dashboard version: {version}")
    if output.resolve().is_relative_to(source.resolve()) or source.resolve().is_relative_to(output.resolve()):
        raise ValueError("Staging output must not overlap dashboard source")
    if output.exists():
        raise FileExistsError(f"Staging output already exists: {output}")
    text = (source / "index.html").read_text(encoding="utf-8")
    if text.count(_VERSION_MARKER) != 1:
        raise RuntimeError("Expected exactly one source version marker")
    shutil.copytree(source, output, ignore=shutil.ignore_patterns("__pycache__"))
    label = f'aria-label="Host application version" title="{html.escape(commit, quote=True)}">'
    (output / "index.html").write_text(text.replace(_VERSION_MARKER, f"{label}{html.escape(version)}</span>"),
                                      encoding="utf-8")
    (output / "build.json").write_text(
        json.dumps({"version": version, "commit": commit, "dirty": dirty}, indent=2) + "\n", encoding="utf-8")
    verify_site(output, version)


class DirectHandler(SimpleHTTPRequestHandler):
    """Serve Direct assets and a loopback-only TCP relay; management remains owned by the browser."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".svg": "image/svg+xml",
        ".json": "application/json",
    }

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def list_directory(self, path):  # type: ignore[override]
        self.send_error(404, "Not found")
        return None

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local_console(self) -> bool:
        host = self.headers.get("Host", "")
        try:
            authority = urlsplit(f"http://{host}")
            valid = (ipaddress.ip_address(self.server.server_address[0]).is_loopback
                     and authority.hostname in ("localhost", "127.0.0.1")
                     and authority.username is None
                     and (authority.port or 80) == self.server.server_address[1]
                     and self.headers.get("Origin", f"http://{host}") == f"http://{host}")
        except ValueError:
            valid = False
        if not valid:
            self._json(403, {"error": "The console relay requires a same-origin loopback connection"})
        return valid

    def _payload(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length") from error
        if length < 1 or length > 4096 or self.headers.get("Transfer-Encoding"):
            raise ValueError("Expected a JSON body of at most 4096 bytes")
        if self.headers.get_content_type() != "application/json":
            raise ValueError("Expected application/json")
        self.connection.settimeout(3)
        return json.loads(self.rfile.read(length))

    def _console(self) -> None:
        if not self._local_console():
            return
        bridge = self.server.console
        try:
            if self.command == "POST" and urlsplit(self.path).path == "/api/console":
                payload = self._payload()
                if not isinstance(payload, dict) or set(payload) != {"ipv4"}:
                    raise ValueError("Expected exactly the reported IPv4 address")
                address = _CONSOLE_MODULE.console_address(payload["ipv4"])
                if not any(ipaddress.IPv4Address(address) in network for network in _PRIVATE_NETWORKS):
                    raise ValueError("The Direct console requires a private LAN IPv4 address")
                self._json(200, {"session": bridge.open(address), "ipv4": address})
                return
            token = self.headers.get("X-Console-Session")
            if self.command == "GET":
                data, closed = bridge.read(token)
                self._json(200, {"data": base64.b64encode(data).decode("ascii"), "closed": closed})
            elif self.command == "POST":
                data = _CONSOLE_MODULE.console_input(self._payload())
                self._json(200, {"written": bridge.write(token, data)})
            else:
                bridge.close(token)
                self._json(200, {})
        except _CONSOLE_MODULE.ConsoleConflict as error:
            self._json(409, {"error": str(error)})
        except (ValueError, UnicodeDecodeError) as error:
            self._json(400, {"error": str(error)})
        except OSError as error:
            self._json(503, {"error": str(error)})

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/console/capabilities":
            if self._local_console():
                self._json(200, {"available": True})
        elif path == "/api/console":
            self._console()
        else:
            super().do_GET()

    def do_POST(self) -> None:
        if urlsplit(self.path).path in ("/api/console", "/api/console/input"):
            self._console()
        else:
            self.send_error(405, "Only the console relay accepts API requests")

    def do_DELETE(self) -> None:
        if urlsplit(self.path).path == "/api/console":
            self._console()
        else:
            self.send_error(405, "Only console sessions can be deleted")

    def do_PUT(self) -> None:
        self.send_error(405, "Idempotent HTTP methods cannot send shell input")

    do_PATCH = do_PUT


class DirectServer(ThreadingHTTPServer):
    """Own the relay lifetime independently of individual HTTP requests."""

    daemon_threads = True

    def __init__(self, address, handler):
        super().__init__(address, handler)
        self.console = _CONSOLE_MODULE.ConsoleBridge()

    def server_close(self) -> None:
        try:
            self.console.close_all()
        finally:
            super().server_close()


def create_server(bind: str, port: int, directory: Path) -> ThreadingHTTPServer:
    return DirectServer((bind, port), partial(DirectHandler, directory=str(directory)))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1", help="Local bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Local HTTP port (default: 8000)")
    parser.add_argument("--directory", type=Path, default=_DEFAULT_WEB_ROOT,
                        help="Dashboard directory (default: the adjacent web/ directory)")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if not args.directory.is_dir() or not (args.directory / "index.html").is_file():
        parser.error(f"dashboard directory must contain index.html: {args.directory}")
    with TemporaryDirectory(prefix="espforge-direct-") as directory:
        web = args.directory
        if (web / "build.json").is_file():
            verify_site(web)
        elif web.resolve() == _DEFAULT_WEB_ROOT.resolve():
            version, commit, dirty = identity(_SOURCE_ROOT)
            web = Path(directory) / "site"
            build_site(args.directory, web, version, commit, dirty)
        server = create_server(args.bind, args.port, web)
        host = "127.0.0.1" if args.bind == "0.0.0.0" else args.bind
        print(f"Direct dashboard: http://{host}:{args.port}/ (Chrome or Edge; stop with Ctrl+C)", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
