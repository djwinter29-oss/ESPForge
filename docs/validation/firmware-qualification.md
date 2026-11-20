# Firmware qualification procedure

This is the repeatable qualification procedure for the supported ESP32-S3-DevKitC-1 N16R8.
It defines checks, not passing results. Keep observations in new dated [validation records](records/README.md);
the [qualification gaps](qualification-gaps.md) remain open until the relevant physical checks have evidence.

## Ownership and safety prerequisites

- Obtain exclusive authorization for the exact board, USB/UART ports and test interval. Stop other management clients,
  flashers, terminal reset controls and automated jobs. Never select an arbitrary connected board.
- Use the N16R8 image and [wiring](../reference/sdcard.md#pin-allocation) matching the selected storage transport.
  Preserve 16 MB flash, 8 MB octal PSRAM, native USB pins and the native image's 10 mA SD pad drive.
- Use a backed-up, dedicated card containing only expendable test data. Prepare FAT16, FAT32 or exFAT on a computer;
  no check may format or repair a card from firmware. Disconnect card power before switching SDMMC/SPI images.
- Flashing, rebooting, credential changes, card writes and fault injection each require operator authorization.
  Installing tools or running software checks does not provide that authorization.
- Provision any required Wi-Fi network and BLE Control key through the existing dashboards. Keep credentials out of
  logs, screenshots, command lines and result records. Control-key authentication is not BLE link encryption.

## Evidence to capture

Record source revision and local changes; firmware SHA-256, frozen west manifest, SDK, generated `.config` and DTS;
board/module revision, wiring and power arrangement; card make/model, CID, capacity and filesystem; host OS,
USB topology, browser/client versions; UART and host USB logs; selected checks, thresholds, counts and duration.
Retain each image's identity with its results. A configured SD clock ceiling is not a measured bus clock or throughput.

Record attempted/passed/failed/inconclusive counts, first failure, recovery steps and whether a file remains.
Stop and preserve evidence on an unexpected reset, different image/card, uncertain command, lockup or data mismatch.
Do not replay an uncertain state-changing command or hide a failed run behind retries.

## Software gate

Before physical checks, run the existing native suite and both target builds from the checkout:

```sh
bundle exec ceedling test:all
bundle exec ceedling --mixin '={project: {build_root: build/ceedling-sd-spi}, defines: {test: [ZF_STORAGE_SPI=1, ZF_ENABLE_STORAGE_BENCHMARK=1]}}' test:test_hid_reports test:test_control
bash tools/firmware/build.sh
bash tools/firmware/build.sh --storage sd-spi
python3 -m unittest discover -s firmware/tests/tooling -v
```

Use the [firmware development guide](../development/firmware.md) for tool/workspace prerequisites.
Inspect generated configuration: correct PROCPU target, 16 MB flash, 8 MB octal PSRAM, selected storage driver,
four-bit native bus, and both FAT mkfs options disabled. Builds and portable mocks are not physical qualification.

## Runnable USB target checks

Install the existing [Python host package](../../host/python/README.md) in a venv, identify the exact serial in the
dashboard, close that dashboard and use the same interpreter for these commands. Software-only safety checks are:

```sh
python3 -m unittest discover -s firmware/tests/hardware -v
```

The target runner opens only the explicitly selected ZephyrForge HID device. Its default checks are read-only:

```sh
python3 firmware/tests/hardware/run.py --serial BOARD_SERIAL \
  --cycles 100 --reopens 10 > build/firmware-hid-check.json
```

It requires fresh telemetry and storage reports within 5 seconds, validates reports through the existing codecs,
rejects unexpected uptime resets, and fails any completed Feature/Input read exceeding 1000 ms.
The report records actual maxima and selected check counts. HID handle reopens are **not** physical USB
disconnect/reconnect or firmware USB-stack reset tests.

After authorizing scan state changes, repeat scans while checking management responsiveness:

```sh
python3 firmware/tests/hardware/run.py --serial BOARD_SERIAL --cycles 100 --reopens 10 \
  --wifi-scans 20 --allow-state-changes > build/firmware-wifi-check.json
```

Scans must complete with the expected generation, count, unique SSIDs and strongest-first ordering.
Results exclude SSIDs, passwords, Control keys and full wireless reports.

After separately authorizing card writes, test the long-benchmark/USB responsiveness regression:

```sh
python3 firmware/tests/hardware/run.py --serial BOARD_SERIAL --cycles 100 --reopens 10 \
  --benchmark-mib 1024 --allow-state-changes --allow-card-writes > build/firmware-benchmark-check.json
```

Start with 32 MiB, then use 64, 256 and 1024 MiB on cards with enough free space. The runner does not format,
save settings, reboot, change MSC ownership, automatically cancel or resend a failed/uncertain operation.
It requires observed benchmark activity before accepting its terminal result, exact completed byte counts,
zero mismatches/errors, successful cleanup and restoration of the original identified card's firmware mount.
If a run finishes before activity can be observed, treat it as inconclusive rather than attributing an old result.
The benchmark uses only the reserved file and safety rules in the [storage contract](../reference/sdcard.md).

`--max-latency-ms` and `--timeout-seconds` allow recorded threshold changes; use the default 1000 ms/900 s first.
Native HID Feature calls can block in the OS: these checks measure completed calls, not a hard I/O interruption.
Supervise the process externally and record a hang as failure. A zero exit and JSON `result: passed` cover only
the explicitly selected checks, not the manual matrix below. A nonzero exit requires operator recovery.

## SD/card and USB MSC matrix

Cover native SDMMC and SPI separately, at least three representative cards across FAT32/exFAT where supported,
two wiring/socket assemblies, and Linux/Windows/macOS for USB MSC. Keep these proposed minimums in the record;
smaller matrices establish only the combinations actually exercised.

| Check | Procedure and proposed minimum | Acceptance |
| --- | --- | --- |
| Boot/insertion/replacement | 20 authorized cold boots with a card, 20 without, then 20 insert/remove/reinsert cycles at idle per combination | Correct detection/identity; stable insertion mounts within 5 s in the normal case; replacement never auto-exports |
| Sustained I/O | 10 passing runs each at 32/64/256 MiB, 3 at 1024 MiB, then a 2-hour supervised workload | Exact write/read verification; no leftover file, unexpected reset, host USB reset loop or UART CRC/I/O errors |
| MSC handoff | 50 Enable USB drive / OS safely eject / confirmed Return cycles per OS/card/transport | Admission distinguished from completed ownership; firmware unmounts before export, return remounts the same card, HID recovers within 15 s |
| MSC data integrity | While exported, use OS-native file copy/hash checks on expendable files; safely eject before return | Hashes preserved; no concurrent firmware filesystem access; successful remount after return |
| Busy/no-medium regression | Monitor host USB logs during the 1024 MiB benchmark while the unexported LUN is probed | Prompt no-medium responses; no repeated ~33 s USB reset loop; management reads meet the recorded latency threshold |
| Detected removal during work | After explicit fault-injection authorization, remove the dedicated card during write/read and during an ownership transition; repeat 5 times per phase | Run fails visibly, access is revoked, no uncertain command is replayed; replacement is not used for cleanup or auto-export |
| Fault recovery | Preserve logs and inspect/recover the volume on a computer; reinsert or authorized card-power-cycle if reinitialization fails | Recovery steps recorded; no formatting/repair by firmware and no invented successful benchmark |

Removal/power loss can corrupt FAT: “pass” does not mean atomic writes or an undamaged volume after fault injection.
Record a retained `EFTEST.BIN` as cleanup evidence; only the operator may remove it from the original card after
safe ownership release. A failed cleanup is not a successful benchmark. Test power loss separately only with
explicit authorization; the single-copy settings save is not power-loss atomic.

## USB, BLE and Wi-Fi lifecycle stress

| Check | Procedure and proposed minimum | Acceptance |
| --- | --- | --- |
| Physical USB reconnect | 50 authorized USB data-cable disconnect/reconnects at idle, retaining UART logs | Same identity; no unexpected board reset; HID reports return within 15 s and remain responsive |
| BLE reconnect/authentication | With Direct, 50 connect/unlock/read/disconnect cycles; test MTU 23 and a larger negotiated MTU where the central allows it | Advertising resumes; each new connection is locked; old session proofs are unusable; long reads have consistent report layouts |
| BLE/USB coexistence | Read diagnostics through both transports for 30 minutes; designate only one state-changing client | No stale/mixed long-read snapshots, unexpected resets or ownership changes; recorded management latencies remain within the selected limits |
| Wi-Fi recovery | 20 saved-network reconnects after authorized AP disable/enable; exercise unavailable network and wrong-password candidate tests, then cancel explicitly | Failure visible; scan/test generation preserved; saved-network retry resumes; no credential disclosure |
| DHCP renewal | Use an authorized short-lease AP, observe at least 3 lease renewals | Connectivity and management recover without reboot; address/state changes match observations |
| RF coexistence/soak | Run Wi-Fi traffic, BLE reads and USB monitoring for 2 hours, including 20 scans and a long storage run | No reset, stuck test/scan, exhausted connection resources or persistent transport outage |

Use UART logs and Direct for manual BLE observations. The USB runner is not a BLE central and does not qualify
MTU handling, RF, actual USB re-enumeration or DHCP renewal. Longer soaks, thermal/power variation, flash endurance
and RF/EMC/regulatory qualification remain separate product-specific work.
