# Contributing

Read the [architecture](docs/reference/architecture.md) and [documentation ownership](docs/README.md).
Keep changes focused and preserve the default Wi-Fi/BLE-enabled build and no-format storage behavior.
Update all affected host paths and protocol references together.

Run [Ceedling unit tests and firmware build checks](docs/development/firmware.md) and
[host checks](docs/development/host-tools.md) for affected code.
Pull requests use the same reusable [GitHub validation workflows](docs/deployment/release.md#github-workflows).
Keep CI and release builds on the same pinned dependencies; do not bypass release validation.
Record simulated versus real observations explicitly. SD-card hardware testing is not a prerequisite
for working on this initial source setup, but do not claim unobserved hardware qualification.

Do not commit credentials, local environments, generated builds, or personal device data.
See [security reporting](SECURITY.md) for sensitive reports.

## Remove local branches

From the repository root:

```sh
./tools/host/remove-local-branches.sh
```

**Warning:** this immediately force-deletes every local branch except `main`, including unmerged branches.
There is no confirmation or `--apply` flag. Retain any needed commits before running; remote branches are untouched.

The script does not switch branches. If a non-main branch is checked out in any worktree, it stops before deleting
anything. Switch that worktree to `main` or detach it first.
Use `./tools/host/remove-local-branches.sh --help` to view usage without deleting branches.
