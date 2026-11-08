# SD Storage Reference

ESPForge uses an SD card over **native four-bit SDMMC, slot 0**, on the ESP32-S3-DevKitC-1 N16R8.
Zephyr's Espressif SDHC driver, SDMMC disk layer and FatFs are enabled in the default firmware.
This is the SD memory-card bus, not an SDIO peripheral/function API or a PIO-emulated bus.
The disk is `SD`, mounted at `/SD:` once during boot. This reference owns the SD pin allocation,
mount lifecycle, status reporting and data-safety contract. See the
[hardware guide](../guides/hardware.md#sd-card-sdmmc-wiring) for board selection and electrical precautions.

## Pin allocation

GPIO numbers are ESP32-S3 signals, not physical header positions. Verify the labels and schematic of your
exact board and breakout before connecting them.

| SDMMC function | ESP32-S3 pin | Breakout/card signal | Direction relative to ESP32-S3 |
| --- | --- | --- | --- |
| Clock | GPIO12 | CLK | Output |
| Command | GPIO11 | CMD | Bidirectional |
| Data bit 0 | GPIO13 | DAT0 | Bidirectional |
| Data bit 1 | GPIO14 | DAT1 | Bidirectional |
| Data bit 2 | GPIO15 | DAT2 | Bidirectional |
| Data bit 3 | GPIO10 | DAT3 | Bidirectional |
| Supply | 3V3 | 3.3 V supply input | Power |
| Ground | GND | GND | Common ground |

Use a 3.3 V socket/breakout exposing CLK, CMD and **all four data lines**. SPI-only modules exposing just
MOSI/MISO/CS/CLK are not suitable without access to DAT1 and DAT2. Directional SPI level shifters can also
prevent bidirectional native operation. Do not connect 5 V logic.
CMD and DAT0-DAT3 require suitable **external pull-ups to 3.3 V** (typically 10 kOhm; verify the socket/module
requirements and existing resistors). Do not add a pull-up to CLK. Pinctrl also requests internal command/data
pull-ups, but these do not replace electrical qualification. Keep all six signal wires short.

There is no allocated card-detect or power-control GPIO. GPIO10 is DAT3, **not a chip-select output**.
When migrating a card previously used in SPI mode, disconnect card power before starting native SDMMC:
a board reset alone does not necessarily reset the card's selected bus mode.

The board configuration enables native SDMMC slot 0 with explicit pin allocation, a four-bit bus
and a 25 MHz maximum frequency.
SPI2 and SPI3 are disabled. GPIO33-37 are occupied by octal PSRAM on N16R8.

Report `2` publishes storage GPIOs in CLK, CMD, DAT0, DAT1, DAT2, DAT3 order as
`12, 11, 13, 14, 15, 10`. The card-detect GPIO is `255` (unassigned).
If a downstream board changes the wiring, its hardware configuration and reported pin allocation MUST agree;
validate the new allocation before use.

## Driver and filesystem configuration

| Layer | Configuration |
| --- | --- |
| Native controller | `sdhc`, compatible `espressif,esp32-sdhc` |
| SD host slot | `sdhc0`, compatible `espressif,esp32-sdhc-slot`, four-bit bus |
| Disk layer | `zephyr,sdmmc-disk`, disk name `SD` |
| Filesystem | FatFs, mount point `/SD:` |
| Requested SDMMC ceiling | 25 MHz; not a measured runtime clock or throughput |

The default firmware enables GPIO/pinctrl, disk access, the SDMMC disk driver, `CONFIG_SDHC_ESP32`,
the filesystem API and FatFs. Both `CONFIG_FS_FATFS_MOUNT_MKFS` and `CONFIG_FS_FATFS_MKFS` are explicitly
disabled: the application cannot automatically format a failed mount or call FatFs mkfs through these options.

Prepare an existing FAT16/FAT32 volume on a computer and back up its data before use. exFAT is not enabled
in the default firmware. The report format reserves a value for exFAT; that does not imply filesystem support.

## Boot and mount lifecycle

1. Insert the card before powering or rebooting the board.
2. After boot settings, CPU clock application and telemetry initialization,
   storage initialization runs once, before Wi-Fi, BLE and USB initialization.
3. The filesystem is mounted at `/SD:`.
4. On success, it records the mounted state and FatFs filesystem type, then queries the disk sector count with
   the disk API. If the capacity query fails, the filesystem remains mounted but capacity
   is unavailable.
5. On failure, it logs `SD card mount failed: <error>` on the UART console and returns. Startup continues,
   so a failed mount does not prevent USB management or radio initialization.

Mount state, filesystem type and sector count are boot-time facts, not live card monitoring. There is no
retry, automatic remount, card-detect polling or removal detection. Reports continue publishing the cached
facts even if the card is subsequently removed. Do not insert or remove a card while powered/mounted.

## Status reporting

Report `10` carries the cached mount outcome, filesystem type and available capacity over USB HID and BLE.
The [USB HID specification](usb-hid.md#report-id-10-storage-status) owns field values, flags and validation.
A successful mount establishes presence at boot; a failed mount leaves presence unknown.
Capacity counts the whole volume in 512-byte sectors, not free space. The reported clock is the configured
ceiling, not a runtime measurement. CID and negotiated bus state are unavailable.

The mount error code is **only logged**, not retained in Report `10`. Hosts cannot distinguish a missing card,
bad wiring, an unsupported filesystem or another mount error from this report alone. Use the UART log for
diagnosis, and do not label every uninitialized sample "no card".

Update firmware and hosts together when migrating from SPI: current hosts require native SDMMC, and there is
no automatic SPI fallback. Power-cycle the card as described in the wiring instructions.

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
