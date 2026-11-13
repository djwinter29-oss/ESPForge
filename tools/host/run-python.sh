#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong
set -euo pipefail
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
	printf 'Usage: bash tools/host/run-python.sh [web|status|reboot] [OPTIONS]\n'
	printf 'Refreshes the editable host/python install in build/espforge, then runs espforge (default: web).\n'
	printf 'Examples: run-python.sh web | run-python.sh web --serial SERIAL | run-python.sh status --device-path HID_PATH\n'
	printf 'Environment: PYTHON (base interpreter, default python3), VENV_DIR (default build/espforge).\n'
	exit 0
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
venv="${VENV_DIR:-$root/build/espforge}"
base="${PYTHON:-python3}"

if ! command -v "$base" >/dev/null 2>&1; then
	echo "Python interpreter not found: $base" >&2
	exit 1
fi
if ! "$base" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
	echo "ESPForge host tools require Python 3.10 or newer ($base)." >&2
	exit 1
fi

bin="$venv/bin"
[[ -d "$venv/Scripts" ]] && bin="$venv/Scripts"
if [[ ! -x "$bin/python" && ! -x "$bin/python.exe" ]]; then
	if command -v uv >/dev/null 2>&1; then
		uv venv --seed --python "$base" "$venv"
	else
		"$base" -m venv "$venv"
	fi
	[[ -d "$venv/Scripts" ]] && bin="$venv/Scripts"
fi
python="$bin/python"
# Editable source stays live, but version metadata is an installation-time snapshot.
"$python" -m pip install --disable-pip-version-check --no-input --editable "$root/host/python"

command="${1:-web}"
if [[ $# -gt 0 ]]; then
	shift
fi
sh "$root/tools/host/hid-permissions-check.sh"
PYTHONPATH="$root/host/python/src${PYTHONPATH:+:$PYTHONPATH}" exec "$python" -m espforge "$command" "$@"
