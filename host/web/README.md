# ESPForge Shared Web Dashboard

The browser frontend served by both the [Python host](../python/README.md) and the .NET host. It has no build step:
`src/index.html` loads ES modules from `src/js`, styles from `src/css`, and `src/favicon.svg`. The independent Direct
dashboard does not share this code.

## HTTP API

Both hosts must serve the same routes and JSON field names as the PicoForge dashboard API, narrowed by the
[ESPForge implementation reference](../../docs/reference/espforge-implementation.md). Board-scoped routes take `?board=ID` from `/api/boards`.

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

The UI never requests a dropped route. Status keeps the PicoForge shape (`self_test`, `memory.msc`,
`wireless.tcp_cli_enabled` and so on), and saves always send `sdcard_profile: 0` and never `tcp_cli_enabled`.
See the [Python host API notes](../python/README.md#dashboard-http-api) for request limits.

## Tests

From the repository root:

```sh
node host/web/tests/run-tests.mjs
tsc --project host/web/tsconfig.json
python host/web/tests/browser/run.py
```

The browser checks need Playwright for Python and the .NET SDK because they serve the UI through both hosts.
