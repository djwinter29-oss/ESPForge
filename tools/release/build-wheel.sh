#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong
set -euo pipefail

cp LICENSE host/python/LICENSE
mkdir -p host/python/src/espforge/web
cp -R host/web/src/. host/python/src/espforge/web/
python -m pip wheel --disable-pip-version-check --no-deps host/python --wheel-dir dist
