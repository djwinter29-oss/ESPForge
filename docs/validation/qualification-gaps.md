# Qualification gaps

This starter is intended to be ready for later hardware connection, not qualified for production.

| Area | Current boundary |
| --- | --- |
| ESP32-S3 target | DevKitC-1 N16R8 PROCPU source build (16 MB flash, 8 MB octal PSRAM); no physical flash/boot or PSRAM memory-test observation |
| Firmware unit tests | Ceedling covers the portable control dispatcher, report encoding, wireless staging/auth, SHA-256 and boot-settings record with mocked platform hooks and a fake flash; no Zephyr execution |
| USB HID | Firmware builds the `device_next` HID device; hosts are tested with fake devices. Enumeration, report timing and reconnect on a real host are pending |
| BLE | Firmware GATT, session unlock and Control writes build; Direct client tested with fakes. Advertising, long reads, authentication and reconnect pending on hardware |
| Wi-Fi | Saved/test/scan state machine builds; association, failure details, retries, coexistence and DHCP leases unmeasured |
| Boot settings | Record codec, validation and staging tested natively; `storage_partition` erase/program/readback, power-loss behaviour and runtime CPU clock profiles unmeasured on hardware |
| SD card | Drivers, proposed wiring and safe mount code ready; **all SD hardware tests intentionally deferred** |
| Dashboards | Explicit synthetic preview and protocol tests; no live-board screenshot or measurements |
| Security | BLE Control key authentication without link encryption; unencrypted flash; physical USB/UART control; loopback hosts |
| Variants | Only N16R8 is configured; N4/N8/octal-flash modules and other S3 boards are not targets |
| Product readiness | No power-loss, soak, performance, RF, EMC or regulatory qualification |

When hardware arrives, first validate USB enumeration and Report 1, then the console output, BLE and Wi-Fi independently.
SD-card tests are outside the current setup request; schedule them explicitly later, with backups and a dedicated card.
Historical software results do not establish current or future hardware compatibility.
