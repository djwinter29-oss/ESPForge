# Security

Do not put credentials or exploitable details in public issues.
Use this repository's GitHub private vulnerability reporting if available; otherwise contact the
maintainer through an established private channel before sharing sensitive details.

Management is available over physical USB HID and over Bluetooth LE. BLE reads beyond identity and every BLE
command require a session unlocked with the saved Control key; the BLE link itself is not encrypted. Saved
credentials are unencrypted in flash.
Python/.NET hosts bind to loopback; do not expose them to a network.
See [wireless security boundaries](docs/guides/wireless.md#security-boundaries) and
[qualification gaps](docs/validation/qualification-gaps.md).
