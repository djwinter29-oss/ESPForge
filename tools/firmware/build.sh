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
	sdmmc) build=firmware; overlay=esp32s3_devkitc_n16r8_sdmmc.overlay ;;
	sd-spi) build=firmware-sd-spi; overlay=esp32s3_devkitc_n16r8_sd_spi.overlay ;;
	*) printf 'Error: --storage must be sdmmc or sd-spi.\n' >&2; exit 1 ;;
esac
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cache="$root/build/$build/CMakeCache.txt"
if [[ -f "$cache" ]]; then
	cached_build="$(sed -n 's/^APPLICATION_BINARY_DIR:PATH=//p' "$cache")"
	if [[ -n "$cached_build" && "$cached_build" != "$root/build/$build" ]]; then
		printf 'Build directory moved; cleaning %s before rebuilding.\n' "$root/build/$build"
		cmake "-DBINARY_DIR=$root/build/$build" "-DSOURCE_DIR=$root/firmware" \
			-P "$ZEPHYR_BASE/cmake/pristine.cmake"
	fi
fi
python -m west build --pristine auto -b esp32s3_devkitc/esp32s3/procpu "$root/firmware" \
  -d "$root/build/$build" -- \
  -DDTC_OVERLAY_FILE="boards/$overlay" \
  -DZF_ENABLE_STORAGE_BENCHMARK=ON
