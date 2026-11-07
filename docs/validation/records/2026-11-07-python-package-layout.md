# Python host package layout - 2026-11-07

## Scope

Restructured `host/python/` to follow the PicoForge Python project layout and settings:
`pyproject.toml` (setuptools, `espforge` 0.0.0.dev0, BSD-3-Clause, pinned `pyserial==3.5`, `espforge` console
script, strict pyright), `uv.lock`, a mirrored `LICENSE`, and an installable `src/espforge` package with
`protocol/`, `uart/`, `dashboard/`, `cli.py`, `__main__.py` and version resolution. The wheel maps
`host/web/src` to `espforge.web`. The flat `server.py`, `protocol.py` and `requirements.txt` were removed.
Added `tools/host/run-python.sh`, `tools/check_python_wheel.py` and `publish-pypi.yml`. The release workflow now
attaches a verified wheel instead of a Python source ZIP.

## Observed checks

| Check | Observation |
| --- | --- |
| Python 3.12.14, editable install (`unittest`) | 28 passed: protocol, UART (fake and POSIX pseudo-terminal), web, CLI, version and packaging |
| Python 3.10.22, editable install | 28 run, 24 passed, 4 `tomllib` checks skipped by design |
| pyright 1.1.414, strict | 0 errors |
| `uv lock` (uv 0.13.7) | Lock matches the declared pin and version |
| Wheel build and clean install (`check_python_wheel.py`, isolated) | Imports, `espforge`/`python -m espforge` entry points, demo server and all 8 `host/web/src` assets verified |
| Release jobs simulated with version 1.2.3 | Stamped `espforge-1.2.3` wheel verified; Direct ZIP smoke check passed |
| Source launcher | First-run install, `--version` and `web --demo` reply verified |
| Shared dashboard Chromium checks | 4 passed through the packaged Python server |
| Web/Direct Node, .NET and synthetic serial checks, actionlint, documentation links | Passed |

setuptools warns that the `css` and `js` asset folders are not Python packages. PicoForge's identical
configuration produces the same warning, and the wheel contents are verified.

## Evidence limits

No ESP32-S3 hardware was connected and PyPI publishing was not exercised; Trusted Publishing must
be configured first. These checks do not qualify UART, Wi-Fi, BLE or SD behavior.
