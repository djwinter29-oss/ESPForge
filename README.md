# ESPForge

**An ESP32-S3 board-management foundation using Zephyr OS, with Direct, Python and .NET dashboards.**

Inspired by [PicoForge](https://github.com/djwinter29-oss/PicoForge)'s repository layout and documentation
strategy; this is an ESP-specific implementation, not a compatible firmware port.

## What is ready

| Foundation | Initial implementation |
| --- | --- |
| Target | ESP32-S3-DevKitC, default N8 / 8 MB flash, Zephyr PROCPU |
| Firmware | Pinned Zephyr 4.2.0 / SDK 0.17.2, bounded UART JSON management |
| Firmware unit tests | Pinned Ceedling / Unity / CMock, native credential and status-contract tests |
| Radios | **Wi-Fi and BLE enabled on every boot**, software coexistence, RAM-only Wi-Fi setup |
| Storage | SPI SD-card driver + FAT mount, **no automatic formatting or write tests** |
| Direct dashboard | Static browser, Web Serial and read-only Web Bluetooth |
| Python dashboard | Loopback web server + pyserial |
| .NET dashboard | Loopback ASP.NET Core server + System.IO.Ports |
| Layout | PicoForge-inspired light dashboard: identity metrics, board configuration, collapsible pins, diagnostics, storage and Wi-Fi setup |
| GitHub automation | Cross-platform host checks, Ceedling, Zephyr build artifacts, tagged release packages and verified Direct Pages deployment |

**Start here:** [getting started](docs/guides/getting-started.md) ·
[hardware/wiring](docs/guides/hardware.md) · [documentation index](docs/README.md).

Hardware is not required for building or the explicitly labeled dashboard previews.
Firmware targets the board's **USB-to-UART connector**, not native USB HID/CDC.
Wi-Fi being enabled does not mean it is connected: provision a network over UART for each boot.
Basic monitoring does not require an SD card.

## Preview before connecting hardware

From this checkout:

```sh
# Direct: open http://127.0.0.1:8000/host/direct/ and choose Simulated preview
bash tools/host/run-direct.sh --port 8000

# Python: open http://127.0.0.1:8001/ and click Select board
python3 -m pip install -r host/python/requirements.txt
python3 host/python/server.py --demo

# .NET 10: open http://127.0.0.1:8002/ and click Select board
dotnet run --project host/dotnet/ESPForge -- --demo
```

These are separate launch choices. Direct serial/BLE needs a supported desktop browser and localhost/HTTPS.
Replace `--demo` with `--device /dev/ttyUSB0` (or the actual COM port) when hardware arrives.
Only one serial client may own the board at a time.

## Build and extend

Follow [workspace setup, build and flashing](docs/guides/getting-started.md).
When the board arrives, upload over USB-to-UART with
`bash espforge/tools/firmware/flash.sh --port /dev/ttyUSB0` from the initialized workspace.
Run hardware-free C tests with `bundle exec ceedling test:all` after
[installing the test tools](docs/development/firmware.md#host-native-unit-tests).
The layout separates `firmware/`, `host/direct/`, `host/python/`, `host/dotnet/`, shared `host/web/`,
and `docs/`. Fork the source, keep board pin assignments in overlays, and add product services
without blocking management. See [architecture](docs/reference/architecture.md).

This initial foundation does not include PicoForge's complete feature set: no persistent settings,
USB mass storage, benchmarks, file-transfer API, Wi-Fi dashboard transport, or dual-core workload.
It does provide code and operating documentation for the requested default radios and SD integration.

## GitHub automation

Pull requests and pushes to `main` run shared host/native tests and the pinned ESP32-S3 build.
Stable `vMAJOR.MINOR.PATCH` tags publish firmware, Direct/Python source archives and standalone
.NET hosts for Linux, Windows and Apple Silicon, with checksums and qualification limits.
Direct Pages deploys the verified release archive after repository Pages setup.
Python is not yet published to PyPI. See the [workflow and release guide](docs/deployment/release.md)
for a manual preflight, repository settings and release instructions.

## Validation and security

Software evidence is kept in [validation records](docs/validation/records/README.md).
No physical hardware was connected. **SD-card testing is intentionally deferred**; successful builds
and simulated previews are not hardware qualification.
Read [qualification gaps](docs/validation/qualification-gaps.md) before deploying.
BLE diagnostics are public; UART provisioning is plaintext; local hosts must stay on loopback.

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