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
[Host Validation](../../.github/workflows/host-validation.yml) runs Python 3.10 and 3.12
on Ubuntu, macOS and Windows. Node 22 and .NET 10 checks run once per OS, alongside
Python 3.12; the synthetic .NET UART check runs on Linux. Ceedling and documentation
links are independent jobs in that reusable workflow.
[Release packages](../deployment/release.md) additionally smoke-test the extracted Direct,
Python and self-contained .NET dashboards without connected hardware.
Browser previews must be explicitly marked simulated; never present demo screenshots as device measurements.
For a manual UI check, run each [dashboard](../guides/getting-started.md#3-choose-a-dashboard) in demo mode
and confirm the five full-width sections, collapsible UART/SD pin tables, preview banner,
disabled provisioning, sample freshness and disconnect clearing.

Keep protocol v1's field types and error semantics aligned across clients.
Adding telemetry requires updates to firmware serialization, JS validation, references and tests.
Do not expose serial bridges beyond loopback or introduce silent timeouts/fallback data.
