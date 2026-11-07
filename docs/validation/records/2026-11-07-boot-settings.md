# Boot settings - 2026-11-07

## Scope

Adapted PicoForge's boot settings design (commit `5e61572`) as [settings.md](../../reference/settings.md).
Added `firmware/src/boot_config.c/.h`, which keeps PicoForge's 148-byte record offsets with magic `EFCF` version 1.
Also added `boot_flash.c/.h` (first sector of `storage_partition` through `flash_area`) and `system_clock.c`
(80/160/240 MHz CPU profiles through ESP32 clock control). `main()` now loads settings, applies the clock, starts
only the enabled radios and reconnects a saved network. `wifi.connect` saves accepted credentials. Status
`wifi_enabled` and `ble_enabled` report the boot switches. Dashboard wording changed from "this boot" to "connect
and save". `check_firmware_config.py` now also requires flash/clock-control support and rejects images that reach
the settings partition.

## Observed checks

| Check | Observation |
| --- | --- |
| Ceedling 1.1.10 `test:all` | 39 passed: 15 boot settings (fake flash), 15 credentials, 9 status format |
| Zephyr 4.2.0 / SDK 0.17.2 pristine build, `esp32s3_devkitc/esp32s3/procpu` | Passed with no compiler warnings; image 644,600 bytes; `storage_partition` at `0x3B0000` (192 KiB) |
| `check_firmware_config.py` | Passed; overlap check also rejected a synthetic image ending past a synthetic partition |
| Web (42) and Direct (77) Node tests, Direct server tests, both TypeScript checks | Passed |
| Shared and Direct Chromium checks, .NET tests and synthetic serial, Python tests | Passed |
| Documentation links | 192 local targets passed |

## Evidence limits

No ESP32-S3 hardware was connected. Flash erase, program and readback, power-loss behaviour, CPU clock switching,
saved-network reconnect and radio-disable behaviour are unobserved on a board. No settings editor exists yet; the
HID settings commands remain the documented target.
