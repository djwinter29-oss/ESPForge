# Firmware software gates and qualification checks

Executed on **2026-11-20** from application source `c27d94dd8bf7a2a57f680826f0861b6500299fc1`.
Production firmware source was unchanged; this work added an opt-in USB target runner, its software-only
safety tests, CI invocation and the [qualification procedure](../firmware-qualification.md).
Application source remained identical through commit `124b75f`, which included the initial qualification changes.
The pre-existing Python dashboard test adjustment was not part of the firmware build.

## Software environment and results

Host: Linux aarch64, GCC 14.2.0, Python 3.13, Ruby 3.3.13, Bundler 2.6.9 and Ceedling 1.1.10.
Ruby runtime/development packages were restored under ignored build storage without installing system packages.
The existing west 1.5.0 workspace venv was reused. Zephyr was 4.3.2 at
`28af05ca658cbacf745fd5b099566311c58ccb1d`, with both tracked patches applied; SDK 0.17.4 supplied the ESP32-S3 toolchain.
The dependency lockfile was preserved. The resolved west manifest was frozen separately with `west manifest --freeze`.

| Check | Actual result |
| --- | --- |
| `bundle exec ceedling test:all` | 87 tests passed; eight portable suites; C11 warnings treated as errors |
| SPI/benchmark-enabled report and control suites | 36 tests passed |
| Native SDMMC target build through the build wrapper | Passed; no compiler warnings observed |
| SPI target build through the build wrapper | Passed; no compiler warnings observed |
| Firmware tooling tests | 25 tests passed without accessing hardware |
| New target-runner safety tests | 10 tests passed using fake HID clients |
| Runner strict Python type check | Zero errors, warnings or information diagnostics |
| Documentation links and patch whitespace | Passed |

Both generated target configurations retained PROCPU, 16 MB flash, 8 MB octal PSRAM and disabled FAT formatting.
Native DTS retained the four-bit SD bus, 25 MHz configured ceiling and 10 mA output-pad drive; SPI selected its
separate driver and image. Both wrapper builds enabled the optional benchmark; neither ran it as part of compilation.

| Build | Firmware image SHA-256 |
| --- | --- |
| Native SDMMC | `ecb13603b8abb380ad39f39119d2152fb0f43a8ba38daf4d3a74c8be060ba989` |
| SPI | `9e68d2c68e20665a9d6cc034c0d15fbb3b1f864995bdf43595386ccc8533e3b8` |

The binaries were **not flashed** during these checks. These build results do not identify the image already running
on connected hardware and do not establish SD/RF/USB physical qualification.

## Authorized installed-image checks

The operator authorized exclusive access to board serial `50787D173E8C0000`, HID reads/handle reopens,
Wi-Fi scans and 32/1024 MiB benchmarks, and confirmed a backed-up dedicated card.
An existing bridge initially held the HID interface; attempts failed before commands were sent.
The operator released it before the successful runs. No process was forcibly stopped by the tests.

The connected board reported ESP32-S3-DevKitC-1, native SDMMC and firmware **0.1.0**.
Its flashed source revision and image hash were **not independently established**.
The results below apply to that installed image, not automatically to either newly built binary.
Host access used the existing Python package with HIDAPI 0.15.0 on Linux aarch64.

| Selected run | Baseline + reopen samples | HID handle reopens | Wi-Fi scans | Maximum sampled Feature read | Maximum Input poll |
| --- | --- | --- | --- | --- | --- |
| HID and scan stress | 110 | 10 | 20 | 3.745 ms | 250.220 ms |
| 32 MiB benchmark | 10 | 0 | 0 | 9.182 ms | 250.176 ms |
| 1024 MiB benchmark | 20 | 10 | 0 | 8.310 ms | 253.783 ms |

All three runners exited zero with `result: passed`. Fresh telemetry/storage samples met the 5-second liveness
check, and completed sampled reads stayed below the configured 1000 ms limit. Benchmark monitoring added reports
beyond the table's baseline/reopen sample counts. Input maxima include the requested
250 ms polling wait; they are not measurements of firmware execution time. Identity and command-acknowledgement
Feature calls were not individually timed.
No unexpected uptime reset was observed within a run. Handle reopens are not physical USB reconnect tests.
The scan run verified generation/count agreement, unique SSIDs and strongest-first ordering without recording
SSID/password/key values.

Both benchmarks identified card CID `03534453523634478660A8CB47016BEF`, capacity **63,864,569,856 bytes**, mounted
**exFAT**, with a **25 MHz configured clock ceiling**. The bus clock was not measured.

| Benchmark | Target/written/read bytes, each | Write elapsed | Read/verify elapsed | Mismatches | Filesystem result | File remains |
| --- | --- | --- | --- | --- | --- | --- |
| 32 MiB | 33,554,432 | 4,797 ms | 4,047 ms | 0 | 0 | No |
| 1024 MiB | 1,073,741,824 | 153,343 ms | 129,318 ms | 0 | 0 | No |

Each run required observed benchmark activity before accepting its passing terminal result, complete counters,
successful cleanup and return of the original identified card to a firmware mount.
No uncertain command was replayed. No flashing, reboot, formatting, MSC ownership change, physical removal
or power-loss injection was performed.
Machine-readable outputs were retained in ignored build storage as `firmware-hid-wifi-hil.json`,
`firmware-benchmark-32-hil.json` and `firmware-benchmark-1024-hil.json`.

## Remaining qualification limits

Only one board, card, native wiring arrangement, installed image and Linux/HIDAPI host were exercised.
The SPI build was not flashed or physically tested. No target-specific kernel USB entries were available from
the queried journal, and raw SCSI/no-medium behavior was not independently traced.
BLE authentication/reconnect/MTU stress, physical USB reconnects, MSC cycle/data-integrity matrices,
Wi-Fi candidate failure recovery/DHCP renewal, additional cards/sockets/OSes, fault-injection cleanup,
power loss, thermal/RF variation and extended soak/endurance remain open.

Use the [qualification procedure](../firmware-qualification.md) for those remaining checks.
These observations do not rewrite the earlier SD write-reliability record or establish qualification of the new images.
