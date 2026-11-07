# N16R8 Flash and PSRAM

Date: 2026-11-07. Scope: retargeting the firmware from the N8 default DTS to the ESP32-S3-DevKitC-1 N16R8
(16 MB quad flash, 8 MB octal PSRAM).

## Changes

- [Board overlay](../../../firmware/boards/esp32s3_devkitc.overlay): `flash0` is 16 MB, the upstream 4 MB partition
  table is replaced by Zephyr's `partitions_0x0_amp_16M.dtsi`, and `psram0` is 8 MB.
- [prj.conf](../../../firmware/prj.conf): `CONFIG_ESPTOOLPY_FLASHSIZE_16MB`, `CONFIG_ESP_SPIRAM`,
  `CONFIG_SPIRAM_MODE_OCT` and the boot-time PSRAM memory test.
- [check_firmware_config.py](../../../tools/check_firmware_config.py) requires octal PSRAM, `CONFIG_FLASH_SIZE`
  16 MB and `CONFIG_ESP_SPIRAM_SIZE` 8 MB. CI packaging expects `--esp-flash-size=16MB`.

## What ran

| Check | Result |
| --- | --- |
| `west build` for `esp32s3_devkitc/esp32s3/procpu` | Clean, 0 warnings; FLASH 4.3% of 16 MB, `ext_dram_seg` 8 MB region present |
| `.config` | `CONFIG_FLASH_SIZE=16777216`, `CONFIG_ESP_SPIRAM_SIZE=8388608`, `CONFIG_SPIRAM_MODE_OCT=y`, 40 MHz |
| `runners.yaml` | `--esp-flash-size=16MB`, `--esp-flash-mode=dio`, `--esp-flash-freq=80m` |
| `zephyr.dts` | `storage_partition` at `0xFB0000`, 192 KiB |
| `tools/check_firmware_config.py` | Pass |

## Not tested

No board was flashed. PSRAM detection, the memory test and boot on a physical N16R8 module are unverified.
Settings saved by an earlier N8 build were at `0x3B0000` and are not migrated; the first N16R8 boot loads defaults.
