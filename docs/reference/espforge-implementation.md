# ESPForge Implementation Reference

The project's [USB HID specification](usb-hid.md) and
[Bluetooth LE specification](bluetooth.md) define the wire contracts.
This implementation reference lists the ESPForge-specific values, supported features and
behaviour on the ESP32-S3; it is not a separate protocol specification.
The specifications own report layouts and transport rules; this page records the board and platform details
that implement them. Protocol changes must update the corresponding specification and all affected hosts.

## Transports

| Item | ESPForge value |
| --- | --- |
| Target module | ESP32-S3-DevKitC-1 **N16R8**: 16 MB quad flash, 8 MB octal PSRAM. Reports carry no PSRAM field: `ram_total_bytes` and `ram_reserved_bytes` describe internal SRAM only. |
| USB connector | DevKitC **USB** connector (native USB OTG, GPIO19 D- / GPIO20 D+). |
| USB stack | Zephyr `device_next` stack with the `udc_dwc2` driver (Zephyr 4.3.2 or later). |
| USB interfaces | One vendor HID interface (interface `0`). No CDC ACM and no MSC. |
| Development VID:PID | `0xCAFE:0x4021`. This is a development pair and not a product identity. |
| HID usage | Vendor usage page `0xFF00`, usage `0x01`, no boot protocol. |
| USB strings | Manufacturer `djwinter29`, product `ESPForge`, serial = Report `1` UID as 16 uppercase hex digits. |
| Console and flashing | DevKitC **UART** connector (UART0, GPIO43 TX / GPIO44 RX). It carries `printk` diagnostics only. |
| BLE service UUID | `ef5c0000-7c91-4d70-8b32-6e856443f502`. Report and control characteristics are `ef5cXXXX-7c91-4d70-8b32-6e856443f502`, using the suffixes in the Bluetooth specification. |
| BLE name | `ESPForge-<16 uppercase hex UID>` (25 bytes). Device Information manufacturer is `ESPForge`. |
| BLE proof domain | Unchanged: `PFBLECTL1`. The worked proof vector in the Bluetooth reference applies unchanged. |

The UART JSON management protocol from the first ESPForge revision has been removed. All management goes through
HID (USB) or the GATT service (BLE).

## Reports

ESPForge publishes Reports `1`, `2`, `3`, `10`, `12`, and `20`. It does not publish Report `11`. On BLE, `000b` reads
as an empty value.

### Report 1: Identity

| Field | ESPForge value |
| --- | --- |
| `product_id` | `0x0003` ESPForge. Hosts accept only `0x0003`. |
| `device_uid` | Bytes 0-5: the 6-byte eFuse base MAC in Zephyr `hwinfo_get_device_id()` order. Bytes 6-7: zero. |
| `mcu` | `3` ESP32-S3. Other values are unknown. |
| `board_model` | `1` ESP32-S3-DevKitC-1, which requires MCU `3`. `0` makes no board claim. Other values are unassigned. |
| `capabilities` | `0x96`: bit 1 reboot, bit 2 settings save, bit 4 native SDMMC storage transport, bit 7 wireless. |
| `capabilities_extension` | `0`. |
| `ram_total_bytes` | `524288` (ESP32-S3 internal SRAM, 512 KiB). |
| `ram_reserved_bytes` | Statically linked RAM from `_image_ram_start` to `_image_ram_end`. This includes the Zephyr heap pool and thread stacks. |

The cleared capability bits mean the following:

- Bit 0 is clear because there is no identification LED. Opcode `1` returns Unsupported/error `4`.
- Bit 5 is clear because there is no benchmark. Opcode `4` returns Unsupported/error `4`.
- Bit 6 is clear because there is no forced save. Opcode `5` with flag bit 0 set returns Unsupported/error `4`.

Bit 4 selects native SDMMC, not USB mass-storage support. Because ESPForge has no MSC interface, opcode `3` returns Unsupported/error `4`
even though a storage transport is selected.

### Report 2: Board Configuration

| Field | ESPForge value |
| --- | --- |
| `stored_sysclk_profile` | `0` (build clock, 240 MHz), `80`, `160`, or `240` MHz. |
| `stored_sdcard_profile` | Always `0` (Standard). |
| Monitor UART | Index `0`, TX `43`, RX `44`. The monitor-UART-enabled flag is always set. |
| `storage_gpios` | Native four-bit SDMMC order CLK `12`, CMD `11`, DAT0 `13`, DAT1 `14`, DAT2 `15`, DAT3 `10`. |
| `board_flags` | Bit 2 is always set. Bit 3 reflects saved Wi-Fi, bit 4 saved BLE. Bits 0, 1, and 5 are always clear. |
| `reset_cause` | From `hwinfo_get_reset_cause()`: POR→`1`, watchdog→`2`, software→`3`, otherwise `0`. |
| `led_gpio`, `card_detect_gpio` | `255`. |

