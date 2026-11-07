# Qualification gaps

This starter is intended to be ready for later hardware connection, not qualified for production.

| Area | Current boundary |
| --- | --- |
| ESP32-S3 target | N8/default DevKitC PROCPU source build; no physical flash/boot observation |
| Firmware unit tests | Ceedling covers portable credential/status logic with mocked service inputs; no Zephyr execution or UART parser/integration coverage |
| USB-UART | Host parsing and synthetic peers; real bridge/reset/driver behavior pending |
| BLE | Firmware GATT build and browser client present; advertising/ATT long reads/reconnect pending on hardware |
| Wi-Fi | Enabled interface, DHCP and RAM-only connect path; association/coexistence/lease acquisition unmeasured |
| SD card | Drivers, proposed wiring and safe mount code ready; **all SD hardware tests intentionally deferred** |
| Dashboards | Explicit synthetic preview and protocol tests; no live-board screenshot or measurements |
| Security | Public BLE diagnostics, physical UART control, loopback hosts; no wireless control authorization model |
| Variants | N4/N16/PSRAM/other S3 boards are not qualified targets |
| Product readiness | No power-loss, soak, performance, RF, EMC or regulatory qualification |

When hardware arrives, first validate board identity, UART status, BLE and Wi-Fi independently.
SD-card tests are outside the current setup request; schedule them explicitly later, with backups and a dedicated card.
Historical software results do not establish current or future hardware compatibility.
