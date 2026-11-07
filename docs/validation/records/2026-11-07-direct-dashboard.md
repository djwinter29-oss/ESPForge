# Direct dashboard completion - 2026-11-07

## Scope

Compared the local PicoForge Direct HTML, shared dashboard CSS and Direct guide.
Adapted its light topbar, full-width metric sections and collapsible pin tables
to ESPForge's actual protocol rather than copying PicoForge's unsupported controls.
The UI remains shared by Direct, Python and .NET.

## Observed checks

| Check | Observation |
| --- | --- |
| Node dashboard/protocol/transport tests | 13 passed, including session freshness, local validation, read-only simulation, error clearing and serial cleanup |
| Python host regressions | 9 passed |
| .NET build and protocol tests | Build passed without warnings; protocol/demo assertions passed |
| Local Playwright / Chromium | Direct, Python and .NET demo pages loaded without JavaScript errors |
| Desktop / mobile layout | Checked 1440 px, 390 px and 320 px widths; no horizontal overflow |
| Demo lifecycle | Preview banner, disabled credentials, reported radio flags, formatted uptime, freshness, refresh, pin disclosures and disconnect/reconnect checked |
| Synthetic UART UI | Invalid UTF-8 credential length sent no command and left telemetry active; accepted request feedback and passphrase clearing checked |
| Synthetic failure | Status failure cleared values/disabled controls; explicit disconnect allowed reconnect |
| Documentation | Local link and whitespace checks passed |

The browser used local loopback servers and explicitly simulated data. The UART UI
check substituted transport methods in the browser; it did not open a serial device.
Temporary validation servers were stopped afterward. The launcher has no dedicated
test suite, as it is a manual operator tool.

## Evidence limits

No real board, BLE connection, Wi-Fi association or SD card was used.
The dashboard does not implement PicoForge's saved settings, LED/reboot controls,
USB drive handoff, benchmarks, card identity, Wi-Fi CLI console or unsupported telemetry.
Build/wiring references are distinguished from live device values.
See [qualification gaps](../qualification-gaps.md).
