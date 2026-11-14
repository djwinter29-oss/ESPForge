#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Package and smoke-check Direct from the repository root using VERSION and SOURCE_SHA."""

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from host.direct.server import build_site, identity


def main() -> None:
    version = os.environ["VERSION"]
    Path("build/packages").mkdir(parents=True, exist_ok=True)
    footer = "Software checks do not qualify physical USB HID, Wi-Fi, BLE or SD behavior.\n"

    # The standalone Direct archive includes the standard-library console relay.
    direct = Path("build/direct-release")
    _, commit, dirty = identity(Path.cwd())
    assert commit == os.environ["SOURCE_SHA"], "Direct source commit differs from release"
    build_site(Path("host/direct/web"), direct / "web", version, commit, dirty)
    shutil.copyfile("host/direct/server.py", direct / "server.py")
    shutil.copyfile("host/python/src/espforge/dashboard/console.py", direct / "console_bridge.py")
    shutil.copyfile("LICENSE", direct / "LICENSE")
    (direct / "RELEASE.txt").write_text(
        f"ESPForge {version}\nSource: {os.environ['SOURCE_SHA']}\n"
        "Run: python3 server.py --port 8000\nOpen: http://127.0.0.1:8000/ in desktop Chrome or Edge\n"
        + footer, encoding="utf-8")
    shutil.make_archive(f"build/packages/espforge-direct-v{version}", "zip", root_dir=direct)

    def free_port():
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            return listener.getsockname()[1]

    def fetch(url):
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.headers, response.read()

    def smoke(archive, command, web, check):
        with tempfile.TemporaryDirectory() as directory:
            shutil.unpack_archive(archive, directory)
            port = free_port()
            process = subprocess.Popen([sys.executable, *command, "--port", str(port)], cwd=directory)
            origin = f"http://127.0.0.1:{port}"
            try:
                for attempt in range(100):
                    assert process.poll() is None, f"{archive} server exited before readiness"
                    try:
                        assert b"ESPForge" in fetch(f"{origin}/")[1]
                        break
                    except urllib.error.URLError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError(f"{archive} dashboard did not become ready")
                root = Path(directory) / web
                for path in sorted(root.rglob("*")):
                    if path.is_file():
                        relative = path.relative_to(root).as_posix()
                        assert fetch(f"{origin}/{relative}")[1] == path.read_bytes(), relative
                check(origin, Path(directory))
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)

    def check_direct(origin, directory):
        assert sorted(path.name for path in directory.iterdir() if path.name != "__pycache__") == [
            "LICENSE", "RELEASE.txt", "console_bridge.py", "server.py", "web"]
        headers, body = fetch(f"{origin}/")
        assert f'aria-label="Host application version" title="{commit}">{version}</span>'.encode() in body
        assert "default-src 'self'" in headers["Content-Security-Policy"]
        assert fetch(f"{origin}/favicon.svg")[0]["Content-Type"].startswith("image/svg+xml")
        assert fetch(f"{origin}/js/app.mjs")[0]["Content-Type"].startswith("text/javascript")
        assert json.loads(fetch(f"{origin}/api/console/capabilities")[1]) == {"available": True}

    smoke(f"build/packages/espforge-direct-v{version}.zip", ["server.py"], "web", check_direct)


if __name__ == "__main__":
    main()
