#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Serve the standalone ESPForge Direct dashboard on a local secure context (localhost)."""

from __future__ import annotations

import argparse
from functools import partial
import html
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


_SOURCE_ROOT = Path(__file__).resolve().parent
_DEFAULT_WEB_ROOT = _SOURCE_ROOT / "web"
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
    """Serve static Direct files only; the browser talks to the board through WebHID or Web Bluetooth."""

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

    def do_POST(self) -> None:
        self.send_error(405, "Direct serves static files only")

    do_PUT = do_DELETE = do_PATCH = do_POST


def create_server(bind: str, port: int, directory: Path) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((bind, port), partial(DirectHandler, directory=str(directory)))
    server.daemon_threads = True
    return server


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
