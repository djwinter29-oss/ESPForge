#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
python -m west build -b esp32s3_devkitc/esp32s3/procpu "$root/firmware" \
  -d "$root/build/firmware" -- \
  -DDTC_OVERLAY_FILE=boards/esp32s3_devkitc.overlay \
  -DEF_ENABLE_STORAGE_BENCHMARK=ON
