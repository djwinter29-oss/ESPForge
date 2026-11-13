# Hardware setup

## Initial target

The starter targets `esp32s3_devkitc/esp32s3/procpu` in Zephyr 4.3.2.
ESPForge builds for the ESP32-S3-DevKitC-1 **N16R8** (ESP32-S3-WROOM-1-N16R8 module): 16 MB quad flash and
8 MB octal PSRAM. The project configuration selects the N16R8 memory sizes and partition layout
(settings in `storage_partition` at `0xFB0000`), with octal PSRAM at 40 MHz and a boot-time memory test.
PSRAM provides a separate 1 MB shared multi-heap; the kernel heap, Wi-Fi and BLE buffers stay in internal RAM.
Flash runs in DIO at 80 MHz.

Check the module marking. An image for N16R8 does not suit N4/N8 modules (smaller flash, no octal PSRAM)
or N32R16V/N16R16VA modules (octal flash). Other boards need their own DTS/flash configuration and validation;
do not assume compatibility from the ESP32-S3 chip name alone.

The DevKitC has two USB-C connectors, and ESPForge uses both:

| Connector | ESP32-S3 interface | Used for |
| --- | --- | --- |
| **USB** | Native USB OTG (GPIO19 D- / GPIO20 D+) | Management: USB HID, VID:PID `CAFE:4021`, read by the Python and .NET dashboards and by Direct over WebHID |
| **UART** | USB-to-UART bridge to UART0 (GPIO43 TX / GPIO44 RX) | ROM flashing and the Zephyr diagnostic shell/log at 115200 baud, 8N1 |

Connect both when you flash and manage the board from one computer. Native USB exposes HID management and a
removable MSC drive with explicit SD ownership handoff; there is no CDC ACM console. After a Control key is saved over USB,
Bluetooth LE management needs only power; see the [wireless guide](wireless.md).
For UART or raw TCP diagnostics, see the [console guide](console.md).

## SD-card SDMMC wiring

Use a 3.3 V-compatible SD socket exposing CLK, CMD and DAT0-DAT3, with suitable external command/data pull-ups,
short wires and adequate regulated power. A SPI-only breakout is insufficient for four-bit operation.
Wire with power disconnected. Do not apply 5 V to ESP32 GPIOs or a bare SD card.
This is proposed wiring, not electrically qualified hardware.

Follow the [SD pin allocation](../reference/sdcard.md#pin-allocation) for all six SDMMC signals, GPIO8 active-high
card detection, supply and ground. An unwired detection input reads absent and prevents mounting.

GPIO assignments use explicit native SDMMC slot-0 pinctrl in the project's overlay.
The ESP32-S3 has 512 KiB of internal SRAM and no on-chip flash. N16R8 specifies the module's 16 MiB SPI flash
and 8 MiB octal PSRAM; both are external to the SoC. PSRAM is volatile RAM, not additional flash.
The Module memory panel separates SRAM reservation, PSRAM reservation/capacity and detected module-flash
capacity. Reservations include linked regions and permanent heap pools, not live usage. Unknown or unavailable
inventory remains `--`; it is not inferred from the board name. No additional flash chip or interface is configured.

SPI2 is dedicated to the onboard WS2812-compatible RGB LED, with only MOSI allocated; SPI3 remains disabled.
The default LED data pin is GPIO48. This is unverified for the diymore dual-USB-C N16R8 clone; official DevKitC-1
revisions use GPIO48 (v1.0) or GPIO38 (v1.1). For GPIO38, change the LED pinctrl selection from
`SPIM2_MOSI_GPIO48` to `SPIM2_MOSI_GPIO38` in the hardware overlay and rebuild. Reported board facts derive from that
selection. No SPI clock, MISO or chip-select pin is assigned. The driver uses a low fixed intensity, boots Off and
transmits an eight-bit SPI waveform at up to 6.4 MHz with a 350-microsecond reset. GPIO choice, waveform and optical
colour still require physical qualification. A logged transmission failure disables LED control until reboot.
Octal PSRAM occupies GPIO33-37, so those pins are not available on N16R8.
Leave boot-strapping and onboard flash/PSRAM pins alone. Consult your exact board schematic.
The requested SDMMC ceiling is 25 MHz; this is not a measured bus frequency or throughput claim.

Prepare an existing FAT16/FAT32 volume on your computer and back up its data.
Cards may be inserted after startup or replaced; detection mounts them for firmware, not automatically for USB.
Power switching is not implemented. Power-cycle the card when switching from SPI mode;
a board-only reset may leave the card in SPI mode.
Physical unplugging during I/O may corrupt data. Safely eject the USB drive before confirming return to firmware.
See the [SD contract](../reference/sdcard.md) for data-safety behavior.

No board or SD card was attached during project setup. Wiring and radio operation await hardware.
