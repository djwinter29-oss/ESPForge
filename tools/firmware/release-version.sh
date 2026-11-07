#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong
set -euo pipefail

if (($# != 1)) || [[ ! "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
	printf 'Error: release tag must be exactly vMAJOR.MINOR.PATCH (no leading zeros).\n' >&2
	exit 1
fi
printf '%s\n' "${1#v}"
