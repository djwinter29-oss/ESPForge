# ESPForge Shared Web Dashboard

The browser frontend served by both the [Python host](../python/README.md) and the
[.NET host](../dotnet/ESPForge/README.md). It uses static assets and browser ES modules without a build step.
The independent Direct dashboard does not share this code.

## HTTP API

Both hosts must serve the same ESPForge routes and JSON field names.
Board-scoped routes take `?board=ID` from `/api/boards`.

| Route | Methods | Status |
|---|---|---|
| `/`, `/favicon.svg`, `/css/<path>`, `/js/<path>` | GET | Kept |
| `/api/status`, `/api/boards` | GET | Kept |
| `/api/settings`, `/api/reboot`, `/api/control/resync` | POST | Kept |
| `/api/wireless`, `/api/wireless/scan`, `/api/wireless/test`, `/api/wireless/cancel` | POST | Kept |
| `/console`, `/api/console` | | Dropped: no TCP CLI console |
| `/api/led` | | Dropped: no board LED |
| `/api/msc`, `/api/msc/force-return` | | Dropped: no USB drive or forced save |
| `/api/self-test` | | Dropped: no SD benchmark |

The UI never requests an unsupported route. Reserved status fields (`self_test`, `memory.msc`,
`wireless.tcp_cli_enabled` and so on) remain unavailable or inactive, and saves always send
`sdcard_profile: 0` and never `tcp_cli_enabled`.
See the [Python host API notes](../python/README.md#dashboard-http-api) for request limits.

## Tests

From the repository root:

```sh
node host/web/tests/run-tests.mjs
tsc --project host/web/tsconfig.json
python host/web/tests/browser/run.py
```

The browser checks need Playwright for Python and the .NET SDK because they serve the UI through both hosts.
