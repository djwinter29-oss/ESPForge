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
bundle exec ceedling test:credentials
bundle exec ceedling test:status_format

# Regenerate runners/mocks and rebuild tests
bundle exec ceedling clobber test:all
```

The root [project.yml](../../project.yml) selects production C from `firmware/src/`
and tests from `firmware/tests/`. Zephyr-facing `main.c`, `status.c`, `wireless.c`
and `storage.c` are excluded from the native build:

| Suite | Production logic exercised |
| --- | --- |
| `test_credentials.c` | Hex decoding, embedded-NUL rejection, output capacity, SSID/password byte limits, UTF-8 and open-network credentials |
| `test_status_format.c` | Exact JSON contract, radio/error reporting, 64-bit uptime, numeric limits, buffer boundaries |

Status tests use CMock-generated `espforge.h` mocks for radio state and mount-result
inputs. **They do not compile the SD driver, mount a card, format, write or test SD storage.**
The Zephyr application calls these same portable modules; tests do not duplicate them.
Native compilation enables C11 and treats compiler warnings as errors.

Add portable logic tests here and mock only narrow service interfaces. Do not recreate
Zephyr internals with large fake headers. Use Zephyr ztest/Twister for future kernel
or driver integration tests; no ztest suite is configured yet. UART framing/Zephyr JSON
parsing, real BLE/Wi-Fi behavior and flash/boot remain outside this native suite.

The `firmware-unit` job in [Host Validation](../../.github/workflows/host-validation.yml)
runs the same command independently of the reusable [ESP32-S3 build](../../.github/workflows/firmware-build.yml).
Both must pass for firmware changes; a native test pass is not target-build or hardware evidence.

## Zephyr target build

Follow [workspace setup](../guides/getting-started.md#1-prepare-a-zephyr-workspace) before building.
Zephyr 4.2.0 and imported module commits are selected by `west.yml`; SDK 0.17.2 is the initial toolchain.
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
Required defaults include Wi-Fi, BLE, software coexistence, SPI SDHC, SDMMC disk and FatFs.
Both FAT mkfs options must remain disabled. Console/logging are disabled on UART0 to preserve framing;
initialization and mount failures are exposed as status result codes. `PRINTK` is required by dependencies,
but no UART console backend is enabled.

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
Compilation does not validate initialization, UART electrical behavior, coexistence, or filesystem reliability.
Record software evidence separately from future hardware observations in [validation records](../validation/records/README.md).
