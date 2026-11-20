# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Software-only checks for target-test safety, freshness, thresholds, and result attribution."""

from contextlib import redirect_stderr
from io import StringIO
import unittest
from unittest.mock import MagicMock, patch

import run as hardware


def storage():
    return {"sample_valid": True, "initialized": True, "msc_enabled": False,
            "filesystem_format": "fat32", "cid": "card", "sequence": 1}


def status(state="passed", **values):
    return {"state": state, "active": state == "writing", "target_bytes": 32 * 1024 * 1024,
            "written_bytes": 32 * 1024 * 1024, "read_bytes": 32 * 1024 * 1024,
            "mismatch_count": 0, "error": 0, "filesystem_result": 0, "file_remains": False,
            "volume_mounted": True, "write_elapsed_ms": 100, "read_elapsed_ms": 100, **values}


class HardwareCheckTests(unittest.TestCase):
    def test_opt_in_and_numeric_validation_happen_before_opening_hardware(self):
        for options in (
            [], ["--wifi-scans", "1"], ["--benchmark-mib", "32", "--allow-state-changes"],
            ["--benchmark-mib", "1025", "--allow-state-changes", "--allow-card-writes"],
            ["--cycles", "0"], ["--max-latency-ms", "0"], ["--timeout-seconds", "0"],
        ):
            with self.subTest(options=options), redirect_stderr(StringIO()), self.assertRaises(SystemExit):
                hardware.arguments(["--serial", "board"] + options if options else [])

    def test_default_run_reads_and_reopens_without_state_changes(self):
        args = hardware.arguments(["--serial", "board", "--cycles", "2", "--reopens", "1"])
        client = MagicMock()
        client.read_info.return_value = {
            "supported": True, "serial_number": "board", "firmware_version": "0.1.0",
            "board_model": "N16R8", "storage_transport": "sdmmc",
        }
        with patch.object(hardware, "ZephyrForgeHid", return_value=client) as open_hid, \
                patch.object(hardware, "sample", return_value=(storage(), [])):
            result = hardware.run(args)
        self.assertEqual(open_hid.call_args_list, [unittest.mock.call(serial_number="board")] * 2)
        self.assertEqual(client.close.call_count, 2)
        client.benchmark.assert_not_called()
        client.scan_wireless.assert_not_called()
        client.set_msc.assert_not_called()
        client.reboot.assert_not_called()
        self.assertEqual(result["checks"]["samples"], 3)
        self.assertIsNone(result["benchmark"])

    def test_sample_waits_for_fresh_reports_and_accepts_uptime_wrap(self):
        client = MagicMock()
        client.read_input_report.side_effect = [
            None,
            {"kind": "runtime", "data": {"sequence": 1, "uptime_ms": 0, "usb_mounted": True}},
            {"kind": "runtime", "data": {"sequence": 2, "uptime_ms": 4, "usb_mounted": True}},
            {"kind": "memory", "data": storage()},
        ]
        metrics = {"last_runtime_sequence": 1, "last_uptime_ms": (1 << 32) - 4}
        with patch.object(hardware, "features"):
            actual, _ = hardware.sample(client, metrics, 1000)
        self.assertEqual(actual, storage())
        self.assertEqual(metrics["runtime_reports"], 1)
        self.assertEqual(metrics["last_uptime_ms"], 4)

    def test_sample_rejects_unexpected_reset_and_missing_reports(self):
        client = MagicMock()
        client.read_input_report.return_value = {
            "kind": "runtime", "data": {"sequence": 2, "uptime_ms": 4, "usb_mounted": True},
        }
        with patch.object(hardware, "features"), self.assertRaisesRegex(RuntimeError, "reset"):
            hardware.sample(client, {"last_uptime_ms": 100}, 1000)
        with patch.object(hardware, "features"), \
                patch.object(hardware, "monotonic", side_effect=[0, 6]), self.assertRaises(TimeoutError):
            hardware.sample(client, {}, 1000)

    def test_exact_latency_threshold_and_exceedance(self):
        client = MagicMock()
        client.identity = None
        with patch.object(hardware, "monotonic", side_effect=[0, 1]):
            hardware.features(client, {}, 1000)
        with patch.object(hardware, "monotonic", side_effect=[0, 1.001]), self.assertRaises(TimeoutError):
            hardware.features(client, {}, 1000)
        with patch.object(hardware, "features"), \
                patch.object(hardware, "monotonic", side_effect=[0, 0, 0, 1.001]), \
                self.assertRaisesRegex(TimeoutError, "Input"):
            hardware.sample(client, {}, 1000)

    def test_benchmark_requires_observed_activity_and_complete_cleanup(self):
        args = hardware.arguments(["--serial", "board", "--benchmark-mib", "32",
                                   "--allow-state-changes", "--allow-card-writes"])
        client = MagicMock()
        client.read_input_report.return_value = None
        samples = [
            (storage(), []), (storage(), [status()]),
            (storage(), [status("writing")]), (storage(), [status()]), (storage(), []),
        ]
        with patch.object(hardware, "sample", side_effect=samples):
            result = hardware.benchmark(client, {}, args)
        self.assertEqual(result["written_bytes"], 32 * 1024 * 1024)
        self.assertFalse(result["file_remains"])
        client.benchmark.assert_called_once_with(True, 32)

    def test_failed_benchmark_and_refused_admission_are_not_replayed_or_cancelled(self):
        args = hardware.arguments(["--serial", "board", "--benchmark-mib", "32",
                                   "--allow-state-changes", "--allow-card-writes"])
        for refused in (False, True):
            client = MagicMock()
            client.read_input_report.return_value = None
            if refused:
                client.require_completed.side_effect = RuntimeError("refused")
            with self.subTest(refused=refused), \
                    patch.object(hardware, "sample", side_effect=[
                        (storage(), []), (storage(), [status("failed", error=7, filesystem_result=1)]),
                    ]), self.assertRaises(RuntimeError):
                hardware.benchmark(client, {}, args)
            client.benchmark.assert_called_once_with(True, 32)

    def test_benchmark_rejects_bad_cleanup_counters_and_replacement_card(self):
        args = hardware.arguments(["--serial", "board", "--benchmark-mib", "32",
                                   "--allow-state-changes", "--allow-card-writes"])
        for terminal, after in (
            (status(file_remains=True), storage()),
            (status(read_bytes=1), storage()),
            (status(), {**storage(), "cid": "replacement"}),
        ):
            client = MagicMock()
            client.read_input_report.return_value = None
            with self.subTest(terminal=terminal, after=after), \
                    patch.object(hardware, "sample", side_effect=[
                        (storage(), []), (storage(), [status("writing"), terminal]), (after, []),
                    ]), self.assertRaises(RuntimeError):
                hardware.benchmark(client, {}, args)
            client.benchmark.assert_called_once_with(True, 32)

    def test_old_terminal_result_and_uncertain_admission_never_become_success(self):
        args = hardware.arguments(["--serial", "board", "--benchmark-mib", "32",
                                   "--allow-state-changes", "--allow-card-writes", "--timeout-seconds", "1"])
        client = MagicMock()
        client.read_input_report.return_value = None
        with patch.object(hardware, "sample", side_effect=[(storage(), []), (storage(), [status()])]), \
                patch.object(hardware, "monotonic", side_effect=[0, 0, 2]), self.assertRaises(TimeoutError):
            hardware.benchmark(client, {}, args)
        client.benchmark.assert_called_once_with(True, 32)
        client.reset_mock()
        client.benchmark.side_effect = TimeoutError("uncertain admission")
        with patch.object(hardware, "sample", return_value=(storage(), [])), self.assertRaises(TimeoutError):
            hardware.benchmark(client, {}, args)
        client.benchmark.assert_called_once_with(True, 32)
        client.require_completed.assert_not_called()

    def test_wifi_scan_generation_wrap_and_result_contract(self):
        args = hardware.arguments(["--serial", "board", "--cycles", "1", "--reopens", "0",
                                   "--wifi-scans", "1", "--allow-state-changes"])
        client = MagicMock()
        client.read_info.return_value = {
            "supported": True, "serial_number": "board", "firmware_version": "0.1.0",
            "board_model": "N16R8", "storage_transport": "sdmmc",
        }
        client.read_wireless.side_effect = [
            {"scan_generation": 65535}, {"scan_generation": 1, "scan_state": "complete", "scan_count": 2},
        ]
        client.scan_wireless.return_value = [{"ssid_hex": "61", "rssi": -30}, {"ssid_hex": "62", "rssi": -60}]
        with patch.object(hardware, "ZephyrForgeHid", return_value=client), \
                patch.object(hardware, "sample", return_value=(storage(), [])):
            result = hardware.run(args)
        self.assertEqual(result["checks"]["wifi_scans"], 1)
        client.scan_wireless.assert_called_once()
        client.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
