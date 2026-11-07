"""Loopback-only dashboard server. Run from a source checkout."""

import argparse
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import serial

from protocol import BoardClient, ProtocolError, demo_status, validate_request

WEB_ROOT = Path(__file__).resolve().parents[1] / "web"
ASSETS = {
    "/": ("index.html", "text/html"),
    "/index.html": ("index.html", "text/html"),
    "/dashboard.css": ("dashboard.css", "text/css"),
    "/app.js": ("app.js", "text/javascript"),
    "/transports.js": ("transports.js", "text/javascript"),
    "/protocol.js": ("protocol.js", "text/javascript"),
}


class DashboardServer(ThreadingHTTPServer):
    def __init__(self, port: int, client: BoardClient | None) -> None:
        super().__init__(("127.0.0.1", port), DashboardHandler)
        self.client = client


class DashboardHandler(BaseHTTPRequestHandler):
    server: DashboardServer

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(10)

    def _trusted(self) -> bool:
        port = self.server.server_port
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("Origin")
        return self.headers.get("Host") in allowed and (
            origin is None or origin in {f"http://{host}" for host in allowed}
        )

    def _reply(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, value: dict[str, Any]) -> None:
        self._reply(status, json.dumps(value).encode("utf-8"), "application/json")

    def do_GET(self) -> None:
        if not self._trusted():
            self._json(403, {"ok": False, "message": "Untrusted host or origin"})
            return
        path = urlsplit(self.path).path
        if path == "/api/host":
            self._json(200, {"name": "Python", "demo": self.server.client is None})
        elif path in ASSETS:
            name, content_type = ASSETS[path]
            self._reply(200, (WEB_ROOT / name).read_bytes(), content_type)
        else:
            self._json(404, {"ok": False, "message": "Not found"})

    def do_POST(self) -> None:
        if not self._trusted():
            self._json(403, {"ok": False, "message": "Untrusted host or origin"})
            return
        if self.path != "/api/request":
            self._json(404, {"ok": False, "message": "Not found"})
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self._json(415, {"ok": False, "message": "JSON content type required"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= 2048:
                raise ProtocolError("Request body must be 1-2048 bytes")
            request = validate_request(json.loads(self.rfile.read(length)))
        except (ValueError, ProtocolError) as error:
            self._json(400, {"ok": False, "message": str(error)})
            return
        try:
            if self.server.client is None:
                if request["op"] != "status":
                    raise ProtocolError("Simulated preview does not execute commands")
                reply = {"id": 1, "ok": True, "status": demo_status()}
            else:
                reply = self.server.client.request(request)
            self._json(200, reply)
        except (ProtocolError, serial.SerialException) as error:
            logging.warning("Board request failed: %s", error)
            self._json(502, {"ok": False, "message": str(error)})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--device", help="Serial port, e.g. /dev/ttyUSB0 or COM4")
    source.add_argument("--demo", action="store_true", help="Explicit hardware-free preview")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be 1-65535")
    client = None
    try:
        client = BoardClient(args.device) if args.device else None
        with DashboardServer(args.port, client) as server:
            print(f"ESPForge Python{' SIMULATED' if args.demo else ''}: http://127.0.0.1:{args.port}/", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except (OSError, serial.SerialException) as error:
        parser.exit(1, f"Host startup/runtime error: {error}\n")
    finally:
        if client:
            client.close()


if __name__ == "__main__":
    main()
