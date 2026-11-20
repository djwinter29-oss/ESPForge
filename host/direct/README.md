# ZephyrForge Direct Dashboard

Connect to a ZephyrForge ESP32-S3 board directly from desktop Chrome or Edge using **USB (WebHID)** or
**Bluetooth LE (Web Bluetooth)**. View live diagnostics, edit boot settings, provision Wi-Fi and Bluetooth, and
reboot the board without installing the Python or .NET host application.

The dashboard uses plain browser ES modules: no bundle, build step, or runtime JavaScript package installation is
required. It is fully independent of the Python/.NET dashboard assets in `host/web/`.

- [Quick start](#quick-start)
- [Dashboard layout](#dashboard-layout)
- [Controls](#controls)
- [Page lifecycle](#page-lifecycle)
- [Protocol and connection](#protocol-and-connection)
- [Architecture](#architecture)
- [Checks](#checks)
- [Further reading](#further-reading)

## Quick start

### Choose how to run it

| Option | Start here | USB / Bluetooth |
|---|---|---|
| Hosted dashboard | GitHub Pages, after a release is [published](../../docs/deployment/release.md) | Yes, with browser support |
| Repository checkout | Run the command below from the repository root | Yes, with browser support |
| Release ZIP | Extract `zephyrforge-direct-vX.Y.Z.zip` from the repository's Releases page | Yes, with browser support |

**From a repository checkout:**

```sh
tools/host/run-direct.sh --port 8000
```

**From an extracted release ZIP:**

```sh
python3 server.py --port 8000
```

For either local option, open **<http://127.0.0.1:8000/>**. The local server requires Python, but does not require the
ZephyrForge Python host package. It binds only to `127.0.0.1`, sends same-origin-only WebHID/Web Bluetooth permissions
and isolates top-level browsing contexts. These headers do not add encryption or change browser-granted device
permissions. Local startup does not require reverse DNS resolution.

Local checkout launches serve a temporary, versioned copy without editing the source assets. Like the other hosts,
versions use `vMAJOR.MINOR.PATCH` Git tags: the next commit after `v1.2.3` displays `1.2.4-dev.1`.
Direct also appends the short commit ID and `.dirty` when there are uncommitted changes. With no release tag,
it uses `0.0.0-dev.COUNT`; unavailable Git identity produces an explicit warning and `0.0.0-debug`.
Restart the server after commits or edits to refresh the snapshot.

Release ZIPs and Pages retain the exact release version, independently of any surrounding Git checkout.
The version label's tooltip shows the source commit; `build.json` records the version, commit and dirty state.
An inconsistent page or build identity is rejected rather than silently restamped. A custom `--directory`
without build metadata is still served unchanged.

Opening `index.html` as a `file://` URL is not supported. WebHID and Web Bluetooth require a supported browser and
OS in a secure context, such as HTTPS or localhost. Bluetooth support on Linux varies by browser and adapter.

### Connect a board

1. Close other applications using the board's HID interface, including the Python/.NET hosts.
2. Choose **USB**, then **Select board**.
3. Select the ZephyrForge board (USB `0xCAFE:0x4021`) and grant access to its vendor HID interface.
4. Wait for valid identity, configuration, and fresh status reports before using controls.

The chooser opens even for previously authorized devices so you can select the intended board. Cancel leaves the
dashboard disconnected. Browser permission cannot override another application's HID access.

For Bluetooth, first provision a Control key over USB. Then choose **Bluetooth**, enter the saved key, and scan for
a board advertising as `ZephyrForge-…`. See [wireless setup](../../docs/guides/wireless.md).

### Safety essentials

- Do not run competing clients against the same board.
- A timeout or disconnect does **not** automatically retry a command. Resolve uncertain outcomes before continuing.
- Disconnecting with unsaved board or wireless edits asks for confirmation and identifies the connected board.
- Control keys authenticate commands; they do not encrypt BLE traffic. Flash credentials are not encrypted.
- Host tests and successful builds do not establish physical hardware, radio, or SD-card reliability.

## Dashboard layout

| Section | What it shows or controls |
|---|---|
| Device information | Product, serial, system clock, firmware version, and flash/PSRAM capacities |
| Board configuration | Next-boot clock, Wi-Fi and Bluetooth switches, and reset cause |
| Pin configuration | Collapsible management UART, SDMMC and allocated card-detect GPIO tables |
| Live diagnostics | Uptime, Core 0 CPU load, temperature, storage bus speed, and wireless status |
| Storage | Card state, capacity, filesystem, and card identity |

Hover or focus Product for separate Board and MCU rows, or Module memory for SRAM/PSRAM reservations and flash capacity.
Click or tap either item to toggle its details; Escape closes them.
Firmware RAM is boot-stable build accounting, not live heap or stack usage.
ZephyrForge has one SD-card profile, so
the dashboard always saves profile 0 and shows the bus clock actually reported by Storage.

USB connections can explicitly export an initialized SD card and return it after confirmed OS eject;
see [SD ownership](../../docs/reference/sdcard.md#usb-drive-handoff). Bluetooth cannot change ownership.
ZephyrForge has no forced save. Local serving also provides a browser link to the native Wi-Fi shell.
The Device information RGB dropdown sends volatile colour requests over USB or an authenticated BLE session.
It requires fresh available-driver telemetry; uncertain commands are reconciled without replay.
When firmware advertises benchmarking, Storage offers a start-confirmation dialog naming the size and card wear,
cancellation, and live write/read verification results. Confirming after the board changes sends no command.
See [benchmark safety and timing](../../docs/reference/sdcard.md#optional-storage-benchmark); BLE mirrors progress
read-only.
Without this capability, benchmark controls and BLE benchmark-status polling are omitted.

### Wi-Fi shell

With the local server, fresh connected Wi-Fi status links to the
[unauthenticated plaintext diagnostic shell](../../docs/guides/console.md).
Keep the originating dashboard tab open and connected. Before opening, reading or sending input, the terminal
checks that tab's fresh board identity and reported address; replacement, stale status or a closed dashboard
disconnects it. The server does not own HID or BLE, and accepts only private LAN IPv4 targets on port 2323.
Wi-Fi connectivity is not proof of listener readiness; failed TCP connections are reported explicitly.

The relay is available only through same-origin loopback HTTP requests. Static hosting, including Pages and
other local static servers, keeps Wi-Fi status as plain text rather than presenting a broken shell link.
`GET /api/console/capabilities` reports `{"available":true}` on the local ZephyrForge server.
Direct opens with `POST /api/console`, exactly `{"ipv4":"REPORTED_ADDRESS"}`; the remaining header-token,
bounded packet and no-replay contract matches the [bridge API](../web/README.md#browser-shell).
The release ZIP includes its standard-library relay and requires no Python host installation.

Opening discards any previous client's unfinished input, then requests native `shell echo on` once for that
session, without changing saved product settings.
The terminal uses bounded plain-text output and supports native editing/erase sequences, not complete VT100
emulation or colour styling. Control keys, arrows and Tab work; Shift+Tab leaves the terminal and multiline
paste requires confirmation. Uncertain input is never retried. Close the shell tab to disconnect;
abandoned relay sessions expire after 15 idle seconds.

## Controls

Controls depend on board capabilities, connection type, and fresh reports.

| Action | USB | Authenticated BLE |
|---|---|---|
| System clock (Default, 80, 160, or 240 MHz) | Supported | Supported |
| Confirmed reboot | Supported | Supported |
| Radio switches, Wi-Fi credentials, and Control-key provisioning | Supported | USB-only |

### Wireless provisioning

Wi-Fi follows the Python/.NET dashboards' scan/select, **Other network…**, password and **Test connection** flow.
Open networks hide the password field; long network names and dialog actions wrap on narrow screens.

1. Over USB, choose **Configure…** for the radio.
2. For Wi-Fi, select or enter a network and successfully test it.
3. For Bluetooth, generate a Control key and save a copy before committing it.
4. Use **Save&Reboot** to persist the changes.

Save a successfully tested Wi-Fi pair before its staging lifetime expires, normally within ten minutes.
A failed replacement test invalidates the previous tested pair and blocks Save until another test succeeds or
cancellation clears the temporary credentials. If cancellation fails, the dialog stays open and Save remains blocked
until a retry or verified reconnect result confirms clearing. A failed replacement-key save wipes submitted key
text; regenerate it or disable Bluetooth to abandon the replacement. Disabling a configured radio erases its saved
credentials on a successful save.

The form displays its Save-block reason and uses the same reason for eligibility, request rejection, and the Save
button title.

### Saving and rebooting

**Save&Reboot** requires confirmation and verifies the settings command's completion before reporting success.
Firmware persists the settings and schedules a reboot; configuration is reread after reconnection.
Over Bluetooth, Save keeps the saved radio switches. **Reboot** is a separate, confirmed action.
Cancel or Escape sends no command. Safety gates are checked again at confirmation, not just when opening a dialog.

## Page lifecycle

Navigating away releases board resources. Returning through the browser's history cache reloads into a disconnected
state: drafts are cleared; reconnect explicitly. Commands are never automatically replayed.

Pending-operation journals remain in the current tab's `sessionStorage` for same-board reconciliation.
They contain allowlisted transaction/profile/commit-mask or generation facts, never SSIDs, passwords, or Control
keys. Missing, inaccessible, or invalid journal storage blocks writes. Keep the tab open while resolving an
uncertain operation; recovery does not survive ending the tab's session. If same-board recovery remains uncertain,
**Abandon unresolved recovery…** clears only the local journal after explicit confirmation; use it only after
independently checking the board. It does not undo or verify the operation. Never retry until its effect is known.

Async form results belong to their originating session, connection generation, and draft lifecycle. Old
completions cannot clear newer post-reconnect drafts.

## Protocol and connection

The [USB HID](../../docs/reference/usb-hid.md) and
[Bluetooth LE](../../docs/reference/bluetooth.md) specifications own report layouts, discovery identifiers,
capabilities, authentication and supported commands. Direct validates those contracts before enabling operations.

WebHID provides payload bytes without the report ID; exact report lengths are required. Control operations
serialize Feature 20 SET/GET transactions and match transaction ID and opcode. Reconnect identifies the board
through Feature 1 and its stable UID, then reads outstanding results without SET replay. Telemetry expires after
750 ms and storage after 1500 ms. Wireless status polls every 500 ms during scan/test and every two seconds while
idle; it expires after three polling intervals.

## Architecture

Direct owns its HTML, CSS, favicon, browser modules, and local server. It imports nothing from `host/web/` and does
not use Web Serial. See the
[Direct independence policy](../../docs/development/host-tools.md#direct-dashboard-independence).

| Layer | Responsibility |
|---|---|
| Static server | Loopback hosting, security headers, and revalidated static assets |
| Application | Browser integration and lifecycle ownership |
| Protocol | Report codecs, constants and opcode policy |
| Transport | Abort-aware WebHID/Web Bluetooth byte pipes, framing and authentication |
| Board session | Connection lifecycle, command journal, recovery, polling and use cases |
| State | Domain/UI stores, allowlisted events, readiness selectors and errors |
| Presentation | Dashboard composition, feature dialogs, view models and DOM updates |
| Timers | Abortable waits and page-owned timer scopes |

### Ownership rules

- Protocol and state do not access the DOM or browser device APIs; the application supplies browser dependencies.
- Board modules write domain state through declared events; only the connection module advances connection phases.
- Commands are journalled before writing. The single-flight queue rejects overlaps rather than buffering stale
  intents. Link policy belongs to opcode descriptors, not transports.
- UI gating and use cases share `canRun`. Rendering reuses one eligibility snapshot and performs no device I/O.
- Domain errors use reason codes; the presentation layer converts them to display text.
- Dashboard-only state uses a separate UI store. Wireless drafts/phases stay local to the form controller.

## Checks

Run commands below from the **repository root**. These are development checks, not a firmware build or hardware
qualification.

### Host tests and type checks

```sh
node host/direct/tests/run-tests.mjs
python3 -m unittest host.direct.tests.test_server -v
npx --yes --package typescript@5.9.3 tsc --project host/direct/tests/types/tsconfig.json
npx --yes --package typescript@5.9.3 tsc --project host/direct/tests/types/tsconfig.core-strict.json
npx --yes --package typescript@5.9.3 tsc --project host/direct/tests/types/tsconfig.protocol-strict.json
npx --yes --package typescript@5.9.3 tsc --project host/direct/tests/types/tsconfig.board-runtime-strict.json
```

The full runtime check covers all browser modules; full strict mode is enforced for the shared core utilities,
protocol codecs, board lifecycle, recovery, polling, transports and reducer. The remaining runtime modules are
moving to strict checking incrementally.

To isolate command-lifecycle failures:

```sh
node --test host/direct/tests/board/commands.test.mjs
```

| Test directory | Scope |
|---|---|
| `tests/integration/` | Composition root and cross-layer scenarios |
| `tests/contracts/` | Architecture, self-containment, and test-layout invariants |
| `tests/ui/` | Presentation, console, and DOM behavior |
| `tests/web/` | HTML and asset contracts |
| `tests/browser/` | Chromium interaction checks and their pinned dependency |
| `tests/types/` | TypeScript config and static-only negative type contracts; never run with Node |
| `tests/support/` | Shared Direct-only fixtures, including a fake ZephyrForge WebHID device |
| `tests/test_server.py` | Server behavior |

### Browser checks

```sh
python3 -m pip install -r host/direct/tests/browser/requirements.txt
python3 -m playwright install chromium
python3 host/direct/tests/browser/run.py
```

The runner owns an ephemeral loopback server and fails on incomplete checks, assertion failures, browser errors,
or failed runtime asset loads.
It also runs the vendored axe-core 4.10.3 WCAG 2.1 A/AA and best-practice rules against the dashboard and each dialog;
its MPL-2.0 and bundled third-party notices are in `tests/browser/vendor/`. Checks cover dialog focus/Escape,
narrow viewports, invalid keys, Wi-Fi selection/cancellation/reset, save/reconnect ownership, failed-key-save
recovery, module request count/transfer size, and telemetry render coalescing. A fake WebHID board drives the
production entry point through connect, input reports, and Save. A history-navigation check verifies draft
disposal and journal retention. They do not exercise real hardware.

The JavaScript runner enforces aggregate coverage of 90% lines, 80% branches, and 85% functions, plus per-file floors
of 80% lines, 55% branches, and 50% functions. LCOV output provides per-file metrics independently of Node's
human-readable coverage table. Repeated source records combine hits by line, branch and function identity rather
than averaging execution totals; merging records without complete per-item details is an error.
The type checks cover the complete runtime module graph and full strict checks for protocol modules, shared core
utilities, board lifecycle, recovery, polling, transports and reducer. Other runtime modules are moving to strict
checking incrementally.

## Further reading

- [Getting started](../../docs/guides/getting-started.md)
- [Wireless setup](../../docs/guides/wireless.md)
- [ZephyrForge implementation reference](../../docs/reference/zephyrforge-implementation.md)
- [HID report reference](../../docs/reference/usb-hid.md)
- [Bluetooth LE protocol](../../docs/reference/bluetooth.md)
- [Boot settings](../../docs/reference/settings.md)
- [Host development](../../docs/development/host-tools.md)
- [Release and Pages publishing](../../docs/deployment/release.md)
