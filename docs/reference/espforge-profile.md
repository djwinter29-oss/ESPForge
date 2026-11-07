# ESPForge Protocol Profile

The [USB HID reference](usb-hid.md) and [Bluetooth LE reference](bluetooth.md) were imported from PicoForge and are
the wire contract. This profile lists every value and behaviour that ESPForge sets differently on the ESP32-S3.
Where this page and an imported reference disagree, this page wins for ESPForge firmware and hosts. Everything not
listed here is implemented as the imported references describe.

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
| BLE service UUID | `ef5c0000-7c91-4d70-8b32-6e856443f502`. Report and control characteristics are `ef5cXXXX-7c91-4d70-8b32-6e856443f502`, where `XXXX` is the same 16-bit suffix as in PicoForge. |
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
| `capabilities` | `0x8E`: bit 1 reboot, bit 2 settings save, bit 3 SPI storage transport, bit 7 wireless. |
| `capabilities_extension` | `0`. |
| `ram_total_bytes` | `524288` (ESP32-S3 internal SRAM, 512 KiB). |
| `ram_reserved_bytes` | Statically linked RAM from `_image_ram_start` to `_image_ram_end`. This includes the Zephyr heap pool and thread stacks. |

The cleared capability bits mean the following:

- Bit 0 is clear because there is no identification LED. Opcode `1` returns Unsupported/error `4`.
- Bit 5 is clear because there is no benchmark. Opcode `4` returns Unsupported/error `4`.
- Bit 6 is clear because there is no forced save. Opcode `5` with flag bit 0 set returns Unsupported/error `4`.

Bit 3 selects SPI. **Deviation:** because ESPForge has no MSC interface, opcode `3` returns Unsupported/error `4`
even though a storage transport is selected.

### Report 2: Board Configuration

| Field | ESPForge value |
| --- | --- |
| `stored_sysclk_profile` | `0` (build clock, 240 MHz), `80`, `160`, or `240` MHz. |
| `stored_sdcard_profile` | Always `0` (Standard). |
| Monitor UART | Index `0`, TX `43`, RX `44`. The monitor-UART-enabled flag is always set. |
| `storage_gpios` | SPI order CLK `12`, MOSI `11`, MISO `13`, CS `10`, then `255`, `255`. |
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
| `bus_mode` | `2` SPI. |
| `bus_clock_hz` | The devicetree `spi-max-frequency` ceiling (10 MHz) while a card is initialized. |
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
| `3` | Unsupported/error `4` (no MSC; see the deviation above). |
| `4` | Unsupported/error `4` (no benchmark). |
| `5` | Implemented. Clock must be `0`/`80`/`160`/`240`. SD-card profile `1` and switch bit 2 (TCP CLI) are Invalid/error `3`. Flag bit 0 (forced save) is Unsupported/error `4`. |
| `6`-`12` | Implemented. |
| `13` | Unsupported/error `4` (no TCP CLI). |

BLE control supports opcodes `1`, `2`, and `5`, with the same results as USB. All other opcodes keep the Bluetooth
reference results.

## Bluetooth LE Differences

| Topic | ESPForge behaviour |
| --- | --- |
| Stack | Zephyr host with the ESP32 controller. Peripheral role, one connection. |
| Challenge nonce | `sys_csrand_get()` on the ESP32-S3 hardware RNG. |
| Service Changed | Zephyr's standard Generic Attribute service (`CONFIG_BT_GATT_SERVICE_CHANGED`, `CONFIG_BT_GATT_CACHING`). The firmware does not send the PicoForge-specific full-range indication on each subscription, so clients must not wait for one. The Direct client keeps its subscribe-then-continue fallback. |
| Advertising | 60 ms for 30 s after start or disconnect, then 500 ms. This matches the reference. |
| Read snapshots | Matches the reference, including ATT `0x07` for a blob read on a different handle. |
| Pairing | No bonding and no persistence. Bluetooth never writes flash. |

## Hosts

The Python and .NET dashboards use USB HID only: the Python dashboard through `hidapi`, the .NET dashboard through
`HidSharp`. The Direct dashboard uses WebHID and Web Bluetooth. All three apply this profile: they reject other
product IDs and hide LED, MSC, benchmark, forced-save, and TCP CLI controls, because the matching capability bits are
clear or the profile marks the opcode as Unsupported.
