# Hardware setup

## Initial target

The starter targets `esp32s3_devkitc/esp32s3/procpu` in Zephyr 4.3.2.
Its default DTS describes an ESP32-S3-WROOM module with 8 MB flash (N8).
No PSRAM is assumed or enabled. Other S3 development boards and N4/N16/PSRAM module variants
need a matching DTS/flash configuration and their own build/flash validation; do not assume compatibility
from the ESP32-S3 chip name alone.

The DevKitC has two USB-C connectors, and ESPForge uses both:

| Connector | ESP32-S3 interface | Used for |
| --- | --- | --- |
| **USB** | Native USB OTG (GPIO19 D- / GPIO20 D+) | Management: USB HID, VID:PID `CAFE:4021`, read by the Python and .NET dashboards and by Direct over WebHID |
| **UART** | USB-to-UART bridge to UART0 (GPIO43 TX / GPIO44 RX) | Flashing through the ROM bootloader, and the Zephyr console/log at 115200 baud, 8N1 |

Connect both when you flash and manage the board from one computer. The USB connector exposes only the HID
interface: there is no CDC ACM console and no mass-storage gadget. After a Control key has been saved over USB,
Bluetooth LE management needs only power; see the [wireless guide](wireless.md).

## SD-card SPI wiring

Use a 3.3 V-compatible SD breakout with suitable pull-ups, short wires, and adequate regulated power.
Wire with power disconnected. Do not apply 5 V to ESP32 GPIOs or a bare SD card.
This is proposed wiring, not electrically qualified hardware.

| ESP32-S3 signal | GPIO | Breakout/card signal |
| --- | --- | --- |
| Chip select | 10 | CS / DAT3 |
| Controller output | 11 | MOSI / CMD |
| Clock | 12 | SCLK / CLK |
| Controller input | 13 | MISO / DAT0 |
| Supply | 3V3 | 3.3 V supply input |
| Ground | GND | GND |

GPIO assignments use Zephyr's SPI2 default pinctrl and the project's overlay.
SPI3 is disabled because its default signals can conflict with module flash/PSRAM connections.
Leave boot-strapping and onboard flash/PSRAM pins alone. Consult your exact board schematic.
The requested SPI ceiling is 10 MHz; this is not a measured bus frequency or throughput claim.

Prepare an existing FAT16/FAT32 volume on your computer and back up its data.
Insert before boot: the starter mounts once at startup. Hot-plug, card-detect, power switching,
SDMMC four-bit transport and automatic remount are not implemented.
Do not remove the card while powered/mounted. There is no host filesystem handoff.
See the [SD contract](../reference/sdcard.md) for data-safety behavior.

No board or SD card was attached during project setup. Wiring and radio operation await hardware.
