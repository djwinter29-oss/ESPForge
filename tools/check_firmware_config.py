"""Verify required defaults in a generated Zephyr configuration."""

import argparse
import re
import sys
from pathlib import Path


def settings_partition_failures(build: Path, config: dict[str, str]) -> list[str]:
    """The flashed image must end before the settings record in storage_partition."""
    match = re.search(r"storage_partition: partition@[0-9a-f]+ \{[^}]*?reg = < (0x[0-9a-f]+) (0x[0-9a-f]+) >",
                      (build / "zephyr.dts").read_text(), re.S)
    if not match:
        return ["storage_partition is missing from zephyr.dts"]
    start = int(match.group(1), 16)
    end = int(config.get("CONFIG_FLASH_LOAD_OFFSET", "0"), 0) + (build / "zephyr.bin").stat().st_size
    if end > start:
        return [f"firmware image ends at {end:#x}, past the settings partition at {start:#x}"]
    return []


def card_detect_failures(dts: str) -> list[str]:
    detect = re.search(r"\bsd-detect-gpios\s*=\s*<\s*&gpio0\s+(0x[0-9a-f]+|\d+)\s+"
                       r"(0x[0-9a-f]+|\d+)\s*>;", dts)
    if not detect or [int(value, 0) for value in detect.groups()] != [8, 0x20]:
        return ["SD card detection must use GPIO8 active-high with a pull-down"]
    return []


def sdmmc_failures(build: Path) -> list[str]:
    dts = re.sub(r"/\*.*?\*/", "", (build / "zephyr.dts").read_text(), flags=re.S)
    slot = re.search(r"\bespforge_sd:\s*sdhc@0\s*\{([^{}]*)", dts)
    if not slot:
        return ["native SDMMC slot 0 (espforge_sd) is missing from zephyr.dts"]
    properties = slot.group(1)
    failures = []
    required = (
        ('compatible = "espressif,esp32-sdhc-slot";', "native SDMMC slot driver"),
        ('status = "okay";', "enabled SDMMC slot"),
        ("pinctrl-0 = < &espforge_sd_default >;", "SDMMC pinctrl"),
    )
    for text, name in required:
        if text not in properties:
            failures.append(f"{name} is missing from espforge_sd")
    for name, expected in (("bus-width", 4), ("max-bus-freq", 25_000_000)):
        value = re.search(rf"\b{name}\s*=\s*<\s*(0x[0-9a-f]+|\d+)\s*>;", properties)
        if not value or int(value.group(1), 0) != expected:
            failures.append(f"SDMMC {name} must be {expected}")
    pins = re.search(r"\bespforge_sd_default:\s*\w+\s*\{\s*[^{}]*"
                     r"clock\s*\{([^{}]*)\};\s*command_data\s*\{([^{}]*)\};", dts)
    if not pins:
        failures.append("SDMMC clock and command/data pinctrl groups are missing")
    else:
        muxes = []
        for group in pins.groups():
            mux = re.search(r"\bpinmux\s*=\s*([^;]+);", group)
            muxes.extend(re.findall(r"<\s*(0x[0-9a-f]+|\d+)\s*>", mux.group(1)) if mux else [])
        # ESP32_PIN_NUM_MASK in esp-pinctrl-common.h stores the GPIO in the low six bits.
        if [int(value, 0) & 0x3F for value in muxes] != [12, 11, 13, 14, 15, 10]:
            failures.append("SDMMC CLK/CMD/DAT0-DAT3 GPIOs must be 12/11/13/14/15/10")
        if "bias-pull-up;" not in pins.group(2):
            failures.append("SDMMC command/data pinctrl must request pull-ups")
    return failures


def sd_spi_failures(build: Path) -> list[str]:
    dts = re.sub(r"/\*.*?\*/", "", (build / "zephyr.dts").read_text(), flags=re.S)
    failures = []
    controller = re.search(r"\bspi3:\s*spi@[0-9a-f]+\s*\{([^{}]*)", dts)
    if not controller or 'status = "okay";' not in controller.group(1):
        failures.append("SPI3 SD controller must be enabled")
    elif ("pinctrl-0 = < &espforge_sd_spi_default >;" not in controller.group(1)
          or not re.search(r"cs-gpios = < &gpio0 (?:0xa|10) (?:0x1|1) >;", controller.group(1))):
        failures.append("SPI3 requires SD pinctrl and GPIO10 active-low chip select")
    slot = re.search(r"\bespforge_sd_spi:\s*sdhc@0\s*\{([^{}]*)", dts)
    if not slot or 'compatible = "zephyr,sdhc-spi-slot";' not in slot.group(1):
        failures.append("SPI SD slot is missing")
    elif not re.search(r"spi-max-frequency = < (?:0x17d7840|25000000) >;", slot.group(1)):
        failures.append("SPI SD clock ceiling must be 25000000")
    pins = re.search(r"\bespforge_sd_spi_default:\s*\w+\s*\{\s*[^{}]*"
                     r"clock\s*\{([^{}]*)\};\s*data\s*\{([^{}]*)\};", dts)
    muxes = []
    if pins:
        for group in pins.groups():
            mux = re.search(r"\bpinmux\s*=\s*([^;]+);", group)
            muxes.extend(re.findall(r"<\s*(0x[0-9a-f]+|\d+)\s*>", mux.group(1)) if mux else [])
    if [int(value, 0) & 0x3F for value in muxes] != [12, 11, 13]:
        failures.append("SPI3 SCK/MOSI/MISO GPIOs must be 12/11/13")
    if not pins or "bias-pull-up;" not in pins.group(2):
        failures.append("SPI SD data pinctrl must request pull-ups")
    native = re.search(r"\bespforge_sd:\s*sdhc@0\s*\{([^{}]*)", dts)
    if not native or 'status = "disabled";' not in native.group(1):
        failures.append("native SDMMC slot must be disabled in the SD-SPI image")
    native_disk = re.search(r"\bespforge_sd:\s*sdhc@0\s*\{[^{}]*\bmmc\s*\{([^{}]*)", dts)
    if not native_disk or 'status = "disabled";' not in native_disk.group(1):
        failures.append("native SDMMC disk must be disabled in the SD-SPI image")
    return failures


