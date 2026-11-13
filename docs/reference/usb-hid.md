# USB HID Specification

## Scope and Conventions

This document is the project's USB HID specification for firmware and clients. It defines device discovery,
report types and byte layouts, control requests and results, wireless staging, and client validation.
The [Bluetooth LE specification](bluetooth.md) defines the separate BLE transport, which reuses the report
payloads but has its own control envelope and authentication.

The **device** is the board providing the HID interface; the **host** is the client reading reports and submitting
commands. All sizes and offsets are in bytes. Payload sizes exclude the report ID. Multibyte integers are
little-endian unless stated otherwise; signed integers use two's complement. SSIDs and Control keys are raw
bytes, not NUL-terminated or hexadecimal text on the wire.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described
in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

[Boot settings](settings.md) defines credential persistence and flash safety;
[SD storage](sdcard.md) defines mounting and data safety.

References to Zephyr and host libraries describe the current implementation, not additional
wire fields. Software tests do not establish hardware qualification; see [Design Validation](#design-validation).

## USB Interface and Discovery

The device exposes one vendor-defined HID interface with no boot protocol, plus native USB mass storage.
There is no CDC ACM interface. Hosts identify HID by its usage collection, not a fixed composite interface number.

| Item | Value |
| --- | --- |
| Development VID:PID | `0xCAFE:0x4021`; not a production product identity |
| HID usage page | `0xFF00` |
| HID usage | `0x01` |
| Manufacturer string | `djwinter29` |
| Product string | `ESPForge` |
| Serial string | Report `1` UID as 16 uppercase hexadecimal digits, in byte order |

Management uses the board's native **USB** connector. The **UART** connector is for a diagnostic shell/log output and
ROM flashing; it has no HID management protocol. HID carries no CLI text, file data or SD block data.

Hosts MUST read Feature `1` before interpreting other reports or enabling commands. USB descriptors help find
the interface but do not replace validation of its product ID, report version, lengths and fields.

## Report ID Allocation

Report ID `0` is unused. Unassigned IDs have no payload and require no padding.

| IDs | Role | Assignments |
| --- | --- | --- |
| `1`-`9` | Device information and telemetry | `1` Identity; `2` Board Configuration; `3` Telemetry |
| `10`-`19` | Application status | `10` Storage; `11` optional benchmark; `12` Wireless |
| `20`-`29` | Device and application control | `20` Control Command & Result |
| `30`-`255` | Expansion | Unassigned |

Report ranges group responsibilities; they are not separate usage pages or mandatory dashboard tabs.
The descriptor defines each exposed report's type and length.

## Ownership

| Function | Report | Contract |
| --- | --- | --- |
| Identity, firmware, capabilities and SRAM accounting | Feature `1` | Read-only; stable for one boot |
| Stored next-boot settings and board facts | Feature `2` | Read-only; not measured runtime settings |
| Board measurements | Input `3` | Periodic telemetry and current-snapshot GET |
| Storage facts | Input `10` | Periodic detection, mount and USB ownership snapshot |
| Wireless link, test, scan and staging | Feature `12` | Read-only snapshot |
| Reboot, settings save and wireless operations | Feature `20` | SET submits a command; GET returns the latest USB result |

Read-only status MUST NOT perform an action. GET MUST NOT repeat an operation, consume a result or clear it.
A control result acknowledges validation, completion or admission; Feature `12` owns subsequent Wi-Fi test
and scan state. MSC handoff and optional benchmarking use USB-only commands.

## Report IDs

| Report ID | Name | Type | Direction | Payload |
| --- | --- | --- | --- | ---: |
| `1` | Device Identity & Capabilities | Feature | Host reads | 26 |
| `2` | Board Configuration | Feature | Host reads | 17 |
| `3` | Board Telemetry | Input | Device publishes / host reads | 22 |
| `10` | Storage Status | Input | Device publishes / host reads | 34 |
| `12` | Wireless Status | Feature | Host reads | 48 |
| `20` | Control Command & Result | Feature | Host writes/reads | 68 |

### Wire Framing

On the USB HID wire, each report begins with its nonzero report ID. In the tables below, offset `0` is the first
payload byte after that ID. HIDAPI buffers include the ID at index `0`; WebHID supplies the ID separately and
exposes only the payload. Other adapters MUST follow their library's documented framing and normalize before
decoding.

Some APIs add framing or fixed-size padding. Hosts MUST remove only framing documented by that API, never a
payload byte based solely on its value, and MUST validate the exact normalized payload length.
Feature `20` uses a 69-byte HIDAPI buffer; Feature `12` uses 49 bytes. These are control transfers, which can
span multiple 64-byte packets; they do not require oversized interrupt endpoints.

All current report layouts use version `1`, independently of firmware semantic version.

### Connection and Read Flow

1. Read Feature `1` and validate product, layout, length, capabilities and SRAM accounting.
2. Read Feature `2` for stored settings, reset cause and configured GPIOs.
3. Monitor Input reports `3` and `10`, tracking freshness separately.
4. Read and poll Feature `12` when wireless capability bit 7 is set.
5. Submit operations through Feature `20` and read the matching result. Monitor Feature `12` for an admitted
   Wi-Fi test or scan; control completion does not mean association or scanning has finished.

Report `11` is not exposed and MUST NOT be requested or subscribed to.

## Report ID 1: Device Identity & Capabilities

Read after connection. Identity and capabilities remain stable for that boot.

| Offset | Size | Field | Meaning |
| -----: | ---: | ----- | ------- |
| 0 | 1 | `version` | Layout version, `1` |
| 1 | 2 | `product_id` | Product-family ID, `0x0003` for ESPForge |
| 3 | 8 | `device_uid` | Opaque identity bytes in USB serial-string order |
| 11 | 1 | `firmware_major` | Firmware semantic-version major |
| 12 | 1 | `firmware_minor` | Firmware semantic-version minor |
| 13 | 1 | `firmware_patch` | Firmware semantic-version patch |
| 14 | 1 | `mcu` | `3` ESP32-S3; other values unassigned in this project |
| 15 | 1 | `board_model` | `0` unspecified; `1` ESP32-S3-DevKitC-1 |
| 16 | 1 | `capabilities_extension` | Capability bits 8-15; zero in the current device |
| 17 | 1 | `capabilities` | Static capabilities and selected storage transport |
| 18 | 4 | `ram_total_bytes` | Total internal SRAM, not free memory or PSRAM |
| 22 | 4 | `ram_reserved_bytes` | Statically linked/reserved internal SRAM |
| **Total** | **26** | | **27 bytes including report ID** |

The discovery prefix is three bytes: version at offset `0`, product ID at offsets `1`-`2`.
Hosts MUST validate the descriptor-declared length and prefix, then the full payload before enabling commands.
An unsupported version is an explicit layout error. An unknown product MUST NOT enable this project's commands.
Product IDs identify families, not releases, MCU types or individual devices.

Display the UID as **Serial / UID**, two uppercase hex characters per byte in order. It is not an integer or a
host-generated identifier. The current board uses its six-byte eFuse base MAC followed by two zero bytes;
clients MUST preserve the eight reported bytes for identity matching and BLE proofs.
Unknown MCU or board-model values MAY be retained for diagnostics, but MUST NOT be guessed or corrected.
Board model `1` requires MCU `3`; model `0` makes no board claim.

### Product IDs and Capabilities

| Product ID | Meaning |
| ---------: | ------- |
| `0x0000` | Reserved / unspecified |
| `0x0003` | ESPForge |
| Other | Not a supported project identity |

| Capability bit | Meaning | Current device |
| ---: | --- | --- |
| 0 | Identification LED | Clear |
| 1 | Confirmed standalone reboot | Set |
| 2 | Persistent boot-settings save | Set |
| 3 | Legacy SPI storage transport | Clear |
| 4 | Native SDMMC storage transport | Set |
| 5 | Storage benchmark | Set only when built with the optional feature |
| 6 | Forced settings save | Clear |
| 7 | Wireless capability | Set |

The capability byte is `0x96`, or `0xB6` with benchmarking enabled.
Extension bits are unassigned: devices MUST transmit zero, and hosts
MUST NOT assign meaning to unknown extension bits. Firmware version is diagnostic information, not a substitute
for capabilities.

Bits 1 and 2 identify reboot and settings-save support. Bit 4 selects the six-signal native SDMMC layout of Report `2`;
it does **not** imply USB mass-storage support. Report `2` board flag bit 6 advertises MSC ownership control.
LED and forced-save support are absent: opcode `1` and opcode `5` flag bit 0 return
Unsupported/error `4`. When bit 5 is clear, opcode `4` is also unsupported and Report `11` is unavailable.
Wireless capability does not imply that Wi-Fi is connected
or that BLE has started.

### Board Models

| Board model | MCU | Meaning |
| ----------: | --- | ------- |
| `0` | Reported separately | No specific board identity claimed |
| `1` | `3` ESP32-S3 | Configured ESP32-S3-DevKitC-1 target |
| `2`-`255` | Unassigned | Reserved |

The board model is the configured build target, not automatic hardware detection.

### Firmware RAM Reservation

Display **Firmware RAM reserved / total**, in KiB and optionally as a percentage. Hosts MUST reject a zero total
or a reservation greater than total. This is build accounting, not free heap, stack high-water use or runtime
memory pressure.

The current board reports 524288 bytes of internal SRAM. Reservation covers statically linked RAM,
including the reserved Zephyr heap pool and thread stacks. PSRAM is separate and
is not represented by these fields. Count each reservation once; do not infer live allocations.

## Report ID 2: Board Configuration

Read-only; SET is rejected. Read after connection and again after reboot or re-enumeration.
Settings describe the next boot, while GPIOs describe configured board facts.

| Offset | Size | Field | Meaning |
| -----: | ---: | ----- | ------- |
| 0 | 1 | `version` | Layout version, `1` |
| 1 | 2 | `stored_sysclk_profile` | Stored clock in MHz: `0` build default, `80`, `160` or `240` |
| 3 | 1 | `stored_sdcard_profile` | `0` Standard; other values unsupported |
| 4 | 1 | `monitor_uart_index` | Hardware UART index; `255` unavailable |
| 5 | 1 | `monitor_uart_tx_gpio` | TX GPIO; `255` unassigned |
| 6 | 1 | `monitor_uart_rx_gpio` | RX GPIO; `255` unassigned |
| 7 | 6 | `storage_gpios` | Native SDMMC order: CLK, CMD, DAT0, DAT1, DAT2, DAT3 |
| 13 | 1 | `board_flags` | Flags below |
| 14 | 1 | `reset_cause` | Reset enum below |
| 15 | 1 | `led_gpio` | `255`; no LED control |
| 16 | 1 | `card_detect_gpio` | `8`, active-high card-detect input; `255` on older firmware without detection |
| **Total** | **17** | | **18 bytes including report ID** |

| Board flag bit | Meaning | Current device |
| ---: | --- | --- |
| 0 | Card detect configured | Set |
| 1 | Direct GPIO LED configured | Clear |
| 2 | Monitor UART enabled | Set |
| 3 | Wi-Fi enabled for next boot | Saved switch |
| 4 | BLE enabled for next boot | Saved switch |
| 5 | Reserved TCP CLI switch | Clear |
| 6 | Native USB MSC with explicit ownership handoff | Set |
| 7 | Reserved | Zero |

The current board reports UART0 TX GPIO43 / RX GPIO44 and SDMMC pins `12, 11, 13, 14, 15, 10`.
GPIO values are signal numbers, not physical header positions. See [SD pin allocation](sdcard.md#pin-allocation).
Assigned GPIOs MUST be valid for the reported MCU/board. An enabled UART requires its index and both pins;
TX/RX MUST both be assigned or both unavailable. Native four-bit SDMMC requires all six storage pins assigned.

Wi-Fi and BLE switches default on and represent next-boot policy, not current link state.
Hosts MUST reject unsupported stored profiles and inconsistent flags/pins.
Report `3` carries the running CPU clock; Report `10` carries storage status. `0` selects the build clock,
currently 240 MHz. The SD profile does not promise a clock rate or measured performance.

A successful opcode `5` returns verified saved settings and schedules reboot. During the 1000 ms grace period,
USB remains available for the result read. Hosts MUST NOT send a second reboot command or require a configuration
read before disconnect; reread Feature `2` after reconnection.

Reset values: `0` Unknown, `1` Power-on, `2` watchdog, `3` software-requested, `4` reserved recorded-fault recovery,
`5`-`255` unassigned. Hosts MUST NOT infer a reset cause from missing evidence.
The current implementation maps Zephyr hardware reset flags to `1`, `2` or `3`, otherwise `0`.

## Report ID 3: Board Telemetry

Published nominally every 250 ms while HID is ready. Input GET returns a current snapshot with sequence `0`.
Publication sequences wrap modulo 256. The current implementation allocates a sequence when submitting a report;
failed submissions can therefore leave gaps. Sequences are not delivery acknowledgements.

| Offset | Size | Field | Meaning |
| -----: | ---: | ----- | ------- |
| 0 | 1 | `version` | Layout version, `1` |
| 1 | 1 | `led_flags` | Zero; no identification output |
| 2 | 2 | `temperature_centidegrees_celsius` | Signed die-temperature estimate, hundredths of a degree Celsius |
| 4 | 8 | `uptime_ms` | Monotonic milliseconds since boot |
| 12 | 2 | `core0_service_load_basis_points` | Core 0 load; 10000 = 100%; `65535` unavailable |
| 14 | 2 | `core1_service_load_basis_points` | `65535`; second core not running this application |
| 16 | 4 | `system_clock_hz` | Current CPU clock, nonzero |
| 20 | 1 | `sequence` | Publication sequence, modulo 256 |
| 21 | 1 | `espforge_flags` | USB and sensor-valid flags below |
| **Total** | **22** | | **23 bytes including report ID** |

`espforge_flags`: bit 0 USB configured; bit 1 reserved CDC-open indication, always clear; bit 2 temperature valid;
bit 3 reserved LED-available indication, always clear; bits 4-7 zero.
USB configured means the host configured the device, not storage ownership.
When temperature-valid is clear, the temperature field MUST be zero and MUST NOT be displayed as a measurement.

Core 0 load is derived from idle-thread runtime over windows of at least 250 ms. The first sample establishes a
baseline and is unavailable; shorter requests reuse the last completed window.
This is service load, not calibrated remaining capacity. Valid values are `0`-`10000` inclusive or `65535`.
Hosts MUST reject `10001`-`65534`, not clamp them, and MUST display unavailable values as unavailable, not zero.
The reported clock is the running clock, not a requested setting. Die temperature is not calibrated ambient
temperature.

## Report ID 10: Storage Status

Published nominally every 500 ms while HID is ready. Input GET returns a snapshot with sequence `0` and does not
advance the publication sequence. Publication sequences have the same gap/wrap behavior as Report `3`.
It reflects the storage worker's detection, mount and ownership state; it performs no disk I/O in the HID callback.

| Offset | Size | Field | Meaning |
| -----: | ---: | ----- | ------- |
| 0 | 1 | `version` | Layout version, `1` |
| 1 | 1 | `sequence` | Publication sequence |
| 2 | 1 | `sd_flags` | Flags below |
| 3 | 1 | `component_type` | `0` unavailable; `1` SD card after successful mount |
| 4 | 1 | `bus_mode` | `0` unavailable; `3` native SDMMC after successful mount |
| 5 | 4 | `bus_clock_hz` | Configured SDMMC ceiling after successful mount; zero otherwise |
| 9 | 1 | `speed_mode` | `0` unavailable; `1` Standard after successful mount |
| 10 | 4 | `block_count` | 512-byte sectors; zero unless capacity is valid |
| 14 | 16 | `cid` | Zero; CID unavailable through the current disk API |
| 30 | 1 | `filesystem_format` | Firmware mount format: enum below; current firmware clears it when unavailable |
| 31 | 1 | `msc_enabled` | Boolean: USB currently owns the medium |
| 32 | 1 | `msc_transition_pending` | Boolean: ownership request queued or storage worker busy |
| 33 | 1 | `msc_request_rejected` | Boolean: last attempted handoff failed/cancelled; cleared by a successful handoff |
| **Total** | **34** | | **35 bytes including report ID** |

| SD flag bit | Meaning |
| ---: | --- |
| 0 | Storage configured |
| 1 | Presence known |
| 2 | Present |
| 3 | Initialized |
| 4 | CID valid; always clear in the current device |
| 5 | Capacity valid |
| 6 | Storage sample valid |
| 7 | Reserved, zero |

An idle absent card reports `sd_flags = 0x43`; an inserted card whose mount failed reports `0x47`.
Both have zero component/bus/clock/speed/capacity/CID fields and unknown filesystem.
Detection errors invalidate presence rather than claiming absence. Mount errors are logged to UART.
During USB ownership or worker activity, sample-valid is clear and only the configured SD flag may remain set.
Component/bus/clock/speed/capacity/CID fields MUST be zero when sample-valid is clear.

A successful mount sets bits 0-3 and 6, component type `1`, bus mode `3`, speed mode `1`, and the configured
25 MHz ceiling. This clock is not a measured runtime frequency. Capacity-valid is set only when the sector-count
query returns a nonzero count; geometry validation failure releases the medium and reports initialization failure.
Capacity is `block_count * 512` bytes, not free filesystem space.

Hosts MUST require initialized status for valid capacity, zero capacity when invalid, and zero CID while
CID-valid is clear. Reserved flags, unsupported bus/speed values and nonboolean MSC bytes are invalid.
USB ownership or a pending transition MUST NOT coexist with a valid firmware SD sample.
Detection is debounced; a fresh report is not a guarantee against subsequent physical unplugging.

Filesystem enum: `0` Unknown, `1` FAT12, `2` FAT16, `3` FAT32, `4` reserved exFAT encoding.
The default firmware does not enable exFAT. A format enum does not imply support for creating or mounting that
format. There is no automatic formatting, repair or management file-transfer API.
See [SD storage](sdcard.md) for mount lifecycle and data-safety rules.

## Report ID 11: Storage Benchmark Status

When capability bit 5 is set, Input `11` publishes the retained benchmark snapshot nominally every 500 ms.
Its payload is 32 bytes (33 including USB report ID). When disabled it is absent from the USB descriptor;
the BLE `000b` mirror reads empty. When enabled, authenticated BLE reads the same payload without the ID.

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 1 | Layout version `1` |
| 1 | 1 | Sequence |
| 2 | 1 | State |
| 3 | 1 | Flags: bit 0 temporary file may remain, bit 1 volume mounted; others zero |
| 4 | 4 | Target bytes |
| 8 | 4 | Written bytes |
| 12 | 4 | Read/verified bytes |
| 16 | 4 | Write elapsed milliseconds |
| 20 | 4 | Read elapsed milliseconds |
| 24 | 4 | Mismatched bytes |
| 28 | 1 | Execution error |
| 29 | 1 | FatFs result |
| 30 | 2 | Zero padding |

Multibyte fields are little-endian. States: `0` Idle, `1` Queued, `2` Preparing, `3` Writing, `4` Reading,
`5` Cleanup, `6` Passed, `7` Failed, `8` Cancelled. States 1–5 are active.
Errors: `0` none, `1` busy, `2` USB owner, `3` size, `4` card unavailable, `5` insufficient space,
`6` existing temporary file, `7` I/O, `8` verification, `9` cleanup, `10` mount.
Error and FatFs result are zero outside Failed; Failed requires a nonzero error.
FatFs result is 0–19, retained for I/O/cleanup failures when available.

Target is zero or an integral MiB, at most 1 GiB; read ≤ written ≤ target and mismatches ≤ read.
Idle counters are zero; Queued has zero counters except target. Passed requires a nonzero target, complete
write/read, zero mismatches and no remaining-file flag. Hosts must reject contradictory snapshots.
Progress is `(written + read) * 50 / target` (zero for zero target).
Rates are bytes multiplied by 1000 divided by the corresponding elapsed milliseconds; zero elapsed means unavailable.
See [benchmark safety and timing](sdcard.md#optional-storage-benchmark) for cleanup and measurement boundaries.

## Report ID 20: Control Command & Result

Feature `20` carries reboot, MSC ownership, settings-save, credential-staging, Wi-Fi test and scan commands.
SET submits one typed operation; GET returns the latest USB result. Both payloads are exactly 68 bytes
(69 including the report ID). BLE uses a separate [control form](bluetooth.md#control-characteristic).

### SET Request

| Offset | Size | Field | Meaning |
| -----: | ---: | ----- | ------- |
| 0 | 1 | `version` | Layout version, `1` |
| 1 | 1 | `transaction_id` | Host-chosen nonzero ID, echoed by GET |
| 2 | 1 | `opcode` | Assigned operation below |
| 3 | 1 | `flags` | Opcode-specific; unspecified bits zero |
| 4 | 64 | `arguments` | Opcode-specific; unused bytes zero |
| **Total** | **68** | | **69 bytes including report ID** |

Argument offsets in the following table are relative to the 64-byte `arguments` field.

| Opcode | Operation | Flags | Arguments / support |
| ---: | --- | --- | --- |
| `1` | Reserved LED control | - | Unsupported/error `4` |
| `2` | Reboot | Bit 0 confirmation required; other bits zero | All zero |
| `3` | USB MSC ownership | Enable: `0`; return: bit 0 eject confirmation required | Byte 0: `1` USB, `0` firmware; bytes 1-63 zero |
| `4` | Optional storage benchmark | `0` | Byte 0 action: `1` start, `0` cancel; bytes 1-4 LE32 size MiB; bytes 5-63 zero |
| `5` | Save settings and reboot | Bit 1 commits staged wireless values; bit 0 forced save is unsupported | Bytes 0-1 clock MHz; byte 2 SD profile `0`; byte 3 switches, bit 0 Wi-Fi / bit 1 BLE; bytes 4-63 zero |
| `6` | Stage Wi-Fi SSID | `0` | Byte 0 length; bytes 1-32 raw SSID, length 1-32; remaining bytes zero. Length `0` clears network/password |
| `7` | Stage Wi-Fi password | `0` | Byte 0 length; bytes 1-63 printable ASCII; remaining bytes zero. Length `0` selects open network, otherwise 8-63 |
| `8` | Stage Control key | `0` | Byte 0 length; bytes 1-32 raw key, length exactly 32; remaining bytes zero. Length `0` clears key |
| `9` | Test Wi-Fi | `0` | All zero |
| `10` | Cancel test and discard staging | `0` | All zero |
| `11` | Start Wi-Fi scan | `0` | All zero |
| `12` | Read Wi-Fi scan entry | `0` | Byte 0 index; bytes 1-2 scan generation; bytes 3-63 zero |
| `13` | Reserved TCP CLI proof | - | Unsupported/error `4` |
| Other | Unassigned | - | Unsupported/error `7` |

Reboot requires explicit confirmation and discards staged wireless values and any expiry marker.
Hosts SHOULD warn when Feature `12` indicates staging or expiry.
Opcode `5` accepts clocks `0`, `80`, `160`, `240` MHz, SD profile `0`, and only the Wi-Fi/BLE switch bits.
Switch bit 2 is invalid. Forced-save bit 0 returns Unsupported/error `4` before other save-argument validation.
A 64-character hexadecimal raw Wi-Fi PSK is not supported.

### MSC Command Rules

Report `2` flag bit 6 advertises this workflow; Report `1` capabilities are unchanged.
Older firmware with bit 6 clear and card-detect GPIO `255` remains readable, but hosts MUST hide MSC controls.
Opcode `3` is USB-only; BLE returns Unsupported/error `4`.

Enable requires an initialized card with valid geometry. Return requires the user's assertion that the operating
system safely ejected the drive; firmware cannot verify native-class OS eject. Action `2` and other force-return
forms are invalid. Extra flag/argument bits are rejected.

Completed/error `0`, with zero result data, means the ownership request was admitted (or the requested owner was
already active). It does not prove media work succeeded. Report `10` then shows a pending transition and the
settled ownership or rejection. The request is cancelled if the card changes before execution.
Export briefly reconnects native USB; the same UID must be selected after reconnection.
Handoff is deferred about one second, shortened to about 50 ms after the exact Feature `20` result is read.
An uncertain request MUST NOT be replayed; reconcile its result explicitly and obtain fresh storage status.

Busy/error `5`, detail `0`, means storage is already busy. Invalid/error `3` means no usable card is available.
Other backend admission failures return Failed/error `6`. See [SD ownership](sdcard.md#usb-drive-handoff).

### Benchmark Command Rules

Opcode `4` is USB-only and requires capability bit 5; otherwise it returns Unsupported/error `4`.
Start action `1` requires 1–1024 MiB. Cancel action `0` requires zero size; idle cancellation is a no-op.
Flags and unused arguments must be zero. Bad layout returns Invalid/malformed; invalid size returns
Invalid/argument, detail `3`.

Completed with zero data means start/cancel admission, not a passing run. Busy details `1` and `2` identify
worker conflict and USB ownership; Failed/detail `4` identifies an unavailable card. File-existence and
free-space preflight happen on the worker after admission and can produce Failed Report `11`.
Never replay uncertain requests; explicitly reconcile Feature `20`, then obtain fresh Reports `10` and `11`.
See [benchmark safety](sdcard.md#optional-storage-benchmark) before confirming writes.

### Wireless Command Rules

Credential staging, test and scan are USB-only; BLE has its restricted control form.
Wireless capability does not imply that either radio is currently enabled or connected.
The separate [diagnostic TCP shell](../guides/console.md) has no HID switch or USB proof-signing operation.

Opcodes `6`-`8` stage values in RAM; they do not write flash or reboot.
Opcode `5` flag bit 1 commits staged wireless values with board settings in one verified flash save.
If unexpired staged values exist and bit 1 is clear, saving is Invalid/error `3`, detail `27`.
If bit 1 is set after expiry, saving is Invalid with detail `20`; if no staging or expiry marker exists, detail `21`.
With only an expiry marker and bit 1 clear, a successful settings-only save clears the marker and schedules reboot.
Refresh Features `2` and `12` after reconnection.

Staged secrets are wiped after commit, by opcode `10`, on reboot or after their ten-minute lifetime.
Expiry retains only a non-secret marker until the next staging command, opcode `10`, a successful save or reboot.
Staging an empty SSID also stages an empty password.

Testing MUST NOT combine a new SSID with the saved password. If a staged SSID differs from the saved SSID,
a password MUST also be staged; zero length explicitly selects an open network.
Forgetting the network with an empty SSID is exempt. The saved password may be used only when the target SSID
matches byte-for-byte; a password-only update uses the saved SSID.
Testing an unchanged saved pair with no staged Wi-Fi candidate is Invalid with detail `21`.
Staging during a test is Busy with detail `25`; staging during a scan is permitted and does not affect the scan.
Restaging either Wi-Fi field invalidates the successful test for that pair.

Staged values expire ten minutes after the last staging command.
A successful test restarts the ten-minute save window. Expiry wipes secrets, invalidates test validity,
disconnects an active candidate link and returns to saved-network policy.
Opcode `5` with commit and opcode `9` report expiry with detail `20`.
Saving without testing is permitted.

Opcode `10` cancels a test, discards all staging and expiry, and returns to saved-network policy.
During a scan it discards staging but leaves the scan running.
Opcode `11` completes when the scan is admitted, not when finished.
An admitted scan clears the previous list, advances its nonzero 16-bit generation and retains at most the
18 strongest unique SSIDs. A scan that does not finish within ten seconds fails.
Scan during a test or another scan, test during scan, and wireless commit during test/scan return Busy
with detail `25` or `26` as applicable.

Opcode `12` requires the index and generation from Feature `12`.
It returns Busy/detail `26` during scanning, Invalid/detail `22` unless the requested generation is complete,
and Invalid/detail `23` for an out-of-range entry.
Scan security bits are privacy bit 0, WPA bit 1 and RSN bit 2.
RSN identifies a WPA2/WPA3-family advertisement, not verified WPA3 support; enterprise modes are not distinguished.
Scan results contain no credentials.

Scans and tests may run with the Wi-Fi boot switch off; that switch controls the automatic saved-network join.
The current device supports open and WPA2-Personal networks, not WPA3-SAE.

### GET Result

GET returns the latest operation without replaying it or consuming the result.
Unused bytes MUST be zero.

| Offset | Size | Field | Meaning |
| -----: | ---: | ----- | ------- |
| 0 | 1 | `version` | Layout version, `1` |
| 1 | 1 | `transaction_id` | Latest admitted request ID; zero before any request |
| 2 | 1 | `opcode` | Latest request opcode; zero before any request |
| 3 | 1 | `status` | State enum below |
| 4 | 1 | `error_reason` | Error enum below |
| 5 | 63 | `result_data` | Opcode-specific result or rejection detail |
| **Total** | **68** | | **69 bytes including report ID** |

For Invalid, Busy or Failed, `result_data[0]` is the detail, zero if none; bytes 1-62 are zero.
For Unsupported, all result data is zero.

Successful opcode `5`: bytes 0-1 verified clock MHz, byte 2 SD profile `0`, byte 3 saved Wi-Fi/BLE mask,
byte 4 commit mask (bit 0 SSID, bit 1 password, bit 2 Control key), bytes 5-62 zero.
Commit mask is zero for settings-only saves.

Successful opcode `12`: bytes 0-1 scan generation, byte 2 index, byte 3 SSID length, bytes 4-35 zero-padded SSID,
byte 36 signed RSSI, byte 37 security bits, bytes 38-62 zero.
Other successful result data is zero.

| Status | Allowed error | Meaning |
| --- | --- | --- |
| `0` Idle | `0` | No request; ID, opcode and data zero |
| `1` Pending | `0` | Reserved processing state; not emitted by the current synchronous dispatcher |
| `2` Completed | `0` | Operation finished or MSC/benchmark/Wi-Fi test/scan admitted |
| `3` Invalid | `1`, `2`, `3` | Malformed request, missing confirmation or invalid argument/state |
| `4` Unsupported | `4`, `7` | Assigned but unavailable operation, or unassigned opcode |
| `5` Busy | `5` | Conflicting operation |
| `6` Failed | `6` | Processing could not complete |

Error enum: `0` none; `1` malformed flags/unused arguments; `2` missing confirmation; `3` invalid argument/state;
`4` unavailable capability; `5` busy; `6` operation failed; `7` unsupported opcode.

| Detail | Meaning | Use |
| ---: | --- | --- |
| `0` | No additional detail | Default |
| `1` | Storage worker busy or USB-owned medium | Busy/error `5`, opcodes `2`, `5` |
| `2` | USB-owned medium | Busy/error `5`, opcode `4` |
| `3` | Benchmark size invalid | Invalid/error `3`, opcode `4` |
| `4` | Card unavailable | Failed/error `6`, opcode `4` |
| `5`-`9` | Reserved command details; Report `11` execution errors are separate | - |
| `10` | Mount unavailable | Failed/error `6`, opcode `4` |
| `11`-`15` | Reserved | - |
| `16` | Invalid SSID length | Invalid/error `3`, opcode `6` |
| `17` | Invalid password length/characters | Invalid/error `3`, opcode `7` |
| `18` | Invalid Control-key length | Invalid/error `3`, opcode `8` |
| `19` | Incomplete/unsafe credential pair | Invalid/error `3`, opcodes `5`, `9` |
| `20` | Staged values expired | Invalid/error `3`, opcodes `5`, `9` |
| `21` | No eligible staged values | Invalid/error `3`, opcodes `5`, `9` |
| `22` | Stale/incomplete scan generation | Invalid/error `3`, opcode `12` |
| `23` | Scan index out of range | Invalid/error `3`, opcode `12` |
| `24` | Reserved no-Control-key detail; not emitted by this device | - |
| `25` | Wi-Fi test active | Busy/error `5`, wireless commit `5` or opcodes `6`-`9`, `11` |
| `26` | Wi-Fi scan active | Busy/error `5`, wireless commit `5` or opcodes `9`, `11`, `12` |
| `27` | Staging exists but commit flag is clear | Invalid/error `3`, opcode `5` |
| `28` | USB staging blocks BLE save/reboot | Busy/error `5`, BLE opcodes `2`, `5` |
| `29`-`255` | Reserved | - |

Details are zero for Idle, Pending, Completed and Unsupported. Report `12` has a separate Wi-Fi detail namespace.

| USB opcode | Current terminal statuses |
| --- | --- |
| `1`, `4`, `13` | Unsupported/error `4` |
| `2` | Completed, Invalid/error `1` or `2`, Busy, Failed |
| `3` | Completed (admitted), Invalid/error `1`, `2` or `3`, Busy, Failed; older firmware Unsupported/error `4` |
| `5` | Completed, Invalid/error `1` or `3`, Unsupported/error `4`, Busy, Failed |
| `6`-`8` | Completed, Invalid/error `1` or `3`, Busy |
| `9`, `11` | Completed, Invalid/error `1` or `3`, Busy, Failed |
| `10` | Completed, Invalid/error `1` |
| `12` | Completed, Invalid/error `1` or `3`, Busy |
| Unassigned | Unsupported/error `7` |

Validation follows these rules:

1. Invalid report framing/type/length, version or zero transaction ID rejects SET without changing the result.
   The host MUST treat the transfer failure as authoritative, not wait for a matching result.
2. Unassigned or unsupported opcodes return Unsupported before interpreting their arguments.
   Opcode `5` forced-save bit 0 also returns Unsupported before save-argument validation.
3. For supported opcodes, validate flags and unused bytes, then argument ranges and confirmation.
   Credential length/content errors use details `16`-`18`; trailing nonzero bytes are malformed/error `1`.
4. Check resource conflicts before stateful preconditions: test/scan Busy precedes candidate/scan-state errors.
   For a save with commit, active test/scan takes precedence over expired or missing staging.
5. Validate operation state, including staged credential pairs, commit requirements and scan generation/index.
6. Execute the operation; failures return Failed/error `6`.

Every valid-envelope request updates the USB result slot, including invalid and unsupported operations.
There is no forced-save suppression of later SETs.
BLE adds its own lock/proof checks and restrictions; see [BLE validation order](bluetooth.md#validation-order).
Hosts MUST reject unknown status/error values and impossible status/error/opcode combinations, not interpret
them as success.

For opcode `5`, Completed means settings passed flash readback verification and reset was scheduled.
A failure scheduling reset after a verified save can report Failed even though flash changed.
Hosts MUST reconcile saved settings after an uncertain or failed save; they MUST NOT assume no side effects.
For opcode `2`, Completed means reset was scheduled, not that the host observed reboot.
For opcodes `9` and `11`, Completed means a test/scan was admitted; Feature `12` owns its outcome.

USB and BLE have separate result slots and transaction IDs; neither replaces the other's result.
Hosts MUST serialize commands per transport, use nonzero IDs `1`-`255`, and match both ID and opcode.
The device does not enforce ID uniqueness or deduplicate requests.
A later valid-envelope command replaces that transport's result, and disconnect does not clear the stored slot;
reset does. A matching ID after reconnect does not establish which client submitted it.

Timeout or disconnect can leave admission/outcome uncertain. Hosts MUST NOT automatically replay reboot or save,
or submit further writes on that transport until the uncertainty is resolved by result/device-state inspection.
GET is non-destructive and never extends or restarts an operation.

## Report ID 12: Wireless Status

Read-only Feature `12` reports link, test, scan and staging state. Saved switches come from Feature `2`.
BLE exposes the same payload through its [GATT layout](bluetooth.md#gatt-layout).

| Offset | Size | Field | Meaning |
| -----: | ---: | ----- | ------- |
| 0 | 1 | `version` | Layout version, `1` |
| 1 | 1 | `wifi_state` | `0` off; `1` connecting; `2` connected; `3` failed; `4` testing/joining; `5` test joined; `6` test failed |
| 2 | 1 | `detail` | Wi-Fi/test detail enum below |
| 3 | 1 | `ble_state` | `0` off; `1` advertising; `2` connected |
| 4 | 1 | `flags` | Bit 0 network configured; bit 1 Control key saved; bits 2-3 zero; bit 4 SSID staged; bit 5 password staged; bit 6 key staged; bit 7 pair tested |
| 5 | 4 | `ipv4` | Display-order/network-order octets `a.b.c.d`; zero when no connected link |
| 9 | 1 | `ssid_length` | `0`-`32` bytes |
| 10 | 32 | `ssid` | Raw active/retained test SSID, otherwise saved SSID; zero-padded |
| 42 | 1 | `scan_state` | `0` idle; `1` scanning; `2` complete; `3` failed |
| 43 | 2 | `scan_generation` | Generation of current scan; zero before any scan |
| 45 | 1 | `scan_count` | `0`-`18`; zero until complete |
| 46 | 1 | `test_generation` | Zero before a test; then `1`-`255`, skipping zero on wrap |
| 47 | 1 | `staged_state` | Bit 0 empty SSID; bit 1 empty password; bit 2 empty key; bit 3 staging expired; bits 4-7 zero |
| **Total** | **48** | | **49 bytes including report ID** |

Wi-Fi detail values: `0` no reason supplied; `1` interface/radio initialization unavailable;
`2` reserved network-not-found; `3` reserved password-rejected; `4` reserved no-DHCP-address;
`5` timeout or join could not start; `6` tested link lost; `7`-`255` reserved.
The current Zephyr driver does not supply the 802.11 join reason, so wrong passwords and missing APs may both
report Failed/detail `0`. A Bluetooth startup failure can appear as detail `1` in saved-network status when
no Wi-Fi detail takes precedence. This is not a dedicated BLE error field.
Hosts MUST interpret state and detail together; detail `0` does not make a Failed state successful.

Bits 2-3 of `flags` are zero; no TCP CLI serving indication exists.
Staged flags expose candidate presence and test validity, never passwords or keys.
An empty SSID implicitly stages an empty password, setting bits 4 and 5.
`staged_state` bits 0-2 are meaningful only with the matching staged flags.
When expired bit 3 is set, staged flags 4-7 are clear.
Pair-tested bit 7 applies to the exact unexpired Wi-Fi pair, not the Control key.
Saving without testing remains allowed.

Each admitted test advances its nonzero generation, including an immediate test failure.
Keep the generation with its status; it is independent of scan generation.
SSID is not a string terminator-based field: hosts SHOULD display printable UTF-8 and escape invalid bytes/control
characters, for example `\xNN`, without changing the bytes used for comparison or restaging.

Each admitted scan clears the previous list and advances the nonzero 16-bit generation.
Completion publishes retained count; failure publishes count zero.
Use opcode `12` with that generation and an index to reject stale reads.
Features `2`, `12` and `20` are independent snapshots, not an atomic board-wide observation.

Hosts SHOULD poll Feature `12` every 500 ms during test/scan and every 2 seconds otherwise.
At three polling intervals (1.5 seconds active, 6 seconds otherwise), hosts MUST mark status stale and MUST NOT
enable operations based on its old staging flags or scan state.

### Cross-Interface Resource Arbitration

USB and BLE callbacks use the same control dispatcher under one application mutex.
Credential staging and wireless state are device-wide; result slots are transport-specific.
BLE reboot/save returns Busy/detail `28` while unexpired USB staging exists.
USB wireless commit rejects active tests/scans; staging during a test is Busy.
These conflicts are rejected, not silently queued for later.

MSC block I/O and media lifecycle work run outside the application mutex and management loop.
Reboot and settings-save return Busy/detail `1` while storage is busy or USB-owned.
The optional benchmark runs on the serialized storage worker. There is no CDC filesystem interface or forced-save transaction.
Downstream filesystem users must participate in storage ownership/locking. See
[architecture](architecture.md#lifecycle-and-failure-handling) and
[SD storage](sdcard.md#safety-and-ownership).

## Host Polling and Validation

Hosts MUST validate report type, ID, normalized length, version, reserved fields, supported enums and cross-field
constraints. Feature `1` validates identity and memory accounting; Feature `2` validates stored profiles and board
facts; Input `3` validates sensor/load availability; Input `10` validates initialization/capacity and zeroed
unsupported fields. Unsupported layouts and failed mandatory reads are explicit errors, not zero-filled fallbacks.

Only Feature `20` is writable. Hosts MUST hide or disable LED, forced-save and TCP CLI controls.
Benchmark writes require capability bit 5, USB transport and fresh benchmark/storage state.
MSC requires Report `2` flag bit 6, USB transport and fresh, settled ownership status.
For settings-only save, leave flag bit 1 clear; for credential commit, set it explicitly.
Verify the saved settings and commit mask in the completion result, reconnect to the same UID, and reread
Features `1`, `2` and `12`.

Report `10` refreshes receipt time for a worker snapshot, not a synchronous probe.
Unknown presence MUST NOT be labeled confirmed absence. No report provides a file API or safe-unplug guarantee.

### Input Freshness

Hosts MUST timestamp valid Input reports using a monotonic clock, independently by ID.
Freshness lasts three nominal publication intervals: 750 ms for Report `3`, 1500 ms for Report `10`.
At or beyond that age, mark data stale and do not present it as current.
Before the first valid report, state is unavailable.
A valid Input GET snapshot may refresh receipt time but does not advance the publication sequence.

On suspend, mark Input data stale until new reports/snapshot reads arrive.
On disconnect, clear cached connection state. Re-enumeration does not make old values fresh;
repeat mandatory Feature reads and require new valid data before enabling operations.
Prior values MAY be shown only as explicitly historical/stale.

## Design Validation

Hosts accept report version `1` only. An incompatible field, size, unit, validation rule or lifecycle change
requires an affected report-version increment and coordinated firmware/host updates.
An additive capability-selected transport does not change the existing byte layout: native SDMMC assigns bit 4,
uses all six Report `2` pin slots and adds bus-mode value `3`, without reinterpreting legacy SPI bit 3 / mode `2`
or reserved SDIO-PIO mode `1`. These reports retain version `1`. Current hosts require native SDMMC and reject
legacy SPI identities; SPI-era hosts reject the native identity. Firmware and hosts MUST be updated together.
There is no wire-level SPI fallback or assumption that version `1` alone guarantees transport compatibility.
Wire-layout versioning is independent of firmware semantic version and
[persistent-record migration](settings.md#record-format). There is no legacy wire fallback.

Software checks cover report byte layouts, board facts, telemetry/storage flags, request envelopes,
opcode restrictions, credential staging, save/commit, scans and USB/BLE result isolation.
Host checks cover codecs, validation, request/result shapes and command lifecycle.
Test commands are maintained in the [firmware](../development/firmware.md) and
[host development](../development/host-tools.md) guides.

These checks use portable firmware modules and synthetic host reports. They do not qualify USB enumeration,
control-transfer stalls, real interrupt delivery, suspend/resume, card hardware or live radio behavior.
See [qualification gaps](../validation/qualification-gaps.md) and the
[Bluetooth conformance list](bluetooth.md#conformance).

## Implementation and Integration

The native USB interface uses Zephyr's `udc_dwc2` driver. Feature GET supports IDs `1`, `2`, `12`, `20`;
Input GET supports `3`, `10`. Unsupported type/ID or an insufficient GET buffer is rejected.
SET requires Feature `20`, exactly 69 bytes including ID, and a valid envelope.
The callback rejects invalid envelopes before the status stage completes, leaving the prior result readable.

Input publication is scheduled from the main loop, nominally 250 ms telemetry / 500 ms storage.
One transfer is in flight at a time, so intervals are not delivery guarantees.
USB callbacks run in the stack thread; shared control access holds the application mutex.
Python (`hidapi`), .NET (`HidSharp`) and Direct (WebHID) implement the same payload contract.

## Specification History

The initial report design was derived from the
[PicoForge USB HID specification](https://github.com/djwinter29-oss/PicoForge/blob/5e615725b22714963c2d16ed56215042e1411553/docs/reference/usb-hid.md)
at commit `5e615725b227`. This document defines the current project contract; the upstream document is historical
context, not an additional source of requirements. Existing offsets and reserved IDs are retained without
claiming support for upstream-only features.
