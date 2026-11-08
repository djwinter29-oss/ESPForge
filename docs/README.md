# Documentation

Start with operating guides; distinguish project contracts from validation evidence.
Guides and references describe behavior, configuration and APIs rather than internal source-file walkthroughs.
Development guides keep the source-layout and command details needed to build, test and extend the project.

## Start with your task

- **Connect a board:** [Getting started](guides/getting-started.md).
- **Use a dashboard:** [Direct](../host/direct/README.md), [Python](../host/python/README.md) or
  [.NET](../host/dotnet/ESPForge/README.md).
- **Check a contract or maintain the project:** choose its owner below. No sequential reading is required.

## Authoritative ownership

Keep each topic in one document; other documents link rather than duplicate its contract.

| Topic | Owner |
| --- | --- |
| Target, connectors, electrical constraints and board pin restrictions | [Hardware](guides/hardware.md) |
| Workspace creation, build, flash, first dashboard | [Getting started](guides/getting-started.md) |
| Wi-Fi network requirements, provisioning and radio troubleshooting | [Wireless](guides/wireless.md) |
| Layer responsibilities and service lifecycle | [Architecture](reference/architecture.md) |
| Project overview and entry points | [Repository README](../README.md) |
| Platform integration and measurement limits | [ESPForge implementation](reference/espforge-implementation.md) |
| Shared report layouts, identity values, capabilities, USB control and validation | [USB HID](reference/usb-hid.md) |
| ESPForge BLE advertising, GATT, authentication and control contract | [Bluetooth LE](reference/bluetooth.md) |
| Saved next-boot settings: record format, flash partition, clock and radio application | [Boot settings](reference/settings.md) |
| SD pin allocation, driver configuration, mount behavior, status and data safety | [SD storage](reference/sdcard.md) |
| Shared dashboard HTTP routes and request rules | [Shared dashboard API](../host/web/README.md) |
| Toolchains and software validation | [Firmware](development/firmware.md), [host tools](development/host-tools.md) |
| Packaging and publication | [Release](deployment/release.md) |
| Unqualified behavior and observed results | [Gaps](validation/qualification-gaps.md), [records](validation/records/README.md) |

`guides/` is for use, `reference/` for contracts, `development/` for maintenance,
`deployment/` for publishing, and `validation/` for evidence and limitations.

## Maintenance principles

- Change the owner of a contract, not every overview that mentions the feature.
- Keep navigation in this index and the repository README; avoid repeating full reading lists in each document.
- Use links only for prerequisites or detailed contracts. A guide should remain usable without a source walkthrough.
- Keep exact safety and interoperability details where needed; do not replace them with vague summaries.
- Internal refactors do not require prose changes unless behavior, a public API or an operating command changes.
- Keep dated evidence unchanged. A software test result does not establish physical qualification.
