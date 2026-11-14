#!/usr/bin/env bash
# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong
set -euo pipefail

for storage in sdmmc sd-spi; do
  (cd "build/firmware-packages/espforge-esp32s3-$storage-software-build" &&
    zip -r "../../packages/espforge-firmware-v$VERSION-esp32s3-devkitc-$storage.zip" .)
done
cd build/packages
sha256sum *.zip *.tar.gz *.whl > SHA256SUMS.txt
