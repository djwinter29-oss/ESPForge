# Contributing

Read the [architecture](docs/reference/architecture.md) and [documentation ownership](docs/README.md).
Keep changes focused and preserve the default Wi-Fi/BLE-enabled build and no-format storage behavior.
Update all affected host paths and protocol references together.

Run [firmware build checks](docs/development/firmware.md) and
[host checks](docs/development/host-tools.md) for affected code.
Record simulated versus real observations explicitly. SD-card hardware testing is not a prerequisite
for working on this initial source setup, but do not claim unobserved hardware qualification.

Do not commit credentials, local environments, generated builds, or personal device data.
See [security reporting](SECURITY.md) for sensitive reports.
