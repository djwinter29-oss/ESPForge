# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Contract and lifecycle checks for USB Features 12 and 20."""

import threading
import unittest
from unittest.mock import Mock, patch

from zephyrforge_tests.support.helpers import make_monitor
from zephyrforge_tests.support.wireless_fixtures import BOARD, make_wireless_client, result, settings, status
from zephyrforge.dashboard.server import create_app
from zephyrforge.dashboard.monitor import CommandOutcomeUncertain
from zephyrforge.hid.device import WirelessTestCancelled
from zephyrforge.reports import (
    CONTROL_REPORT_ID, WIRELESS_REPORT_ID,
    build_wireless_command_report, build_settings_command_report,
    ProtocolError, parse_control_result_report, parse_wireless_status_report,
    validate_wireless_configuration,
)

class WirelessWorkflowTests(unittest.TestCase):
    def client(self, reports=()):
        return make_wireless_client(reports)

    def test_test_workflow_wrap_and_independent_generations(self):
        client = self.client([
            status(test=255, generation=900, scan=2),
            result(6, 1), result(7, 2), result(9, 3),
            status(wifi=5, flags=0xB3, test=255, generation=900, scan=2),
            status(wifi=4, flags=0x33, test=1, generation=900, scan=2),
            status(wifi=5, flags=0xB3, test=1, generation=900, scan=2),
        ])
        poll, progress = Mock(), Mock()
        with patch("zephyrforge.hid.device.sleep") as sleep:
            tested = client.test_wireless(b"ESP\0\xff", "secret12", on_poll=poll, on_progress=progress)
        commands = [bytes(call.args[0]) for call in client._device.send_feature_report.call_args_list]
        self.assertEqual([command[3] for command in commands], [6, 7, 9])
        self.assertEqual(commands[0][6:11], b"ESP\0\xff")
        self.assertRegex(tested["test_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(tested, {"ipv4": "192.168.1.2", "detail": 0, "phase": "", "test_id": client._tested_id,
                                  "test_generation": 1, "remaining_seconds": 600})
        self.assertEqual(poll.call_count, 3)
        sleep.assert_called_with(0.5)
        self.assertFalse(client._command_uncertain)

    def test_scan_workflow_and_entry_generation_validation(self):
        data = bytearray(63)
        data[:5] = bytes((1, 0, 0, 1, 65))
        data[36] = 200
        client = self.client([
            status(scan=2, generation=65535, test=22), result(11),
            status(scan=1, generation=1, test=22), status(scan=2, generation=1, count=1, test=22),
            result(12, 2, data=data),
        ])
        with patch("zephyrforge.hid.device.sleep"):
            networks = client.scan_wireless()
        self.assertEqual(networks[0]["ssid"], "A")
        sent = client._device.send_feature_report.call_args_list
        self.assertEqual([call.args[0][3] for call in sent], [11, 12])
        self.assertEqual(sent[1].args[0][5:8], [0, 1, 0])
        client = self.client([status(), result(11), status(scan=2, generation=1, count=1),
                              result(12, 2, data=bytes((2,)) + data[1:])])
        with self.assertRaisesRegex(ValueError, "generation"):
            client.scan_wireless()
        self.assertFalse(client.command_uncertain)

    def test_test_failure_expiry_and_generation_mismatch(self):
        for final, error in ((status(wifi=6, test=1, flags=0x33, detail=3), RuntimeError),
                             (status(wifi=4, test=2, flags=0x33), ValueError)):
            client = self.client([status(), result(6), result(7, 2), result(9, 3), final])
            with self.assertRaises(error):
                client.test_wireless("new", "secret12")
            self.assertEqual(client.command_uncertain, error is ValueError)
        client = self.client([status(staged=8)])
        with self.assertRaisesRegex(RuntimeError, "expired"):
            client._tested_id, client._tested_generation = "a" * 32, 9
            client.set_wireless(settings(use_tested_wifi=True, test_id="a" * 32, test_generation=9))
        client._device.send_feature_report.assert_not_called()

    def test_tested_save_never_restages_pair_or_reads_after_save(self):
        candidate = status(wifi=5, flags=0xB3, test=9)
        saved = bytes((240, 0, 0, 3, 3))
        client = self.client([candidate, candidate, result(5, data=saved)])
        client._tested_id, client._tested_generation = "a" * 32, 9
        response = client.set_wireless(settings(use_tested_wifi=True, test_id="a" * 32, test_generation=9))
        sent = client._device.send_feature_report.call_args_list
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0].args[0][3:5], [5, 2])
        self.assertEqual(response["settings"], BOARD)
        self.assertEqual(response["ssid_hex"], "ESP網".encode().hex())
        self.assertTrue(response["stale"])
        self.assertEqual(client._device.get_feature_report.call_count, 3)
        client = self.client([candidate])
        client._tested_id, client._tested_generation = "a" * 32, 9
        with self.assertRaisesRegex(RuntimeError, "exact staged"):
            client.set_wireless(settings(use_tested_wifi=True, ssid="different", test_id="a" * 32, test_generation=9))
        client._device.send_feature_report.assert_not_called()

    def test_tested_save_requires_the_browser_test_identity_before_any_write(self):
        candidate = status(wifi=5, flags=0xB3, test=9)
        for token, generation in (("b" * 32, 9), ("a" * 32, 8), ("a" * 32, 9)):
            client = self.client([candidate])
            client._tested_id = "a" * 32 if generation != 9 or token != "a" * 32 else None
            client._tested_generation = 9
            request = settings(use_tested_wifi=True, test_id=token, test_generation=generation)
            with self.subTest(token=token, generation=generation), self.assertRaisesRegex(RuntimeError, "test"):
                client.set_wireless(request)
            client._device.send_feature_report.assert_not_called()

    def test_same_ssid_retest_issues_new_identity_and_rejects_the_original_browser(self):
        client = self.client([status(test=255), result(6), result(7, 2), result(9, 3),
                              status(wifi=5, flags=0xB3, test=1),
                              status(wifi=5, flags=0xB3, test=1), result(6, 4), result(7, 5), result(9, 6),
                              status(wifi=5, flags=0xB3, test=2), status(wifi=5, flags=0xB3, test=2)])
        first = client.test_wireless("ESP網", "secret12")
        second = client.test_wireless("ESP網", "another12")
        self.assertNotEqual(first["test_id"], second["test_id"])
        self.assertEqual((first["test_generation"], second["test_generation"]), (1, 2))
        with self.assertRaisesRegex(RuntimeError, "test"):
            client.set_wireless(settings(use_tested_wifi=True, test_id=first["test_id"],
                                         test_generation=first["test_generation"]))
        self.assertEqual([call.args[0][3] for call in client._device.send_feature_report.call_args_list],
                         [6, 7, 9, 6, 7, 9])

    def test_key_only_save_cannot_commit_an_unowned_password(self):
        for flags, include_ssid in ((0xB3, True), (0xB3, False), (0x43, False)):
            client = self.client([status(wifi=5, flags=flags, test=9)])
            request = settings(ble_key="ab" * 32) if flags != 0x43 else settings()
            if not include_ssid:
                request.pop("ssid")
            with self.subTest(flags=flags, include_ssid=include_ssid), self.assertRaisesRegex(RuntimeError, "staged"):
                client.set_wireless(request)
            client._device.send_feature_report.assert_not_called()

    def test_tested_save_rechecks_pair_after_staging_owned_key(self):
        for replaced in (False, True):
            candidate = status(wifi=5, flags=0xB3, test=9)
            staged = status(wifi=5, flags=0xF3, test=10 if replaced else 9)
            reports = [candidate, result(8), staged]
            if not replaced:
                reports.append(result(5, 2, data=bytes((240, 0, 0, 3, 7))))
            client = self.client(reports)
            client._tested_id, client._tested_generation = "a" * 32, 9
            request = settings(use_tested_wifi=True, test_id="a" * 32, test_generation=9, ble_key="ab" * 32)
            if replaced:
                with self.assertRaisesRegex(RuntimeError, "pair changed"):
                    client.set_wireless(request)
            else:
                client.set_wireless(request)
            self.assertEqual([call.args[0][3] for call in client._device.send_feature_report.call_args_list],
                             [8] if replaced else [8, 5])

    def test_invalid_or_unrelated_test_identity_is_rejected(self):
        for token, generation in ((None, 1), ("", 1), ("a" * 32, None), ("a" * 32, 0), ("a" * 32, True),
                                  ("a" * 32, 256), ("A" * 32, 1), ("g" * 32, 1)):
            with self.subTest(token=token, generation=generation), self.assertRaises(ValueError):
                validate_wireless_configuration(settings(use_tested_wifi=True, test_id=token,
                                                         test_generation=generation))
        with self.assertRaises(ValueError):
            validate_wireless_configuration(settings(test_id="a" * 32, test_generation=1))

    def test_success_and_cancel_invalidate_cached_wireless_observations(self):
        monitor, client = self.monitor()
        monitor._snapshot["wireless"] = {"ssid": "previous-candidate", "test_generation": 1}
        def tested(*args, **kwargs):
            self.assertIsNone(monitor.snapshot()["wireless"], "invalidate before the test writes or returns")
            return {"test_generation": 2, "remaining_seconds": 600, "test_id": "a" * 32}
        client.test_wireless.side_effect = tested
        monitor.test_wireless("new-candidate", "")
        self.assertIsNone(monitor.snapshot()["wireless"])
        monitor._snapshot["wireless"] = {"ssid": "new-candidate", "test_generation": 2}
        monitor.cancel_wireless_test()
        self.assertIsNone(monitor.snapshot()["wireless"])

    def test_explicit_empty_ssid_owns_firmware_implicit_password_erasure(self):
        client = self.client([status(), result(6), status(flags=0x33, ssid=b""),
                              result(5, 2, data=bytes((240, 0, 0, 3, 3)))])
        client.set_wireless(settings(ssid=""))
        self.assertEqual([call.args[0][3] for call in client._device.send_feature_report.call_args_list], [6, 5])

    def test_save_rejects_expired_or_unrequested_staged_fields_before_commit(self):
        for flags in (0x03, 0x73):
            client = self.client([status(), result(8), status(flags=flags)])
            request = settings(ble_key="ab" * 32)
            request.pop("ssid")
            with self.subTest(flags=flags), self.assertRaisesRegex(RuntimeError, "expired or were replaced"):
                client.set_wireless(request)
            self.assertEqual([call.args[0][3] for call in client._device.send_feature_report.call_args_list], [8])

    def test_sequential_save_stages_only_provided_fields_and_verifies_commit(self):
        staged = status(flags=0x73)
        client = self.client([status(), result(6), result(7, 2), result(8, 3), staged,
                              result(5, 4, data=bytes((240, 0, 0, 3, 7)))])
        response = client.set_wireless(settings(password="secret12", ble_key="ab" * 32))
        self.assertEqual(response["settings"], BOARD)
        self.assertEqual([call.args[0][3] for call in client._device.send_feature_report.call_args_list],
                         [6, 7, 8, 5])
        client = self.client([status(), status(), result(5, data=bytes((240, 0, 0, 3, 0)))])
        request = settings()
        request.pop("ssid")
        client.set_wireless(request)
        self.assertEqual(client._device.send_feature_report.call_count, 1)
        self.assertEqual(client._device.send_feature_report.call_args.args[0][4], 0)
        for data in (bytes((160, 0, 0, 3, 1)), bytes((240, 0, 0, 3, 0))):
            client = self.client([status(), result(6), status(flags=0x13), result(5, 2, data=data)])
            with self.assertRaisesRegex(ProtocolError, "differ"):
                client.set_wireless(settings())
            self.assertFalse(client.command_uncertain)

    def test_hex_save_uses_raw_ssid_and_returns_verified_saved_fields(self):
        board = {**BOARD, "tcp_cli_enabled": False, "radios": 1}
        client = self.client([status(), result(6), result(7, 2), status(flags=0x33),
                              result(5, 3, data=bytes((240, 0, 0, 1, 3)))])
        request = settings(ssid="display-only", ssid_hex="4100fF", password="", ble_enabled=False,
                           tcp_cli_enabled=False, board=board)
        response = client.set_wireless(request)
        sent = client._device.send_feature_report.call_args_list
        self.assertEqual(sent[0].args[0][5:9], [3, 65, 0, 255])
        self.assertEqual(response["ssid_hex"], "4100ff")
        self.assertEqual(response["ssid"], "A\\x00\\xFF")
        self.assertFalse(response["ble_enabled"])
        self.assertFalse(response["tcp_cli_enabled"])
        self.assertEqual(response["settings"], board)
        for encoded in ("0", "gg", "01 02", "a" * 66, None, 12):
            with self.subTest(encoded=encoded), self.assertRaises(ValueError):
                validate_wireless_configuration(settings(ssid_hex=encoded))

    def test_all_zero_control_key_is_present_and_only_empty_input_clears(self):
        for key, configured in (("00" * 32, True), ("", False)):
            client = self.client([status(), result(8), status(flags=0x43, staged=0 if configured else 4),
                                  result(5, 2, data=bytes((240, 0, 0, 3, 4)))])
            request = settings(ble_key=key)
            request.pop("ssid")
            response = client.set_wireless(request)
            self.assertEqual(response["ble_key_configured"], configured)
            staged_command = client._device.send_feature_report.call_args_list[0].args[0]
            self.assertEqual(staged_command[5], 32 if configured else 0)

    def test_cancel_during_scan_uses_opcode_ten_without_clearing_scan(self):
        client = self.client([result(10)])
        client.cancel_wireless_test()
        command = client._device.send_feature_report.call_args.args[0]
        self.assertEqual(command[:5], [20, 1, 1, 10, 0])
        self.assertEqual(command[5:], [0] * 64)
        client._device.get_feature_report.assert_called_once_with(20, 69)

    def test_cancelled_test_sends_cancel_and_leaves_outcome_known(self):
        client = self.client([status(), result(6, 1), result(7, 2), result(9, 3), result(10, 4)])
        stop = threading.Event()
        stop.set()
        with self.assertRaises(WirelessTestCancelled):
            client.test_wireless("ESP32", "secret12", cancel=stop)
        sent = [call.args[0][3] for call in client._device.send_feature_report.call_args_list]
        self.assertEqual(sent, [6, 7, 9, 10])
        self.assertFalse(client._command_uncertain)

    def test_failed_cancel_is_known_and_lost_cancel_reconciles_its_own_result_only(self):
        for lost in (False, True):
            with self.subTest(lost=lost):
                client = self.client([
                    status(), result(6, 1), result(7, 2), result(9, 3),
                    OSError("lost cancel reply") if lost else result(10, 4, state=6, error=6),
                ])
                stop = threading.Event()
                stop.set()
                with self.assertRaises((OSError, RuntimeError)):
                    client.test_wireless("ESP32", "secret12", cancel=stop)
                self.assertEqual(client.command_uncertain, lost)
                self.assertIsNone(client.uncertain_wireless_operation)
                self.assertEqual(client.uncertain_command, (4, 10) if lost else None)
                if lost:
                    client._device.get_feature_report.side_effect = [result(10, 4)]
                    self.assertIsNotNone(client.reconcile_outcome((4, 10), None))
                    self.assertFalse(client.command_uncertain)
                self.assertEqual(client._device.send_feature_report.call_count, 4)

    def test_timeout_does_not_replay_scan_or_save(self):
        # A stale result cannot resolve a SET, even when its opcode matches.
        for opcode in (5, 11):
            client = self.client([result(opcode, 255)])
            command = (build_settings_command_report(BOARD, 1) if opcode == 5 else
                       build_wireless_command_report(1, opcode))
            with patch("zephyrforge.hid.device.monotonic", side_effect=[0, 6]), self.assertRaises(TimeoutError):
                client._execute_control(command, opcode)
            self.assertTrue(client._command_uncertain)
            with self.assertRaisesRegex(RuntimeError, "uncertain"):
                client.cancel_wireless_test()
            client._device.send_feature_report.assert_called_once()

    def test_async_timeout_preserves_uncertainty(self):
        client = self.client([])
        with patch("zephyrforge.hid.device.monotonic", side_effect=[0, 36]), self.assertRaises(TimeoutError):
            client._poll_wireless("test", 0, 35)
        self.assertTrue(client.command_uncertain)
        self.assertEqual(client.uncertain_wireless_operation, ("test", 1))

    def test_reconcile_requires_matching_command_and_terminal_wireless_generation(self):
        client = self.client()
        client._command_uncertain = True
        client._uncertain_command = (7, 11)
        client._uncertain_wireless_operation = ("scan", 3)
        statuses = iter((status(scan=1, generation=3), status(scan=2, generation=3, count=1)))

        def read_report(report_id, _size):
            if report_id == CONTROL_REPORT_ID:
                return result(11, transaction=7)
            if report_id == WIRELESS_REPORT_ID:
                return next(statuses)
            raise AssertionError(f"Unexpected HID report {report_id}")

        client._device.get_feature_report.side_effect = read_report
        self.assertIsNone(client.reconcile_outcome((8, 11), ("scan", 3)))
        self.assertTrue(client.command_uncertain)
        self.assertIsNone(client.reconcile_outcome((7, 11), ("scan", 3)))
        self.assertTrue(client.command_uncertain)
        control, wireless = client.reconcile_outcome((7, 11), ("scan", 3))
        self.assertEqual((control["transaction_id"], control["opcode"]), (7, 11))
        self.assertEqual(wireless["scan_state"], "complete")
        self.assertFalse(client.command_uncertain)

    def test_saved_switches_come_from_report_two_not_runtime(self):
        client = self.client([status()])
        client.configuration = {"radios": 1, "tcp_cli_enabled": False}
        parsed = client.read_wireless()
        self.assertTrue(parsed["wifi_enabled"])
        self.assertFalse(parsed["ble_enabled"])
        self.assertFalse(parsed["tcp_cli_enabled"])
        client.read_configuration = Mock(return_value=client.configuration)
        request = {"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 1}
        self.assertFalse(client._complete_settings(request)["tcp_cli_enabled"])
        client.read_configuration.side_effect = OSError("no Report 2")
        self.assertFalse(client._complete_settings(request)["tcp_cli_enabled"])
        client.read_configuration.assert_not_called()

    def test_resync_discards_only_reset_ram_wifi_operations_without_replaying_them(self):
        for opcode in (6, 7, 9, 10, 11, 12):
            with self.subTest(opcode=opcode):
                client = self.client([result(0, transaction=0, state=0), status(wifi=0, ssid=b"")])
                client._command_uncertain = True
                client._uncertain_command = (7, opcode)
                client._uncertain_wireless_operation = ("test", 2)
                control, wireless = client.reconcile_outcome((7, opcode), ("test", 2))
                self.assertIsNone(control, "reset is not a successful command result")
                self.assertEqual(wireless["test_generation"], 0)
                self.assertFalse(client.command_uncertain)
                self.assertIsNone(client._uncertain_command)
                self.assertIsNone(client._uncertain_wireless_operation)
                client._device.send_feature_report.assert_not_called()

    def test_resync_never_discards_save_reboot_key_or_nonreset_wifi(self):
        for opcode in (2, 5, 8):
            with self.subTest(opcode=opcode):
                client = self.client([result(0, transaction=0, state=0)])
                client._command_uncertain = True
                self.assertIsNone(client.reconcile_outcome((7, opcode), None))
                self.assertTrue(client.command_uncertain)
                client._device.send_feature_report.assert_not_called()
        for wireless in (
            status(scan=2, generation=1), status(wifi=6, test=1),
            status(flags=0x13), status(flags=0x23), status(flags=0x43),
        ):
            with self.subTest(wireless=wireless):
                client = self.client([result(0, transaction=0, state=0), wireless])
                client._command_uncertain = True
                self.assertIsNone(client.reconcile_outcome((7, 9), ("test", 2)))
                self.assertTrue(client.command_uncertain)

    def test_confirmed_wifi_failure_without_driver_reason_is_not_called_a_timeout(self):
        client = self.client([status(wifi=6, test=1)])
        with self.assertRaisesRegex(RuntimeError, "driver did not report a reason"):
            client._poll_wireless("test", 0, 35)
        self.assertFalse(client.command_uncertain)

    def test_status_read_returns_owned_snapshot_without_mutating_previous_reads(self):
        for initial, active in ((status(), False), (status(wifi=4, flags=0x33, test=1), True),
                                (status(scan=1, generation=1), True)):
            client = self.client([initial, OSError("USB")])
            cached = client.read_wireless()
            self.assertEqual(client.wireless_active, active)
            with self.assertRaises(OSError):
                client.read_wireless()
            self.assertFalse(cached["stale"])

    def test_tcp_proof_opcode_is_unavailable(self):
        with self.assertRaises(ValueError):
            build_wireless_command_report(7, 13, value=bytes(16))
        parsed = parse_control_result_report(result(13, 7, state=4, error=4))
        self.assertEqual((parsed["status"], parsed["proof"]), ("unsupported", None))
        with self.assertRaises(ValueError):
            parse_control_result_report(result(13, 7, data=bytes(16)))

    def test_uncertain_delivery_blocks_all_later_writes(self):
        for failure in ("short", OSError("USB"), ValueError("invalid result")):
            client = self.client([failure])
            if failure == "short":
                client._device.send_feature_report.side_effect = lambda _: 1
            elif isinstance(failure, ValueError):
                client._device.get_feature_report.side_effect = [bytes(69)]
            with self.assertRaises((OSError, ValueError)):
                client.cancel_wireless_test()
            self.assertTrue(client._command_uncertain)
            with self.assertRaisesRegex(RuntimeError, "uncertain"):
                client.reboot()
            self.assertEqual(client._device.send_feature_report.call_count, 1)

    def test_http_routes_validate_sanitize_and_preserve_raw_ssid(self):
        boards = Mock()
        dashboard = boards.monitor.return_value
        saved = {"wireless": parse_wireless_status_report(status()), "reboot_pending": True, "settings": BOARD}
        dashboard.set_wireless.side_effect = lambda body: validate_wireless_configuration(body) or saved
        dashboard.test_wireless.return_value = {"test": {"state": 5}}
        dashboard.scan_wireless.return_value = {"networks": []}
        dashboard.cancel_wireless_test.return_value = {"cancelled": True}
        client = create_app(boards).test_client()
        for body in (None, [], settings(confirm_reboot=False), settings(password="short")):
            self.assertEqual(client.post("/api/wireless?board=a", json=body).status_code, 400)
        body = settings(password="secret12", ble_key="ab" * 32)
        response = client.post("/api/wireless?board=a", json=body)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("secret12", response.text)
        self.assertNotIn("ab" * 32, response.text)
        self.assertEqual(client.post("/api/wireless/scan?board=a").status_code, 200)
        self.assertEqual(client.post("/api/wireless/cancel?board=a").json, {"cancelled": True})
        monitor_calls = boards.monitor.call_count
        for body in (None, [], {"ssid": [True]}, {"ssid": [-1]}, {"ssid": [256]}, {"ssid": ["65"]},
                     {"ssid": "ESP32", "password": 123}):
            with self.subTest(body=body):
                self.assertEqual(client.post("/api/wireless/test?board=a", json=body).status_code, 400)
        dashboard.test_wireless.assert_not_called()
        self.assertEqual(boards.monitor.call_count, monitor_calls)
        self.assertEqual(client.post("/api/wireless/test?board=a",
                                     json={"ssid": [65, 0, 255], "password": ""}).status_code, 200)
        dashboard.test_wireless.assert_called_once_with(b"A\0\xff", "")
        boards.monitor.assert_called_with("a")
        self.assertEqual(client.post("/api/wireless/test?board=a",
                                     json={"ssid": "ignored", "ssid_hex": "4100FF", "password": ""}).status_code, 200)
        dashboard.test_wireless.assert_called_with(b"A\0\xff", "")
        for failure, uncertain in (
            (TimeoutError("secret12"), True),
            (OSError("secret12"), False),
            (ProtocolError("secret12"), False),
        ):
            dashboard.test_wireless.side_effect = failure
            response = client.post("/api/wireless/test", json={"ssid": "ESP32", "password": "secret12"})
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json["uncertain"], uncertain)
            self.assertNotIn("secret12", response.text)
        dashboard.test_wireless.side_effect = ValueError("bug")
        response = client.post("/api/wireless/test", json={"ssid": "ESP32", "password": ""})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json["error"], "Internal server error")

    def monitor(self):
        client = Mock()
        return make_monitor(client, {"connected": True, "hardware": {"wireless_supported": True},
                                     "memory": {"msc": {"enabled": False, "transition_pending": False}}}), client

    def test_busy_command_reply_does_not_block_later_wireless_commands(self):
        monitor, client = self.monitor()
        client.reboot.return_value = {"status": "busy", "error": "busy", "detail": 0}
        with self.assertRaisesRegex(RuntimeError, "busy"):
            monitor.reboot()
        self.assertEqual(monitor.snapshot()["control_result"]["status"], "busy")
        client.scan_wireless.return_value = []
        self.assertEqual(monitor.scan_wireless(), {"networks": []})

    def test_monitor_ownership_gates_and_input_pump(self):
        monitor, client = self.monitor()
        baseline = monitor._snapshot.copy()
        for change in ({"connected": False}, {"hardware": {}}, {"memory": None},
                       {"memory": {"msc": {"enabled": True}}}, {"memory": {"msc": {"transition_pending": True}}},
                       {"reboot_pending": True}):
            monitor._snapshot = {**baseline, **change}
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                monitor.set_wireless(settings())
            client.set_wireless.assert_not_called()
        monitor._snapshot = baseline
        client.read_input_report.return_value = {"kind": "memory", "data": {"msc": {"enabled": False}}}
        monitor._drain_input_reports()
        self.assertEqual(client.read_input_report.call_count, 16)
        client.read_input_report.side_effect = OSError("USB disconnected")
        with self.assertRaises(OSError):
            monitor._drain_input_reports()

    def test_monitor_polls_wireless_at_active_and_idle_intervals(self):
        for active, interval in ((False, 2.0), (True, 0.5)):
            monitor, client = self.monitor()
            monitor._stop = threading.Event()
            client.wireless_active = active
            client.read_info.return_value = {
                "supported": True, "settings_supported": False, "wireless_supported": True,
            }
            client.read_configuration.return_value = BOARD
            client.read_input_report.return_value = None
            client.read_wireless.side_effect = [OSError("bad status"), {"ssid": "new", "stale": False}]
            monitor._client_factory = lambda: client
            now = [0.0]
            iterations = []

            def wait(timeout):
                if timeout == 0.05:
                    iterations.append(now[0])
                    now[0] += interval / 2
                    if len(iterations) == 3:
                        monitor._stop.set()
                return False

            monitor._stop.wait = wait
            with patch("zephyrforge.dashboard.monitor.time.monotonic", side_effect=lambda: now[0]):
                monitor._run()
            self.assertEqual(client.read_wireless.call_count, 2)
            self.assertEqual(monitor._snapshot["wireless"]["ssid"], "new")
            self.assertIsNone(monitor._snapshot["wireless_error"])

    def test_monitor_keeps_serving_inputs_and_freshness_while_testing(self):
        monitor, client = self.monitor()
        runtime = {"temperature_valid": True, "temperature_centidegrees": 2500,
                   "led_available": False, "led_on": False}
        memory = {"msc": {"enabled": False, "transition_pending": False}, "filesystem_format": "fat32"}
        client.read_input_report.side_effect = [
            {"kind": "runtime", "data": runtime}, {"kind": "memory", "data": memory},
            None,
        ]

        def joining(ssid, password, *, on_poll, on_progress, cancel):
            on_progress("Connecting to Wi-Fi")
            self.assertEqual(monitor.snapshot()["wireless_phase"], "Connecting to Wi-Fi")
            monitor._input_received_at = {"runtime": 0, "memory": 0}
            with patch("zephyrforge.dashboard.monitor.time.monotonic", return_value=30):
                self.assertTrue(monitor.snapshot()["telemetry_stale"])
                on_poll()
                snapshot = monitor.snapshot()
                self.assertFalse(snapshot["telemetry_stale"])
                self.assertFalse(snapshot["storage_stale"])
                self.assertEqual(snapshot["runtime"], runtime)
                self.assertEqual(snapshot["memory"], memory)
            return {"remaining_seconds": 600}

        client.test_wireless.side_effect = joining
        self.assertEqual(monitor.test_wireless("ESP網", "secret12")["test"]["remaining_seconds"], 600)
        self.assertIsNone(monitor.snapshot()["wireless_phase"])

    def test_cancel_reaches_running_test_while_other_commands_get_busy(self):
        for finishes_first in (False, True):
            with self.subTest(finishes_first=finishes_first):
                monitor, client = self.monitor()
                started = threading.Event()

                def joining(ssid, password, *, on_poll, on_progress, cancel):
                    started.set()
                    self.assertTrue(cancel.wait(10), "never cancelled")
                    if finishes_first:
                        return {"remaining_seconds": 600}
                    client.cancel_wireless_test()
                    raise WirelessTestCancelled("Wi-Fi test cancelled")

                client.test_wireless.side_effect = joining
                outcome = []
                worker = threading.Thread(target=lambda: outcome.append(self.run_test(monitor)))
                worker.start()
                self.assertTrue(started.wait(2))
                with patch("zephyrforge.dashboard.monitor._BUSY_WAIT_SECONDS", 0.1), \
                        self.assertRaisesRegex(RuntimeError, "busy with another command"):
                    monitor.reboot()
                client.reboot.assert_not_called()
                self.assertEqual(monitor.cancel_wireless_test(), {"cancelled": True})
                worker.join(2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(outcome, [600 if finishes_first else "cancelled"])
                client.cancel_wireless_test.assert_called_once_with()
                self.assertFalse(monitor.snapshot()["command_outcome_uncertain"])

    @staticmethod
    def run_test(monitor):
        try:
            return monitor.test_wireless("ESP32", "secret12")["test"]["remaining_seconds"]
        except WirelessTestCancelled:
            return "cancelled"

    def test_monitor_uncertainty_propagates_to_other_writes(self):
        monitor, client = self.monitor()
        client.command_uncertain = True
        client.scan_wireless.side_effect = OSError("USB")
        with self.assertRaises(CommandOutcomeUncertain):
            monitor.scan_wireless()
        self.assertTrue(monitor.snapshot()["command_outcome_uncertain"])
        with self.assertRaisesRegex(RuntimeError, "uncertain"):
            monitor.cancel_wireless_test()


if __name__ == "__main__":
    unittest.main()
