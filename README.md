# ESPForge

**An ESP32-S3 board-management foundation using Zephyr OS, with Direct, Python and .NET dashboards.**

Inspired by [PicoForge](https://github.com/djwinter29-oss/PicoForge)'s repository layout and documentation
strategy; this is an ESP-specific implementation, not a compatible firmware port.

## What is ready

| Foundation | Initial implementation |
| --- | --- |
| Target | ESP32-S3-DevKitC-1 N16R8: 16 MB flash, 8 MB octal PSRAM, Zephyr PROCPU |
| Firmware | Pinned Zephyr 4.3.2 / SDK 0.17.4; PicoForge's USB HID and Bluetooth LE protocol, as adapted by the [ESPForge profile](docs/reference/espforge-profile.md) |
| Firmware unit tests | Pinned Ceedling / Unity / CMock: control dispatcher, report encoding, wireless staging and authentication, SHA-256 and boot settings |
| Radios | **Wi-Fi and BLE enabled by default**, software coexistence, Wi-Fi scan/test/save, BLE Control key authentication |
| Settings | PicoForge-style [boot settings](docs/reference/settings.md): one CRC-checked flash record for CPU clock, radio switches and credentials, edited from every dashboard |
| Storage | SPI SD-card driver + FAT mount, **no automatic formatting or write tests** |
| Direct dashboard | Independent static browser app over WebHID and Web Bluetooth |
| Python dashboard | Loopback Flask server + `hidapi` |
| .NET dashboard | Loopback ASP.NET Core server + HidSharp |
| Layout | PicoForge dashboard layout: device information, boot configuration, board configuration, live telemetry, storage and wireless setup |
| GitHub automation | Cross-platform host checks, Ceedling, Zephyr build artifacts, tagged release packages and verified Direct Pages deployment |

**Start here:** [getting started](docs/guides/getting-started.md) ·
[hardware/wiring](docs/guides/hardware.md) · [documentation index](docs/README.md).

Hardware is not required for building or for starting the dashboards.
Management uses the board's **USB** connector (native USB HID, `CAFE:4021`) and BLE; the **UART** connector is for
flashing and the console log. Wi-Fi being enabled does not mean it is connected: test and save a network from a
dashboard. Basic monitoring does not require an SD card.

## Run the dashboards

From this checkout:

```sh
# Direct: open http://127.0.0.1:8000/ and click USB (WebHID) or Bluetooth
bash tools/host/run-direct.sh --port 8000

# Python: open http://127.0.0.1:8001/
bash tools/host/run-python.sh web

# .NET 10: open http://127.0.0.1:8002/
bash tools/host/run-dotnet.sh
```

These are separate launch choices. Direct needs a supported desktop browser and localhost/HTTPS.
Python and .NET select the first ESPForge board, or one chosen with `--serial SERIAL` or `--device-path HID_PATH`.
Without a board they show an empty board list; there is no simulated mode. On Linux, run
`bash tools/host/hid-permissions-setup.sh` once to grant HID access.

## Build and extend

Follow [workspace setup, build and flashing](docs/guides/getting-started.md).
When the board arrives, upload over the UART connector with
`bash espforge/tools/firmware/flash.sh --port /dev/ttyUSB0` from the initialized workspace.
Run hardware-free C tests with `bundle exec ceedling test:all` after
[installing the test tools](docs/development/firmware.md#host-native-unit-tests).
The layout separates `firmware/`, the independent `host/direct/` dashboard, `host/python/`, `host/dotnet/`,
their shared bridge dashboard `host/web/`,
and `docs/`. Fork the source, keep board pin assignments in overlays, and add product services
without blocking management. See [architecture](docs/reference/architecture.md).

ESPForge does not include PicoForge's complete feature set: no LED, USB mass storage, SD benchmark,
TCP CLI, file-transfer API or dual-core workload. See the [ESPForge profile](docs/reference/espforge-profile.md).

## GitHub automation

Pull requests and pushes to `main` run shared host/native tests and the pinned ESP32-S3 build.
Stable `vMAJOR.MINOR.PATCH` tags publish firmware, Direct/Python source archives and standalone
.NET hosts for Linux, Windows and Apple Silicon, with checksums and qualification limits.
Direct Pages deploys the verified release archive after repository Pages setup.
Python is published to PyPI after a release. See the [workflow and release guide](docs/deployment/release.md)
for a manual preflight, repository settings and release instructions.

## Validation and security

Software evidence is kept in [validation records](docs/validation/records/README.md).
No physical hardware was connected. **SD-card testing is intentionally deferred**; successful builds
and simulated previews are not hardware qualification.
Read [qualification gaps](docs/validation/qualification-gaps.md) before deploying.
BLE commands need the Control key but the link is not encrypted; flash credentials are unencrypted; local hosts must stay on loopback.

## Documentation

- **Use:** [getting started](docs/guides/getting-started.md) · [hardware](docs/guides/hardware.md) ·
  [wireless](docs/guides/wireless.md) · [Direct](host/direct/README.md) ·
  [Python](host/python/README.md) · [.NET](host/dotnet/ESPForge/README.md)
- **Develop:** [architecture](docs/reference/architecture.md) · [protocol](docs/reference/protocol.md) ·
  [SD storage](docs/reference/sdcard.md) · [firmware](docs/development/firmware.md) ·
  [host tools](docs/development/host-tools.md)
- **Maintain:** [contributing](CONTRIBUTING.md) · [release](docs/deployment/release.md) ·
  [security](SECURITY.md) · [documentation ownership](docs/README.md)

## License

[BSD 3-Clause](LICENSE). Third-party dependencies and Espressif radio blobs retain their own licenses.