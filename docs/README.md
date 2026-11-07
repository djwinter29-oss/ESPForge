# Documentation

ESPForge follows PicoForge's documentation organization and wire protocol, not its hardware.
Start with operating guides; distinguish implementation contracts from validation evidence.

## Reading order

1. [Getting started](guides/getting-started.md), [hardware](guides/hardware.md), then your dashboard guide:
   [Direct](../host/direct/README.md), [Python](../host/python/README.md), or [.NET](../host/dotnet/ESPForge/README.md).
2. [Wireless](guides/wireless.md), [architecture](reference/architecture.md),
   [management protocol](reference/protocol.md), [boot settings](reference/settings.md), and
   [SD storage](reference/sdcard.md).
3. [Firmware development](development/firmware.md), [host development](development/host-tools.md),
   and [qualification gaps](validation/qualification-gaps.md).
4. [Release procedure](deployment/release.md), then dated [validation records](validation/records/README.md).

## Authoritative ownership

Keep each topic in one document; other documents link rather than duplicate its contract.

| Topic | Owner |
| --- | --- |
| Target, connectors, GPIO assignments, electrical constraints | [Hardware](guides/hardware.md) |
| Workspace creation, build, flash, first dashboard | [Getting started](guides/getting-started.md) |
| Default radios, provisioning and security limits | [Wireless](guides/wireless.md) |
| Layer responsibilities and service lifecycle | [Architecture](reference/architecture.md) |
| Transports and protocol document map | [Protocol](reference/protocol.md) |
| ESPForge identity, report values and deviations from PicoForge | [ESPForge profile](reference/espforge-profile.md) |
| USB HID and Bluetooth LE contract imported from PicoForge | [USB HID](reference/usb-hid.md), [Bluetooth LE](reference/bluetooth.md) |
| Saved next-boot settings: record format, flash partition, clock and radio application | [Boot settings](reference/settings.md) |
| Mount behavior, ownership and data safety | [SD storage](reference/sdcard.md) |
| Toolchains and software validation | [Firmware](development/firmware.md), [host tools](development/host-tools.md) |
| Packaging and publication | [Release](deployment/release.md) |
| Unqualified behavior and observed results | [Gaps](validation/qualification-gaps.md), [records](validation/records/README.md) |

`guides/` is for use, `reference/` for contracts, `development/` for maintenance,
`deployment/` for publishing, and `validation/` for evidence and limitations.
