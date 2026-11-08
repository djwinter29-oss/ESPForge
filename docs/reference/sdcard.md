# SD Storage Reference

ESPForge uses an SD card over **SPI2** on the ESP32-S3-DevKitC-1 N16R8.
Zephyr's SPI SDHC driver, SDMMC disk layer and FatFs are enabled in the default firmware.
Despite its name, the SDMMC disk layer here sits above a **SPI** host, not a four-bit SDMMC bus.
The disk is `SD`, mounted at `/SD:` once during boot. This reference owns the SD pin allocation,
mount lifecycle, status reporting and data-safety contract. See the
[hardware guide](../guides/hardware.md#sd-card-spi-wiring) for board selection and electrical precautions.

## Pin allocation

GPIO numbers are ESP32-S3 signals, not physical header positions. Verify the labels and schematic of your
exact board and breakout before connecting them.

| SPI2 function | ESP32-S3 pin | Breakout/card signal | Direction relative to ESP32-S3 |
| --- | --- | --- | --- |
| Chip select, active low | GPIO10 | CS / DAT3 | Output |
| Controller output | GPIO11 | MOSI / CMD | Output |
| Clock | GPIO12 | SCLK / CLK | Output |
| Controller input | GPIO13 | MISO / DAT0 | Input |
| Supply | 3V3 | 3.3 V supply input | Power |
| Ground | GND | GND | Common ground |

There is no allocated card-detect pin, power-control GPIO or DAT1/DAT2 connection. A four-bit SDMMC breakout
must be wired for SPI operation; this firmware does not use its four-bit data bus.

The [board overlay](../../firmware/boards/esp32s3_devkitc.overlay) enables `spi2`, assigns GPIO10 as
`GPIO_ACTIVE_LOW` chip select, and creates `espforge_sd` with `spi-max-frequency = <10000000>`.
Clock, MOSI and MISO use Zephyr's board-default SPI2 pinctrl. SPI3 is disabled because its default pins can
conflict with module flash/PSRAM signals; GPIO33-37 are occupied by octal PSRAM on N16R8.

Report `2` publishes storage GPIOs in CLK, MOSI, MISO, CS order as
`12, 11, 13, 10, 255, 255`; `255` means unassigned. The card-detect GPIO is also `255`.
If a downstream board changes the wiring, update both its overlay/pinctrl and the board facts encoded in
[hid_reports.c](../../firmware/src/app/usb/hid_reports.c), then validate the new allocation.

## Driver and filesystem configuration

| Layer | Configuration |
| --- | --- |
| SPI host | `spi2`, enabled by the board overlay |
| SD host driver | `zephyr,sdhc-spi-slot`, chip-select index `0` |
| Disk layer | `zephyr,sdmmc-disk`, disk name `SD` |
| Filesystem | FatFs, mount point `/SD:` |
| Requested SPI ceiling | 10 MHz; not a measured runtime clock or throughput |

[prj.conf](../../firmware/prj.conf) enables SPI/GPIO, disk access, the SDMMC disk driver, SPI SDHC,
the filesystem API and FatFs. Both `CONFIG_FS_FATFS_MOUNT_MKFS` and `CONFIG_FS_FATFS_MKFS` are explicitly
disabled: the application cannot automatically format a failed mount or call FatFs mkfs through these options.

Prepare an existing FAT16/FAT32 volume on a computer and back up its data before use. exFAT is not enabled
in the default firmware. The report format reserves a value for exFAT; that does not imply filesystem support.

## Boot and mount lifecycle

1. Insert the card before powering or rebooting the board.
2. After boot settings, CPU clock application and telemetry initialization,
   [main.c](../../firmware/src/main.c) calls `ef_storage_init()` once, before Wi-Fi, BLE and USB initialization.
3. [storage.c](../../firmware/src/app/storage/storage.c) calls `fs_mount()` for `/SD:`.
4. On success, it records the mounted state and FatFs filesystem type, then queries the disk sector count with
   `DISK_IOCTL_GET_SECTOR_COUNT`. If the capacity query fails, the filesystem remains mounted but capacity
   is unavailable.
5. On failure, it logs `SD card mount failed: <error>` on the UART console and returns. Startup continues,
   so a failed mount does not prevent USB management or radio initialization.

Mount state, filesystem type and sector count are boot-time facts, not live card monitoring. There is no
retry, automatic remount, card-detect polling or removal detection. Reports continue publishing the cached
facts even if the card is subsequently removed. Do not insert or remove a card while powered/mounted.

## Status reporting

Report `10` carries storage status over USB HID and BLE. Byte layouts are defined in the
[USB HID reference](usb-hid.md); ESPForge-specific values are listed in the
[implementation reference](espforge-implementation.md#report-10-storage).

| Condition or field | ESPForge behavior |
| --- | --- |
| Every published sample | Configured and sample-valid flags are set |
| Successful mount | Presence-known, present and initialized flags are set |
| Failed mount | Only configured and sample-valid flags are set (`sd_flags = 0x41`); presence is unknown, not confirmed absent |
| Capacity | Valid only after a successful mount and nonzero sector-count query; `block_count` counts 512-byte sectors, not free space |
| Bus and speed | SPI (`bus_mode = 2`) and Standard (`speed_mode = 1`) after a successful mount; zero otherwise |
| Bus clock | The configured 10 MHz ceiling after a successful mount; zero otherwise, not a measured frequency |
| Filesystem | FatFs type: FAT12 `1`, FAT16 `2`, FAT32 `3`; zero when unavailable |
| Card identity (CID) | Unavailable through the current Zephyr disk API; CID-valid is clear and CID bytes are zero |
| USB mass-storage fields | Always zero; there is no MSC interface or handoff |

The mount error code is **only logged**, not retained in Report `10`. Hosts cannot distinguish a missing card,
bad wiring, an unsupported filesystem or another mount error from this report alone. Use the UART log for
diagnosis, and do not label every uninitialized sample "no card".

## Safety and ownership

- Only firmware owns the filesystem. No USB mass storage, host file API, or storage handoff exists.
- A failed mount returns an error rather than creating a new volume.
- The starter does not create files, run write/verify benchmarks, or attempt repair.
- FAT support includes filesystem read/write APIs for downstream product code; no write workload
  is performed by this application.
- Future filesystem users must serialize their operations, check every return value, close/sync files and
  arrange safe unmount before removal. Keep blocking storage work out of the management loop and application lock.
- There is no implemented power-loss recovery or sustained-recording guarantee.

## Validation limits

SD-card testing is intentionally deferred until hardware is connected. Successful compilation and
simulated absent-card UI do not qualify any card, breakout, FAT layout or sustained recording workload.
The pin allocation is proposed wiring, not electrically qualified hardware. Actual bus frequency,
mount compatibility and throughput remain unmeasured; see the
[qualification gaps](../validation/qualification-gaps.md).
