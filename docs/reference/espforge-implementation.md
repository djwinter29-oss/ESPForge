# ESPForge Implementation Reference

This page records platform integration and measurement limits that are not wire contracts.
Hardware selection and wiring belong to the hardware guide; report layouts and supported operations belong
to the USB HID and Bluetooth LE specifications.

## Platform integration

| Area | Current implementation |
| --- | --- |
| Application core | Zephyr runs on PROCPU; the second core does not run an application workload |
| USB | Zephyr's `device_next` stack with the native USB OTG controller |
| Bluetooth | Zephyr Bluetooth host with the ESP32-S3 controller and entropy source |
| Wi-Fi | Zephyr network management, DHCP and Espressif software coexistence |
| Filesystem | Zephyr disk access and FatFs over the native Espressif SDMMC controller |
| Settings | A fixed CRC-checked flash record, rather than Zephyr settings/NVS |

## Measurement limits

- CPU clock telemetry normally reads the clock driver; if that read fails, the current implementation uses the
  build clock. A saved profile or boot snapshot does not prove that the requested clock was applied.
- Storage status is cached from boot. Its clock value is the configured ceiling, not a measured or negotiated
  frequency; fresh report delivery does not establish current card presence.

## Driver limits

Wi-Fi join events do not supply the 802.11 failure reason. Wireless diagnostics describe state, not a reliable
classification of authentication or access-point failures.

The disk API does not expose card CID or negotiated SD bus state to the application. Mount errors are logged
to UART, not carried as error codes in storage reports.

These are implementation limits, not hardware qualification. Observed evidence and outstanding physical tests
belong in the validation records and qualification gaps.
