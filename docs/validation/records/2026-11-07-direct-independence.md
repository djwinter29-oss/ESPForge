# Direct dashboard independence - 2026-11-07

## Scope

Rebuilt `host/direct/` to follow the PicoForge Direct folder structure: its own `web/index.html`,
`web/favicon.svg`, `web/css/direct.css`, layered `web/js/` ES modules, loopback `server.py` and a
mirrored `tests/` tree. Direct no longer loads `host/web/`; `host/web/` is now bridge-only for
Python and .NET. This supersedes the shared-UI statement in the
[earlier Direct record](2026-11-07-direct-dashboard.md). The Direct ZIP now contains `web/`,
`server.py`, `LICENSE` and `RELEASE.txt`, and Pages serves `web/` as the site root.

## Observed checks

| Check | Observation |
| --- | --- |
| Direct Node tests (`run-tests.mjs`) | 77 passed, including architecture/layout contracts and a Web Serial integration flow |
| Direct server (`unittest`) | 7 passed: headers, MIME types, listing/traversal 404, mutating-method 405, arguments |
| TypeScript 5.9 no-emit JSDoc check | Passed |
| Local Playwright 1.64.1 / Chromium | 6 fixture checks and the shipped-page check (CSP, dialogs, history) passed |
| `host/web` bridge tests | 11 passed |
| Python host and .NET tests | Passed, including the synthetic .NET serial check |
| Release packaging script | Ran locally with a test version; Direct and Python archives passed extracted-HTTP smoke checks |
| Pages site checks | Simulated against the built Direct ZIP |
| actionlint, documentation links | Passed |

The tests found that **Refresh status** was never wired or enabled; it now calls the session refresh
when connected.

## Evidence limits

All browser checks used a fake Web Serial device or simulated preview. No real board, Bluetooth
connection, Wi-Fi association or SD card was used, and GitHub-hosted workflows have not run.
See [qualification gaps](../qualification-gaps.md).
