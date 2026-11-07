"""Verify required defaults in a generated Zephyr configuration."""

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


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    config_path = root / "build/firmware/zephyr/.config"
    config = dict(line.split("=", 1) for line in config_path.read_text().splitlines()
                  if line.startswith("CONFIG_") and "=" in line)
    enabled = [
        "WIFI", "BT", "BT_PERIPHERAL", "ESP32_SW_COEXIST_ENABLE",
        "NET_DHCPV4", "SPI_SDHC", "DISK_DRIVER_SDMMC", "FAT_FILESYSTEM_ELM",
        "FLASH", "FLASH_MAP", "CLOCK_CONTROL", "USB_DEVICE_STACK_NEXT",
        "USBD_HID_SUPPORT", "HWINFO", "REBOOT", "THREAD_RUNTIME_STATS",
        "ESP_SPIRAM", "SPIRAM_MODE_OCT",
    ]
    values = {"FLASH_SIZE": "16777216", "ESP_SPIRAM_SIZE": "8388608"}
    disabled = ["FS_FATFS_MOUNT_MKFS", "FS_FATFS_MKFS", "JSON_LIBRARY", "BT_SMP"]
    failures = [f"CONFIG_{name} must be enabled" for name in enabled
                if config.get(f"CONFIG_{name}") != "y"]
    failures.extend(f"CONFIG_{name} must be disabled" for name in disabled
                    if config.get(f"CONFIG_{name}", "n") != "n")
    failures.extend(f"CONFIG_{name} must be {value} for the N16R8 module" for name, value in values.items()
                    if config.get(f"CONFIG_{name}") != value)
    failures.extend(settings_partition_failures(root / "build/firmware/zephyr", config))
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("PASS: N16R8 16 MB flash and 8 MB octal PSRAM, Wi-Fi, BLE, coexistence, DHCP, SPI SD/FAT, USB HID, settings flash; no mkfs or JSON")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
