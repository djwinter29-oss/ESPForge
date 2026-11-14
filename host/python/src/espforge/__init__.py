# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""ESPForge host tools."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("espforge")
except PackageNotFoundError:
    __version__ = "0.0.0-debug"

__all__ = ["__version__"]
