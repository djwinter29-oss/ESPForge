#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
west build -b esp32s3_devkitc/esp32s3/procpu "$root/firmware" \
  -d "$root/build/firmware" -- \
  -DDTC_OVERLAY_FILE=boards/esp32s3_devkitc.overlay
