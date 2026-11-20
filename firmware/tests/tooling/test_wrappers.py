"""Firmware wrapper checks with mocked downloads, installers and device access."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[3] / "tools/firmware"
MOCK = r"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_LOG"
case "$*" in
    "-")
        printf '%s\n' "${MOCK_SERIAL_PORT:-}" ;;
    "-c "*)
        exit "${MOCK_PYTHON_STATUS:-0}" ;;
    "-m venv "*)
        mkdir -p "$3/bin"
        touch "$3/pyvenv.cfg"
        cp "$0" "$3/bin/python"
        printf 'export PATH=%q:"$PATH"\n' "$3/bin" > "$3/bin/activate" ;;
    "-m pip install "*)
        exit "${MOCK_PIP_STATUS:-0}" ;;
    "-m west init "*)
        mkdir -p .west
        printf '[manifest]\npath = %s\nfile = west.yml\n' "$(basename "$MOCK_ROOT")" > .west/config ;;
    "-m west config --local manifest.path")
        sed -n 's/^path = //p' .west/config ;;
    "-m west config --local manifest.path "*)
        sed -i "s|^path = .*|path = $6|" .west/config ;;
    "-m west update "*)
        manifest=$(sed -n 's/^path = //p' .west/config)
        [[ -f "$manifest/west.yml" ]] || { printf 'Missing west manifest\n' >&2; exit 17; }
        mkdir -p zephyr/scripts modules/hal/espressif/zephyr
        touch zephyr/scripts/requirements-base.txt modules/hal/espressif/zephyr/requirements.txt ;;
    "-m west list zephyr "*)
        printf '%s/zephyr\n' "$(dirname "$MOCK_ROOT")" ;;
    "-m west list hal_espressif "*)
        printf '%s/modules/hal/espressif\n' "$PWD" ;;
    "-m west blobs fetch "*)
        exit "${MOCK_BLOB_STATUS:-0}" ;;
    "-m west sdk install "*)
        sdk="$HOME/zephyr-sdk-0.17.4"
        mkdir -p "$sdk/xtensa-espressif_esp32s3_zephyr-elf/bin"
        printf '0.17.4\n' > "$sdk/sdk_version"
        touch "$sdk/xtensa-espressif_esp32s3_zephyr-elf/bin/xtensa-espressif_esp32s3_zephyr-elf-gcc"
        chmod +x "$sdk/xtensa-espressif_esp32s3_zephyr-elf/bin/xtensa-espressif_esp32s3_zephyr-elf-gcc" ;;
    "-m west build "*)
        [[ "${MOCK_BUILD_STATUS:-0}" == 0 ]] || exit "$MOCK_BUILD_STATUS"
        build="$MOCK_ROOT/build/firmware"
        driver=SDHC_ESP32
        while (($#)); do
            case "$1" in
                -d) build="$2"; shift ;;
                -DDTC_OVERLAY_FILE=*sd_spi.overlay) driver=SPI_SDHC ;;
            esac
            shift
        done
        if [[ -f "$build/CMakeCache.txt" ]] &&
            ! grep -Fxq "APPLICATION_BINARY_DIR:PATH=$build" "$build/CMakeCache.txt"; then
            printf 'Build directory moved; cached pristine path is stale\n' >&2
            exit 18
        fi
        mkdir -p "$build/zephyr"
        printf 'APPLICATION_BINARY_DIR:PATH=%s\nAPPLICATION_SOURCE_DIR:PATH=%s/firmware\n' \
            "$build" "$MOCK_ROOT" > "$build/CMakeCache.txt"
        for file in zephyr.elf runners.yaml; do
            printf 'artifact\n' > "$build/zephyr/$file"
        done
        if [[ "${MOCK_INVALID_IMAGE:-0}" == 1 ]]; then
            printf 'incomplete\n' > "$build/zephyr/zephyr.bin"
        else
            printf '\xe9image\n' > "$build/zephyr/zephyr.bin"
        fi
        printf 'CONFIG_BOARD_TARGET="esp32s3_devkitc/esp32s3/procpu"\nCONFIG_%s=y\n' "$driver" \
            > "$build/zephyr/.config" ;;
    "-m west flash "*)
        exit "${MOCK_FLASH_STATUS:-0}" ;;
    *)
        printf 'Unexpected invocation: %s\n' "$*" >&2
        exit 99 ;;
esac
"""


class WrapperTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="zephyrforge-wrappers-")
        self.addCleanup(temp.cleanup)
        self.workspace = Path(temp.name)
        # Confine mocked workspace discovery even when fixtures live beneath a real west workspace.
        (self.workspace / ".west").mkdir()
        (self.workspace / ".west/config").write_text("[manifest]\npath = ZephyrForge\nfile = west.yml\n")
        self.root = self.workspace / "ZephyrForge"
        shutil.copytree(TOOLS, self.root / "tools/firmware")
        shutil.copytree(TOOLS.parents[1] / "patches", self.root / "patches")
        shutil.copy(TOOLS.parents[1] / "west.yml", self.root / "west.yml")
        self.bin = self.workspace / "mock-bin"
        self.bin.mkdir()
        python = self.bin / "python3"
        python.write_text(MOCK)
        python.chmod(0o755)
        shutil.copy(python, self.bin / "python")
        for tool in ("git", "cmake", "ninja", "gperf", "dtc", "make", "gcc", "g++", "xz", "wget"):
            path = self.bin / tool
            path.write_text("#!/usr/bin/env bash\n"
                            'if [[ "$*" == *"rev-parse HEAD"* ]]; then '
                            "echo 28af05ca658cbacf745fd5b099566311c58ccb1d; fi\n"
                            "exit 0\n")
            path.chmod(0o755)
        (self.bin / "cmake").write_text("""#!/usr/bin/env bash
set -euo pipefail
printf 'cmake %s\\n' "$*" >> "$MOCK_LOG"
if [[ "$*" == *"/cmake/pristine.cmake" ]]; then
    case "$1" in
        "-DBINARY_DIR=$MOCK_ROOT/build/firmware"|"-DBINARY_DIR=$MOCK_ROOT/build/firmware-sd-spi")
            rm "${1#-DBINARY_DIR=}/CMakeCache.txt" ;;
        *) printf 'Refusing to clean outside the selected build\\n' >&2; exit 20 ;;
    esac
fi
""")
        self.log = self.workspace / "commands.log"
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", PYTHON=str(python),
                        HOME=str(self.workspace), MOCK_ROOT=str(self.root), MOCK_LOG=str(self.log))
        for key in ("VENV_DIR", "VIRTUAL_ENV", "ZEPHYR_BASE", "ZEPHYR_SDK_INSTALL_DIR",
                    "MOCK_BUILD_STATUS", "MOCK_BLOB_STATUS", "MOCK_PIP_STATUS", "MOCK_FLASH_STATUS",
                    "MOCK_PYTHON_STATUS", "MOCK_INVALID_IMAGE"):
            self.env.pop(key, None)

    def run_script(self, name, *args):
        return subprocess.run(["bash", str(self.root / "tools/firmware" / name), *args],
                              cwd=self.root, env=self.env, capture_output=True, text=True)

    def commands(self):
        return self.log.read_text() if self.log.exists() else ""

    def test_build_bootstraps_then_reuses_venv_workspace_and_sdk(self):
        for _ in range(2):
            result = self.run_script("build.sh")
            self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands()
        for command in ("-m venv ", "-m west sdk install "):
            self.assertEqual(commands.count(command), 1)
        self.assertNotIn("-m west init ", commands)
        self.assertEqual(commands.count("-m west build "), 2)
        self.assertIn("-m west update --narrow -o=--depth=1", commands)
        self.assertIn("-m west blobs fetch hal_espressif", commands)
        self.assertIn("-b esp32s3_devkitc/esp32s3/procpu", commands)
        self.assertIn("-DDTC_OVERLAY_FILE=boards/esp32s3_devkitc_n16r8_sdmmc.overlay", commands)
        self.assertIn("-DZF_ENABLE_STORAGE_BENCHMARK=ON", commands)

    def test_dependency_patch_applies_once_accepts_reverse_match_and_rejects_conflict(self):
        self.assertEqual(self.run_script("build.sh").returncode, 0)
        git = self.bin / "git"
        git.write_text("""#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
    *"rev-parse HEAD"*) echo 28af05ca658cbacf745fd5b099566311c58ccb1d ;;
    *"apply --reverse --check"*) [[ "$PATCH_STATE" == applied ]] ;;
    *"apply --check"*) [[ "$PATCH_STATE" == fresh ]] ;;
    *"apply "*) exit 0 ;;
    *) exit 99 ;;
esac
""")
        for state, expected in (("fresh", 0), ("applied", 0), ("conflict", 1)):
            self.env["PATCH_STATE"] = state
            self.log.write_text("")
            result = self.run_script("apply-zephyr-patches.sh", str(self.workspace / "zephyr"))
            self.assertEqual(result.returncode, expected, result.stderr)
            calls = self.commands()
            self.assertIn("apply --check", calls)
            if state == "fresh":
                self.assertNotIn("apply --reverse", calls)
            else:
                self.assertIn("apply --reverse --check", calls)
            if state == "conflict":
                self.assertIn("neither applies nor matches", result.stderr)
        self.env["PATCH_STATE"] = "fresh"
        self.log.write_text("")
        result = self.run_script("apply-zephyr-patches.sh", str(self.root))
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("apply", self.commands())

    def test_flash_builds_missing_artifacts_then_flashes_once(self):
        result = self.run_script("flash.sh", "--port", "/dev/mock", "--baud", "115200")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands()
        self.assertEqual(commands.count("-m west build "), 1)
        self.assertEqual(commands.count("-m west flash "), 1)
        self.assertLess(commands.index("-m west build "), commands.index("-m west flash "))
        self.assertIn("--skip-rebuild -r esp32 --esp-device /dev/mock --esp-baud-rate 115200 --no-erase",
                      commands)

    def test_flash_reuses_existing_artifacts(self):
        self.assertEqual(self.run_script("build.sh").returncode, 0)
        self.log.write_text("")
        result = self.run_script("flash.sh", "--port", "/dev/mock")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("-m west build ", self.commands())

    def test_flash_repairs_missing_moved_checkout_before_loading_manifest(self):
        config = self.workspace / ".west/config"
        previous = self.workspace / "previous-checkout"
        for storage, directory in (("sdmmc", "firmware"), ("sd-spi", "firmware-sd-spi")):
            with self.subTest(storage=storage):
                self.assertEqual(self.run_script("build.sh", "--storage", storage).returncode, 0)
                cache = self.root / f"build/{directory}/CMakeCache.txt"
                current = cache.read_text()
                cache.write_text(current.replace(str(self.root / "firmware"), str(previous / "firmware")))
                config.write_text(
                    "[manifest]\npath = previous-checkout\nfile = west.yml\n[zephyr]\nbase = zephyr\n")
                self.log.write_text("")
                result = self.run_script("flash.sh", "--storage", storage, "--port", "/dev/mock", "--dry-run")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("path = ZephyrForge", config.read_text())
                self.assertIn("base = zephyr", config.read_text())
                calls = self.commands()
                self.assertLess(calls.index("-m west config --local manifest.path ZephyrForge"),
                                calls.index("-m west update "))
                self.assertNotIn("-m west build ", calls)
                self.assertNotIn("-m west flash ", calls)
                cache.write_text(current)

    def test_existing_checkout_and_unrelated_missing_manifests_are_not_redirected(self):
        self.assertEqual(self.run_script("build.sh").returncode, 0)
        previous = self.workspace / "previous-checkout"
        previous.mkdir()
        (previous / "west.yml").touch()
        cache = self.root / "build/firmware/CMakeCache.txt"
        cache.write_text(cache.read_text().replace(str(self.root / "firmware"), str(previous / "firmware")))
        config = self.workspace / ".west/config"
        for manifest, expected in (("previous-checkout", 0), ("another-project", 17)):
            with self.subTest(manifest=manifest):
                content = f"[manifest]\npath = {manifest}\nfile = west.yml\n"
                config.write_text(content)
                self.log.write_text("")
                result = self.run_script("flash.sh", "--port", "/dev/mock", "--dry-run")
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertEqual(config.read_text(), content)
                self.assertNotIn(f"-m west config --local manifest.path {self.root.name}", self.commands())
                self.assertNotIn("-m west flash ", self.commands())

    def test_flash_rebuilds_moved_source_cache_without_flashing_in_dry_run(self):
        self.assertEqual(self.run_script("build.sh").returncode, 0)
        build = self.root / "build/firmware"
        (build / "zephyr/zephyr.bin").unlink()
        old_build = self.workspace / "previous-checkout/build/firmware"
        old_build.mkdir(parents=True)
        marker = old_build / "keep"
        marker.touch()
        (build / "CMakeCache.txt").write_text(f"APPLICATION_BINARY_DIR:PATH={old_build}\n")
        self.log.write_text("")
        result = self.run_script("flash.sh", "--port", "/dev/mock", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"cmake -DBINARY_DIR={build} -DSOURCE_DIR={self.root / 'firmware'}", self.commands())
        self.assertIn("-m west build ", self.commands())
        self.assertNotIn("-m west flash ", self.commands())
        self.assertTrue(marker.exists(), "a cached old build path must never be cleaned")

    def test_spi_build_and_flash_use_a_separate_image(self):
        result = self.run_script("build.sh", "--storage", "sd-spi")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-d " + str(self.root / "build/firmware-sd-spi"), self.commands())
        self.assertIn("-DDTC_OVERLAY_FILE=boards/esp32s3_devkitc_n16r8_sd_spi.overlay", self.commands())
        self.log.write_text("")
        result = self.run_script("flash.sh", "--storage", "sd-spi", "--port", "/dev/mock")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("-m west build ", self.commands())
        self.assertIn("-m west flash -d " + str(self.root / "build/firmware-sd-spi"), self.commands())
        self.assertFalse((self.root / "build/firmware").exists())

    def test_spi_dry_run_builds_only_the_selected_image(self):
        result = self.run_script("flash.sh", "--storage", "sd-spi", "--port", "/dev/mock", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "build/firmware-sd-spi/zephyr/zephyr.bin").exists())
        self.assertFalse((self.root / "build/firmware").exists())
        self.assertNotIn("-m west flash ", self.commands())

    def test_wrong_storage_image_is_rejected_without_flashing(self):
        self.assertEqual(self.run_script("build.sh").returncode, 0)
        config = self.root / "build/firmware/zephyr/.config"
        config.write_text(config.read_text().replace("CONFIG_SDHC_ESP32=y", "CONFIG_SPI_SDHC=y"))
        result = self.run_script("flash.sh", "--port", "/dev/mock")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match --storage sdmmc", result.stderr)
        self.assertNotIn("-m west flash ", self.commands())

    def test_incomplete_image_is_rebuilt_and_failed_conversion_prevents_flash(self):
        self.assertEqual(self.run_script("build.sh").returncode, 0)
        image = self.root / "build/firmware/zephyr/zephyr.bin"
        image.write_bytes(b"raw data")
        self.log.write_text("")
        result = self.run_script("flash.sh", "--port", "/dev/mock")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-m west build ", self.commands())
        image.write_bytes(b"raw data")
        self.env["MOCK_INVALID_IMAGE"] = "1"
        self.log.write_text("")
        result = self.run_script("flash.sh", "--port", "/dev/mock")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("valid ESP image", result.stderr)
        self.assertNotIn("-m west flash ", self.commands())

    def test_invalid_storage_does_not_install_build_or_flash(self):
        for name in ("build.sh", "flash.sh"):
            result = self.run_script(name, "--storage", "sdio")
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.commands(), "")

    def test_flash_auto_detects_serial_port_when_omitted(self):
        self.env["MOCK_SERIAL_PORT"] = "/dev/mock-auto"
        result = self.run_script("flash.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Auto-detected serial port: /dev/mock-auto", result.stdout)
        self.assertIn("--esp-device /dev/mock-auto", self.commands())

    def test_flash_without_detectable_port_fails_before_build(self):
        result = self.run_script("flash.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not detect a serial port", result.stderr)
        self.assertNotIn("-m west build ", self.commands())

    def test_dry_run_builds_but_never_flashes(self):
        result = self.run_script("flash.sh", "--port", "/dev/mock", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-m west build ", self.commands())
        self.assertNotIn("-m west flash ", self.commands())
        self.assertIn("Dry run only (no device access)", result.stdout)

    def test_build_failure_prevents_flash(self):
        self.env["MOCK_BUILD_STATUS"] = "31"
        result = self.run_script("flash.sh", "--port", "/dev/mock")
        self.assertEqual(result.returncode, 31)
        self.assertNotIn("-m west flash ", self.commands())

    def test_dependency_failure_prevents_build_and_flash(self):
        for key in ("MOCK_PIP_STATUS", "MOCK_BLOB_STATUS"):
            with self.subTest(key=key):
                self.env[key] = "23"
                self.log.write_text("")
                result = self.run_script("flash.sh", "--port", "/dev/mock")
                self.assertEqual(result.returncode, 23)
                self.assertNotIn("-m west build ", self.commands())
                self.assertNotIn("-m west flash ", self.commands())
                del self.env[key]

    def test_wrong_board_is_rejected_without_flashing(self):
        self.assertEqual(self.run_script("build.sh").returncode, 0)
        (self.root / "build/firmware/zephyr/.config").write_text('CONFIG_BOARD_TARGET="other"\n')
        result = self.run_script("flash.sh", "--port", "/dev/mock")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Build is not for", result.stderr)
        self.assertNotIn("-m west flash ", self.commands())

    def test_help_and_invalid_options_do_not_install(self):
        self.assertEqual(self.run_script("flash.sh", "--help").returncode, 0)
        self.assertNotEqual(self.run_script("flash.sh", "--port", "/dev/mock", "--baud", "0").returncode, 0)
        self.assertEqual(self.commands(), "")

    def test_relative_custom_venv_and_existing_workspace(self):
        (self.workspace / ".west").mkdir(exist_ok=True)
        (self.workspace / ".west/config").touch()
        self.env["VENV_DIR"] = "custom venv"
        result = self.run_script("build.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "custom venv/pyvenv.cfg").exists())
        self.assertNotIn("-m west init ", self.commands())

    def test_invalid_venv_is_not_overwritten(self):
        (self.workspace / ".venv").mkdir()
        result = self.run_script("build.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a Python venv", result.stderr)
        self.assertNotIn("-m venv ", self.commands())

    def test_runner_error_is_not_retried(self):
        self.env["MOCK_FLASH_STATUS"] = "19"
        result = self.run_script("flash.sh", "--port", "/dev/mock")
        self.assertEqual(result.returncode, 19)
        self.assertEqual(self.commands().count("-m west flash "), 1)

    def mock_package_manager(self):
        apt = self.bin / "apt-get"
        apt.write_text(
            '#!/usr/bin/env bash\n'
            'printf "apt-get %s\\n" "$*" >> "$MOCK_LOG"\n'
            'exit "${MOCK_APT_STATUS:-0}"\n'
        )
        apt.chmod(0o755)
        sudo = self.bin / "sudo"
        sudo.write_text('#!/usr/bin/env bash\nexec "$@"\n')
        sudo.chmod(0o755)
        self.env["MOCK_PYTHON_STATUS"] = "1"

    def test_missing_venv_support_installs_host_package(self):
        self.mock_package_manager()
        result = self.run_script("build.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("apt-get update", self.commands())
        self.assertIn("apt-get install -y --no-install-recommends python3-venv", self.commands())

    def test_host_install_failure_stops_setup(self):
        self.mock_package_manager()
        self.env["MOCK_APT_STATUS"] = "29"
        result = self.run_script("flash.sh", "--port", "/dev/mock")
        self.assertEqual(result.returncode, 29)
        self.assertNotIn("-m venv ", self.commands())
        self.assertNotIn("-m west flash ", self.commands())


if __name__ == "__main__":
    unittest.main()
