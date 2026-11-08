# ESPForge Direct Dashboard

Connect to an ESPForge ESP32-S3 board directly from desktop Chrome or Edge using **USB (WebHID)** or
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
| Release ZIP | Extract `espforge-direct-vX.Y.Z.zip` from the repository's Releases page | Yes, with browser support |

**From a repository checkout:**

```sh
tools/host/run-direct.sh --port 8000
```

**From an extracted release ZIP:**

```sh
python3 server.py --port 8000
```

For either local option, open **<http://127.0.0.1:8000/>**. The local server requires Python, but does not require the
ESPForge Python host package. Keep the default loopback binding for local use.

Opening `index.html` as a `file://` URL is not supported. WebHID and Web Bluetooth require a supported browser and
OS in a secure context, such as HTTPS or localhost. Bluetooth support on Linux varies by browser and adapter.

### Connect a board

1. Close other applications using the board's HID interface, including the Python/.NET hosts.
2. Choose **USB**, then **Select board**.
3. Select the ESPForge board (USB `0xCAFE:0x4021`) and grant access to its vendor HID interface.
4. Wait for valid identity, configuration, and fresh status reports before using controls.

The chooser opens even for previously authorized devices so you can select the intended board. Cancel leaves the
dashboard disconnected. Browser permission cannot override another application's HID access.

For Bluetooth, first provision a Control key over USB. Then choose **Bluetooth**, enter the saved key, and scan for
a board advertising as `ESPForge-…`. See [wireless setup](../../docs/guides/wireless.md).

### Safety essentials

- Do not run competing clients against the same board.
- A timeout or disconnect does **not** automatically retry a command. Resolve uncertain outcomes before continuing.
- Control keys authenticate commands; they do not encrypt BLE traffic. Flash credentials are not encrypted.
- Host tests and successful builds do not establish physical hardware, radio, or SD-card reliability.

## Dashboard layout

The layout follows the PicoForge Direct dashboard, but its implementation is independent.

| Section | What it shows or controls |
|---|---|
| Device information | Product, board/MCU, serial, system clock, reserved/total firmware RAM, and firmware version |
| Board configuration | Next-boot clock, Wi-Fi and Bluetooth switches, and reset cause |
| Pin configuration | Collapsible management UART and six-signal SDMMC GPIO tables |
| Live diagnostics | Uptime, Core 0 CPU load, temperature, storage bus speed, and wireless status |
| Storage | Card state, capacity, filesystem, and card identity |

Firmware RAM is boot-stable build accounting, not live heap or stack usage. ESPForge has one SD-card profile, so
the dashboard always saves profile 0 and shows the bus clock actually reported by Storage.

ESPForge does not implement the PicoForge LED, USB mass-storage handoff, storage benchmark, forced save, or TCP
CLI console. The dashboard omits those controls rather than inventing values; see the
[ESPForge implementation reference](../../docs/reference/espforge-implementation.md).

## Controls

Controls depend on board capabilities, connection type, and fresh reports.

| Action | USB | Authenticated BLE |
|---|---|---|
| System clock (Default, 80, 160, or 240 MHz) | Supported | Supported |
| Confirmed reboot | Supported | Supported |
| Radio switches, Wi-Fi credentials, and Control-key provisioning | Supported | USB-only |

### Wireless provisioning

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
uncertain operation; recovery does not survive ending the tab's session.

Async form results belong to their originating session, connection generation, and draft lifecycle. Old
completions cannot clear newer post-reconnect drafts.

## Protocol and connection

The dashboard implements the [HID report reference](../../docs/reference/usb-hid.md) and
[Bluetooth LE protocol](../../docs/reference/bluetooth.md) as narrowed by the
[ESPForge implementation reference](../../docs/reference/espforge-implementation.md):

- USB `0xCAFE:0x4021`, product ID 3, MCU 3, board model 1, and capability byte `0x96` (native SDMMC).
- Reports 1, 2, 3, 10, 12, and 20. Report 11 does not exist; unknown Input reports are ignored.
- Opcodes 1, 3, 4, and 13 (LED, MSC, benchmark, TCP CLI proof) are unsupported and never sent.
  Save flag 1 (forced save) is not used; the wireless commit flag is USB-only.
- BLE service `ef5c0000-7c91-4d70-8b32-6e856443f502` with `ef5cXXXX-…` characteristics. Characteristic `000b`
  is empty and not read. Zephyr's standard Service Changed is not awaited.
