# ESPForge Shared Web Dashboard

The browser frontend served by both the [Python host](../python/README.md) and the
[.NET host](../dotnet/ESPForge/README.md). It uses static assets and browser ES modules without a build step.
The independent Direct dashboard does not share this code.

## HTTP API

Both hosts must serve the same ESPForge routes and JSON field names.
Board-scoped routes take `?board=ID` from `/api/boards`.

| Route | Purpose |
| --- | --- |
| `GET /`, `/favicon.svg`, `/css/<path>`, `/js/<path>` | Static dashboard assets |
| `GET /api/boards` | Discover boards and obtain IDs for board-scoped requests |
| `GET /api/status` | Identity, telemetry, storage, boot configuration and wireless status |
| `POST /api/settings` | Save clock and radio switches, then reboot; `system_clock_mhz` is `0`, `80`, `160` or `240`, `sdcard_profile` is `0`, `radios` is `0`-`3` |
| `POST /api/reboot` | Confirmed reboot, with `{"confirm":true}` |
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

Unsupported routes are not served: `/console`, `/api/console`, `/api/led`, `/api/msc`,
`/api/msc/force-return` and `/api/self-test`. The UI never requests them.
Reserved status values remain `self_test: null`, disabled `memory.msc` and
`wireless.tcp_cli_enabled: false`; their presence does not enable unsupported features.

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
