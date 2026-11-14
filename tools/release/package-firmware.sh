#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong
set -euo pipefail

for expected in 'CONFIG_ESP_SIMPLE_BOOT=y' 'CONFIG_FLASH_SIZE=16777216' \
  'CONFIG_BOARD_TARGET="esp32s3_devkitc/esp32s3/procpu"'; do
  if ! grep -Fxq "$expected" "$FIRMWARE_BUILD/zephyr/.config"; then
    printf 'Error: N16R8 simple-boot packaging requires %s.\n' "$expected" >&2
    exit 1
  fi
done
for expected in --esp-app-address=0x0 --esp-flash-mode=dio \
  --esp-flash-freq=80m --esp-flash-size=16MB; do
  if ! grep -Fq -- "$expected" "$FIRMWARE_BUILD/zephyr/runners.yaml"; then
    printf 'Error: packaged flashing instructions require runner option %s.\n' "$expected" >&2
    exit 1
  fi
done
package=espforge/build/firmware-package
mkdir -p "$package/licenses"
cp espforge/LICENSE "$package/LICENSE"
cp "$FIRMWARE_BUILD"/zephyr/{zephyr.bin,zephyr.elf,.config,zephyr.dts,runners.yaml} "$package/"
cp "$FIRMWARE_BUILD/west-manifest.yml" "$package/"
cp -R espforge/docs "$package/docs"
for component in zephyr modules/hal/espressif modules/crypto/mbedtls; do
  find "$component" -name .git -prune -o -type f \
    \( -iname 'license*' -o -iname 'copying*' -o -iname 'notice*' \
       -o -iname 'copyright*' -o -iname '*third*notice*' \) -print0 |
  while IFS= read -r -d '' source; do
    destination="$package/licenses/$source"
    mkdir -p "$(dirname "$destination")"
    cp "$source" "$destination"
  done
done
sed -n '1,/\*\//p' modules/fs/fatfs/ff.c > "$package/licenses/fatfs-LICENSE"
source_version=$(sed -n 's/^#define ESPFORGE_VERSION "\(.*\)"/\1/p' espforge/firmware/src/app/espforge.h)
{
  printf 'Firmware version: %s\n' "${ESPFORGE_VERSION:-$source_version}"
  printf 'Source commit: %s\n' "$(git -C espforge rev-parse HEAD)"
  printf 'Storage image: %s\n' "$STORAGE"
  printf 'Board: esp32s3_devkitc/esp32s3/procpu\nModule: ESP32-S3-WROOM-1-N16R8\nZephyr SDK: 0.17.4\n'
  printf 'Software build only; not flashed or hardware-qualified. SD testing is deferred.\n'
} > "$package/BUILD-INFO.txt"
cat > "$package/FLASHING.txt" <<'EOF'
Target: ESP32-S3-DevKitC-1 N16R8 / 16 MB flash, 8 MB octal PSRAM, PROCPU, simple-boot image.
This is a software build, not a hardware-qualified release.
Check docs/guides/hardware.md and docs/validation/qualification-gaps.md first.
BUILD-INFO.txt identifies the storage variant. Use only its matching SD wiring.
Disconnect card power before changing between native SDMMC and SD-over-SPI images.

Close all serial clients. Flash through the UART (USB-to-UART) connector;
the USB connector carries the ESPForge HID management interface after boot.
Create/activate a Python virtual environment, then install esptool 5:
  python -m pip install "esptool>=5,<6"
Replace PORT below with the actual serial port:
  python -m esptool --chip esp32s3 --port PORT --baud 460800 write-flash --flash-mode dio --flash-freq 80m --flash-size 16MB 0x0 zephyr.bin
This overwrites image sectors; it does not request a full-chip erase.
Do not use this image on a different flash/module configuration.
If reset fails, hold BOOT, press/release RESET, release BOOT and retry.
Uploader success does not verify application boot, Wi-Fi, BLE or SD behavior.

runners.yaml is build provenance, not a relocatable west build directory.
For the source-build west flash wrapper, follow docs/guides/getting-started.md.
EOF
