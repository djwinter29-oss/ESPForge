# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Bundle the shared dashboard without maintaining a second source copy."""

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict) -> None:
        root = Path(self.root)
        web = root.parent / "web" / "src"
        if web.is_dir():
            destination = "src/espforge/web" if self.target_name == "sdist" else "espforge/web"
            build_data["force_include"][str(web)] = destination
        elif not (root / "src" / "espforge" / "web").is_dir():
            raise FileNotFoundError("Shared dashboard assets are missing")
