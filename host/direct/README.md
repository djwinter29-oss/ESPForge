# Direct dashboard

A static browser dashboard with USB-UART Web Serial and read-only Web Bluetooth.
It uses the same device/configuration/diagnostics/storage/pin sections as Python and .NET.
There is no Python or .NET serial bridge in the Direct path.

From the repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000/host/direct/> in supported desktop Chrome/Edge.
Select USB-UART and Connect, then choose the board's serial bridge.
Web Serial/Web Bluetooth require a secure context (localhost or HTTPS); `file://` is unsupported.
Browser/OS support differs, especially Bluetooth on Linux. UART does not require a USB HID firmware interface.

Select **Simulated preview** to review the layout before attaching hardware.
The banner explicitly marks synthetic data; no hardware or SD test runs.
Bluetooth can only read status. Use UART for Wi-Fi provisioning.
Disconnect before changing transports, flashing, or opening another serial host.
On failure the dashboard clears stale values and stops polling; reconnect explicitly.

Keep `host/direct/` and its sibling `host/web/` together when statically hosting.
No hosted site is provisioned by this checkout.

See [getting started](../../docs/guides/getting-started.md), [wireless](../../docs/guides/wireless.md),
and the [protocol](../../docs/reference/protocol.md).
