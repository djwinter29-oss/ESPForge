#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: bash tools/firmware/flash.sh [--port PORT] [--baud BAUD] [--dry-run]

Flash ESPForge through the USB-to-UART connector; build first if artifacts are missing.
Missing workspace, Python dependencies and build tools are prepared automatically.
  --port PORT   Serial port, e.g. /dev/ttyUSB0 or COM4 (auto-detected if omitted)
  --baud BAUD   Positive upload baud rate (default: 460800)
  --dry-run     Validate prerequisites and print the command; do not flash
  -h, --help    Show this help

Close serial clients before flashing. Existing complete ESP images are reused; incomplete images are rebuilt.
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

[[ "$baud" =~ ^[1-9][0-9]*$ ]] || fail "--baud must be a positive integer"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build="$root/build/firmware"
is_esp_image() {
	[[ -s "$1" ]] && [[ "$(od -An -tx1 -N1 "$1" | tr -d '[:space:]')" == "e9" ]]
}
needs_build=false
for artifact in zephyr.bin zephyr.elf .config runners.yaml; do
	[[ -s "$build/zephyr/$artifact" ]] || needs_build=true
done
is_esp_image "$build/zephyr/zephyr.bin" || needs_build=true
source "$root/tools/firmware/env.sh"
if [[ -z "$port" ]]; then
	port="$(python - <<'PY'
from serial.tools import list_ports

ports = []
for info in list_ports.comports():
    description = f"{info.description or ''} {info.hwid or ''}".lower()
    if info.vid == 0x10c4:
        score = 3
    elif info.vid in (0x1a86, 0x0403, 0x067b):
        score = 2
    elif info.vid is not None and "usb" in description and (
        "serial" in description or "uart" in description
    ):
        score = 1
    else:
        continue
    ports.append((score, info.device, info.description or "USB serial device"))

if not ports:
    raise SystemExit("Error: no likely USB serial port found; connect the board or specify --port.")

best_score = max(score for score, _, _ in ports)
matches = [(device, description) for score, device, description in ports if score == best_score]
if len(matches) != 1:
    choices = ", ".join(f"{device} ({description})" for device, description in matches)
    raise SystemExit(f"Error: multiple likely serial ports found: {choices}; specify --port.")

print(matches[0][0])
PY
)"
	[[ -n "$port" ]] || fail "Could not detect a serial port; specify --port."
	printf 'Auto-detected serial port: %s\n' "$port"
fi
if "$needs_build"; then
	printf 'Build artifacts are missing; building firmware before upload.\n'
	bash "$root/tools/firmware/build.sh"
fi
for artifact in zephyr.bin zephyr.elf .config runners.yaml; do
	[[ -s "$build/zephyr/$artifact" ]] || fail "Build did not produce $build/zephyr/$artifact"
done
is_esp_image "$build/zephyr/zephyr.bin" ||
	fail "Build did not produce a valid ESP image at $build/zephyr/zephyr.bin"
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
