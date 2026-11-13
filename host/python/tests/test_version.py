# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Version resolution contracts independent of installed packages and hardware."""

import importlib.metadata
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "espforge" / "__init__.py"


class VersionTests(unittest.TestCase):
    def test_package_export_matches_installed_distribution_metadata(self):
        import espforge

        try:
            installed = importlib.metadata.version("espforge")
        except importlib.metadata.PackageNotFoundError:
            installed = "0.0.0-debug"
        self.assertEqual(espforge.__version__, installed)

    def test_missing_distribution_uses_source_fallback(self):
        with patch("importlib.metadata.version", side_effect=importlib.metadata.PackageNotFoundError) as lookup:
            package = runpy.run_path(str(PACKAGE))
        lookup.assert_called_once_with("espforge")
        self.assertEqual(package["__version__"], "0.0.0-debug")

    def test_installed_metadata_is_used_for_wheels_and_editable_source_imports(self):
        for version in ("1.2.3", "1.2.4.dev5+g1234567", "0.0.0.dev0"):
            with self.subTest(version=version), patch("importlib.metadata.version", return_value=version) as lookup:
                package = runpy.run_path(str(PACKAGE))
                self.assertEqual(package["__version__"], version)
                lookup.assert_called_once_with("espforge")

    def test_unexpected_metadata_errors_are_not_hidden(self):
        with patch("importlib.metadata.version", side_effect=OSError("Metadata unreadable")):
            with self.assertRaisesRegex(OSError, "Metadata unreadable"):
                runpy.run_path(str(PACKAGE))


@unittest.skipUnless(os.name == "posix" and shutil.which("bash"), "Bash launcher checks require POSIX")
class LauncherVersionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="espforge-python-launcher-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / "ESPForge"
        tools = root / "tools/host"
        tools.mkdir(parents=True)
        self.script = tools / "run-python.sh"
        shutil.copyfile(Path(__file__).resolve().parents[3] / "tools/host/run-python.sh", self.script)
        (tools / "hid-permissions-check.sh").write_text("#!/bin/sh\nexit 0\n")
        venv = root / "existing venv"
        (venv / "bin").mkdir(parents=True)
        python = venv / "bin/python"
        python.write_text("""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$LAUNCH_LOG"
case "$*" in
    "-c "*) exit 0 ;;
    "-m pip install "*)
        if [[ "${LAUNCH_PIP_STATUS:-0}" != 0 ]]; then
            echo "Installation failed" >&2
            exit "$LAUNCH_PIP_STATUS"
        fi ;;
    "-m espforge "*) exit 0 ;;
    *) echo "Unexpected invocation: $*" >&2; exit 99 ;;
esac
""")
        python.chmod(0o755)
        self.log = root / "commands.log"
        self.env = os.environ | {"PYTHON": str(python), "VENV_DIR": str(venv), "LAUNCH_LOG": str(self.log)}
        self.env.pop("LAUNCH_PIP_STATUS", None)

    def launch(self):
        return subprocess.run(["bash", str(self.script), "web", "--port", "8011"],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def test_existing_environment_refreshes_metadata_before_every_launch(self):
        for _ in range(2):
            result = self.launch()
            self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text().splitlines()
        actions = ["install" if "-m pip install " in line else "launch" for line in commands
                   if "-m pip install " in line or "-m espforge " in line]
        self.assertEqual(actions, ["install", "launch", "install", "launch"])
        self.assertEqual(commands[-1], "-m espforge web --port 8011")
        self.assertIn("--editable", commands[1])

    def test_failed_metadata_refresh_never_launches_the_old_installation(self):
        self.env["LAUNCH_PIP_STATUS"] = "23"
        result = self.launch()
        self.assertEqual(result.returncode, 23)
        self.assertIn("Installation failed", result.stderr)
        self.assertNotIn("-m espforge ", self.log.read_text())
