# USB HID, BLE and Wi-Fi Implementation

Date: 2026-11-07. Scope: the firmware, Python, .NET and Direct implementation of the
[USB HID](../../reference/usb-hid.md), [Bluetooth](../../reference/bluetooth.md) and
[settings](../../reference/settings.md) specifications as amended by the
[ESPForge profile](../../reference/espforge-profile.md).

## What ran

| Check | Result |
| --- | --- |
| `west build` for `esp32s3_devkitc/esp32s3/procpu`, Zephyr v4.3.2, SDK 0.17.4 | Clean, 0 warnings |
| `tools/check_firmware_config.py` | Pass |
| `bundle exec ceedling clobber test:all` | 59 tests pass |
| `node host/web/tests/run-tests.mjs` | 177 tests pass |
| `node host/direct/tests/run-tests.mjs` | 110 tests pass |
| Python `unittest` (`host/python/tests`) and Direct server tests | Pass (167 Python tests) |
| `dotnet test host/dotnet/ESPForge.Tests` | 218 tests pass |
| `pyright` | 0 errors |
| `tools/check_python_wheel.py` | Pass |
| Browser checks (`host/web/tests/browser/run.py`, `host/direct/tests/browser/run.py`) | Pass with simulated boards |
| `tools/check_docs.py`, `actionlint` | Pass |

## Simulated

Dashboard browser checks use fake WebHID boards or hosts with no board attached. Report codecs, BLE
authentication and staging logic run natively under Ceedling with proof vectors.

## Not tested

No physical board was connected. USB HID enumeration, BLE pairing and transfer, Wi-Fi association,
SD-card mounting and reboot behavior on hardware all remain unverified. SD-card testing is deferred.
