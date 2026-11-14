# Qualification gaps

Functional hardware testing on ESP32-S3-DevKitC-1 N16R8 has been reported with no issues in the listed checks.
See the [hardware test report](records/2026-11-14-hardware-tests.md) for coverage, provenance and missing configuration
details. This is functional evidence, not production qualification.

| Area | Current boundary |
| --- | --- |
| ESP32-S3 target | N16R8 flashing and boot reported working; firmware revision, image hashes and PSRAM memory-test output not recorded |
| Firmware unit tests | Ceedling covers the portable control dispatcher, report encoding, SD lifecycle, wireless staging/auth, SHA-256 and boot-settings record with mocked platform hooks and a fake flash; no Zephyr execution |
| USB HID | Dashboard connection reported working; report timing, host compatibility and repeated reconnect behavior remain unqualified |
| BLE | Monitoring and authenticated control reported working; MTU variation, reconnect stress and radio coexistence remain unqualified |
| Wi-Fi | Provisioning and connection reported working; failure recovery, lease renewal, coexistence and long-duration behavior remain unqualified |
| Boot settings | Save and reboot reported working; interrupted erase/program, endurance and individual CPU-clock profiles not documented in the report |
| SD card | Native four-bit SDMMC, SPI, detection and replacement reported working; card/wiring matrix, sustained I/O and fault recovery remain unqualified |
| USB MSC | Handoff and return reported working; no OS/card matrix, repeated-cycle data or interrupted-handoff results recorded; see [SD ownership](../reference/sdcard.md#usb-drive-handoff) |
| Diagnostic shells | UART and Wi-Fi TCP shells reported working; admission/reconnect stress and concurrent HID/BLE responsiveness remain unqualified |
| Storage benchmark | Portable safety and host codecs tested; physical benchmark figures, removal-during-write and cleanup results not supplied |
| Onboard RGB LED | LED controls reported working; exact board revision/pin, waveform timing and optical measurements not recorded |
| Module memory inventory | Live board diagnostics reported working; raw PSRAM/flash inventory values, reservations and memory-accounting checks not supplied |
| Dashboards | Live USB HID connection and diagnostics reported working; no per-dashboard/OS/browser hardware matrix or raw measurements recorded |
| Security | BLE Control key authentication without link encryption; unencrypted flash; physical USB/UART control; unauthenticated plaintext diagnostic TCP; loopback hosts |
| Variants | Only N16R8 is configured; N4/N8/octal-flash modules and other S3 boards are not targets |
| Product readiness | No power-loss, soak, performance, RF, EMC or regulatory qualification |

Further qualification should record firmware/image identity, host/tool versions, board and card details,
procedures, durations and observed results. Use backups and a dedicated card for destructive or fault-injection tests.
Historical software-only records remain unchanged; neither they nor one functional report establish compatibility
with every hardware or workload combination.
