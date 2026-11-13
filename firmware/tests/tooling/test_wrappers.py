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
        touch .west/config ;;
    "-m west update "*)
        mkdir -p zephyr/scripts modules/hal/espressif/zephyr
        touch zephyr/scripts/requirements-base.txt modules/hal/espressif/zephyr/requirements.txt ;;
    "-m west list zephyr "*)
        printf '%s/zephyr\n' "$PWD" ;;
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
        mkdir -p "$MOCK_ROOT/build/firmware/zephyr"
        for file in zephyr.bin zephyr.elf runners.yaml; do
            printf 'artifact\n' > "$MOCK_ROOT/build/firmware/zephyr/$file"
        done
        printf 'CONFIG_BOARD_TARGET="esp32s3_devkitc/esp32s3/procpu"\n' > "$MOCK_ROOT/build/firmware/zephyr/.config" ;;
    "-m west flash "*)
        exit "${MOCK_FLASH_STATUS:-0}" ;;
    *)
        printf 'Unexpected invocation: %s\n' "$*" >&2
        exit 99 ;;
esac
"""


class WrapperTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="espforge-wrappers-")
        self.addCleanup(temp.cleanup)
        self.workspace = Path(temp.name)
        self.root = self.workspace / "ESPForge"
        shutil.copytree(TOOLS, self.root / "tools/firmware")
        self.bin = self.workspace / "mock-bin"
        self.bin.mkdir()
        python = self.bin / "python3"
        python.write_text(MOCK)
        python.chmod(0o755)
        for tool in ("git", "cmake", "ninja", "gperf", "dtc", "make", "gcc", "g++", "xz", "wget"):
            path = self.bin / tool
            path.write_text("#!/usr/bin/env bash\nexit 0\n")
            path.chmod(0o755)
        self.log = self.workspace / "commands.log"
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", PYTHON=str(python),
                        HOME=str(self.workspace), MOCK_ROOT=str(self.root), MOCK_LOG=str(self.log))
        for key in ("VENV_DIR", "VIRTUAL_ENV", "ZEPHYR_BASE", "ZEPHYR_SDK_INSTALL_DIR",
                    "MOCK_BUILD_STATUS", "MOCK_BLOB_STATUS", "MOCK_PIP_STATUS", "MOCK_FLASH_STATUS",
                    "MOCK_PYTHON_STATUS"):
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
        for command in ("-m venv ", "-m west init ", "-m west sdk install "):
            self.assertEqual(commands.count(command), 1)
        self.assertEqual(commands.count("-m west build "), 2)
        self.assertIn("-m west update --narrow -o=--depth=1", commands)
        self.assertIn("-m west blobs fetch hal_espressif", commands)
        self.assertIn("-b esp32s3_devkitc/esp32s3/procpu", commands)
        self.assertIn("-DDTC_OVERLAY_FILE=boards/esp32s3_devkitc.overlay", commands)

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
        (self.workspace / ".west").mkdir()
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