- Every BLE command carries an HMAC-SHA256 proof from the session's Control key; the transport checks the
  [worked proof vector](../../docs/reference/bluetooth.md#worked-proof-vector) in its tests.

WebHID provides payload bytes without the report ID; exact report lengths are required. Control operations
serialize Feature 20 SET/GET transactions and match transaction ID and opcode. Reconnect identifies the board
through Feature 1 and its stable UID, then reads outstanding results without SET replay. Telemetry expires after
750 ms and storage after 1500 ms. Wireless status polls every 500 ms during scan/test and every two seconds while
idle; it expires after three polling intervals.

## Architecture

Direct owns its HTML, CSS, favicon, browser modules, and local server. It imports nothing from `host/web/` and does
not use Web Serial. See the
[Direct independence policy](../../docs/development/host-tools.md#direct-dashboard-independence).

| Source | Responsibility |
|---|---|
| `server.py` | Loopback static server with security headers |
| `web/js/app.mjs` | Browser composition root; the only module reading browser globals |
| `web/js/protocol/` | Report codecs, constants, and opcode policy |
| `web/js/transport/` | Abort-aware WebHID/Web Bluetooth byte pipes, framing, and link authentication |
| `web/js/board/` | Session facade, connection lifecycle, command journal, recovery, polling, and use cases |
| `web/js/state/` | Domain/UI stores, allowlisted events, readiness selectors, and errors |
| `web/js/ui/` | Dashboard composition, view models, and DOM updates |
| `web/js/timers.mjs` | Abortable waits and page-owned timer scopes |

### Ownership rules

- Protocol and state do not access the DOM or browser device APIs. `app.mjs` supplies browser dependencies.
- Board modules write domain state through declared events; only the connection module advances connection phases.
- Commands are journalled before writing. The single-flight queue rejects overlaps rather than buffering stale
  intents. Link policy belongs to opcode descriptors, not transports.
- UI gating and use cases share `canRun`. Rendering reuses one eligibility snapshot and performs no device I/O.
- Domain errors use reason codes; `ui/messages.mjs` converts them to display text.
- Dashboard-only state uses a separate UI store. Wireless drafts/phases stay local to the form controller.

## Checks

Run commands below from the **repository root**. These are development checks, not a firmware build or hardware
qualification.

### Host tests and type checks

```sh
node host/direct/tests/run-tests.mjs
python3 -m unittest host.direct.tests.test_server -v
npx --yes --package typescript@5.9.3 tsc --project host/direct/web/js/tsconfig.json
```

JavaScript tests mirror `web/js` paths; for example, `board/commands.mjs` maps to
`tests/board/commands.test.mjs`. To isolate a failure:

```sh
node --test host/direct/tests/board/commands.test.mjs
```

| Test directory | Scope |
|---|---|
| `tests/integration/` | Composition root and cross-layer scenarios |
| `tests/contracts/` | Architecture, self-containment, and test-layout invariants |
| `tests/web/` | HTML and asset contracts |
| `tests/browser/` | Chromium interaction checks and their pinned dependency |
| `tests/types/` | Static-only negative type contracts; never run with Node |
| `tests/support/` | Shared Direct-only fixtures, including a fake ESPForge WebHID device |
| `tests/test_server.py` | Server behavior |

### Browser checks

```sh
python3 -m pip install -r host/direct/tests/browser/requirements.txt
python3 -m playwright install chromium
python3 host/direct/tests/browser/run.py
```

The runner owns an ephemeral loopback server and fails on incomplete checks, assertion failures, or browser errors.
Checks cover dialog focus/Escape, narrow viewports, invalid keys, Wi-Fi selection/cancellation/reset, save/reconnect
ownership, failed-key-save recovery, and telemetry render coalescing. A fake WebHID board drives the production
entry point through connect, input reports, and Save. A history-navigation check verifies draft disposal and journal
retention. They do not exercise real hardware.

## Further reading

- [Getting started](../../docs/guides/getting-started.md)
- [Wireless setup](../../docs/guides/wireless.md)
- [ESPForge implementation reference](../../docs/reference/espforge-implementation.md)
- [HID report reference](../../docs/reference/usb-hid.md)
- [Bluetooth LE protocol](../../docs/reference/bluetooth.md)
- [Boot settings](../../docs/reference/settings.md)
- [Host development](../../docs/development/host-tools.md)
- [Release and Pages publishing](../../docs/deployment/release.md)
