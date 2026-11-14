# Getting started

These instructions use a source checkout. [GitHub release automation](../deployment/release.md)
is configured for tagged packages; configuring a workflow does not mean a release is already published.
You can build and preview all three dashboards before connecting hardware.

## 1. Prepare a Zephyr workspace

Build target: ESP32-S3-DevKitC-1 N16R8, PROCPU, 16 MB flash and 8 MB octal PSRAM.
Check the module marking against the [hardware guide](hardware.md) before flashing.
Linux instructions below use Python 3.12, Zephyr 4.3.2, and Zephyr SDK 0.17.4.
For automatic setup on Debian/Ubuntu-compatible Linux or Raspberry Pi OS, run from your existing checkout:

```sh
tools/firmware/build.sh
```

The script installs missing host packages (requesting `sudo` when needed), creates/reuses a Python venv,
initializes a workspace in the checkout's parent directory if none exists, downloads pinned modules and radio blobs,
and installs the ESP32-S3 SDK toolchain before building. First use requires network access and several GB of disk space.
See [build environment options](../development/firmware.md#zephyr-target-build) to choose a Python interpreter or venv.
The following procedure is an alternative for manual setup.

Install Zephyr's [host prerequisites](https://docs.zephyrproject.org/4.3.0/develop/getting_started/index.html)
(CMake, Ninja, device-tree compiler, compiler utilities and Python venv support).

From a directory **outside** this repository, create a workspace containing the source checkout:

```sh
mkdir espforge-workspace
cd espforge-workspace
git clone https://github.com/djwinter29-oss/ESPForge espforge
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install west
west init -l espforge
west update --narrow -o=--depth=1
python -m pip install -r zephyr/scripts/requirements-base.txt -r modules/hal/espressif/zephyr/requirements.txt
west blobs fetch hal_espressif
west sdk install --version 0.17.4 --toolchains xtensa-espressif_esp32s3_zephyr-elf
```

The repository's `west.yml` pins Zephyr and imports only its Espressif, FatFs and mbedTLS dependencies.
Espressif radio blobs are required and have their own licenses. If SDK discovery fails, set
`ZEPHYR_SDK_INSTALL_DIR` to the installed SDK directory.

For an existing checkout, put it at `espforge-workspace/espforge` (or use a Linux symlink),
then run `west init -l espforge` in a new, otherwise uninitialized workspace. Do not initialize
a second workspace inside an existing Zephyr workspace.

## 2. Build now; flash later

Run from the workspace created above; missing build prerequisites are prepared automatically:

```sh
bash espforge/tools/firmware/build.sh
```

Outputs are in `espforge/build/firmware/zephyr/`: `zephyr.elf` and `zephyr.bin`.
Both radios and native four-bit SDMMC support are enabled in the default build; no card is needed to compile.
For the alternate SD-over-SPI image, add `--storage sd-spi` to both build and flash commands and to
`check_firmware_config.py`. See [image selection](../development/firmware.md#zephyr-target-build)
and use its matching [SD wiring](../reference/sdcard.md#pin-allocation).
The build uses PROCPU only, not a dual-core application.

When hardware arrives, attach the board's **UART** (USB-to-UART bridge) connector and close any serial terminal on it:

```sh
# Preview an upload command; the likely USB-UART port is detected automatically
bash espforge/tools/firmware/flash.sh --dry-run

# Upload the existing build and reset the board
bash espforge/tools/firmware/flash.sh
```

The [flash script](../../tools/firmware/flash.sh) detects a likely USB-UART port when `--port`
is omitted, preferring Silicon Labs CP210x devices. If equally likely ports are present, pass
`--port PORT` to choose one. It checks the build artifacts and board target, and uses Zephyr's
ESP32 runner to select the correct image offset and flash parameters. If required artifacts
are missing or empty, it builds first, including during `--dry-run`.
A complete existing build is reused; run the build script again after changing firmware.
It does not request a full-chip erase, but image sectors are
erased/replaced during flashing. Saved [boot settings](../reference/settings.md#flash-reservation) survive normal
uploads. No SD-card access is performed.

Replace the port with the real device, for example `COM4` on Windows with a Bash-capable
Zephyr environment. From a native Windows shell, use the equivalent
`west flash -d espforge/build/firmware --skip-rebuild -r esp32 --esp-device COM4 --esp-baud-rate 460800 --no-erase`.
Use a data-capable USB cable and confirm your board is the matching N16R8 variant.
On Linux, identify the bridge using `python -m serial.tools.list_ports` from the Zephyr venv (pyserial is installed
with Zephyr's requirements); check serial permissions rather than running the flasher as root.

If automatic reset fails,
hold BOOT, press/release RESET, release BOOT, and retry. Flash only a matching module configuration;
flashing replaces its existing firmware. If uploading is unreliable, retry with
`--baud 115200` after checking the cable and power. This firmware is not a UF2 image.
After flashing, connect the **USB** connector as well and check live status in a dashboard; uploader success alone
is not proof that application boot or radios work. The UART connector keeps showing the Zephyr console log, for
example with `python -m serial.tools.miniterm /dev/ttyUSB0 115200`.

## 3. Choose a dashboard

Run from the repository root (`cd espforge`):

| Dashboard | Launch | Open |
| --- | --- | --- |
| Direct | `bash tools/host/run-direct.sh --port 8000` | `http://127.0.0.1:8000/` |
| Python | `bash tools/host/run-python.sh web`, or `espforge web` after `pip install espforge` | `http://127.0.0.1:8001/` |
| .NET | `bash tools/host/run-dotnet.sh` | `http://127.0.0.1:8002/` |

Direct needs supported desktop Chrome/Edge for WebHID or Web Bluetooth.
Its static server uses Python only as a convenience; HTTPS static hosting needs nothing installed.
Python uses Python 3.10+ with Flask and `hidapi`; .NET uses the .NET 10 SDK/runtime with HidSharp.
Python and .NET select the first ESPForge board, or the one given by `--serial SERIAL` (the 16 hex-digit UID) or
`--device-path HID_PATH`. On Linux, run `bash tools/host/hid-permissions-setup.sh` once, then reconnect the board;
do not run the dashboards as root. Without a board the hosts show an empty board list; there is no simulated mode.

## 4. First connection

Connect the board's **USB** connector. In Direct, click **USB** and choose the ESPForge HID device; in Python or .NET,
select the board in the list. Confirm product `ESPForge`, the board, firmware version and serial number.
An SD mount failure is expected without a card and does not prevent dashboard operation.
Test and save a 2.4 GHz network, and optionally create a Bluetooth Control key, using [wireless setup](wireless.md).
Run one host per board at a time, so Control commands do not interleave. A command whose outcome is uncertain is
never retried; confirm the
re-sync prompt after checking the board.

Hardware acceptance and all SD-card tests are deferred; see [qualification gaps](../validation/qualification-gaps.md).
