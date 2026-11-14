# Firmware development

## Source layout

The firmware is grouped by role: board configuration, platform integration and application services.
Keep hardware-dependent integration separate from portable management logic.

| Directory | Contents |
| --- | --- |
| `src/config/` | Board identity, UID/serial, reset cause and board facts |
| `src/platform/` | Boot settings, flash access, CPU clock and platform hooks |
| `src/app/` | Shared services and telemetry |
| `src/app/control/` | Portable Report 20 control dispatcher shared by USB and BLE |
| `src/app/usb/` | USB HID integration and portable report encoding |
| `src/app/storage/` | SD-card mount and Storage report |
| `src/app/wireless/` | Portable staging, command authentication and SHA-256/HMAC |
| `src/app/wireless/bluetooth/` | BLE GATT service and advertising |
| `src/app/wireless/wifi/` | Wi-Fi saved-network joins, candidate tests and scans |

Native tests are grouped by the same service roles.

## Host-native unit tests

ESPForge uses Ceedling 1.1.10 with Unity and CMock. Install Ruby 3.3,
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

The native build exercises portable production logic through narrow platform interfaces.
Zephyr stack integration, hardware sampling, SD mounting, flash access and clock application are excluded:

| Suite | Production logic exercised |
| --- | --- |
| Control | Shared opcode dispatcher: status/error replies, Wi-Fi base/key staging, test/cancel/scan, settings, reboot, resync and unsupported opcodes |
| Reports | Exact USB HID/BLE report byte layouts, little-endian fields and flags |
| Benchmark | Temporary-file write/read verification and cancellation/cleanup safety over an in-memory backend |
| Authentication | HMAC-SHA-256 command authentication, nonces, replay rejection and key-change handling |
| Wireless staging | Staged Wi-Fi credentials, password rules, expiry, tested flag and key-only commits |
| Cryptography | SHA-256/HMAC vectors |
| Settings | [Boot settings](../reference/settings.md) record layout, CRC-32, validation, staging, discard, save failure and next-boot snapshots over an in-memory flash fake |

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

