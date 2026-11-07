"""Verify required defaults in a generated Zephyr configuration."""

import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    config_path = root / "build/firmware/zephyr/.config"
    config = dict(line.split("=", 1) for line in config_path.read_text().splitlines()
                  if line.startswith("CONFIG_") and "=" in line)
    enabled = [
        "WIFI", "BT", "BT_PERIPHERAL", "ESP32_SW_COEXIST_ENABLE",
        "NET_DHCPV4", "SPI_SDHC", "DISK_DRIVER_SDMMC", "FAT_FILESYSTEM_ELM",
    ]
    disabled = ["FS_FATFS_MOUNT_MKFS", "FS_FATFS_MKFS", "UART_CONSOLE", "ESP_CONSOLE"]
    failures = [f"CONFIG_{name} must be enabled" for name in enabled
                if config.get(f"CONFIG_{name}") != "y"]
    failures.extend(f"CONFIG_{name} must be disabled" for name in disabled
                    if config.get(f"CONFIG_{name}", "n") != "n")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("PASS: Wi-Fi, BLE, coexistence, DHCP, SPI SD/FAT; no mkfs or UART console")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
