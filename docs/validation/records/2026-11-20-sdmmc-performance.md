# Native SDMMC clock and throughput improvement

Executed on **2026-11-20**. Application source was `124b75f507c9ab8f7f5303cdb7ab09394a3f2bd5` with the
native board's clock ceiling changed from 25 to 40 MHz. No production C code changed.
SPI remains at 25 MHz. Card-speed negotiation uses the existing Zephyr SD stack, not a new retry mechanism.
The [SD reference](../../reference/sdcard.md#driver-and-filesystem-configuration) owns configuration and recovery.

## Configuration and authorization

- ESP32-S3-DevKitC-1 N16R8, PROCPU, 16 MB flash and 8 MB octal PSRAM.
- Native four-bit SDMMC with unchanged pin allocation and 10 mA pad drive.
- Zephyr 4.3.2, SDK 0.17.4; built through the supported firmware wrapper.
- FatFs/exFAT, unchanged aligned 32 KiB internal-RAM benchmark buffer; both mkfs options disabled.
- Board HID serial `50787D173E8C0000`, reporting firmware 0.1.0.
- Card CID `03534453523634478660A8CB47016BEF`, capacity 63,864,569,856 bytes.
- CPU clock profile remained `0` before/after flashing; post-flash telemetry reported 240 MHz.

The operator authorized flashing/reboot, both benchmark sizes, exclusive access and a backed-up dedicated card,
and confirmed `/dev/ttyACM0` as this board's UART connector (USB serial `5A7A040081`).
The flashing tool reported chip MAC `50:78:7d:17:3e:8c`, verified the image hash and reset the board.
No full-chip erase, card formatting, MSC ownership change or physical fault injection was requested or performed.

Flashed `zephyr.bin` SHA-256:
`fd322c604a17d72d081326cfddc49fa6366dc92ffc13c735876862ba2a55a157`.
Generated DTS retained the four-bit bus and selected a 40,000,000 Hz ceiling.
The driver's divider calculation selects 40 MHz for this request; no oscilloscope clock measurement was made.

## Measured results

Both selected runs exited zero with `result: passed`, exact written/read counters, zero mismatches,
filesystem result zero, no remaining temporary file and the same card remounted for firmware.
Each run included ten initial fresh-report samples and ten post-benchmark HID handle reopens.

| Size | Target/written/read bytes, each | Write elapsed | Read/verify elapsed | Write throughput | Read/verify throughput |
| --- | --- | --- | --- | --- | --- |
| 32 MiB | 33,554,432 | 3,434 ms | 2,796 ms | 9.319 MiB/s | 11.445 MiB/s |
| 1024 MiB | 1,073,741,824 | 109,666 ms | 89,859 ms | 9.337 MiB/s | 11.396 MiB/s |

The 1024 MiB write rate is **9.791 MB/s** in decimal units.
Write timing includes pattern generation, filesystem allocation, writes and final close/sync;
read timing includes verification. These are filesystem workload results, not raw bus rates.

Compared with the [earlier installed-image observations](2026-11-20-firmware-qualification.md), on the same card:

| Size | Earlier write rate | New write rate | Write increase | Read/verify increase |
| --- | --- | --- | --- | --- |
| 32 MiB | 6.671 MiB/s | 9.319 MiB/s | 39.69% | 44.74% |
| 1024 MiB | 6.678 MiB/s | 9.337 MiB/s | 39.83% | 43.91% |

The earlier installed image's source/hash was not independently established.
This is an observed before/after comparison, not a controlled same-binary A/B experiment isolating clock alone.
Historical records are unchanged.

Maximum sampled Feature reads were 3.571 ms and 3.870 ms for the short and long runs.
Maximum Input polls were 250.200 ms and 250.227 ms, including the intentional 250 ms wait.
Both remained below the 1000 ms sampled-read threshold, with fresh telemetry/storage reports within five seconds
and no unexpected uptime reset observed. Identity and acknowledgement Feature calls were not individually timed.
No uncertain command was replayed; test handles were closed.

The native build passed without compiler warnings observed. The existing firmware tooling suite passed 25 tests;
documentation link and whitespace checks passed.
Build, flashing and machine-readable results were retained in ignored build storage under the
`firmware-sdmmc-40-` prefix.

## Limits

Only one card, board, wiring arrangement and Linux/HIDAPI host were exercised, with one run per size.
Slow/non-High-Speed card negotiation was inspected in the existing stack but not tested with another physical card.
Negotiation follows advertised bus capability, not measured write-speed class; there is no automatic downclocking
after CRC errors. Restore the conservative ceiling and rebuild if wiring cannot support higher-speed operation.
Neither UHS/1.8 V operation nor true 50 MHz is provided by the current driver configuration.
At 40 MHz, four-bit raw bandwidth is 20 MB/s before protocol, card-busy, filesystem and CPU overhead;
card packaging rates measured with a UHS reader are not an achievable guarantee here.
This does not establish extended soak, power-loss, MSC, BLE or multi-card qualification.
