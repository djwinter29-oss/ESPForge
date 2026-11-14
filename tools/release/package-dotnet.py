#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Archive and smoke-check a published .NET host from the repository root using VERSION and RID."""

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main() -> None:
    version, rid = os.environ["VERSION"], os.environ["RID"]
    source_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    root = Path("build/host-release").resolve()
    web = Path("host/web/src")
    assets = {path.relative_to(web).as_posix(): path.read_bytes() for path in web.rglob("*")
              if path.is_file() and "__pycache__" not in path.parts}
    assert assets, "Shared dashboard assets are missing"
    libraries = json.loads((root / "ESPForge.deps.json").read_text())["libraries"]
    assert f"ESPForge/{version}" in libraries, "Package version does not match release"
    shutil.copyfile("LICENSE", root / "LICENSE")
    notices = [path for path in Path("build/nuget").rglob("*")
               if path.is_file() and ("license" in path.name.lower()
                                      or "notice" in path.name.lower())]
    assert notices, "Restored dependency license notices are missing"
    for path in notices:
        destination = root / "licenses" / path.relative_to("build/nuget")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
    (root / "RELEASE.txt").write_text(
        f"ESPForge {version} ({rid})\nSource: {source_sha}\n"
        "Run ESPForge, optionally with --serial SERIAL or --device-path HID_PATH.\n"
        "On Windows use ESPForge.exe. Open http://127.0.0.1:8002/.\n"
        "No .NET installation is required. Only loopback hosting is supported.\n"
        "Software checks do not qualify physical USB HID, Wi-Fi, BLE or SD behavior.\n",
        encoding="utf-8")
    Path("build/packages").mkdir(parents=True, exist_ok=True)
    archive = shutil.make_archive(f"build/packages/espforge-host-v{version}-{rid}",
                                  "zip" if rid.startswith("win-") else "gztar", root_dir=root)
    with tempfile.TemporaryDirectory() as directory:
        shutil.unpack_archive(archive, directory)
        wwwroot = Path(directory) / "wwwroot"
        deployed = {path.relative_to(wwwroot).as_posix(): path.read_bytes()
                    for path in wwwroot.rglob("*") if path.is_file() and path.suffix not in (".gz", ".br")}
        assert deployed == assets, "Published shared dashboard assets differ from source"
        executable = Path(directory) / ("ESPForge.exe" if rid.startswith("win-") else "ESPForge")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        process = subprocess.Popen([str(executable), "--port", str(port)], cwd=directory)
        try:
            for attempt in range(100):
                assert process.poll() is None, "Standalone host exited before readiness"
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as response:
                        page = response.read()
                        assert b"ESPForge Dashboard | .NET" in page
                        assert f"App v{version}<".encode() in page, "Dashboard version does not match release"
                    break
                except urllib.error.URLError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Standalone dashboard did not become ready")
            pages = {"index.html": "/", "console.html": "/console"}
            for name, content in assets.items():
                route = pages.get(name, f"/{name}")
                if name in pages:
                    content = content.replace(b"{{ dashboard_type }}", b".NET").replace(
                        b"{{ app_version }}", version.encode())
                with urllib.request.urlopen(f"http://127.0.0.1:{port}{route}", timeout=2) as response:
                    assert response.read() == content, name
                    assert response.headers["X-Content-Type-Options"] == "nosniff", name
                    expected_type = {".html": "text/html", ".css": "text/css", ".mjs": "text/javascript",
                                     ".svg": "image/svg+xml"}[Path(name).suffix]
                    assert response.headers["Content-Type"].startswith(expected_type), name
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/boards", timeout=5) as response:
                reply = json.load(response)
                assert isinstance(reply["boards"], list) and "default_board_id" in reply, reply
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


if __name__ == "__main__":
    main()
