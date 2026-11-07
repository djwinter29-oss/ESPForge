# Hardware setup

## Initial target

The starter targets `esp32s3_devkitc/esp32s3/procpu` in Zephyr 4.2.0.
Its default DTS describes an ESP32-S3-WROOM module with 8 MB flash (N8).
No PSRAM is assumed or enabled. Other S3 development boards and N4/N16/PSRAM module variants
need a matching DTS/flash configuration and their own build/flash validation; do not assume compatibility
from the ESP32-S3 chip name alone.

Use the connector connected to the board's USB-to-UART bridge for management and flashing.
UART0 is GPIO43 TX / GPIO44 RX at 115200 baud, 8 data bits, no parity, 1 stop bit, no flow control.
The separate native USB connector is **not** a management interface in this starter.
No USB HID, CDC ACM, or mass-storage gadget is implemented.

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
