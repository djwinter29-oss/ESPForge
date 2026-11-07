# Firmware development

## Host-native unit tests

Like PicoForge, ESPForge uses Ceedling 1.1.10 with Unity and CMock. Install Ruby 3.3,
Bundler 2.6.9 and a native GCC toolchain (`gcc` on PATH). These tests need neither
Zephyr nor an ESP32-S3 board. From the repository root:

```sh
gem install bundler -v 2.6.9
bundle config set --local path build/gems
bundle install
bundle exec ceedling test:all
```

`Gemfile` pins Ceedling and `Gemfile.lock` locks its dependencies. Commit the lockfile
when intentionally updating tools. Local gems, mock code, runners and test binaries
are ignored build products, not firmware dependencies.

```sh
# One suite
bundle exec ceedling test:control
bundle exec ceedling test:wireless_auth

# Regenerate runners/mocks and rebuild tests
bundle exec ceedling clobber test:all
```

The root [project.yml](../../project.yml) selects production C from `firmware/src/`
and tests from `firmware/tests/`. Zephyr glue (`main.c`, `board.c`, `usb_hid.c`, `ble.c`,
`wifi.c`, `telemetry.c`, `storage.c`, `boot_flash.c` and `system_clock.c`) is excluded from
the native build. The portable protocol core talks to it only through [ef_platform.h](../../firmware/src/ef_platform.h):

| Suite | Production logic exercised |
| --- | --- |
| `test_control.c` | Shared opcode dispatcher: status/error replies, Wi-Fi base/key staging, test/cancel/scan, settings, reboot, resync and unsupported opcodes |
| `test_hid_reports.c` | Exact USB HID/BLE report byte layouts, little-endian fields and flags |
| `test_wireless_auth.c` | HMAC-SHA-256 command authentication, nonces, replay rejection and key-change handling |
| `test_wireless_stage.c` | Staged Wi-Fi credentials, password rules, expiry, tested flag and key-only commits |
| `test_sha256.c` | SHA-256/HMAC vectors |
| `test_boot_config.c` | [Boot settings](../reference/settings.md) record layout, CRC-32, validation, staging, discard, save failure and next-boot snapshots over an in-memory flash fake |

Platform hooks are CMock-generated mocks. **The tests do not compile the SD driver, mount a card,
format, write or test SD storage.** The Zephyr application calls these same portable modules;
tests do not duplicate them. Native compilation enables C11 and treats compiler warnings as errors.

Add portable logic tests here and mock only narrow service interfaces. Do not recreate
Zephyr internals with large fake headers. Use Zephyr ztest/Twister for future kernel
or driver integration tests; no ztest suite is configured yet. USB/BLE stacks, real Wi-Fi behavior,
flash programming, clock changes and boot remain outside this native suite.

The `firmware-unit` job in [Host Validation](../../.github/workflows/host-validation.yml)
runs the same command independently of the reusable [ESP32-S3 build](../../.github/workflows/firmware-build.yml).
Both must pass for firmware changes; a native test pass is not target-build or hardware evidence.

## Zephyr target build

Follow [workspace setup](../guides/getting-started.md#1-prepare-a-zephyr-workspace) before building.
Zephyr 4.3.2 and imported module commits are selected by `west.yml`; SDK 0.17.4 is the toolchain.
Run the build script from anywhere within the initialized workspace, with its Python venv activated:

```sh
bash espforge/tools/firmware/build.sh
python espforge/tools/check_firmware_config.py
```

For changes to board/configuration selection, use a pristine build from the workspace:

```sh
west build -p always -b esp32s3_devkitc/esp32s3/procpu espforge/firmware \
  -d espforge/build/firmware -- -DDTC_OVERLAY_FILE=boards/esp32s3_devkitc.overlay
```

Inspect generated `build/firmware/zephyr/.config` and `zephyr.dts`, not just source intent.
Required defaults include Wi-Fi, BLE, software coexistence, SPI SDHC, SDMMC disk, FatFs and
the `device_next` USB stack with HID. Both FAT mkfs options must remain disabled.
The management protocol runs over the ESP32-S3 native USB connector (USB HID, VID:PID `CAFE:4021`)
and BLE GATT, as described in the [ESPForge profile](../reference/espforge-profile.md).
The UART connector carries only the Zephyr console/log output and the ROM bootloader used for flashing;
it has no management protocol.

The reusable build also freezes the resolved west manifest and attaches binaries, configuration,
dependency licenses and software-only flashing instructions. PRs and tagged releases use this same
build path. An optional `ESPFORGE_VERSION=MAJOR.MINOR.PATCH` environment override sets the firmware
version for release builds; an empty/unset override preserves `espforge.h`'s default.
Invalid overrides fail configuration rather than silently using another version.
See [release automation](../deployment/release.md) for package contents and preflight.

## USB upload wrapper

After building, use [the USB flashing instructions](../guides/getting-started.md#2-build-now-flash-later).
`tools/firmware/flash.sh --port PORT` wraps `west flash` with the ESP32 runner,
explicit port, 460800 upload baud, `--skip-rebuild` and `--no-erase`.
`--baud` overrides upload speed; `--dry-run` validates artifacts and prints the command
without accessing a device. Runner errors propagate to the caller.

This is a manual operator tool, with no dedicated automated test suite or CI test step.
Use `--help` and `--dry-run` to inspect it before uploading to hardware.

Do not connect an SD card or run storage tests for software-only setup.
Compilation does not validate initialization, USB enumeration, BLE/Wi-Fi coexistence, or filesystem reliability.
Record software evidence separately from future hardware observations in [validation records](../validation/records/README.md).