### Report 3: Telemetry

| Field | ESPForge value |
| --- | --- |
| Temperature | ESP32-S3 internal die-temperature sensor (`coretemp`). The valid flag (extension bit 2) is clear if a read fails. |
| `uptime_ms` | `k_uptime_get()`. |
| `core0_service_load_basis_points` | PRO CPU load from Zephyr idle-thread runtime statistics over windows of at least 250 ms. |
| `core1_service_load_basis_points` | Always `65535`; the APP CPU does not run Zephyr. |
| `system_clock_hz` | Current CPU clock. |
| Extension flags | Bit 0 USB configured; bit 1 always clear (no CDC); bit 2 temperature valid; bit 3 always clear. |

### Report 10: Storage

| Field | ESPForge value |
| --- | --- |
| `bus_mode` | `3` native SDMMC while initialized; `0` otherwise. |
| `bus_clock_hz` | The devicetree `max-bus-freq` ceiling (25 MHz) while a card is initialized, not a measured frequency. |
| `speed_mode` | `1` Standard while a card is initialized. |
| `block_count` | From `DISK_IOCTL_GET_SECTOR_COUNT`. |
| CID | Not exposed by the Zephyr disk API. `sd_flags` bit 4 is clear and the CID bytes are zero. |
| `filesystem_format` | FatFs `fs_type` of the mounted volume: `1` FAT12, `2` FAT16, `3` FAT32, `4` exFAT. |
| MSC fields | Always `0`. |

There is no card-detect input. A successful mount establishes that the card is present. If mounting fails, the
sample is still valid, with only `sd_flags` bits 0 and 6 set.

### Report 12: Wireless

`flags` bit 2 (TCP CLI serving) is always clear because ESPForge has no TCP CLI.

The Zephyr ESP32 Wi-Fi driver reports connect and disconnect outcomes without the 802.11 reason code. ESPForge
therefore reports these failure `detail` values:

| Detail | Meaning |
| ---: | --- |
| `0` | The driver rejected or dropped the join without a reason. Wrong passwords and missing APs both appear like this. |
| `1` | No Wi-Fi interface exists. This value is also used, in the saved-network state only, when Bluetooth failed to start. |
| `5` | The join timed out, or could not be started. |
| `6` | A test network was joined and then lost before the test finished. |

A scan interrupts an in-progress saved-network join. The join resumes after the scan. Scans and tests are allowed
while the Wi-Fi boot switch is off; the switch only controls the automatic saved-network join at boot. Wi-Fi uses
WPA2-Personal and open networks; WPA3-SAE is not enabled.

### Report 20: Control

| Opcode | ESPForge behaviour |
| ---: | --- |
| `1` | Unsupported/error `4` (no LED). |
| `2` | Implemented. |
| `3` | Unsupported/error `4` (no MSC). |
| `4` | Unsupported/error `4` (no benchmark). |
| `5` | Implemented. Clock must be `0`/`80`/`160`/`240`. SD-card profile `1` and switch bit 2 (TCP CLI) are Invalid/error `3`. Flag bit 0 (forced save) is Unsupported/error `4`. |
| `6`-`12` | Implemented. |
| `13` | Unsupported/error `4` (no TCP CLI). |

BLE control supports opcodes `1`, `2`, and `5`, with the same results as USB. All other opcodes keep the Bluetooth
reference results.

## Bluetooth LE Differences

The [Bluetooth LE specification](bluetooth.md) owns the project's GATT layout, authentication and transport behavior.
See [Service Changed and caching](bluetooth.md#service-changed-and-caching),
[session unlock](bluetooth.md#session-unlock) and [pairing and bonding](bluetooth.md#pairing-and-bonding).

## Hosts

The Python and .NET dashboards use USB HID only: the Python dashboard through `hidapi`, the .NET dashboard through
`HidSharp`. The Direct dashboard uses WebHID and Web Bluetooth. All three follow this implementation reference: they reject other
product IDs and hide LED, MSC, benchmark, forced-save, and TCP CLI controls, because the matching capability bits are
clear or this reference marks the opcode as Unsupported.
