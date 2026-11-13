# ESPForge Shared Web Dashboard

The browser frontend served by both the [Python host](../python/README.md) and the
[.NET host](../dotnet/ESPForge/README.md). It uses static assets and browser ES modules without a build step.
The independent Direct dashboard does not share this code.

Choose **Configure…** in the Wi-Fi or Bluetooth dropdown to open its provisioning dialog without changing
the radio's Enabled/Disabled selection. Wireless edits are saved with **Save&Reboot**.

## HTTP API

Both hosts must serve the same ESPForge routes and JSON field names.
Board-scoped routes take `?board=ID` from `/api/boards`.

The Module memory panel separates internal SRAM, external PSRAM and module SPI flash. `/api/status` adds
`hardware.psram_total_bytes`, `psram_reserved_bytes` and `flash_total_bytes`, in bytes, when the firmware advertises
[memory inventory](../../docs/reference/usb-hid.md#report-id-13-module-memory-inventory).
Unsupported or unavailable values are `null` or absent and display `--`. RAM reservation is linked accounting,
including heap pools, not live usage; flash capacity is not free space. No capacity is inferred from N16R8.

| Route | Purpose |
| --- | --- |
| `GET /`, `/favicon.svg`, `/css/<path>`, `/js/<path>` | Static dashboard assets |
| `GET /api/boards` | Discover boards and obtain IDs for board-scoped requests |
| `GET /api/status` | Identity, telemetry, storage, boot configuration and wireless status |
| `POST /api/settings` | Save clock and radio switches, then reboot; `system_clock_mhz` is `0`, `80`, `160` or `240`, `sdcard_profile` is `0`, `radios` is `0`-`3` |
| `POST /api/reboot` | Confirmed reboot, with `{"confirm":true}` |
| `POST /api/led` | Volatile onboard RGB colour |
| `POST /api/msc` | Explicitly enable USB storage or return it after confirmed OS eject |
| `POST /api/control/resync` | Explicitly reconcile an uncertain command outcome |
| `POST /api/wireless` | Save Wi-Fi credentials, Control key and radio switches |
| `POST /api/wireless/scan` | Scan for Wi-Fi networks |
| `POST /api/wireless/test` | Test candidate credentials |
| `POST /api/wireless/cancel` | Cancel a test and clear temporary credentials |

Settings requests with `confirm_data_loss:true` are refused (HTTP 400 in Python, HTTP 409 in .NET);
there is no forced-save workflow.
Wireless requests may omit `tcp_cli_enabled` or supply `false`, never `true`. Omitted credentials are not
restaged. Opaque SSIDs use `ssid_hex` alongside an escaped display label; test/save requests may use the hex
form to preserve network bytes.

MSC requests use `{"enabled":true}` to export or `{"enabled":false,"confirm_ejected":true}` to return.
`enabled` is required and boolean; optional `confirm_ejected` is boolean and defaults to false. Extra fields,
nonboolean values and unconfirmed return are HTTP 400. Unavailable/stale/busy ownership is HTTP 409; transport
failure is HTTP 503 and may leave an uncertain outcome. HTTP 200 acknowledges admission, not completed handoff:
Python includes `control_result`, while .NET returns `{}`. Poll `/api/status` for `memory.msc.transition_pending`,
`enabled` and `request_rejected`; do not automatically replay. See the
[SD handoff contract](../../docs/reference/sdcard.md#usb-drive-handoff) for OS eject, reconnect and safety limitations.

Unsupported routes are not served: `/console`, `/api/console`,
`/api/msc/force-return` and `/api/self-test`. The UI never requests them.

`POST /api/benchmark` accepts `{"start":true,"size_mib":32,"confirm":true}` or
`{"start":false,"size_mib":0}`. Start requires 1–1024 MiB and explicit write confirmation.
Fields are strictly typed, extras are rejected (HTTP 400), and cancel requires zero size.
Unavailable/stale/busy admission is HTTP 409; transport errors are HTTP 503 and may require explicit resync.
HTTP 200 acknowledges admission (Python `control_result`, .NET `{}`), not a passing run.
Poll `self_test` and `self_test_stale` for [Report 11](../../docs/reference/usb-hid.md#report-id-11-storage-benchmark-status)
progress/result. `self_test` is null when absent or stale; zero-duration throughput is null.
Controls remain hidden without capability bit 5 or detected storage; BLE is read-only.
Never automatically replay a start/cancel request.
`wireless.tcp_cli_enabled` remains false; the independent diagnostic shell has no dashboard bridge.

Unavailable per-core load, temperature, card presence, bus clock and capacity diagnostics use JSON `null`.
The dashboard displays unavailable measurements as `--` without a footer warning; malformed diagnostic values
still produce a warning. Unknown card presence is not treated as a confirmed missing card.
Storage stays hidden until a fresh report detects a card or confirms successful initialization. Detected cards
remain visible if initialization fails. USB-owned storage remains visible without a valid firmware SD sample.
Busy or stale reports retain visibility; disconnect clears detection.
Service load shows **Core 0 / Core 1**, for example `3.1% / --` when Core 1 is unavailable.
Diagnostic tiles expand to fill each responsive row, including rows with fewer visible tiles.

Commands are serialized per board. A timeout or disconnect can leave the outcome uncertain; further writes
remain blocked until explicit reconciliation. Clients must not replay a state-changing request.
Both hosts remain loopback-only and require local request origins.

## Tests

From the repository root:

```sh
node host/web/tests/run-tests.mjs
tsc --project host/web/tsconfig.json
python host/web/tests/browser/run.py
```

The browser checks need Playwright for Python and the .NET SDK because they serve the UI through both hosts.

## RGB LED control

`POST /api/led` accepts only `{"colour":0..7}` with an integer additive RGB mask: red=1, green=2, blue=4,
zero=Off. Capability and fresh available-driver telemetry are required; storage activity does not block it.
Success means queued transmission, not physical verification or persistence. The shared dropdown beside Device
information displays reported colour and uses the existing explicit Re-sync flow after an uncertain outcome.
