# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Version resolution contracts independent of installed packages and hardware."""

import importlib.metadata
from pathlib import Path
import runpy
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
