# Management protocol v1

## UART

UART0 uses the [hardware guide's serial configuration](../guides/hardware.md).
Requests are UTF-8 JSON objects terminated by LF (CR before LF is tolerated).
Maximum 511 payload bytes plus LF, one request outstanding, positive signed 32-bit `id`.
Responses are one JSON line; ROM boot messages may precede them and are ignored by hosts only
when they do not start with `{`. Malformed JSON replies are errors, not ignored telemetry.
Host response bound: 4096 bytes. Host request deadline: 5 seconds. IDs correlate replies;
stale IDs are ignored. Commands are never automatically retried.

### Status

```json
{"id":1,"op":"status"}
```

Illustrative reply, not a hardware observation:

```json
{"id":1,"ok":true,"status":{"protocol":1,"product":"ESPForge","board":"ESP32-S3-DevKitC","firmware":"0.1.0","uptime_ms":123000,"wifi_enabled":true,"ble_enabled":true,"wifi_connected":false,"wifi_error":0,"ble_error":0,"sd_mounted":false,"sd_error":-19}}
```

| Status field | Type / meaning |
| --- | --- |
| `protocol` | Integer, exactly 1 |
| `product`, `board`, `firmware` | Identity strings |
| `uptime_ms` | Nonnegative integer milliseconds since boot |
| `wifi_enabled`, `ble_enabled` | Boolean default intent |
| `wifi_connected` | Boolean association state, not DHCP/internet confirmation |
| `wifi_error` | Latest Wi-Fi initialization/submission/event result |
| `ble_error` | BLE initialization or latest advertising-start result |
| `sd_mounted`, `sd_error` | Boolean FAT mount result and its return code |

Zero means success; negative values are Zephyr errno values.
Wi-Fi event failure codes may be positive driver results. `-115` means a connect request is pending
on this target. `-11` can represent initialization pending. A nonzero SD result is not proof
the card is absent: wiring, formatting, power, and driver failures can also cause it.

### Wi-Fi connect

The UART uses **hex-encoded UTF-8 bytes**, not raw credential strings:

```json
{"id":2,"op":"wifi.connect","ssid_hex":"6c6162","psk_hex":"70617373776f7264"}
```

This example encodes SSID `lab` and illustrative passphrase `password`; use your own credentials.
SSID: 1-32 bytes; WPA2 passphrase: 8-63 bytes, or empty for open network. No NUL bytes.
Hex avoids Zephyr's JSON parser limitation: strings are validated but not unescaped.
Encoding is not encryption. The response is `{"id":2,"ok":true,"error":0}` when submitted;
follow status for the eventual association result.

Errors have `ok:false` and numeric `error`. Invalid requests return `-22`, unknown operations `-95`.
An oversized frame is discarded through LF, then returns `{"id":0,"ok":false,"error":-90}`.
Malformed/missing IDs use `id:0`; hosts treat that error as a rejected frame.
Firmware ignores unknown fields; bridges deliberately restrict their HTTP request schema.

## Host HTTP bridge

Python and .NET share:

- `GET /api/host`: `{ "name": "Python" | ".NET", "demo": boolean }`.
- `POST /api/request` with `Content-Type: application/json`: `{ "op": "status" }` or
  `{ "op": "wifi.connect", "ssid": "...", "psk": "..." }`.
  The bridge validates credentials, converts them to UART hex, and assigns IDs.
- Success returns the firmware reply. Invalid HTTP input is 400, unsupported media type 415,
  foreign Host/Origin 403, board timeout/error 502; JSON error bodies contain `ok:false` and `message`.
- Bodies are bounded to 2048 bytes. No CORS permission is granted. Only loopback binding is supported.
- Explicit demo mode returns the illustrative absent-card status and rejects commands.

## BLE

Service: `7a9c0001-6d8e-4c21-a120-455350464f52`.
Status characteristic: `7a9c0002-6d8e-4c21-a120-455350464f52`.
The service UUID is in advertising; `ESPForge` is in scan-response data.
The characteristic is read-only UTF-8 JSON containing the status object without a UART envelope or LF.
It is bounded below 512 bytes and supports ATT offset/long reads. Offset zero refreshes a snapshot;
subsequent offsets read that snapshot. One BLE connection is supported; there are no notifications,
writes, control tokens or credentials in BLE. Reads are public and do not require pairing.
