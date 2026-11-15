# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

import json
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import MagicMock, Mock, patch

from espforge.cli import _read_status_reports, main


class StatusCommandTests(unittest.TestCase):
    def test_module_entry_point_exposes_the_cli_without_hardware(self):
        result = subprocess.run(
            [sys.executable, "-m", "espforge", "--help"], capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("{status,web,reboot}", result.stdout)

    def test_status_keeps_settings_and_board_configuration_output(self):
        configuration = {
            "system_clock_mhz": 240,
            "sdcard_profile": 0,
            "radios": 3,
            "tcp_cli_enabled": False,
            "reset_cause": 1,
        }
        memory = {"msc": {"enabled": False, "transition_pending": False, "request_rejected": False}}
        device = MagicMock()
        device.__enter__.return_value = device
        device.read_info.return_value = {"supported": True, "self_test_supported": False}
        device.read_configuration.return_value = configuration
        device.read_settings.side_effect = AssertionError("read_settings was removed")
        output = StringIO()
        with patch("espforge.cli.ESPForgeHid", return_value=device), \
                patch("espforge.cli._read_status_reports", return_value=(None, memory, None)), \
                redirect_stdout(output):
            self.assertEqual(main(["status"]), 0)

        payload = json.loads(output.getvalue())
        self.assertEqual(payload["settings"], {
            "system_clock_mhz": 240,
            "sdcard_profile": 0,
            "radios": 3,
            "tcp_cli_enabled": False,
        })
        self.assertEqual(payload["board_configuration"], configuration)
        self.assertEqual(payload["msc"], memory["msc"])
        self.assertIsNone(payload["self_test"])
        device.read_configuration.assert_called_once_with()
        device.read_settings.assert_not_called()

    def test_status_includes_advertised_self_test_reports(self):
        runtime = {"uptime_ms": 1}
        memory = {"msc": {"enabled": False}}
        benchmark = {"state": "running", "active": True, "written_bytes": 1024}
        configuration = {"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 3, "tcp_cli_enabled": False}
        for reports in (
            [("runtime", runtime), ("memory", memory), ("self_test", benchmark)],
            [("self_test", benchmark), ("runtime", runtime), ("memory", memory)],
        ):
            with self.subTest(order=[kind for kind, _ in reports]):
                device = MagicMock()
                device.__enter__.return_value = device
                device.read_info.return_value = {"supported": True, "self_test_supported": True}
                device.read_configuration.return_value = configuration
                device.read_input_report.side_effect = [{"kind": kind, "data": data} for kind, data in reports]
                output = StringIO()
                with patch("espforge.cli.ESPForgeHid", return_value=device), \
                        patch("espforge.cli.monotonic", return_value=0), redirect_stdout(output):
                    self.assertEqual(main(["status"]), 0)
                payload = json.loads(output.getvalue())
                self.assertEqual(payload["self_test"], benchmark)
                self.assertEqual(payload["runtime"], runtime)
                self.assertEqual(payload["memory"], memory)
                self.assertEqual(device.read_input_report.call_count, 3)

    def test_only_advertised_self_test_capability_waits_for_a_missing_report(self):
        runtime, memory = {"uptime_ms": 1}, {"msc": {"enabled": False}}
        for supported, read_count in ((False, 2), (True, 5)):
            with self.subTest(self_test_supported=supported):
                device = Mock()
                device.read_input_report.side_effect = [
                    {"kind": "runtime", "data": runtime},
                    {"kind": "memory", "data": memory},
                    *[{"kind": "runtime", "data": runtime}] * 3,
                ]
                with patch("espforge.cli.monotonic", side_effect=[0, 0, 1, 2, 3, 4, 5]):
                    result = _read_status_reports(device, self_test_supported=supported)
                self.assertEqual(result, (runtime, memory, None))
                self.assertEqual(device.read_input_report.call_count, read_count)
                self.assertEqual(
                    [call.kwargs["timeout_ms"] for call in device.read_input_report.call_args_list],
                    [5000, 4000, 3000, 2000, 1000][:read_count],
                )

    def test_unadvertised_self_test_report_is_not_published(self):
        runtime, memory = {"uptime_ms": 1}, {"msc": {"enabled": False}}
        device = Mock()
        device.read_input_report.side_effect = [
            {"kind": "self_test", "data": {"state": "running"}},
            {"kind": "runtime", "data": runtime},
            {"kind": "memory", "data": memory},
        ]
        with patch("espforge.cli.monotonic", return_value=0):
            self.assertEqual(_read_status_reports(device), (runtime, memory, None))
        self.assertEqual(device.read_input_report.call_count, 3)

    def test_report_collection_uses_one_overall_deadline(self):
        runtime = {"uptime_ms": 1}
        device = Mock()
        device.read_input_report.return_value = {"kind": "runtime", "data": runtime}

        with patch("espforge.cli.monotonic", side_effect=[0, 0, 1, 2, 3, 4, 5]):
            result = _read_status_reports(device)

        self.assertEqual(result, (runtime, None, None))
        self.assertEqual(device.read_input_report.call_count, 5)
        self.assertEqual(
            [call.kwargs["timeout_ms"] for call in device.read_input_report.call_args_list],
            [5000, 4000, 3000, 2000, 1000],
        )

    def test_no_reports_returns_after_the_bounded_read(self):
        device = Mock()
        device.read_input_report.return_value = None

        with patch("espforge.cli.monotonic", side_effect=[10.0, 10.0]):
            result = _read_status_reports(device)

        self.assertEqual(result, (None, None, None))
        device.read_input_report.assert_called_once_with(timeout_ms=5000)


if __name__ == "__main__":
    unittest.main()
