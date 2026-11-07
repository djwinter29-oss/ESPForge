# Host development

Python and .NET share the bridge-only dashboard in `host/web/` and the same HTTP bridge schema;
they translate validated HTTP requests to UART. See [Shared bridge dashboard](#shared-bridge-dashboard).
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

The Python suite includes a pseudo-terminal UART peer on POSIX and loopback HTTP tests.
Other platforms skip only the POSIX transport case. .NET tests exercise validation and can use
`--device PORT` to exercise the client against a synthetic UART peer. These are not firmware/hardware tests.
[Host Validation](../../.github/workflows/host-validation.yml) runs Python 3.10 and 3.12
on Ubuntu, macOS and Windows. Node 22 and .NET 10 checks run once per OS, alongside
Python 3.12; the synthetic .NET UART check runs on Linux. Ceedling and documentation
links are independent jobs in that reusable workflow.
On Ubuntu with Python 3.12 it also type-checks the Python package and verifies an installed wheel.
[Release packages](../deployment/release.md) additionally smoke-test the extracted Direct dashboard,
the installed Python wheel and the self-contained .NET dashboards without connected hardware.
Browser previews must be explicitly marked simulated; never present demo screenshots as device measurements.
For a manual UI check, run each [dashboard](../guides/getting-started.md#3-choose-a-dashboard) in demo mode
and confirm the five full-width sections, collapsible UART/SD pin tables, preview banner,
disabled provisioning, sample freshness and disconnect clearing.

Keep protocol v1's field types and error semantics aligned across clients.
Adding telemetry requires updates to firmware serialization, JS validation, references and tests.
Do not expose serial bridges beyond loopback or introduce silent timeouts/fallback data.

## Python host design

`host/python/` follows the PicoForge Python project layout: an installable `src/espforge` package
configured by [pyproject.toml](../../host/python/pyproject.toml), dependencies locked in `uv.lock`,
a mirrored `LICENSE`, and `tests/` with its own tool [requirements](../../host/python/tests/requirements.txt).
There is no `requirements.txt` or flat `server.py`; run the `espforge` command, `python -m espforge`,
or [tools/host/run-python.sh](../../tools/host/run-python.sh) from a checkout.

| Path | Responsibility |
|---|---|
| `src/espforge/__init__.py` | Version from the owning installed distribution, else `0.0.0-debug` |
| `src/espforge/cli.py`, `__main__.py` | `web` and `status` commands; pyserial is imported only after argument parsing |
| `src/espforge/protocol/` | `validate_request`, `ProtocolError` and `demo_status`; pure and import-safe without pyserial |
| `src/espforge/uart/` | `BoardClient`: one serial owner, serialized requests, bounded frames, no retries |
| `src/espforge/dashboard/` | Loopback HTTP server; serves `espforge/web` when installed, else `host/web/src` |
| `tests/test_<area>.py` | Protocol, UART, web, CLI, version and packaging contracts |

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

## Shared bridge dashboard

`host/web/` follows the PicoForge shared-dashboard layout. Both hosts serve `src/` as the site root:
Python reads it from the checkout, and .NET copies `src/**` into `wwwroot/` on build and publish.

| Path | Responsibility |
|---|---|
| `src/index.html`, `src/favicon.svg`, `src/css/dashboard.css` | Static page, icon and styles; no inline code |
| `src/js/app.mjs` | Composition root and session lifecycle; the only module reading browser globals |
| `src/js/dashboard-api.mjs` | `/api/host` and `/api/request` client and protocol v1 status validation |
| `src/js/dashboard.mjs` | Rendering and required-element lookup; no I/O |
| `src/js/operation-state.mjs` | Control eligibility shared by rendering and command handlers |
| `src/js/wireless-form.mjs` | UTF-8 credential limits and the Wi-Fi connect-and-save form |
| `tsconfig.json` | No-emit JSDoc type check of every `src/js` module |

`tests/js/X.test.mjs` mirrors `src/js/X.mjs`; `tests/integration/` mounts `app.mjs` on the parsed page,
`tests/contracts/` enforces the layout, and `tests/browser/` drives Chromium against the Python host package in demo mode.

```sh
node host/web/tests/run-tests.mjs
npx --yes --package typescript@5.9.3 tsc --project host/web/tsconfig.json
python3 host/web/tests/browser/run.py   # requires the editable host/python install and host/web/tests/browser/requirements.txt
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
