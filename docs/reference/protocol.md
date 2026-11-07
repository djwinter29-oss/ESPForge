# Management Protocol

ESPForge uses PicoForge's USB HID and Bluetooth LE protocol. The UART JSON protocol of the first ESPForge revision
has been removed.

| Document | Owns |
| --- | --- |
| [ESPForge profile](espforge-profile.md) | ESPForge identity, transports, report field values, supported opcodes and every deviation from PicoForge |
| [USB HID reference](usb-hid.md) | Report IDs, byte layouts, Control envelope and opcode semantics |
| [Bluetooth LE reference](bluetooth.md) | Advertising, GATT layout, session unlock, command proofs and ATT errors |
| [Boot settings](settings.md) | The saved record behind Feature report `2` and opcode `5` |

Where the profile and the imported references differ, the profile wins.

## Transports

| Transport | Connector or radio | Hosts |
| --- | --- | --- |
| USB HID, VID:PID `CAFE:4021` | DevKitC **USB** connector (ESP32-S3 native USB OTG) | Python (`hidapi`), .NET (`HidSharp`), Direct (WebHID) |
| Bluetooth LE GATT, service `ef5c0000-…` | ESP32-S3 radio | Direct (Web Bluetooth) |
| Console and flashing | DevKitC **UART** connector | `printk` diagnostics and the ROM bootloader only; no management protocol |
