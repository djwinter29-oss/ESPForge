# Firmware development

Follow [workspace setup](../guides/getting-started.md#1-prepare-a-zephyr-workspace) before building.
Zephyr 4.2.0 and imported module commits are selected by `west.yml`; SDK 0.17.2 is the initial toolchain.
Run the build script from anywhere within the initialized workspace, with its Python venv activated:

```sh
bash espforge/tools/firmware/build.sh
python espforge/tools/check_firmware_config.py
```

For changes to board/configuration selection, use a pristine build from the workspace:

```sh
west build -p always -b esp32s3_devkitc/esp32s3/procpu espforge/firmware \
  -d espforge/build/firmware -- -DDTC_OVERLAY_FILE=boards/esp32s3_devkitc.overlay
```

Inspect generated `build/firmware/zephyr/.config` and `zephyr.dts`, not just source intent.
Required defaults include Wi-Fi, BLE, software coexistence, SPI SDHC, SDMMC disk and FatFs.
Both FAT mkfs options must remain disabled. Console/logging are disabled on UART0 to preserve framing;
initialization and mount failures are exposed as status result codes. `PRINTK` is required by dependencies,
but no UART console backend is enabled.

Do not connect an SD card or run storage tests for software-only setup.
Compilation does not validate initialization, UART electrical behavior, coexistence, or filesystem reliability.
Record software evidence separately from future hardware observations in [validation records](../validation/records/README.md).
