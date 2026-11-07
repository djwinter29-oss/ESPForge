#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong
set -euo pipefail
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
	printf 'Usage: bash tools/host/run-direct.sh [--port PORT]\nServes Direct on http://127.0.0.1:PORT/ (default 8000).\n'
	exit 0
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec python3 "$root/host/direct/server.py" "$@"
