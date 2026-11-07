# Architecture

```text
Direct browser ---- WebHID ----------+
       |                             +-- USB HID (native USB) --+
Python browser ---- loopback Python host (hidapi) --+           |
.NET browser ------ loopback ASP.NET host (HidSharp) +          |-- Zephyr application
                                                                |   |-- control dispatcher + boot settings
Direct browser ---- Web Bluetooth ---- BLE GATT ----------------+   |-- Wi-Fi station + DHCP
                                                                    |-- SPI2 SD / FatFs
UART connector ---- Zephyr console/log and ROM flashing only
```

USB HID and BLE carry the same PicoForge reports and Control opcodes, as adapted by the
[ESPForge profile](espforge-profile.md).

## Repository responsibilities

| Layer | Location | Responsibility |
| --- | --- | --- |
| Application loop | `firmware/src/main.c` | Boot order and the 20 ms poll of control, Wi-Fi, telemetry and USB |
| Board glue | `firmware/src/config/board.c`, `app/espforge.h` | Application lock, UID/serial, reset cause, Identity and Configuration reports, delayed reboot |
| Control dispatcher | `firmware/src/app/control/control.c`, `platform/ef_platform.h` | Portable Report 20 opcode handling shared by USB and BLE; talks to Zephyr only through platform hooks |
| Report encoding | `firmware/src/app/usb/hid_reports.c` | Portable byte layouts of Reports 1, 2, 3, 10, 12 and 20 |
| Wireless staging and auth | `firmware/src/app/wireless/wireless_stage.c`, `wireless_auth.c`, `sha256.c` | Staged credentials with expiry; BLE session unlock and per-command HMAC proofs |
| USB HID | `firmware/src/app/usb/usb_hid.c` | `device_next` HID device `CAFE:4021`: Feature reports 1, 2, 12, 20 and periodic Input reports 3 and 10 |
| BLE | `firmware/src/app/wireless/bluetooth/ble.c` | GATT service, read snapshots, Control writes, advertising schedule |
| Wi-Fi | `firmware/src/app/wireless/wifi/wifi.c` | Saved/test/scan state machine over Zephyr `net_mgmt` |
| Telemetry and storage | `firmware/src/app/telemetry.c`, `app/storage/storage.c` | CPU load, temperature and clock; boot-time SD mount and card facts |
| Boot settings | `firmware/src/platform/boot_config.c`, `boot_flash.c`, `system_clock.c` | One CRC-checked next-boot record in `storage_partition`; CPU clock, radio switches and saved credentials ([settings](settings.md)) |
| Board configuration | `firmware/boards/esp32s3_devkitc.overlay` | USB HID device, SD bus and chip select, temperature sensor |
| Direct dashboard | `host/direct/` | Independent PicoForge-style browser app (own HTML/CSS/favicon/ES modules) with WebHID, Web Bluetooth and a loopback static server |
| Shared dashboard | `host/web/` | PicoForge-style `src/` (HTML, favicon, CSS, ES modules) served by Python and .NET |
| Python/.NET | `host/python/`, `host/dotnet/ESPForge/` | Loopback HTTP hosts that own the USB HID device; Python is the installable `espforge` package (`src/` layout, wheel bundles `host/web/src`) |
| Dependency selection | `west.yml` | Pinned Zephyr and imported dependency revisions |
| Native firmware tests | `project.yml`, `Gemfile.lock`, `firmware/tests/` | Pinned Ceedling/Unity/CMock tests of the portable modules |

## Lifecycle and failure handling

Boot loads the [settings record](settings.md), applies the CPU clock profile, mounts the SD card once, starts Wi-Fi
(joining the saved network when enabled), starts BLE when enabled with a saved Control key, and then enables USB.
A mount failure is reported in Report 10 and does not stop USB or the radios. No card self-test or file write runs.

USB callbacks run in the USB stack thread and BLE callbacks in the Bluetooth thread. Both call the same control
dispatcher, and every access to settings, staging and wireless state holds one application mutex. Wi-Fi driver
events are queued and applied by the main loop, which also starts connects, disconnects and scans outside the lock.
Reboots are scheduled about one second after the reply so the host can read the result first.

Hosts reject reports outside the profile and never retry a command whose outcome is uncertain; they block further
writes until the user confirms a re-sync. There is no implicit demo fallback.

## Downstream development

Fork this source foundation. Add product work in separate services rather than blocking the main loop or holding the
application lock. Keep GPIO choices in board overlays, keep protocol changes versioned, and update the authoritative
references and all three host paths together. ESPForge has no LED, USB mass storage, SD benchmark or TCP CLI, and runs
on one core. It is not feature-for-feature PicoForge parity.
