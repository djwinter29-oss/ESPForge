# .NET dashboard

ASP.NET Core on .NET 10, with System.IO.Ports 10.0.0.
From the repository root:

```sh
dotnet run --project host/dotnet/ESPForge -- --device /dev/ttyUSB0
```

Open <http://127.0.0.1:8002/> and click **Select board**. Windows uses the actual `COM` port.
Use `--port` for another HTTP port; only loopback binding is supported.
The process owns one serial handle, with DTR/RTS disabled, and serializes board requests.
Do not run it against a port already in use by Direct, Python, a terminal, or the flasher.

Before hardware arrives:

```sh
dotnet run --project host/dotnet/ESPForge -- --demo
```

The preview is labeled SIMULATED and rejects commands. It is not an automatic fallback.
Ctrl+C stops the server and disposes serial. Publishing copies shared web assets:

```sh
dotnet publish host/dotnet/ESPForge/ESPForge.csproj -c Release -p:PublishDir="$PWD/build/dotnet/"
dotnet build/dotnet/ESPForge.dll --demo
```

The published framework-dependent app requires .NET 10 ASP.NET Core runtime.
[Tagged release packages](../../../docs/deployment/release.md) instead provide self-contained
`linux-x64`, `win-x64` and `osx-arm64` hosts with web assets and dependency notices.
Extract the archive, then run `./ESPForge --demo` (`ESPForge.exe --demo` on Windows),
or use `--device PORT` for a real board. These packages require no installed .NET runtime.
Checks: `dotnet run --project host/dotnet/ESPForge.Tests`.

See [host development](../../../docs/development/host-tools.md),
[protocol](../../../docs/reference/protocol.md), and [getting started](../../../docs/guides/getting-started.md).
