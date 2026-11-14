#!/usr/bin/env bash
set -euo pipefail
storage=sdmmc
while (($#)); do
	case "$1" in
		--storage)
			(($# >= 2)) || { printf 'Error: --storage requires sdmmc or sd-spi.\n' >&2; exit 1; }
			storage="$2"; shift 2 ;;
		-h|--help)
			printf 'Usage: bash tools/firmware/build.sh [--storage sdmmc|sd-spi]\n'
			exit 0 ;;
		*) printf 'Error: unknown argument: %s\n' "$1" >&2; exit 1 ;;
	esac
done
case "$storage" in
	sdmmc) build=firmware; overlay=esp32s3_devkitc.overlay ;;
	sd-spi) build=firmware-sd-spi; overlay=esp32s3_devkitc_sd_spi.overlay ;;
	*) printf 'Error: --storage must be sdmmc or sd-spi.\n' >&2; exit 1 ;;
esac
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
python -m west build -b esp32s3_devkitc/esp32s3/procpu "$root/firmware" \
  -d "$root/build/$build" -- \
  -DDTC_OVERLAY_FILE="boards/$overlay" \
  -DEF_ENABLE_STORAGE_BENCHMARK=ON
