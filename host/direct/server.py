#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Serve the standalone ESPForge Direct dashboard on a local secure context (localhost)."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


_SOURCE_ROOT = Path(__file__).resolve().parent
_DEFAULT_WEB_ROOT = _SOURCE_ROOT / "web"

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)


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
    server = create_server(args.bind, args.port, args.directory)
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
