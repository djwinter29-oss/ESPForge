# Security

Do not put credentials or exploitable details in public issues.
Use this repository's GitHub private vulnerability reporting if available; otherwise contact the
maintainer through an established private channel before sharing sensitive details.

The starter deliberately exposes only read-only public BLE diagnostics and physical UART management.
Python/.NET hosts bind to loopback; do not expose them to a network.
See [wireless security boundaries](docs/guides/wireless.md#security-boundaries) and
[qualification gaps](docs/validation/qualification-gaps.md).
