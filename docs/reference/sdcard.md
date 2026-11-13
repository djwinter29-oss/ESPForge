# SD Storage Reference

ESPForge uses an SD card over **native four-bit SDMMC, slot 0**, on the ESP32-S3-DevKitC-1 N16R8.
Zephyr's Espressif SDHC driver, SDMMC disk layer and FatFs are enabled in the default firmware.
This is the SD memory-card bus, not an SDIO peripheral/function API or a PIO-emulated bus.
The disk is `SD`, mounted at `/SD:` for firmware access or explicitly handed to native USB mass storage.
This reference owns the SD pin allocation,
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
| Card detect | GPIO8 | Inserted-high, 3.3 V detection signal | Input with internal pull-down |
| Supply | 3V3 | 3.3 V supply input | Power |
| Ground | GND | GND | Common ground |

Use a 3.3 V socket/breakout exposing CLK, CMD and **all four data lines**. SPI-only modules exposing just
MOSI/MISO/CS/CLK are not suitable without access to DAT1 and DAT2. Directional SPI level shifters can also
prevent bidirectional native operation. Do not connect 5 V logic.
CMD and DAT0-DAT3 require suitable **external pull-ups to 3.3 V** (typically 10 kOhm; verify the socket/module
requirements and existing resistors). Do not add a pull-up to CLK. Pinctrl also requests internal command/data
pull-ups, but these do not replace electrical qualification. Keep all six signal wires short.

GPIO8 is **active-high**: 3.3 V means inserted, low means absent. Connect a suitable insertion switch between
GPIO8 and 3V3, closing when a card is inserted; the internal pull-down holds an open/unwired input low.
A socket whose detect contact instead shorts to ground on insertion needs polarity adaptation, not direct
connection with this configuration. Never apply 5 V. Detection wiring is required for mounting: an unwired
GPIO8 reports no card even when the SDMMC signals are connected. There is no power-control GPIO.
GPIO10 is DAT3, **not a chip-select output**.
When migrating a card previously used in SPI mode, disconnect card power before starting native SDMMC:
a board reset alone does not necessarily reset the card's selected bus mode.

The board configuration enables native SDMMC slot 0 with explicit pin allocation, a four-bit bus
and a 25 MHz maximum frequency.
SPI2 and SPI3 are disabled. GPIO33-37 are occupied by octal PSRAM on N16R8.

Report `2` publishes storage GPIOs in CLK, CMD, DAT0, DAT1, DAT2, DAT3 order as
`12, 11, 13, 14, 15, 10`. The card-detect GPIO is `8`.
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

## Boot and runtime mount lifecycle

Storage starts after boot settings, CPU clock application and telemetry initialization, before the transports.
An inserted boot-time card is mounted immediately. Startup continues after a logged mount failure.

A separate worker polls card detection nominally every 50 ms and requires 100 ms stable insertion. Insertion, including
insertion after startup, mounts the existing FAT volume. Failed initialization/mount attempts retry every
2 seconds while a card is detected. Successful initialization also requires a nonzero sector count and
512-byte sectors; failed geometry validation releases the medium rather than advertising usable storage.

An observed removal, even shorter than the debounce period, invalidates current card facts and revokes USB ownership.
Absence is confirmed after 100 ms stability; raw absence already rejects USB I/O before the worker handles it.
Replacement mounts for firmware and **never automatically re-exports** to USB.
Card-detect read errors are logged, invalidate presence and media facts, and revoke USB access; recovery requires
stable detection before remounting. No operation formats or repairs a card.

Unmount failure prevents granting another owner; later initialization retries cleanup. The Zephyr forced disk
deinitialization API resets disk references but does not propagate the driver's deinitialization result, so
cleanup is not a verified hardware reset. Power-cycle a card if it cannot be reinitialized.

## USB drive handoff

The dashboard exposes **Enable USB drive** when this firmware advertises MSC and a FAT card is initialized.
Native USB presents HID management plus a removable MSC LUN; it has no CDC console.
Firmware unmounts FAT before exporting raw 512-byte sectors. The native USB device briefly disconnects and
reconnects on export so an OS-ejected LUN can be loaded again.

Before **Return to firmware**, safely eject the drive in the operating system, then explicitly confirm eject
in the dashboard. The native Zephyr class does not expose a public OS-eject notification; the confirmation is
the user's assertion, not firmware verification that the host has flushed every cache. Return revokes USB
access before remounting FAT. No unsafe force-return action exists.

