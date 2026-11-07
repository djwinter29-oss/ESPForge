# USB upload wrapper - 2026-11-07

## Observed software checks

- `bash -n tools/firmware/flash.sh` passed.
- Seven Python wrapper tests passed using temporary synthetic build artifacts and a fake
  `west` executable: argument rejection, help, missing artifacts, wrong board, dry-run safety,
  exact runner arguments including space-containing paths, and runner failure propagation.
- The wrapper's `--dry-run` passed against the actual ESP32-S3 build in the initialized
  Zephyr 4.2.0 workspace.
- `west flash --context` accepted the ESP32 runner, serial port, 460800 upload baud and
  `--no-erase` options with `--skip-rebuild`. Context inspection did not access a device.
- Documentation link and whitespace checks passed.

## Evidence limits

No USB device or board was opened, flashed or reset. This validates wrapper behavior
and runner option compatibility, not physical upload, application boot or radio operation.
No SD-card testing was performed. The dedicated wrapper tests and CI test step were
subsequently removed in favor of manual operation; the observations above are historical,
not a maintained automated suite. See [qualification gaps](../qualification-gaps.md).
