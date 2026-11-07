# Architecture

```text
Direct browser ---- Web Serial ---- UART0 JSON ---- Zephyr application
       |                                      |-- Wi-Fi station + DHCP
       +----------- Web Bluetooth ------------|-- BLE read-only status
Python browser ---- loopback Python host ------|-- SPI2 SD / FatFs
.NET browser ------ loopback ASP.NET host -----|
```

## Repository responsibilities

| Layer | Location | Responsibility |
| --- | --- | --- |
| Firmware application | `firmware/src/main.c` | Bounded UART framing, command dispatch and error replies |
| Status contract | `firmware/src/status.c` | Versioned, bounded diagnostics serialization |
| Wireless service | `firmware/src/wireless.c` | Radio initialization, RAM-only credentials, asynchronous Wi-Fi events, BLE GATT |
| Storage service | `firmware/src/storage.c` | Boot-time mount and visible mount result |
| Board configuration | `firmware/boards/esp32s3_devkitc.overlay` | SD bus and chip-select assignments |
| Shared dashboard | `host/web/` | Layout, validated status rendering, transport clients |
| Direct entry | `host/direct/` | Static, no serial backend required |
| Python/.NET | `host/python/`, `host/dotnet/ESPForge/` | Single-owner serial bridge on loopback |
| Dependency selection | `west.yml` | Pinned Zephyr and imported dependency revisions |

## Lifecycle and failure handling

Boot initializes wireless, attempts one SD mount, then serves UART requests on PROCPU.
Mount failure remains visible and does not stop UART/radios. No card self-test or file write runs.
Wi-Fi request submission and result events are distinct; a mutex protects radio state.
BLE status is snapshotted on offset-zero reads so a long read sees one JSON payload.
Each host owns one serial handle and serializes requests. Direct permits one outstanding request.
Malformed replies, invalid status, disconnects and timeouts clear displayed device values;
polling stops on a failure until the user disconnects/reconnects. There is no implicit demo fallback.
Timeouts do not automatically retry commands.

## Downstream development

Fork this source foundation. Add product work in separate services rather than blocking the UART loop.
Keep GPIO choices in board overlays, keep protocol changes versioned, and update the authoritative
references and all three host paths together. Do not assume PicoForge report/protocol compatibility.
This starter does not include persistent settings, LED/reboot controls, file APIs, recording engines,
USB disk ownership, benchmarks, or dual-core scheduling. It is not feature-for-feature PicoForge parity.
