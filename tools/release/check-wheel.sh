#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong
set -euo pipefail

python -m venv build/wheel-check
build/wheel-check/bin/python -m pip install --disable-pip-version-check dist/*.whl
build/wheel-check/bin/python -I tools/check_python_wheel.py "$VERSION"
