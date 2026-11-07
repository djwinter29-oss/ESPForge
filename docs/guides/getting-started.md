# Getting started

This is a source-checkout starter, not a published firmware or host package.
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
west flash -d espforge/build/firmware --esp-device /dev/ttyUSB0
```

Replace the port with the real device, for example `COM4` on Windows. If automatic reset fails,
hold BOOT, press/release RESET, release BOOT, and retry. Flash only a matching module configuration;
flashing replaces its existing firmware. This firmware is not a UF2 image.

## 3. Choose a dashboard

Run from the repository root (`cd espforge`):

| Dashboard | Launch | Open |
| --- | --- | --- |
| Direct | `python3 -m http.server 8000 --bind 127.0.0.1` | `http://127.0.0.1:8000/host/direct/` |
| Python | `python3 -m pip install -r host/python/requirements.txt`, then `python3 host/python/server.py --device /dev/ttyUSB0` | `http://127.0.0.1:8001/` |
| .NET | `dotnet run --project host/dotnet/ESPForge -- --device /dev/ttyUSB0` | `http://127.0.0.1:8002/` |

Direct needs supported desktop Chrome/Edge for Web Serial or Web Bluetooth.
Its static server uses Python only as a convenience; HTTPS static hosting needs no installed serial bridge.
Python uses Python 3.10+ and pyserial; .NET uses the .NET 10 SDK/runtime.
On Linux, serial access may require membership in the device's owning group (often `dialout`).
Log out/in after changing group membership; do not run the dashboards as root.

Before hardware arrives, choose **Simulated preview** in Direct, or replace `--device PORT` with
`--demo` for either host. Click Connect. The preview is explicitly labeled and does not exercise
radios, storage, firmware or physical serial.

## 4. First connection

Click Connect, select the UART bridge, and confirm product `ESPForge`, protocol `1`, board and firmware.
An SD mount failure is expected without a card and does not prevent dashboard operation.
Provision a 2.4 GHz network using [wireless setup](wireless.md). Stop one serial client before starting
another. A timeout never retries a provisioning command; inspect status before taking further action.

Hardware acceptance and all SD-card tests are deferred; see [qualification gaps](../validation/qualification-gaps.md).