USB opcode `3` acknowledges admission, not completed media work. The worker defers handoff long enough to let
the host read its result; Report `10` reports transition and failure. Never automatically resend an uncertain
command. See the [USB control contract](usb-hid.md#msc-command-rules) for exact flags and result semantics.

## Status reporting

Report `10` carries live detection/ownership snapshots, mount outcome, filesystem type and available capacity
over USB HID and BLE.
The [USB HID specification](usb-hid.md#report-id-10-storage-status) owns field values, flags and validation.
Detection distinguishes confirmed absence from an inserted card whose mount failed.
During media work or USB ownership, the firmware SD sample is invalid and current SD fields are cleared.
Capacity counts the whole volume in 512-byte sectors, not free space. The reported clock is the configured
ceiling, not a runtime measurement. CID and negotiated bus state are unavailable.

The mount error code is **only logged**, not retained in Report `10`. Hosts can distinguish detected absence,
but cannot distinguish bad SDMMC wiring, an unsupported filesystem or another mount error from this report alone.
Use the UART log for
diagnosis, and do not label every uninitialized sample "no card".

Update firmware and hosts together when migrating from SPI: current hosts require native SDMMC, and there is
no automatic SPI fallback. Power-cycle the card as described in the wiring instructions.

## Optional storage benchmark

The dashboards offer a USB-controlled benchmark when capability bit 5 is advertised. It is disabled by default in
CMake; the firmware build wrapper currently enables it. See [build configuration](../development/firmware.md#zephyr-target-build).
It never runs at boot or on insertion. Authenticated BLE can read its progress but cannot start or cancel it.

Back up the card before confirming a run. Choose 1–1024 MiB (dashboard default 32 MiB). The worker writes a deterministic
pattern to `SD:/EFTEST.BIN`, closes it, reads and verifies it, then removes the file. An existing file of that name is
never overwritten or removed. The volume must already be mounted for firmware; no formatting or repair occurs.
Free-space checks reserve the requested size plus one 32 KiB chunk. The benchmark uses a 32 KiB internal-RAM buffer.

The command acknowledges **queued admission**, not successful filesystem preflight or a passing benchmark.
File-existence and free-space checks run asynchronously on the storage worker. Read Report `11` for phases,
progress, measured throughput and terminal result; the [USB contract](usb-hid.md#report-id-11-storage-benchmark-status)
defines its wire layout. Firmware storage samples are invalid during the run; settings, reboot and MSC handoff are
blocked. Management remains responsive while the worker performs storage I/O.

Write timing includes pattern generation, file allocation, writes and final close/sync. Read timing includes reads,
verification and final close. Throughput is completed bytes divided by elapsed time, not a bus-frequency estimate.
A zero elapsed time produces unavailable throughput (`--`), not a fabricated rate.

Cancel requests stop at the next cooperative checkpoint and attempt cleanup. Short/failed I/O is never replayed.
Observed removal stops further access to that media, including close/unlink; replacement media is not used for cleanup.
A failed close or cleanup can leave `EFTEST.BIN` behind. Inspect it on a computer after safely releasing ownership;
remove it manually before starting another run. Unplugging or power loss during writes can still corrupt the volume.
The benchmark causes real card writes and wear; it provides neither power-loss atomicity nor sustained-workload qualification.

## Safety and ownership

- Firmware and USB have exclusive ownership; they never mount/access the same medium concurrently.
- Reboot and settings-save are Busy while the storage worker is active or USB owns the medium.
- Bluetooth mirrors storage/configuration reports but cannot change MSC ownership.
- Physical removal during reads/writes can interrupt I/O and corrupt data. Detection does not prevent unplugging,
  make writes atomic, or provide power-loss recovery. Back up data and safely eject before returning USB ownership.
- A failed mount returns an error rather than creating a new volume.
- Only an explicitly confirmed optional benchmark creates a temporary file; no automatic write workload or repair runs.
- Downstream filesystem users must participate in ownership serialization, check every return value and close/sync
  files before handoff. Keep blocking storage work out of the management loop and application lock.
- There is no implemented power-loss recovery or sustained-recording guarantee.

## Validation limits

SD-card testing is intentionally deferred until hardware is connected. Successful compilation and
simulated absent-card UI do not qualify any card, breakout, FAT layout or sustained recording workload.
The pin allocation is proposed wiring, not electrically qualified hardware. Actual bus frequency,
mount compatibility and throughput remain unmeasured; see the
[qualification gaps](../validation/qualification-gaps.md).
