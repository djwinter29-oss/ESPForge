# Release procedure

No automated publishing or prebuilt release is configured yet.

1. Build from a clean pinned workspace using the [firmware workflow](../development/firmware.md).
2. Run [host checks](../development/host-tools.md) and document versions/configuration/results.
3. Publish .NET with
   `dotnet publish host/dotnet/ESPForge/ESPForge.csproj -c Release -p:PublishDir="$PWD/build/dotnet/"`.
4. Package firmware `zephyr.bin`, `zephyr.elf`, generated `.config` and `zephyr.dts`, the relevant source revision,
   flashing instructions, project LICENSE and all applicable third-party notices.
5. Package Direct with sibling `host/direct/` and `host/web/`. Package Python as a source checkout including
   `host/python/` and `host/web/`; do not claim a PyPI package exists.
6. Include checksums and [qualification limits](../validation/qualification-gaps.md). Clearly label
   firmware built-but-not-flashed and any simulated screenshots.

Before distributing radio-enabled binaries, review Zephyr, Espressif HAL/blob, FatFs, mbedTLS,
pyserial and System.IO.Ports licenses and applicable radio/regulatory requirements.
Do not describe a successful software build as SD-card or wireless hardware qualification.