def phy_sensor_hook_failures(build: Path, config: dict[str, str]) -> list[str]:
    """Wi-Fi modem sleep must release the die-temperature sensor by reference count instead of powering it off."""
    if config.get("CONFIG_ESP32_TEMP") != "y":
        return []
    owner = re.search(r"\(([^()\s]+)\)\n(?:\s+0x[0-9a-f]+ \(size before relaxing\)\n)?\s+0x[0-9a-f]+\s+"
                      r"phy_set_tsens_power\n", (build / "zephyr.map").read_text())
    if not owner or owner.group(1) != "phy_override.c.obj":
        return ["phy_set_tsens_power must come from the HAL phy_override.c, not the PHY library's weak default"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--storage", choices=("sdmmc", "sd-spi"), default="sdmmc")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    build = root / "build" / ("firmware-sd-spi" if args.storage == "sd-spi" else "firmware") / "zephyr"
    config_path = build / ".config"
    config = dict(line.split("=", 1) for line in config_path.read_text().splitlines()
                  if line.startswith("CONFIG_") and "=" in line)
    enabled = [
        "WIFI", "BT", "BT_PERIPHERAL", "ESP32_SW_COEXIST_ENABLE",
        "NET_DHCPV4", "DISK_DRIVER_SDMMC", "FAT_FILESYSTEM_ELM",
        "FLASH", "FLASH_MAP", "CLOCK_CONTROL", "USB_DEVICE_STACK_NEXT",
        "USBD_HID_SUPPORT", "USBD_MSC_CLASS", "HWINFO", "REBOOT", "THREAD_RUNTIME_STATS",
        "ESP_SPIRAM", "SPIRAM_MODE_OCT",
        "SHELL", "SHELL_BACKEND_SERIAL", "SHELL_BACKEND_TELNET", "DEVICE_SHELL", "NET_TCP",
    ]
    values = {"FLASH_SIZE": "16777216", "ESP_SPIRAM_SIZE": "8388608", "SHELL_TELNET_PORT": "2323"}
    disabled = ["FS_FATFS_MOUNT_MKFS", "FS_FATFS_MKFS", "JSON_LIBRARY", "BT_SMP",
                "USBD_CDC_ACM_CLASS", "SHELL_TELNET_SUPPORT_COMMAND", "SHELL_LOG_BACKEND", "SHELL_HISTORY",
                "KERNEL_SHELL", "DEVMEM_SHELL", "DATE_SHELL", "DEVICE_SHELL_INIT_CMD", "FILE_SYSTEM_SHELL",
                "FLASH_SHELL", "NET_SHELL", "NET_L2_WIFI_SHELL", "BT_SHELL"]
    enabled.append("SPI_SDHC" if args.storage == "sd-spi" else "SDHC_ESP32")
    disabled.append("SDHC_ESP32" if args.storage == "sd-spi" else "SPI_SDHC")
    failures = [f"CONFIG_{name} must be enabled" for name in enabled
                if config.get(f"CONFIG_{name}") != "y"]
    failures.extend(f"CONFIG_{name} must be disabled" for name in disabled
                    if config.get(f"CONFIG_{name}", "n") != "n")
    failures.extend(f"CONFIG_{name} must be {value} for the N16R8 module" for name, value in values.items()
                    if config.get(f"CONFIG_{name}") != value)
    failures.extend(settings_partition_failures(build, config))
    failures.extend(sd_spi_failures(build) if args.storage == "sd-spi" else sdmmc_failures(build))
    failures.extend(card_detect_failures((build / "zephyr.dts").read_text()))
    failures.extend(phy_sensor_hook_failures(build, config))
    led_bus = re.search(r"\bspi2:\s*spi@[0-9a-f]+\s*\{([^{}]*)",
                        (build / "zephyr.dts").read_text())
    if not led_bus or not re.search(r"^\s*line-idle-low;", led_bus.group(1), re.M):
        failures.append("SPI2 LED data must idle low for the WS2812 reset/latch interval")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    storage = ("SPI3 SD/FAT at up to 25 MHz on GPIO12/11/13 with GPIO10 CS" if args.storage == "sd-spi"
               else "native 4-bit SDMMC/FAT at up to 25 MHz on GPIO12/11/13/14/15/10")
    print(f"PASS: N16R8 16 MB flash and 8 MB octal PSRAM, Wi-Fi, BLE, coexistence, DHCP, {storage}, "
          "GPIO8 card detect, USB HID/MSC, UART/raw TCP diagnostic shells on port 2323, settings flash; "
          "no mkfs, CDC or JSON")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
