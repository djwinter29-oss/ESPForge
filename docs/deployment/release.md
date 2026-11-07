# Release procedure

## GitHub workflows

The automation follows PicoForge's validation, release and publication split, adapted to the
current Zephyr/UART implementation. It does not introduce native USB HID or a new BLE protocol.

| Workflow | Trigger | Responsibility |
| --- | --- | --- |
| [PR Check](../../.github/workflows/pr-check.yml) | Pull requests, pushes to `main`, manual | Calls shared host validation and the ESP32-S3 target build |
| [Host Validation](../../.github/workflows/host-validation.yml) | Reusable, manual | Python 3.10/3.12 on Linux/macOS/Windows; Node 22 and .NET 10 on each OS; Ceedling; documentation links |
| [Firmware build](../../.github/workflows/firmware-build.yml) | Reusable, manual | Pinned Zephyr/SDK build, generated configuration checks, binaries, frozen manifest, licenses and flashing instructions |
| [Release build packages](../../.github/workflows/release.yml) | Stable version tags, manual preflight | Gates packages on shared validation and publishes checksummed GitHub release assets |
| [Publish .NET Packages](../../.github/workflows/publish-dotnet.yml) | Reusable, manual existing tag | Self-contained `linux-x64`, `win-x64`, `osx-arm64` archives; extracted-host demo smoke tests |
| [Publish Direct Pages](../../.github/workflows/publish-direct.yml) | Successful tagged release, manual published tag | Verifies the released Direct ZIP/checksum and source tag before deploying to Pages |

Actions are pinned to commit SHAs. CI has read-only repository access; only the release job
can publish release assets, and only Pages deployment gets Pages/OIDC write permissions.
PR checks cancel superseded runs; release/publication runs are not cancelled mid-flight.
No workflow flashes hardware, tests an SD card or runs a dedicated manual-tool test suite.

Python is deliberately a **source archive**, not a PyPI distribution. Unlike PicoForge, this
repository has no Python packaging metadata or installed-dashboard asset mechanism yet.
There is no PyPI publishing workflow or PyPI credential requirement. Browser visual checks
remain manual; the existing JavaScript tests and extracted-package HTTP checks run automatically.

## Before the first release

1. Enable GitHub Actions and ensure repository/organization policy permits the pinned actions.
2. For Direct publication, set **Settings > Pages > Build and deployment > Source** to
   **GitHub Actions**. Review protection rules for the `github-pages` environment.
   Pages setup is a repository-administrator action, not performed by this checkout.
3. Run **Release build packages** manually on the intended source ref with, for example,
   `tag: v0.1.0`. This preflight builds/tests packages and attaches run artifacts, but creates
   **no tag, GitHub release or Pages deployment**.
4. Inspect the artifacts, licensing and [qualification limits](../validation/qualification-gaps.md).
   Local validation is not evidence that GitHub-hosted Linux/macOS/Windows jobs have run.

## Publish a stable tag

After the preflight and PR checks pass on the exact source commit:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Only exact `vMAJOR.MINOR.PATCH` tags with no leading zeros are accepted by the shared
[version helper](../../tools/firmware/release-version.sh). Prerelease tags are not published.
Tagged builds inject the validated firmware version through `ESPFORGE_VERSION`; ordinary
builds keep the source default. .NET package versions match the release tag.

The release publishes:

| Asset | Contents/use |
| --- | --- |
| `espforge-firmware-vVERSION-esp32s3-devkitc.zip` | Simple-boot `zephyr.bin`, ELF, hidden `.config`, DTS, runner provenance, frozen west manifest, dependency licenses, docs and flashing instructions |
| `espforge-direct-vVERSION.zip` | Direct and sibling shared web assets, local launcher, docs, project license and release/source metadata |
| `espforge-python-vVERSION-source.zip` | Python source/tests, requirements, sibling shared web assets, docs, project license and release/source metadata |
| `espforge-host-vVERSION-linux-x64.tar.gz` | Self-contained Linux .NET host, dashboard assets and dependency notices |
| `espforge-host-vVERSION-win-x64.zip` | Self-contained Windows .NET host |
| `espforge-host-vVERSION-osx-arm64.tar.gz` | Self-contained Apple Silicon .NET host |
| `SHA256SUMS.txt` | SHA-256 of all six package archives |

Extract source archives before running their commands; keep their `host/` layout intact.
Standalone .NET hosts do not require an installed .NET runtime. Their smoke tests explicitly use
`--demo`, verify every deployed dashboard asset and confirm a simulated status response.
Windows/macOS packages are not publisher-signed or notarized; local OS security policy may
require explicit approval. No signing credentials are configured by these workflows.

The firmware ZIP is not a relocatable west build directory. Its `FLASHING.txt` gives the
esptool 5 command for the selected simple-boot N8 image at `0x0`, with DIO/80 MHz/8 MB flash
parameters. `runners.yaml` records how it was built; do not feed its CI paths to a local west
runner. The [source-build flash wrapper](../guides/getting-started.md#2-build-now-flash-later)
remains the supported west-based path.

## Direct Pages and retries

After a successful tag-triggered release, Pages downloads the **published release asset**, not
an untrusted PR artifact or a fresh build from `main`. It verifies the tag's source commit and
the Direct checksum and archive version/source metadata. The site root redirects to `direct/`,
with shared assets at `web/`.
Web Serial/Bluetooth still require a supported browser and explicit device permission.

A manual **Publish Direct Pages** run can redeploy an existing, non-draft, non-prerelease tag.
A manual **Publish .NET Packages** run rebuilds an existing tag and attaches run artifacts;
it does not modify an existing GitHub release. A Pages setup/deployment failure does not undo
the separately completed GitHub release.

Before distributing radio-enabled binaries, review Zephyr, Espressif HAL/blob, FatFs, mbedTLS,
pyserial and System.IO.Ports licenses and applicable radio/regulatory requirements.
Do not describe a successful software build as SD-card or wireless hardware qualification.
