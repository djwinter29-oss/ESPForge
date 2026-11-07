# Host development

Direct, Python and .NET intentionally share dashboard assets and HTTP bridge schema.
Direct's UART/BLE clients do not call a host backend. Python/.NET translate validated HTTP requests to UART.

From the repository root:

```sh
python3 -m pip install -r host/python/requirements.txt
python3 -m unittest discover -s host/python/tests -v
node --test host/web/tests/*.test.js
dotnet build host/dotnet/ESPForge
dotnet run --project host/dotnet/ESPForge.Tests
python3 tools/check_dotnet_serial.py
python3 tools/check_docs.py
```

The Python suite includes a pseudo-terminal UART peer on POSIX and loopback HTTP tests.
Other platforms skip only the POSIX transport case. .NET tests exercise validation and can use
`--device PORT` to exercise the client against a synthetic UART peer. These are not firmware/hardware tests.
JavaScript tests validate status, framing and credential byte boundaries.
Browser previews must be explicitly marked simulated; never present demo screenshots as device measurements.
For a manual UI check, run each [dashboard](../guides/getting-started.md#3-choose-a-dashboard) in demo mode
and confirm the six sections, preview banner, disabled provisioning, and disconnect clearing.

Keep protocol v1's field types and error semantics aligned across clients.
Adding telemetry requires updates to firmware serialization, JS validation, references and tests.
Do not expose serial bridges beyond loopback or introduce silent timeouts/fallback data.
