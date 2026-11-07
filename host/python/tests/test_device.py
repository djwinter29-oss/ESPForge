# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

import struct
import threading
import unittest
from unittest.mock import Mock, patch

from espforge.hid.device import ESPForgeHid, _matches_vendor_collection, enumerate_devices
from espforge.reports import (
    CONTROL_FEATURE_SIZE,
    InvalidRequest,
    ProtocolError,
    build_control_command_report,
    parse_identity_report,
    parse_status_report,
)


def identity():
    report = bytes([1, 1]) + struct.pack("<H", 3) + bytes.fromhex("0123456789abcdef")
    report += bytes([1, 2, 3, 3, 1, 0, 0x8E]) + struct.pack("<II", 524288, 100000)
    return parse_identity_report(report)


def telemetry():
    return bytes([3]) + struct.pack("<BBhQHHIBB", 1, 0, 0, 42, 0xFFFF, 0xFFFF,
                                    240_000_000, 7, 0x01)


def control_result(opcode=2, status=2, error=0, transaction=1):
    data = struct.pack("<HBBB", 240, 0, 0, 0) if opcode == 5 and status == 2 else b""
    return bytes([20, 1, transaction, opcode, status, error]) + data.ljust(63, b"\0")


def configuration(clock=240):
    payload = bytes([1]) + struct.pack("<H", clock) + bytes([
        0, 0, 43, 44, 12, 11, 13, 10, 255, 255, 0x04, 1, 255, 255,
    ])
    return bytes([2]) + payload


class HidEnumerationTests(unittest.TestCase):
    def test_enumerates_board_identity_without_opening_hid(self):
        devices = [
            {"product_string": "ESPForge", "serial_number": "board-A", "path": b"/hid/a"},
            {"product_string": "", "serial_number": "", "path": b"/hid/b"},
        ]
        with patch("espforge.hid.device._matching_devices", return_value=devices):
            self.assertEqual(enumerate_devices(), [
                {"product_name": "ESPForge", "serial_number": "board-A", "device_path": "/hid/a"},
                {"product_name": "ESPForge", "serial_number": None, "device_path": "/hid/b"},
            ])

    def test_matches_expected_vendor_usage_and_fallback_metadata(self):
        self.assertTrue(_matches_vendor_collection({"usage_page": 0xFF00, "usage": 1}))
        self.assertFalse(_matches_vendor_collection({"usage_page": 1, "usage": 1}))
        self.assertTrue(_matches_vendor_collection({"usage_page": 0, "usage": 0, "product_string": ""}))
        self.assertFalse(_matches_vendor_collection({"usage_page": 0, "usage": 0, "product_string": "Other"}))
        self.assertTrue(_matches_vendor_collection({"usage_page": 0, "usage": 0, "product_string": "ESPForge"}))