`EF_ENABLE_STORAGE_BENCHMARK` is a CMake option defaulting to `OFF`. The build wrapper currently supplies
`-DEF_ENABLE_STORAGE_BENCHMARK=ON`; it enables dashboard-controlled runs, not automatic writes.
For a manual build, choose `west build ... -- -DEF_ENABLE_STORAGE_BENCHMARK=OFF` to omit it.
An existing CMake cache retains its chosen value, so use a fresh build directory to verify the default.
See the [benchmark contract](../reference/sdcard.md#optional-storage-benchmark) before authorizing card writes.

Zephyr 4.3.2 and imported module commits are selected by `west.yml`; SDK 0.17.4 is the toolchain.
The wrappers bootstrap missing prerequisites on Debian/Ubuntu-compatible Linux, including Raspberry Pi OS.
Missing host packages are installed through `apt-get` with `sudo` when not root; a password may be requested.
On other systems, install the reported host prerequisites with your package manager and rerun the script.
If the checkout is not already in a workspace, its parent directory becomes the workspace; `.west`, `.venv`,
Zephyr and modules are placed there. An existing ancestor workspace is reused rather than nested.
The build and flash scripts create or reuse `.venv` at the workspace root and activate it for their subprocesses.
They install `west` and the workspace's Zephyr base and Espressif Python requirements on each invocation;
already satisfied dependencies are reused. Set `PYTHON` to choose the interpreter when creating the venv
(for example `PYTHON=python3.12`), or `VENV_DIR` to use another venv. An unrelated active venv is not selected automatically.
Activation does not change the calling shell; use `. .venv/bin/activate` from the workspace for manual `west` commands.
They update modules to the pinned manifest, fetch required radio blobs and install SDK 0.17.4 with the ESP32-S3
toolchain if no complete SDK is found in `ZEPHYR_SDK_INSTALL_DIR`, the home directory or `/opt`.
First use requires network access and several GB of free space. Installation and build errors stop execution;
no upload is attempted after a failed build. See [manual workspace setup](../guides/getting-started.md#1-prepare-a-zephyr-workspace)
if you prefer to provision dependencies yourself.
Run from the checkout:

```sh
bash tools/firmware/build.sh
python3 tools/check_firmware_config.py
```

The default image uses native four-bit SDMMC. Build and check the alternate SD-over-SPI image with:

```sh
bash tools/firmware/build.sh --storage sd-spi
python3 tools/check_firmware_config.py --storage sd-spi
```

Outputs are separate: `build/firmware/zephyr/zephyr.bin` (native) and
`build/firmware-sd-spi/zephyr/zephyr.bin` (SPI). `--storage sdmmc` explicitly selects the default.
Both retain card detection, FAT mounting and explicit USB drive handoff; neither formats a card.
Use the matching [SD wiring](../reference/sdcard.md#pin-allocation) and disconnect card power when changing buses.

Host Validation also compiles the report tests for SPI with benchmarking enabled:

```sh
bundle exec ceedling --mixin '={project: {build_root: build/ceedling-sd-spi}, defines: {test: [EF_STORAGE_SPI=1, EF_ENABLE_STORAGE_BENCHMARK=1]}}' test:test_hid_reports
```

For changes to board/configuration selection, use a pristine build from the workspace:

```sh
west build -p always -b esp32s3_devkitc/esp32s3/procpu espforge/firmware \
  -d espforge/build/firmware -- -DDTC_OVERLAY_FILE=boards/esp32s3_devkitc.overlay
```

Inspect generated `build/firmware/zephyr/.config` and `zephyr.dts`, not just source intent.
Required defaults include Wi-Fi, BLE, software coexistence, native Espressif SDHC, SDMMC disk, FatFs and
the `device_next` USB stack with HID/MSC, and UART/raw TCP diagnostic shells. Both FAT mkfs options must remain disabled.
The configuration check also verifies native slot 0, four-bit width, the 25 MHz ceiling,
GPIO12/11/13/14/15/10 in CLK/CMD/DAT0-DAT3 order, and command/data pull-up configuration.
For SPI it instead verifies the SPI SD driver, disabled native slot, SPI3 SCK/MOSI/MISO on GPIO12/11/13
and active-low CS on GPIO10. Both require active-high GPIO8 card detection with a pull-down.
Manual SPI builds use `boards/esp32s3_devkitc_sd_spi.overlay` and a separate build directory.
The management protocol runs over the ESP32-S3 native USB connector (USB HID, VID:PID `CAFE:4021`)
and BLE GATT.
The UART connector carries the Zephyr diagnostic shell/log output and the ROM bootloader used for flashing;
it has no dashboard management protocol. Shell commands and TCP exposure are defined in the
[console guide](../guides/console.md).

The reusable build also freezes the resolved west manifest and attaches binaries, configuration,
dependency licenses and software-only flashing instructions. PRs and tagged releases use this same
build path. An optional `ESPFORGE_VERSION=MAJOR.MINOR.PATCH` environment override sets the firmware
version for release builds; an empty/unset override preserves the development default.
Invalid overrides fail configuration rather than silently using another version.
See [release automation](../deployment/release.md) for package contents and preflight.

## USB upload wrapper

Use [the USB flashing instructions](../guides/getting-started.md#2-build-now-flash-later).
`tools/firmware/flash.sh` wraps `west flash` with the ESP32 runner, 460800 upload baud,
`--skip-rebuild` and `--no-erase`. If `--port PORT` is omitted, it selects a likely USB-UART
port, preferring Silicon Labs CP210x devices; tied candidates require an explicit port.
`--baud` overrides upload speed; `--dry-run` validates artifacts and prints the command
without connecting to or flashing a device. Missing or empty required build artifacts trigger a build first;
complete existing builds are reused. Select `--storage sd-spi` for the alternate image, or `--storage sdmmc`
for native. Builds with the wrong board or storage driver are rejected. Runner errors propagate to the caller.

`--dry-run` also prepares dependencies and builds missing firmware.
Use `--help` and `--dry-run` to inspect it before uploading to hardware.
Software-only wrapper tests use mocked installers and runners:
`python3 -m unittest discover -s firmware/tests/tooling -v`.

Do not connect an SD card or run storage tests for software-only setup.
Compilation does not validate initialization, USB enumeration, BLE/Wi-Fi coexistence, or filesystem reliability.
Record software evidence separately from future hardware observations in [validation records](../validation/records/README.md).
