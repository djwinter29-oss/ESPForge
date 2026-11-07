# Getting started

These instructions use a source checkout. [GitHub release automation](../deployment/release.md)
is configured for tagged packages; configuring a workflow does not mean a release is already published.
You can build and preview all three dashboards before connecting hardware.

## 1. Prepare a Zephyr workspace

Initial build target: ESP32-S3-DevKitC, PROCPU, default 8 MB flash DTS.
Check the module marking against the [hardware guide](hardware.md) before flashing.
Linux instructions below use Python 3.12, Zephyr 4.2.0, and Zephyr SDK 0.17.2.
Install Zephyr's [host prerequisites](https://docs.zephyrproject.org/4.2.0/develop/getting_started/index.html)
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
python -m pip install -r zephyr/scripts/requirements-base.txt
west blobs fetch hal_espressif
west sdk install --version 0.17.2 --toolchains xtensa-espressif_esp32s3_zephyr-elf
```

The repository's `west.yml` pins Zephyr and imports only its Espressif, FatFs and mbedTLS dependencies.
Espressif radio blobs are required and have their own licenses. If SDK discovery fails, set
`ZEPHYR_SDK_INSTALL_DIR` to the installed SDK directory.

For an existing checkout, put it at `espforge-workspace/espforge` (or use a Linux symlink),
then run `west init -l espforge` in a new, otherwise uninitialized workspace. Do not initialize
a second workspace inside an existing Zephyr workspace.

## 2. Build now; flash later

Run from the workspace with its venv activated:

```sh
bash espforge/tools/firmware/build.sh
```

Outputs are in `espforge/build/firmware/zephyr/`: `zephyr.elf` and `zephyr.bin`.
Both radios and SPI SD-card support are enabled in the default build; no card is needed to compile.
The build uses PROCPU only, not a dual-core application.

When hardware arrives, attach the board's **USB-to-UART** connector and close all dashboards/terminals:

```sh
# Preview the upload command without accessing hardware
bash espforge/tools/firmware/flash.sh --port /dev/ttyUSB0 --dry-run

# Upload the existing build and reset the board
bash espforge/tools/firmware/flash.sh --port /dev/ttyUSB0
```

The [flash script](../../tools/firmware/flash.sh) requires an explicit port, checks the build
artifacts and board target, and uses Zephyr's ESP32 runner to select the correct image offset
and flash parameters. It uploads the existing build without rebuilding; run the build script
again after changing firmware. It does not request a full-chip erase, but image sectors are
erased/replaced during flashing. No SD-card access is performed.

Replace the port with the real device, for example `COM4` on Windows with a Bash-capable
Zephyr environment. From a native Windows shell, use the equivalent
`west flash -d espforge/build/firmware --skip-rebuild -r esp32 --esp-device COM4 --esp-baud-rate 460800 --no-erase`.
Use a data-capable USB cable and confirm your board is the matching N8 variant.
On Linux, identify the bridge using `python -m serial.tools.list_ports` from an environment
with the [Python host requirements](../../host/python/requirements.txt) installed; check serial
permissions rather than running the flasher as root.

If automatic reset fails,
hold BOOT, press/release RESET, release BOOT, and retry. Flash only a matching module configuration;
flashing replaces its existing firmware. If uploading is unreliable, retry with
`--baud 115200` after checking the cable and power. This firmware is not a UF2 image.
After flashing, check live UART status using a dashboard; uploader success alone is not
proof that application boot or radios work.

## 3. Choose a dashboard

Run from the repository root (`cd espforge`):

| Dashboard | Launch | Open |
| --- | --- | --- |
| Direct | `bash tools/host/run-direct.sh --port 8000` | `http://127.0.0.1:8000/host/direct/` |
| Python | `python3 -m pip install -r host/python/requirements.txt`, then `python3 host/python/server.py --device /dev/ttyUSB0` | `http://127.0.0.1:8001/` |
| .NET | `dotnet run --project host/dotnet/ESPForge -- --device /dev/ttyUSB0` | `http://127.0.0.1:8002/` |

Direct needs supported desktop Chrome/Edge for Web Serial or Web Bluetooth.
Its static server uses Python only as a convenience; HTTPS static hosting needs no installed serial bridge.
Python uses Python 3.10+ and pyserial; .NET uses the .NET 10 SDK/runtime.
On Linux, serial access may require membership in the device's owning group (often `dialout`).
Log out/in after changing group membership; do not run the dashboards as root.

Before hardware arrives, choose **Simulated preview** in Direct, or replace `--device PORT` with
`--demo` for either host. Click **Select board**. The preview is explicitly labeled and does not exercise
radios, storage, firmware or physical serial.

## 4. First connection

Click **Select board**, select the UART bridge, and confirm product `ESPForge`, protocol `1`, board and firmware.
An SD mount failure is expected without a card and does not prevent dashboard operation.
Provision a 2.4 GHz network using [wireless setup](wireless.md). Stop one serial client before starting
another. A timeout never retries a provisioning command; inspect status before taking further action.

Hardware acceptance and all SD-card tests are deferred; see [qualification gaps](../validation/qualification-gaps.md).
