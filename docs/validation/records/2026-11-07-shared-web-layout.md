# Shared bridge dashboard layout - 2026-11-07

## Scope

Restructured `host/web/` to follow the PicoForge shared-dashboard layout: `src/index.html`,
`src/favicon.svg`, `src/css/dashboard.css` and `src/js/*.mjs` modules (`app`, `dashboard-api`,
`dashboard`, `operation-state`, `wireless-form`), a no-emit `tsconfig.json`, and a `tests/` tree
with mirrored unit tests, an integration test, layout contracts and Chromium browser checks.
Python serves `host/web/src/` directly. .NET copies `src/**` into `wwwroot/`. The Python release
ZIP ships only `host/web/src/`. Direct remains independent.

## Observed checks

| Check | Observation |
| --- | --- |
| `host/web` Node tests (`run-tests.mjs`) | 42 passed, including layout contracts and a stale-session integration case |
| TypeScript 5.9 no-emit JSDoc check | Passed for `host/web` and Direct |
| Local Playwright 1.64.1 / Chromium against the Python `--demo` host | 4 checks passed: assets/favicon MIME, simulated session, no overflow at 360/800/1280 px, disconnect |
| Python host tests | Passed, including byte-for-byte asset serving and traversal/dotfile 404s |
| .NET tests and synthetic serial check | Passed; `wwwroot/` matches `host/web/src/` byte-for-byte |
| `dotnet publish` | Published assets match source; MIME types checked per suffix |
| Direct Node, server and browser checks | 77 Node tests and 7 server tests passed; browser checks passed |
| Release packaging script | Simulated locally; Python ZIP contains only `host/web/src` |
| actionlint, documentation links | Passed |

## Evidence limits

All checks used the simulated demo host or synthetic UART peers. No ESP32-S3 hardware was connected,
so they say nothing about firmware behaviour, Wi-Fi or SD card.
