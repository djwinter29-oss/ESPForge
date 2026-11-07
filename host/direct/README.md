# Direct dashboard

A static browser dashboard with USB-UART Web Serial and read-only Web Bluetooth.
It uses a PicoForge-inspired light layout, shared with Python and .NET:
device metrics, board configuration, collapsible UART/SD pin tables, live diagnostics,
storage and Wi-Fi provisioning.
There is no Python or .NET serial bridge in the Direct path.

From the repository root:

```sh
bash tools/host/run-direct.sh --port 8000
```

Open <http://127.0.0.1:8000/host/direct/> in supported desktop Chrome/Edge.
Select USB-UART and **Select board**, then choose the board's serial bridge.
Web Serial/Web Bluetooth require a secure context (localhost or HTTPS); `file://` is unsupported.
Browser/OS support differs, especially Bluetooth on Linux. UART does not require a USB HID firmware interface.

Select **Simulated preview** to review the layout before attaching hardware.
The banner explicitly marks synthetic data; no hardware or SD test runs.
Bluetooth can only read status. Use UART for Wi-Fi provisioning.
Disconnect before changing transports, flashing, or opening another serial host.
On failure the dashboard clears stale values and stops polling; reconnect explicitly.
The transport remains selected until you Disconnect. Status refresh is also available manually.

## Layout and feature boundaries

| Section | ESPForge implementation |
| --- | --- |
| Device information | Live product, board, firmware and protocol; transport selection |
| Board configuration | Build OS/core and actual reported radio-enabled state |
| Pin configuration | Collapsible management UART and SPI2 wiring reference |
| Live diagnostics | Formatted uptime, Wi-Fi association, radio result codes and sample timestamp |
| Storage | Live mount result, fixed mount point and explicitly requested SPI ceiling |
| Wi-Fi setup | USB-UART-only credentials for this boot, with UTF-8 byte validation and explicit result feedback |

Build/wiring defaults are labeled separately from live values. Disconnects and errors clear
live values and disable provisioning. Simulated data is prominently labeled and cannot send commands.
Local credential validation errors leave the healthy connection running; firmware errors stop polling.
Passphrase text is cleared on submission completion and disconnect.

PicoForge has a richer protocol. ESPForge does not yet implement LED/reboot controls,
saved settings, radio switches, serial/UID reporting, measured clock/RAM/temperature,
core-load telemetry, card identity/capacity, storage benchmarks, USB drive handoff or a
Wi-Fi CLI console. The dashboard explains these limits rather than inventing values or
displaying working-looking controls. BLE diagnostics are public and read-only.

## Checks

Dashboard/transport regressions run with `node --test host/web/tests/*.test.js`.
The launcher is a manual convenience script, not a separately tested tool.
Browser validation uses simulated data and does not qualify physical UART/BLE/SD behavior.

Keep `host/direct/` and its sibling `host/web/` together when statically hosting.
[Release automation](../../docs/deployment/release.md) packages this layout and can publish
the verified release to GitHub Pages after repository Pages setup. The hosted site needs no
Python/.NET serial bridge. No site or repository setting has been provisioned locally.

See [getting started](../../docs/guides/getting-started.md), [wireless](../../docs/guides/wireless.md),
and the [protocol](../../docs/reference/protocol.md).
