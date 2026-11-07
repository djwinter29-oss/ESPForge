# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

import unittest
import subprocess
import sys
from fnmatch import fnmatch
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    tomllib = None

PROJECT = Path(__file__).resolve().parents[1]


class PackagingTests(unittest.TestCase):
    def test_public_packages_import_independently_without_hardware(self):
        for module in ("espforge.reports", "espforge.hid", "espforge.dashboard.server",
                       "espforge.reports.models"):
            with self.subTest(module=module):
                result = subprocess.run(
                    [sys.executable, "-c", f"import {module}"], capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_public_apis_live_in_their_domain_packages(self):
        from espforge.dashboard import monitor as dashboard_monitor
        from espforge.dashboard import server
        from espforge.hid import device as hid_device
        import espforge.reports as reports

        self.assertNotIn("struct", reports.__all__)
        self.assertEqual(hid_device.ESPForgeHid.__module__, "espforge.hid.device")
        self.assertEqual(dashboard_monitor.DeviceMonitor.__module__, "espforge.dashboard.monitor")
        self.assertEqual(server.create_app.__module__, "espforge.dashboard.server")
        self.assertIn("parse_identity_report", reports.__all__)
        self.assertIn("parse_wireless_status_report", reports.__all__)
        self.assertIn("parse_memory_report", reports.__all__)
        for alias in ("parse_telemetry_report", "parse_storage_report",
                      "parse_self_test_status_report", "parse_tcp_cli_auth_result",
                      "build_led_command_report", "build_msc_command_report",
                      "build_self_test_command_report", "build_tcp_cli_auth_request"):
            self.assertNotIn(alias, reports.__all__)

    def test_compatibility_modules_are_removed(self):
        package = PROJECT / "src" / "espforge"
        for module in ("console", "device", "monitor", "protocol", "web", "demo", "server"):
            self.assertFalse((package / f"{module}.py").exists(), module)
        for removed in ("uart", "protocol", "reports/hid.py", "reports/self_test.py", "hid/models.py",
                        "dashboard/console.py"):
            self.assertFalse((package / removed).exists(), removed)

    @unittest.skipIf(tomllib is None, "tomllib requires Python 3.11")
    def test_lock_matches_declared_runtime_dependencies(self):
        project = tomllib.loads((PROJECT / "pyproject.toml").read_text())["project"]
        packages = tomllib.loads((PROJECT / "uv.lock").read_text())["package"]
        locked = next(package for package in packages if package["name"] == project["name"])
        declared = {requirement.lower() for requirement in project["dependencies"]}
        self.assertEqual(
            {requirement["name"] + requirement["specifier"] for requirement in locked["metadata"]["requires-dist"]},
            declared,
        )
        for dependency in declared:
            name, version = dependency.split("==")
            self.assertEqual(next(package["version"] for package in packages if package["name"] == name), version)

    @unittest.skipIf(tomllib is None, "tomllib requires Python 3.11")
    def test_package_metadata_includes_repository_license(self):
        project = tomllib.loads((PROJECT / "pyproject.toml").read_text())["project"]
        self.assertEqual(project["version"], "0.0.0.dev0")
        packages = tomllib.loads((PROJECT / "uv.lock").read_text())["package"]
        self.assertEqual(next(package["version"] for package in packages if package["name"] == "espforge"),
                         project["version"])
        self.assertEqual(project["license"], "BSD-3-Clause")
        self.assertEqual(project["license-files"], ["LICENSE"])
        self.assertEqual((PROJECT / "LICENSE").read_bytes(), (PROJECT.parents[1] / "LICENSE").read_bytes())
        self.assertEqual(project["scripts"], {"espforge": "espforge.cli:main"})
        self.assertEqual(project["requires-python"], ">=3.10")
        self.assertIn("Documentation", project["urls"])
        self.assertIn("Source", project["urls"])

    @unittest.skipIf(tomllib is None, "tomllib requires Python 3.11")
    def test_wheel_packages_every_dashboard_asset_from_host_web(self):
        setuptools = tomllib.loads((PROJECT / "pyproject.toml").read_text())["tool"]["setuptools"]
        web = (PROJECT / setuptools["package-dir"]["espforge.web"]).resolve()
        self.assertEqual(web, PROJECT.parent / "web/src")
        self.assertIn("espforge.web", setuptools["packages"])
        patterns = setuptools["package-data"]["espforge.web"]
        assets = [p.relative_to(web).as_posix() for p in web.rglob("*")
                  if p.is_file() and not {"__pycache__", "tests"}.intersection(p.parts)]
        self.assertTrue(assets)
        for asset in assets:
            self.assertTrue(any(fnmatch(asset, pattern) for pattern in patterns), asset)
        self.assertIn("js/wireless-form.mjs", assets)
        self.assertEqual(
            setuptools["packages"],
            ["espforge", "espforge.web", "espforge.reports", "espforge.hid", "espforge.dashboard"],
        )
