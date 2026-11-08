#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: bash tools/firmware/flash.sh --port PORT [--baud BAUD] [--dry-run]

Flash ESPForge through the USB-to-UART connector; build first if artifacts are missing.
Missing workspace, Python dependencies and build tools are prepared automatically.
  --port PORT   Required serial port, e.g. /dev/ttyUSB0 or COM4
  --baud BAUD   Positive upload baud rate (default: 460800)
  --dry-run     Validate prerequisites and print the command; do not flash
  -h, --help    Show this help

Close serial clients before flashing. Existing complete builds are reused, not rebuilt.
Environment: PYTHON (default python3), VENV_DIR (default workspace/.venv).
The venv is created/reused and dependencies installed, including for --dry-run.
Flashing replaces existing firmware; this script does not request a full-chip erase.
EOF
}

fail() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

port=""
baud=460800
dry_run=false
while (($#)); do
	case "$1" in
		--port|--baud)
			(($# >= 2)) && [[ -n "$2" && "$2" != -* ]] ||
				fail "$1 requires a value"
			if [[ "$1" == --port ]]; then
				port="$2"
			else
				baud="$2"
			fi
			shift 2
			;;
		--dry-run) dry_run=true; shift ;;
		-h|--help) usage; exit 0 ;;
		*) fail "Unknown argument: $1 (use --help)" ;;
	esac
done

[[ -n "$port" ]] || fail "--port is required; use --help for examples"
[[ "$baud" =~ ^[1-9][0-9]*$ ]] || fail "--baud must be a positive integer"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build="$root/build/firmware"
needs_build=false
for artifact in zephyr.bin zephyr.elf .config runners.yaml; do
	[[ -s "$build/zephyr/$artifact" ]] || needs_build=true
done
source "$root/tools/firmware/env.sh"
if "$needs_build"; then
	printf 'Build artifacts are missing; building firmware before upload.\n'
	bash "$root/tools/firmware/build.sh"
fi
for artifact in zephyr.bin zephyr.elf .config runners.yaml; do
	[[ -s "$build/zephyr/$artifact" ]] || fail "Build did not produce $build/zephyr/$artifact"
done
grep -Fxq 'CONFIG_BOARD_TARGET="esp32s3_devkitc/esp32s3/procpu"' "$build/zephyr/.config" ||
	fail "Build is not for esp32s3_devkitc/esp32s3/procpu; rebuild for the supported target"

command=(python -m west flash -d "$build" --skip-rebuild -r esp32
	--esp-device "$port" --esp-baud-rate "$baud" --no-erase)

if "$dry_run"; then
	printf 'Dry run only (no device access): '
	printf '%q ' "${command[@]}"
	printf '\n'
	exit 0
fi

printf 'Flashing ESP32-S3 on %s at %s baud; existing firmware will be replaced.\n' "$port" "$baud"
exec "${command[@]}"
