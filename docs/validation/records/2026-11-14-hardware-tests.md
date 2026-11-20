# Functional hardware test report

Report received on **2026-11-14**. The user confirmed programming and testing an
**ESP32-S3-DevKitC-1 N16R8**, marked all checks below as passed, and reported no issues.
These are user-reported manual hardware results, not tests independently executed by the automated suites.

## Reported results

| Check | Reported result |
| --- | --- |
| Firmware flashing and boot | Pass |
| USB HID dashboard connection | Pass |
| Board identity and live diagnostics | Pass |
| LED controls | Pass |
| Settings save and reboot | Pass |
| Wi-Fi provisioning and connection | Pass |
| Bluetooth LE monitoring and authenticated control | Pass |
| Native four-bit SDMMC storage | Pass |
| SD-over-SPI storage | Pass |
| Card detection and replacement | Pass |
| USB drive handoff and return | Pass |
| UART diagnostic shell | Pass |
| Wi-Fi TCP diagnostic shell | Pass |

## Configuration and evidence limits

The board/module target was confirmed. The report did not specify the execution date, firmware revision or image
hashes, host application versions, operating system/browser, SDK/tool versions, SD-card model, exact wiring or
test procedures. No raw logs, measurements, cycle counts or test durations accompanied the report.
It does not establish a pass for every combination of dashboard, host OS, card or board revision.

This records functional testing without changing earlier software-only records. It does not establish sustained
throughput, benchmark results, memory-accounting accuracy, power-loss recovery, removal-during-write safety,
endurance, radio coexistence, RF/EMC compliance or production qualification. Those results were not supplied.

Control-key authentication still does not encrypt BLE traffic; settings remain a single-copy flash record,
and the diagnostic TCP shell remains unauthenticated plaintext. Successful functional testing does not change
those design limits.

See [qualification gaps](../qualification-gaps.md) for the current boundaries.
