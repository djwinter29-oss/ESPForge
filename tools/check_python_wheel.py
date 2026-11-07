#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Verify an installed wheel with its interpreter, outside the source import path and without hardware."""

import argparse
from importlib.metadata import version
from importlib.resources import files
from importlib.util import find_spec
from pathlib import Path
import subprocess
import sys
import sysconfig


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="expected installed distribution and displayed application version")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    assert sys.flags.isolated, "Run this check with python -I to exclude checkout imports and PYTHONPATH"

    import espforge
    from espforge.dashboard.boards import DashboardBoards
    from espforge.dashboard.server import create_app
    from espforge.hid.device import ESPForgeHid
    from espforge.reports import parse_identity_report

    assert espforge.__file__ is not None, "The installed distribution must be a regular package"
    assert not Path(espforge.__file__).resolve().is_relative_to(root / "host/python")
    assert version("espforge") == args.version
    assert espforge.__version__ == args.version
    assert ESPForgeHid.__module__ == "espforge.hid.device"
    assert parse_identity_report.__module__ == "espforge.reports.identity"
    for name in ("protocol", "uart", "console"):
        assert find_spec(f"espforge.{name}") is None, name
    source = root / "host/web/src"
    expected = {path.relative_to(source).as_posix(): path.read_bytes()
                for path in source.rglob("*") if path.is_file() and "__pycache__" not in path.parts}
    web = files("espforge").joinpath("web")

    def assets(directory, prefix=""):
        result = {}
        for path in directory.iterdir():
            name = prefix + path.name
            if path.is_dir():
                if path.name != "__pycache__":
                    result.update(assets(path, name + "/"))
            else:
                result[name] = path.read_bytes()
        return result

    assert assets(web) == expected, "Installed web payload must contain exactly the source assets"
    boards = DashboardBoards(discover=lambda: [])
    app = create_app(dashboard=boards)
    try:
        client = app.test_client()
        response = client.get("/")
        assert response.status_code == 200
        assert b"ESPForge Dashboard | Python" in response.data
        assert f"App v{args.version}<".encode() in response.data
        for asset, content in expected.items():
            if asset.endswith(".html"):
                continue
            with client.get("/" + asset) as response:
                assert response.status_code == 200, asset
                assert response.data == content, asset
        assert client.get("/src/js/app.mjs").status_code == 404
        assert client.get("/console").status_code == 404
        assert client.get("/api/boards").json == {"boards": [], "default_board_id": None}
    finally:
        boards.close()

    for module in ("espforge.reports", "espforge.reports.models", "espforge.hid",
                   "espforge.dashboard.server", "espforge.cli"):
        subprocess.run([sys.executable, "-I", "-c", f"import {module}"], check=True, timeout=10)
    subprocess.run([sys.executable, "-I", "-m", "espforge", "--help"], check=True, timeout=10,
                   stdout=subprocess.DEVNULL)
    scripts = Path(sysconfig.get_path("scripts"))
    executable = scripts / ("espforge.exe" if sys.platform == "win32" else "espforge")
    subprocess.run([str(executable), "--help"], check=True, timeout=10, stdout=subprocess.DEVNULL)
    print(f"Installed ESPForge {args.version}: imports, entry points, template and {len(expected)} assets verified")


if __name__ == "__main__":
    main()