class HidDeviceTests(unittest.TestCase):
    def test_close_waits_for_native_io_and_later_operations_reject_the_closed_handle(self):
        for operation in ("control", "input", "configuration", "identity", "wireless"):
            with self.subTest(operation=operation):
                from test_protocol import identity_report
                from test_wireless import status

                client = self.connection([telemetry()])
                client.configuration = None
                client._expected_serial_number = None
                client.identity["capabilities"] |= 128
                client._device.close = Mock()
                client._device.feature_reports = {
                    1: [identity_report()], 2: [configuration()],
                    12: [status()], 20: [control_result()],
                }
                entered, release, closing = threading.Event(), threading.Event(), threading.Event()
                errors = []
                calls = {
                    "control": client.reboot,
                    "input": client.read_input_report,
                    "configuration": client.read_configuration,
                    "identity": client.read_info,
                    "wireless": client.read_wireless,
                }
                native_method = ("send_feature_report" if operation == "control"
                                 else "read" if operation == "input" else "get_feature_report")
                native = getattr(client._device, native_method)
                lock = threading.RLock()

                class ObservedLock:
                    def __enter__(self):
                        if threading.current_thread().name == "hid-close":
                            closing.set()
                        return lock.__enter__()

                    def __exit__(self, *args):
                        return lock.__exit__(*args)

                def blocked(*args):
                    entered.set()
                    if not release.wait(3):
                        raise AssertionError("native I/O release timed out")
                    return native(*args)

                def run(call):
                    try:
                        call()
                    except Exception as error:
                        errors.append(error)

                client._control_lock = ObservedLock()
                setattr(client._device, native_method, blocked)
                worker = threading.Thread(target=run, args=(calls[operation],))
                closer = threading.Thread(target=run, args=(client.close,), name="hid-close")
                worker.start()
                try:
                    self.assertTrue(entered.wait(1))
                    closer.start()
                    self.assertTrue(closing.wait(1), "close must acquire the shared native I/O lock")
                    client._device.close.assert_not_called()
                    self.assertFalse(client.closed)
                finally:
                    release.set()
                    worker.join(3)
                    if closer.ident is not None:
                        closer.join(3)
                self.assertFalse(worker.is_alive())
                self.assertFalse(closer.is_alive())
                self.assertEqual(errors, [])
                client._device.close.assert_called_once()
                client.close()
                client._device.close.assert_called_once()
                for call in calls.values():
                    with self.assertRaisesRegex(ConnectionError, "closed"):
                        call()

    def test_concurrent_close_is_owned_once_even_when_native_cleanup_fails(self):
        for fails in (False, True):
            with self.subTest(fails=fails):
                client = self.connection()
                entered, release, waiting = threading.Event(), threading.Event(), threading.Event()
                errors = []
                lock = threading.RLock()

                class ObservedLock:
                    def __enter__(self):
                        if threading.current_thread().name == "second-close":
                            waiting.set()
                        return lock.__enter__()

                    def __exit__(self, *args):
                        return lock.__exit__(*args)

                client._control_lock = ObservedLock()

                def close():
                    entered.set()
                    if not release.wait(3):
                        raise AssertionError("native close release timed out")
                    if fails:
                        raise OSError("native close failed")

                def run():
                    try:
                        client.close()
                    except Exception as error:
                        errors.append(error)

                client._device.close = Mock(side_effect=close)
                workers = [threading.Thread(target=run), threading.Thread(target=run, name="second-close")]
                workers[0].start()
                try:
                    self.assertTrue(entered.wait(1))
                    workers[1].start()
                    self.assertTrue(waiting.wait(1))
                    client._device.close.assert_called_once()
                finally:
                    release.set()
                    for worker in workers:
                        if worker.ident is not None:
                            worker.join(3)
                self.assertTrue(all(not worker.is_alive() for worker in workers))
                client._device.close.assert_called_once()
                if fails:
                    self.assertEqual(len(errors), 2)
                    self.assertEqual({type(error) for error in errors}, {OSError, RuntimeError})
                    with self.assertRaisesRegex(RuntimeError, "cleanup failed"):
                        client.read_input_report()
                    with self.assertRaisesRegex(RuntimeError, "cleanup failed"):
                        client.close()
                    client._device.close.assert_called_once()
                else:
                    self.assertEqual(errors, [])
                    self.assertTrue(client.closed)

    def test_read_queued_during_close_never_uses_the_native_handle(self):
        client = self.connection()
        closing, waiting, release = threading.Event(), threading.Event(), threading.Event()
        errors = []
        lock = threading.RLock()

        class ObservedLock:
            def __enter__(self):
                if threading.current_thread().name == "queued-read":
                    waiting.set()
                return lock.__enter__()

            def __exit__(self, *args):
                return lock.__exit__(*args)

        def close():
            closing.set()
            if not release.wait(3):
                raise AssertionError("native close release timed out")

        def run(call):
            try:
                call()
            except Exception as error:
                errors.append(error)

        client._control_lock = ObservedLock()
        client._device.close = Mock(side_effect=close)
        client._device.read = Mock()
        closer = threading.Thread(target=run, args=(client.close,))
        reader = threading.Thread(target=run, args=(client.read_input_report,), name="queued-read")
        closer.start()
        try:
            self.assertTrue(closing.wait(1))
            reader.start()
            self.assertTrue(waiting.wait(1))
            client._device.read.assert_not_called()
        finally:
            release.set()
            closer.join(3)
            if reader.ident is not None:
                reader.join(3)
        self.assertFalse(closer.is_alive())
        self.assertFalse(reader.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ConnectionError)
        client._device.read.assert_not_called()
        client._device.close.assert_called_once()

    def test_initializes_cached_device_state(self):
        transport = Mock()
        with patch("espforge.hid.device._select_device", return_value={
                "path": b"/hid/a", "serial_number": "0123456789ABCDEF"}), \
                patch("espforge.hid.device._require_hid") as hid:
            hid.return_value.device.return_value = transport
            client = ESPForgeHid()
        self.assertIsNone(client.configuration)
        self.assertIsNone(client._tested_generation)
        self.assertIsNone(client._tested_at)

    def test_capability_gate_reuses_cached_identity(self):
        client = self.connection()
        client.read_info = Mock(side_effect=AssertionError("identity is already cached"))
        client._device.feature_reports[20] = [control_result()]
        self.assertEqual(client.reboot()["status"], "completed")
        client.read_info.assert_not_called()

    def test_forced_save_and_removed_feature_methods_are_unavailable(self):
        client = self.connection()
        with self.assertRaises(TypeError):
            client.set_settings({"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 0}, force=True)
        with self.assertRaises(InvalidRequest):
            client.set_settings({"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 0,
                                 "tcp_cli_enabled": True})
        for name in ("set_led", "set_msc", "set_self_test", "tcp_cli_auth_proof", "_reopen_for_result"):
            self.assertFalse(hasattr(client, name), name)
        self.assertEqual(client._device.sent, [])

    def connection(self, reports=None):
        class FakeTransport:
            def __init__(self):
                self.reports = list(reports or [])
                self.sent = []
                self.feature_reports = {}

            def read(self, size, timeout):
                report = self.reports.pop(0) if self.reports else []
                return report[:size]

            def send_feature_report(self, payload):
                self.sent.append(bytes(payload))
                return len(payload)

            def get_feature_report(self, report_id, size):
                self.last_get = (report_id, size)
                response = self.feature_reports[report_id].pop(0)
                return response

        client = ESPForgeHid.__new__(ESPForgeHid)
        client._device = FakeTransport()
        client.closed = False
        client._close_error = None
        client.identity = identity()
        client._transaction_id = 0
        client.last_command_result = None
        client._command_uncertain = False
        client._uncertain_command = None
        client._uncertain_wireless_operation = None
        client._control_lock = threading.RLock()
        client._wireless_active = False
        client._tested_generation = None
        client._tested_at = None
        return client

    def test_input_reports_dispatch_under_new_ids(self):
        client = self.connection([telemetry()])
        self.assertEqual(client.read_input_report()["kind"], "runtime")
        self.assertTrue(client._device.reports == [])

    def test_feature_20_command_write_then_result_read(self):
        client = self.connection()
        client._device.feature_reports[20] = [control_result()]
        result = client.reboot()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(client._device.sent, [build_control_command_report(1, 2, flags=1)])
        self.assertEqual(client._device.last_get, (20, CONTROL_FEATURE_SIZE))

    def test_settings_save_uses_one_command_and_verified_result_without_configuration_read(self):
        client = self.connection()
        client._device.feature_reports[20] = [control_result(opcode=5)]
        client._device.feature_reports[2] = [configuration()]
        settings = {"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 0}
        self.assertEqual(client.set_settings(settings), {**settings, "tcp_cli_enabled": False})
        self.assertEqual(client._device.sent, [build_control_command_report(1, 5, arguments=bytes((240, 0, 0, 0)))])
        self.assertEqual(client._device.feature_reports[2], [configuration()])
        self.assertEqual(client._device.last_get, (20, 69))

    def test_unavailable_capability_blocks_control_write(self):
        client = self.connection()
        client.identity["capabilities"] = 0x0C
        with self.assertRaisesRegex(RuntimeError, "reboot"):
            client.reboot()
        self.assertEqual(client._device.sent, [])
        client.identity["capabilities"] = 0x0A
        with self.assertRaisesRegex(RuntimeError, "persistent settings"):
            client.set_settings({"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 0})
        client.identity["capabilities"] = 0x8E & ~128
        with self.assertRaisesRegex(RuntimeError, "Wireless"):
            client.cancel_wireless_test()
        self.assertEqual(client._device.sent, [])

    def test_invalid_user_input_is_rejected_before_any_write(self):
        client = self.connection()
        client.identity["capabilities"] |= 128
        for command in (
            lambda: client.set_settings({"system_clock_mhz": 100, "sdcard_profile": 0, "radios": 0}),
            lambda: client.set_settings({"system_clock_mhz": 150, "sdcard_profile": 0}),
            lambda: client.set_settings({"system_clock_mhz": 200, "sdcard_profile": 0, "radios": 0}),
            lambda: client.set_settings({"system_clock_mhz": 240, "sdcard_profile": 1, "radios": 0}),
            lambda: client.test_wireless("LabNet", "short"),
            lambda: client.set_wireless({"wifi_enabled": True}),
        ):
            with self.assertRaises(InvalidRequest):
                command()
        self.assertEqual(client._device.sent, [])
        self.assertFalse(client.command_uncertain)

    def test_benchmark_input_report_11_is_a_protocol_error(self):
        client = self.connection([bytes([11]) + bytes(32)])
        with self.assertRaisesRegex(ProtocolError, "report 11"):
            client.read_input_report()

    def test_command_result_must_match_transaction_and_opcode(self):
        client = self.connection()
        client._device.feature_reports[20] = [control_result(opcode=5, transaction=1)]
        with patch("espforge.hid.device.monotonic", side_effect=[0, 5.1]):
            with self.assertRaisesRegex(TimeoutError, "uncertain"):
                client.reboot()
        with self.assertRaisesRegex(RuntimeError, "uncertain outcome"):
            client.reboot()
        self.assertEqual(len(client._device.sent), 1)


if __name__ == "__main__":
    unittest.main()
