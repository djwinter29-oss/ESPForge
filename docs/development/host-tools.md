# Host development

Python and .NET share a dashboard and HTTP API; each host owns the
board's USB HID interface and decodes the [USB HID reports](../reference/usb-hid.md).
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

The Python host is an installable package with pinned dependencies and separate test tooling.
Run `espforge`, `python -m espforge`, or the checkout launch script.

| Layer | Responsibility |
|---|---|
| Package identity | Version from the installed distribution, with a development fallback |
| CLI | `status`, `web` and `reboot` commands with `--serial` / `--device-path` selection |
| Reports | Pure decoders and encoders for Reports 1, 2, 3, 10, 12 and 20 with ESPForge-specific validation |
| HID transport | Device discovery, Feature/Input reads and Control writes |
| Dashboard services | Loopback Flask app, board discovery, one serialized monitor per board and the HTTP API |
| Tests | Report codecs, HID device, monitor, boards, wireless, web API, CLI, version and packaging contracts |

Package builds require an explicit copy of the shared dashboard assets; there is no custom build hook.
The staged copy is ignored by Git and included in both wheels and source distributions.
Source-checkout launches and editable installs need no staging and use the shared dashboard directly.
Python type-checking runs in strict mode. Runtime dependency pins live in `pyproject.toml`; pip handles installation
without a checked-in lockfile. Hatchling builds the package, and hatch-vcs derives its version from Git tags.
Editable installs use the same distribution metadata as wheels; reinstall after a commit or tag change to refresh it.
To stage the current assets and check a wheel locally on Linux/macOS, from the repository root:

```sh
rm -rf host/python/src/espforge/web
mkdir -p host/python/src/espforge/web
cp -R host/web/src/. host/python/src/espforge/web/
python3 -m pip wheel --no-deps host/python --wheel-dir build/wheels
python3 -m venv build/wheel-check
build/wheel-check/bin/python -m pip install build/wheels/*.whl
build/wheel-check/bin/python -I tools/check_python_wheel.py
```

Repeat staging before every checkout package build so deleted or changed assets do not leave stale copies.
After packaging, remove `host/python/src/espforge/web` to resume serving the shared checkout assets directly.
A source distribution built after staging already contains the assets and needs no external copy when building its wheel.

## Shared dashboard

The .NET host uses MinVer with `vMAJOR.MINOR.PATCH` Git tags, patch increments and `dev` prerelease identifiers.
Builds need Git history and tags to calculate development versions. The dashboard displays the assembly's
informational version without an SDK-appended commit hash. After a commit, tag or version override change, use
`dotnet build host/dotnet/ESPForge/ESPForge.csproj --no-incremental` to refresh both the assembly version and
cached dependency metadata.
For an explicit package version, pass `-p:MinVerVersionOverride=1.2.3` to `dotnet publish`.

Both hosts serve the same static assets: Python uses the checkout or installed package,
and .NET includes the assets during build and publication.

| Layer | Responsibility |
|---|---|
| Static assets | Page, icon and styles; no inline code |
| Application lifecycle | Browser integration and session ownership |
| API client | Board, status, settings, reboot, re-sync and wireless routes |
| Presentation | Rendering without device or network I/O |
| Operation policy | Control eligibility shared by rendering and command handlers |
| Wireless forms | Wi-Fi scan/test and Control key dialog |

Unit tests cover individual responsibilities; integration tests exercise the assembled page and shared status
contract. Browser checks drive Chromium against both hosts with fake boards.
See the [shared dashboard README](../../host/web/README.md) for the route table.

```sh
node host/web/tests/run-tests.mjs
npx --yes --package typescript@5.9.3 tsc --project host/web/tsconfig.json
python3 host/web/tests/browser/run.py   # requires the editable host/python install, the .NET SDK and host/web/tests/browser/requirements.txt
```

## Direct dashboard independence

Direct owns its static page, styles, layered browser modules and loopback static server.

- Direct must not import, link or copy at runtime from `host/web/`; `host/web/` must not reference Direct.
- Browser integration belongs at the application boundary; lower layers receive dependencies by injection.
- Lower-layer JavaScript is type-checked.
- Unit and architectural contract tests enforce the layer boundaries.

```sh
node host/direct/tests/run-tests.mjs
python3 -m unittest host.direct.tests.test_server -v
python3 host/direct/tests/browser/run.py   # requires host/direct/tests/browser/requirements.txt
```

Host Validation runs both dashboards' Node tests and the Direct server tests on every OS, both
TypeScript checks on Ubuntu, and both Chromium browser checks in a separate job.
