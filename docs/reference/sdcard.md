# SD storage contract

Zephyr's SPI SDHC driver, SDMMC disk layer, and FatFs are enabled in the default firmware.
Despite its name, the SDMMC disk layer here sits above a **SPI** host, not a four-bit SDMMC bus.
The disk is `SD`, mounted at `/SD:` once during boot.
Use the [hardware guide](../guides/hardware.md) for wiring and format requirements.

## Safety and ownership

- Only firmware owns the filesystem. No USB mass storage, host file API, or storage handoff exists.
- `CONFIG_FS_FATFS_MOUNT_MKFS=n` and `CONFIG_FS_FATFS_MKFS=n` disable both automatic formatting
  and mkfs support. A failed mount returns an error rather than creating a new volume.
- The starter does not create files, run write/verify benchmarks, or attempt repair.
- Failed mounts leave board management and wireless usable; status reports `sd_mounted=false`
  and the actual mount result. Do not label every mount failure "no card".
- No hot-plug detection, retry/remount, power-loss recovery, exFAT, or throughput guarantee.
- FAT support includes filesystem read/write APIs for downstream product code; no write workload
  is performed by this application. Any future writer must handle all return values and safe unmount.

The overlay requests a 10 MHz SPI ceiling; actual clock/card behavior is unmeasured.
SD-card testing is intentionally deferred until hardware is connected. Successful compilation and
simulated absent-card UI do not qualify any card, breakout, FAT layout or sustained recording workload.
