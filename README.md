# ESPForge

[![PR Check](https://github.com/djwinter29-oss/ESPForge/actions/workflows/pr-check.yml/badge.svg?branch=main)](https://github.com/djwinter29-oss/ESPForge/actions/workflows/pr-check.yml)
[![Release](https://github.com/djwinter29-oss/ESPForge/actions/workflows/release.yml/badge.svg)](https://github.com/djwinter29-oss/ESPForge/actions/workflows/release.yml)
[![License: BSD 3-Clause](https://img.shields.io/badge/License-BSD%203--Clause-blue.svg)](LICENSE)
![Target: ESP32-S3](https://img.shields.io/badge/Target-ESP32--S3-2674b8)

**Your ESP32-S3. Three dashboards. One Zephyr foundation.**

ESPForge brings board identity, live telemetry, persistent boot settings and wireless setup into one
management experience. Connect over **USB HID** or **Bluetooth LE**, choose your dashboard, and build
your own ESP32-S3 application on top.

Built for **ESP32-S3-DevKitC-1 N16R8** with **Zephyr OS**, **16 MB flash**, **8 MB octal PSRAM**
and **native four-bit SDMMC**, with an alternate **SD-over-SPI** firmware image.

**[Get started](docs/guides/getting-started.md)** · **[Choose a dashboard](#choose-your-dashboard)** ·
**[Hardware & wiring](docs/guides/hardware.md)** · **[Explore the docs](docs/README.md)**

> **Project status:** software-tested foundation, not hardware-qualified firmware.
> Physical USB, radio and SD-card acceptance remain pending. You can build the project and launch
> the dashboards without a board; live measurements require hardware.

## What you can do

| | ESPForge provides |
| --- | --- |
| **Know your board** | Device identity, firmware version, UART and SD bus pin allocation |
| **Watch it run** | Uptime, CPU clock, core-0 load, die temperature and firmware RAM accounting |
| **Configure the next boot** | CPU clock, Wi-Fi/BLE switches and credentials in a CRC-checked flash record |
| **Set up wireless** | Scan, test and save a 2.4 GHz Wi-Fi network; provision a BLE Control key over USB |
| **Use storage** | Runtime card detection, FAT mounting and explicit native USB MSC handoff over SDMMC or SPI |
| **Inspect diagnostics** | Native Zephyr shells over UART and raw TCP; see the [console guide](docs/guides/console.md) |
| **Build your product** | Separate board/platform code, management services and host clients, with portable firmware tests |

Wi-Fi and BLE switches are enabled by default. Wi-Fi needs a saved network to connect;
BLE management needs a provisioned Control key. An SD card is **optional for basic management**.

## One board, three ways to connect

```mermaid
flowchart LR
    Direct["Direct dashboard<br/>Desktop Chrome / Edge"] -->|WebHID| USB["USB HID"]
    Direct -->|Web Bluetooth| BLE["Bluetooth LE"]
    Python["Python dashboard<br/>Flask + hidapi"] --> USB
    Dotnet[".NET dashboard<br/>ASP.NET Core + HidSharp"] --> USB
    USB --> Board["ESP32-S3 + Zephyr<br/>Settings · Telemetry · Wi-Fi · SDMMC"]
    BLE --> Board
    UART["UART connector<br/>Flash + diagnostic shell/logs"] -.-> Board
```

Use the board's **USB** connector for native USB HID (`CAFE:4021`).
The separate **UART** connector is for flashing and a diagnostic shell/logs, not dashboard commands.
Wi-Fi is provisioned by the dashboards and also exposes the [raw TCP diagnostic shell](docs/guides/console.md).

## Choose your dashboard

| Dashboard | Best fit | Connection | Guide |
| --- | --- | --- | --- |
| **Direct** | Browser-native management without a USB bridge service | WebHID or Web Bluetooth | [Direct guide](host/direct/README.md) |
| **Python** | A local web dashboard backed by Python | USB HID via `hidapi` | [Python guide](host/python/README.md) |
| **.NET** | A local web dashboard backed by .NET 10 | USB HID via HidSharp | [.NET guide](host/dotnet/ESPForge/README.md) |

From the repository root, choose **one**:

```sh
# Direct -> http://127.0.0.1:8000/
bash tools/host/run-direct.sh --port 8000

# Python -> http://127.0.0.1:8001/
bash tools/host/run-python.sh web

# .NET 10 -> http://127.0.0.1:8002/
bash tools/host/run-dotnet.sh
```

Direct needs a supported desktop browser and localhost or HTTPS. Its local static server uses Python;
it does not bridge USB or Bluetooth traffic.
Python and .NET select the first ESPForge board, or one chosen with `--serial SERIAL` or
`--device-path HID_PATH`. Without hardware, the board list is empty; there is no simulated mode.

**Linux:** run `bash tools/host/hid-permissions-setup.sh` once, then reconnect the board.
Keep bridge hosts on loopback and use one management client per board at a time.

## Build something of your own

1. **Prepare the workspace.** Follow [getting started](docs/guides/getting-started.md) for the pinned
   Zephyr 4.3.2 / SDK 0.17.4 environment and Espressif dependencies.
2. **Build and flash.** From the initialized Zephyr workspace with its virtual environment active:

   ```sh
   bash espforge/tools/firmware/build.sh
   bash espforge/tools/firmware/flash.sh --port /dev/ttyUSB0
   ```

   Flash only the matching N16R8 module through its UART connector; replace the port with yours.
3. **Connect and configure.** Attach the USB connector, open a dashboard, then follow
   [wireless setup](docs/guides/wireless.md) to test a network or provision BLE.
4. **Extend the firmware.** Keep board wiring in overlays and product services out of blocking
   management paths. Start with the [architecture](docs/reference/architecture.md) and
   [firmware development guide](docs/development/firmware.md).

| Directory | Responsibility |
| --- | --- |
| [firmware/](firmware/) | Zephyr application, platform integration and native unit tests |
| [host/direct/](host/direct/) | Independent WebHID / Web Bluetooth dashboard |
| [host/python/](host/python/) | Python USB host, CLI and local dashboard server |
| [host/dotnet/](host/dotnet/) | .NET USB host and local dashboard server |
| [host/web/](host/web/) | Shared browser UI for the Python and .NET hosts |
| [docs/](docs/) | Operating guides, specifications and validation evidence |

## Designed for clear contracts

### Reference map

| Reference | Covers |
| --- | --- |
| [Architecture](docs/reference/architecture.md) | Connection paths, layer responsibilities and service lifecycle |
| [ESPForge implementation](docs/reference/espforge-implementation.md) | Platform integration and measurement limits |
| [USB HID](docs/reference/usb-hid.md) | Report layouts, discovery, Control requests and opcode semantics |
| [Bluetooth LE](docs/reference/bluetooth.md) | Advertising, GATT, session unlock and command proofs |
| [Boot settings](docs/reference/settings.md) | Next-boot record, CPU/radio settings and flash safety |
| [SD storage](docs/reference/sdcard.md) | Six-signal wiring, driver configuration, mount behavior and data safety |

USB HID and Bluetooth LE define the wire contracts. The implementation reference describes this board
and platform; it is **not a separate protocol**.

## Tested in software. Honest about hardware.

GitHub automation runs cross-platform host checks, Ceedling / Unity / CMock tests, dashboard
type-checks and the pinned ESP32-S3 firmware build. Native firmware tests cover control dispatch,
report encoding, wireless staging/authentication, SHA-256 and boot settings.

Stable version tags drive firmware and host packaging, checksums and qualification notes.
Release workflows also support Direct Pages deployment, PyPI publication and standalone .NET hosts
for Linux, Windows and Apple Silicon. Workflow configuration is not proof of an available release:
see the [release guide](docs/deployment/release.md).

**Know the boundaries before deploying:**

- Physical USB, Wi-Fi, BLE and SD behavior still need [hardware qualification](docs/validation/qualification-gaps.md).
- SD storage supports detected insertion/replacement and explicit [USB ownership handoff](docs/reference/sdcard.md).
  There is **no automatic formatting**. An optional [confirmed storage benchmark](docs/reference/sdcard.md#optional-storage-benchmark)
  measures temporary-file write/read verification.
- BLE commands are Control-key authenticated, but the link is **not encrypted**; flash credentials are also unencrypted.
- Settings use a single flash record and are **not power-loss atomic**.
- The TCP diagnostic shell is unauthenticated plaintext: use only on trusted networks, without port forwarding.
- The onboard RGB LED has a volatile colour dropdown beside Device information; see the [hardware guide](docs/guides/hardware.md)
  for the unverified default pin and board-revision alternative.
- There is no file-transfer API or dual-core application workload.

Read the [validation records](docs/validation/records/README.md) for observed evidence, not inferred guarantees.

## Contribute & explore

[Contributing](CONTRIBUTING.md) · [Host development](docs/development/host-tools.md) ·
[Release procedure](docs/deployment/release.md) · [Security policy](SECURITY.md) ·
[Documentation index](docs/README.md)

ESPForge was inspired by [PicoForge](https://github.com/djwinter29-oss/PicoForge)'s repository and documentation
organization. It is an ESP-specific implementation, not a compatible firmware port.

## License

[BSD 3-Clause](LICENSE). Third-party dependencies and Espressif radio blobs retain their own licenses.
