# Host development

Python and .NET share the dashboard in `host/web/` and serve the same PicoForge-style HTTP API; each host owns the
board's USB HID interface and decodes the [USB HID reports](../reference/usb-hid.md) as narrowed by the
[ESPForge profile](../reference/espforge-profile.md). See [Shared dashboard](#shared-dashboard).
The [Direct dashboard](../../host/direct/README.md) is independent: see
[Direct dashboard independence](#direct-dashboard-independence).

From the repository root:

```sh
python3 -m pip install --editable host/python -r host/python/tests/requirements.txt
python3 -m unittest discover -s host/python/tests -v
(cd host/python && pyright)
node host/web/tests/run-tests.mjs
dotnet test host/dotnet/ESPForge.Tests
python3 tools/check_docs.py
```

Python and .NET tests use fake HID devices and loopback HTTP; they do not open real hardware and are not firmware
or hardware tests. [Host Validation](../../.github/workflows/host-validation.yml) runs Python 3.10 and 3.12 on
Ubuntu, macOS and Windows. Node 22 and .NET 10 checks run once per OS, alongside Python 3.12. Ceedling and
documentation links are independent jobs in that reusable workflow.
On Ubuntu with Python 3.12 it also type-checks the Python package and verifies an installed wheel.
[Release packages](../deployment/release.md) additionally smoke-test the extracted Direct dashboard,
the installed Python wheel and the self-contained .NET dashboards without connected hardware.
There is no demo mode: without a board, the hosts show an empty board list and never invent values.

Keep report decoding, field names and error semantics aligned across the three clients. Adding telemetry requires
updates to the firmware report, all three decoders, the references and tests. Do not expose the hosts beyond
loopback, retry uncertain commands, or introduce silent timeouts/fallback data.

On Linux, run [hid-permissions-setup.sh](../../tools/host/hid-permissions-setup.sh) once to install the udev rule
for `CAFE:4021`. [run-python.sh](../../tools/host/run-python.sh) and [run-dotnet.sh](../../tools/host/run-dotnet.sh)
call [hid-permissions-check.sh](../../tools/host/hid-permissions-check.sh) before starting.

## Python host design

`host/python/` follows the PicoForge Python project layout: an installable `src/espforge` package
configured by [pyproject.toml](../../host/python/pyproject.toml), dependencies locked in `uv.lock`,
a mirrored `LICENSE`, and `tests/` with its own tool [requirements](../../host/python/tests/requirements.txt).
There is no `requirements.txt` or flat `server.py`; run the `espforge` command, `python -m espforge`,
or [tools/host/run-python.sh](../../tools/host/run-python.sh) from a checkout.

| Path | Responsibility |
|---|---|
| `src/espforge/__init__.py` | Version from the owning installed distribution, else `0.0.0-debug` |
| `src/espforge/cli.py`, `__main__.py` | `status`, `web` and `reboot` commands with `--serial` / `--device-path` selection |
| `src/espforge/reports/` | Pure decoders and encoders for Reports 1, 2, 3, 10, 12 and 20 with ESPForge profile checks |
| `src/espforge/hid/` | `ESPForgeHid`: `hidapi` transport for `CAFE:4021`, Feature/Input reads and Control writes |
| `src/espforge/dashboard/` | Flask app on loopback: board discovery, one serialized monitor per board, the HTTP API; serves `espforge/web` when installed, else `host/web/src` |
| `tests/test_<area>.py` | Report codecs, HID device, monitor, boards, wireless, web API, CLI, version and packaging contracts |

`[tool.setuptools]` maps `espforge.web` to `../web/src`, so the wheel bundles exactly the shared
dashboard assets and nothing is copied into `host/python`. pyright runs in strict mode over
`src/espforge`. After changing dependencies, update `pyproject.toml` and run `uv lock` in
`host/python`; the packaging tests require the lock to match the declared pins and version.
To check a wheel locally on Linux/macOS:

```sh
python3 -m pip wheel --no-deps host/python --wheel-dir build/wheels
python3 -m venv build/wheel-check
build/wheel-check/bin/python -m pip install build/wheels/*.whl
build/wheel-check/bin/python -I tools/check_python_wheel.py 0.0.0.dev0
```

## Shared dashboard

`host/web/` follows the PicoForge shared-dashboard layout. Both hosts serve `src/` as the site root:
Python reads it from the checkout, and .NET copies `src/**` into `wwwroot/` on build and publish.

| Path | Responsibility |
|---|---|
| `src/index.html`, `src/favicon.svg`, `src/css/dashboard.css` | Static page, icon and styles; no inline code |
| `src/js/app.mjs` | Composition root and session lifecycle; the only module reading browser globals |
| `src/js/dashboard-api.mjs` | Client of the board, status, settings, reboot, re-sync and wireless routes |
| `src/js/dashboard.mjs` | Rendering and required-element lookup; no I/O |
| `src/js/operation-state.mjs` | Control eligibility shared by rendering and command handlers |
| `src/js/wireless-form.mjs` | Wi-Fi scan/test and Control key dialog |
| `tsconfig.json` | No-emit JSDoc type check of every `src/js` module |

`tests/js/X.test.mjs` mirrors `src/js/X.mjs`; `tests/integration/` mounts `app.mjs` on the parsed page,
`status-contract.json` pins the status JSON shared by both hosts, and `tests/browser/` drives Chromium against the
Python and .NET hosts with fake boards. See the [shared dashboard README](../../host/web/README.md) for the route table.

```sh
node host/web/tests/run-tests.mjs
npx --yes --package typescript@5.9.3 tsc --project host/web/tsconfig.json
python3 host/web/tests/browser/run.py   # requires the editable host/python install, the .NET SDK and host/web/tests/browser/requirements.txt
```

## Direct dashboard independence

`host/direct/` follows the PicoForge Direct layout and owns everything it serves: `web/index.html`,
`web/favicon.svg`, `web/css/`, layered ES modules in `web/js/`, and the loopback `server.py`.

- Direct must not import, link or copy at runtime from `host/web/`; `host/web/` must not reference Direct.
- Only `web/js/app.mjs` reads browser globals; lower layers receive dependencies by injection.
- Every module except `app.mjs` is listed in `web/js/tsconfig.json` and starts with `// @ts-check`.
- Each `tests/X.test.mjs` mirrors `web/js/X.mjs`; `tests/contracts/` enforces these rules.

```sh
node host/direct/tests/run-tests.mjs
python3 -m unittest host.direct.tests.test_server -v
python3 host/direct/tests/browser/run.py   # requires host/direct/tests/browser/requirements.txt
```

Host Validation runs both dashboards' Node tests and the Direct server tests on every OS, both
TypeScript checks on Ubuntu, and both Chromium browser checks in a separate job.
