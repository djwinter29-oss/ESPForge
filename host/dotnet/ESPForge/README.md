# ESPForge .NET Host

The .NET 10 host monitors the ESPForge vendor HID interface (`0xCAFE:0x4021`) and serves the shared local dashboard at
`http://127.0.0.1:8002/` by default. Override the port with `--port PORT`; only one dashboard server can bind to a
port at a time.

Python and .NET share their own frontend, but must not share any code with Direct. See the
[host tools guide](../../../docs/development/host-tools.md).

```sh
dotnet run --project host/dotnet/ESPForge/ESPForge.csproj
```

Select a default board at launch with `--serial SERIAL` (the 16 hex-digit Report 1 UID) or `--device-path HID_PATH`.
The options are mutually exclusive; without either, the first discovered board is selected. Use **Rescan** to refresh
the board list. On Linux, grant HID access once with
[hid-permissions-setup.sh](../../../tools/host/hid-permissions-setup.sh), then reconnect the board.
[run-dotnet.sh](../../../tools/host/run-dotnet.sh) checks those permissions and runs this project.

The host follows the [USB HID reference](../../../docs/reference/usb-hid.md) as amended by the
[ESPForge profile](../../../docs/reference/espforge-profile.md): product `0x0003`, MCU `3` (ESP32-S3), board model `1`,
capabilities `0x8E`, clocks `0`/`80`/`160`/`240` MHz, SD-card profile `0`, and radio switches bit 0 (Wi-Fi) and bit 1
(BLE). Identity, configuration, or storage reports outside that profile are rejected as invalid.

## HTTP API

The routes and JSON fields match the PicoForge dashboard API, without the features ESPForge lacks.

| Route | Purpose |
| --- | --- |
| `GET /api/boards` | Discover attached boards. Other requests select one with `?board=<id>`. |
| `GET /api/status` | Hardware identity, telemetry, SD-card status, board configuration, and wireless status. |
| `POST /api/settings` | Save `system_clock_mhz`, `sdcard_profile` (`0`), and `radios` (`0`-`3`), verified by HID readback. |
| `POST /api/reboot` | Reboot with `{"confirm":true}`. |
| `POST /api/control/resync` | Clear an uncertain command outcome after confirmation. |
| `POST /api/wireless` | Save Wi-Fi credentials and radio switches. `tcp_cli_enabled` is accepted only as `false`. |
| `POST /api/wireless/scan`, `/test`, `/cancel` | Scan, test candidate credentials, and cancel a test. |

There is no LED, MSC, benchmark (self-test), forced save, or TCP CLI console. `/api/led`, `/api/msc`,
`/api/msc/force-return`, `/api/self-test`, the console API, and the `/console` page are not served.
`confirm_data_loss:true` on `POST /api/settings` is refused with HTTP 409. Status keeps the shared shape: `memory.msc`
is always disabled and `self_test` is `null`.
Run with `ASPNETCORE_ENVIRONMENT=Development` to expose `/openapi/v1.json`.

Serial-identified boards retain their monitor for at least 30 seconds after disappearing from a successful rescan,
allowing brief USB reconnects without losing selection. Active commands postpone retirement; uncertain outcomes keep
the monitor until confirmed re-sync or shutdown. Boards without serial numbers use their HID device path as identity.
If a HID write times out or its result cannot be matched, the dashboard marks the command outcome uncertain and blocks
further writes rather than replaying or overwriting the result. Persistent errors, invalid reports, and permission
failures remain errors.

## Source Layout

- `Protocol/` — HID report models, ESPForge profile validation, and wireless report codecs.
- `Hid/` — USB HID transport (HidSharp) and serialized device monitoring.
- `Dashboard/` — board selection and grouped status/wireless endpoints.

Build and publish always copy the current `host/web/src` assets into `wwwroot`; the .NET host serves those files,
not a separate dashboard implementation. Report 2 supplies the saved service switches; it is cached per HID handle and
re-read after a settings save or reconnect, so a Wi-Fi poll reads only Report 12. Omitted credentials are not staged.
Tested saves commit the staged pair without restaging it. Status and scan entries include escaped `ssid` labels and
lossless `ssid_hex`; test/save requests accept `ssid_hex` for opaque network names.

Board monitoring starts asynchronously on first access, so the first status response can briefly show that it is
waiting for HID. The monitor polls every 100 ms.

## Tests

```sh
dotnet test host/dotnet/ESPForge.Tests/ESPForge.Tests.csproj
```

The xunit tests cover the HID protocol, monitor, and dashboard API with fake devices; asset checks require the source
checkout. They do not validate physical USB detach/reconnect.
