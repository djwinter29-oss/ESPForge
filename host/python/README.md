# ESPForge Python Host

USB HID control, diagnostics, and a local dashboard for ESPForge firmware on the ESP32-S3-DevKitC.
The host talks to the board's native USB HID interface (VID:PID `0xCAFE:0x4021`) using the
[USB HID contract](../../docs/reference/usb-hid.md).
Basic monitoring needs no SD card. Wireless controls depend on the connected firmware's capabilities.

Python and .NET share their own frontend in `host/web/src`. The Direct dashboard is independent: **no code is shared
with Direct**. See the [Direct independence policy](../../docs/development/host-tools.md#direct-dashboard-independence).
This Python host connects over USB HID, not the USB-UART bridge or Bluetooth LE.
Wireless status uses Report 12 and all writes use the unified Report 20 channel. The dashboard preserves the saved
Wi-Fi and BLE switches from Report 2 and supports staged credentials, connection tests, and scans.
Opaque scan SSIDs include `ssid_hex` beside an escaped display name; test/save requests may send that hex value
to preserve the network bytes. Saving a tested pair reuses its staging without resending either credential.

## Install

Use Python 3.10 or newer in a virtual environment:

```sh
python -m venv .venv
```

Activate it with `source .venv/bin/activate` on Linux/macOS or `.venv\Scripts\Activate.ps1` in Windows PowerShell, then:

```sh
python -m pip install espforge
espforge web
```

Open **http://127.0.0.1:8001/**. The wheel includes the dashboard assets; Node.js and .NET are not required.
Runtime dependencies are Flask and HIDAPI, pinned in [pyproject.toml](pyproject.toml).
Native HID access still requires the operating system's usual libraries, drivers, and permissions.
Hatchling and hatch-vcs derive package versions from `vMAJOR.MINOR.PATCH` Git tags, with development versions
between tags. The dashboard displays the installed `espforge` distribution version, matching `pip show espforge`,
for both wheels and editable installs. Uninstalled source checkouts report `0.0.0-debug`.

Wheels are attached to [GitHub Releases](https://github.com/djwinter29-oss/ESPForge/releases/latest) and published to
PyPI after [release setup](../../docs/deployment/release.md#before-the-first-release); downloads may be unavailable
before then. For firmware build and flashing, start with [Getting Started](../../docs/guides/getting-started.md).

### Run from a source checkout

For an explicit development installation in your active environment, from the repository root:

```sh
python -m pip install --editable host/python
espforge web
```

Reinstall the editable package after changing commits or tags to refresh its installed version metadata.
Alternatively, `bash tools/host/run-python.sh web` refreshes the editable installation on every launch, so its
dashboard version matches the package metadata for the current checkout. The script reuses its virtual environment;
if installation fails, it does not start the host with stale metadata. Stop an already-running host before relaunching.

Source-checkout launches need no asset copy. Building a wheel or source distribution requires
[explicit asset staging](../../docs/development/host-tools.md#python-host-design) first; there is no custom build hook.

## Commands

```sh
espforge web
espforge web --port 8011
espforge status
espforge status --serial SERIAL
espforge reboot --serial SERIAL --confirm
python -m espforge --help
```

`status` prints JSON diagnostics from the reports received within a five-second collection window; unavailable
fields remain `null`. `reboot` requires explicit confirmation and uses the board's saved settings.
All three commands accept either `--serial SERIAL` or `--device-path PATH` to select a board.
The server always binds to `127.0.0.1`. Python and .NET default to ports 8001 and 8002.

Use **Rescan** and the dashboard's board selector to switch between attached boards. Run only one HID host connection
per board; separate host processes can conflict for access.

On Linux, grant your user access to the HID device once with
[hid-permissions-setup.sh](../../tools/host/hid-permissions-setup.sh), then reconnect the board and restart the
dashboard. It installs `/etc/udev/rules.d/99-espforge-hid.rules` for `CAFE:4021` and may prompt for sudo:

```sh
bash tools/host/hid-permissions-setup.sh
```

From a source checkout, [run-python.sh](../../tools/host/run-python.sh) creates `build/espforge`, installs this package
in editable mode on first use, checks HID permissions and runs `espforge` (default command `web`).

## Dashboard Operations

- **Monitor:** live board identity, runtime, memory, pins, SD-card details, and Wi-Fi state.
- **Boot configuration:** save the clock (Default, 80, 160 or 240 MHz) and the Wi-Fi/BLE switches with
  **Save&Reboot**. The SD profile is always Standard. **Reboot Board** uses the already saved settings. See
  [settings and save safety](../../docs/reference/settings.md).
- **Wireless:** provision Wi-Fi and a Control key over USB. Bluetooth connections use the independent Direct
  dashboard. See [wireless setup](../../docs/guides/wireless.md).

ESPForge has no board LED, USB drive (MSC), SD benchmark, forced save, CDC console or TCP CLI console, so the
dashboard does not offer them and their routes are absent; see [Dashboard HTTP API](#dashboard-http-api).

Commands can be rejected or remain uncertain after a timeout/disconnect; delivery is not completion.
Do not replay uncertain writes. Feature availability and safety gates follow the connected firmware.
Host tests use fakes only; see the [qualification gaps](../../docs/validation/qualification-gaps.md).

## Dashboard HTTP API

Python and .NET implement the [shared dashboard HTTP API](../web/README.md#http-api).
That contract owns routes, request fields, reserved status values and unsupported operations.
Use the board ID returned by discovery when selecting a board for API requests.

## Development and License

For host tests, type checks and frontend ownership, see [Host development](../../docs/development/host-tools.md#python-host-design).

| Package | Responsibility |
|---|---|
| `espforge.reports` | Report codecs and ESPForge-specific validation; never opens a device |
| `espforge.hid` | HIDAPI device access and Report 20 command exchange |
| `espforge.dashboard` | Board monitor, multi-board selection, and the loopback Flask server |
| `espforge.cli` | The `espforge` and `python -m espforge` entry point |
| `espforge.web` | Dashboard assets explicitly staged from the shared frontend for package builds |

Each public package can be imported independently without opening a device.

The package uses the **BSD-3-Clause** license. Its [LICENSE](LICENSE) mirrors the
[repository license](../../LICENSE) and is included in built wheels; keep both copies identical.
