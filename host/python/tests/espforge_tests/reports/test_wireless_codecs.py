# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

import unittest

from espforge.reports import (
    build_settings_command_report,
    build_wireless_command_report,
    parse_control_result_report,
    parse_wireless_status_report,
    validate_wireless_configuration,
)
from espforge_tests.support.wireless_fixtures import BOARD, result, settings, status


class WirelessReportCodecTests(unittest.TestCase):
    def test_exact_status_layout_and_opaque_ssid(self):
        raw = b"Wi\0\xff\n" + "網".encode()
        parsed = parse_wireless_status_report(status(ssid=raw))
        self.assertEqual(parsed["ssid"], "Wi\\x00\\xFF\\x0A網")
        self.assertEqual(bytes.fromhex(parsed["ssid_hex"]), raw)
        self.assertEqual(parsed["wifi_state"], "connected")
        self.assertEqual(parsed["ipv4"], "192.168.1.2")
        self.assertNotIn("password_configured", parsed)
        self.assertNotIn("tcp_cli_enabled", parsed)
        self.assertNotIn("error", parsed)
        self.assertNotIn("tcp_cli_auth_required", parsed)
        self.assertNotIn("age_ms", parsed)
        self.assertNotIn("rssi", parsed)
        command = build_wireless_command_report(9, 6, value=bytes.fromhex(parsed["ssid_hex"]))
        self.assertEqual(command[:6], bytes((20, 1, 9, 6, 0, len(raw))))
        self.assertEqual(command[6:6 + len(raw)], raw)
        self.assertEqual(len(command), 69)
        self.assertEqual(parse_wireless_status_report(status(ssid=b"a" * 32))["ssid_hex"], "61" * 32)
        # Reserved flags/detail are ignored, as specified for Feature 12.
        self.assertEqual(parse_wireless_status_report(status(flags=11, detail=255))["detail"], 0)
        for padded in (b"\0" + status(), status() + b"\0"):
            with self.assertRaises(ValueError):
                parse_wireless_status_report(padded)

    def test_status_vectors_and_tcp_cli_flag_rejection(self):
        tested = parse_wireless_status_report(status(wifi=5, flags=0xB3, ssid="ESPForge", test=1))
        self.assertEqual(tested["ssid_hex"], b"ESPForge".hex())
        self.assertFalse(tested["tcp_cli_started"])
        self.assertEqual((tested["wifi_state"], tested["test_generation"], tested["pair_tested"]),
                         ("test_joined", 1, True))
        lost = parse_wireless_status_report(status(wifi=6, flags=0xB3, detail=6, test=1))
        self.assertEqual((lost["wifi_state"], lost["pair_tested"]), ("test_failed", True))
        init = parse_wireless_status_report(status(flags=1, detail=1))
        self.assertEqual((init["wifi_state"], init["detail"]), ("connected", 1))
        # Feature 12 must not advertise the removed TCP CLI.
        for flags in (0x07, 0x04):
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                parse_wireless_status_report(status(flags=flags))

    def test_status_cross_field_validation(self):
        for kwargs in (
            {"wifi": 7}, {"wifi": 4}, {"scan": 1}, {"count": 1},
            {"scan": 1, "generation": 1, "count": 1}, {"scan": 2, "generation": 1, "count": 19},
            {"flags": 0x13, "staged": 8}, {"staged": 1}, {"flags": 0x13, "staged": 1},
            {"flags": 0x83}, {"flags": 5}, {"staged": 16},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                parse_wireless_status_report(status(**kwargs))
        malformed = bytearray(status(ssid=b"a"))
        malformed[12] = 1
        for report in (malformed, status()[:-1], status() + b"\1", bytes((13,)) + status()[1:]):
            with self.assertRaises(ValueError):
                parse_wireless_status_report(report)
        clear = parse_wireless_status_report(status(flags=0x33, staged=3))
        self.assertTrue(clear["ssid_staged"] and clear["password_staged"])
        self.assertEqual(parse_wireless_status_report(status(staged=8))["staged_state"], 8)

    def test_staging_limits_and_save_switch_mask(self):
        for opcode, value, size in ((6, b"x" * 32, 32), (6, "", 0), (7, "", 0),
                                     (7, "x" * 63, 63), (8, "00" * 32, 32), (8, "", 0)):
            command = build_wireless_command_report(1, opcode, value=value)
            self.assertEqual((len(command), command[3], command[5]), (69, opcode, size))
            self.assertFalse(any(command[6 + size:]))
        for opcode, value in ((6, b"x" * 33), (7, "short"), (7, "a" * 64), (7, "abcde\nxy"),
                              (8, "ab"), (8, b"a" * 31)):
            with self.subTest(opcode=opcode), self.assertRaises(ValueError):
                build_wireless_command_report(1, opcode, value=value)
        for commit, flags in ((False, 0), (True, 2)):
            command = build_settings_command_report(BOARD, 7, commit=commit)
            self.assertEqual(command[:9], bytes((20, 1, 7, 5, flags, 240, 0, 0, 3)))
            self.assertEqual(command[9:], bytes(60))
        self.assertEqual(
            build_settings_command_report({key: value for key, value in BOARD.items() if key != "tcp_cli_enabled"}, 7),
            build_settings_command_report(BOARD, 7))
        for board in ({**BOARD, "tcp_cli_enabled": True}, {**BOARD, "sdcard_profile": 1},
                      {**BOARD, "system_clock_mhz": 200}):
            with self.subTest(board=board), self.assertRaises(ValueError):
                build_settings_command_report(board)
        validate_wireless_configuration(settings())
        validate_wireless_configuration(settings(ble_key="00" * 32))
        for overrides in ({"confirm_reboot": False}, {"tcp_cli_enabled": 0}, {"tcp_cli_enabled": True},
                          {"password": "short"}, {"use_tested_wifi": True, "password": "secret12"},
                          {"unknown": 1}, {"board": {**BOARD, 1: True, "unknown": True}}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                validate_wireless_configuration(settings(**overrides))

    def test_scan_entry_layout_and_security(self):
        for security, label in enumerate(("Open", "WEP", "WPA", "WPA", "RSN (WPA2/WPA3)",
                                          "RSN (WPA2/WPA3)", "WPA/RSN", "WPA/RSN")):
            data = bytearray(63)
            data[:6] = bytes((0x34, 0x12, 2, 2, 0, 255))
            data[36:38] = bytes((214, security))
            parsed = parse_control_result_report(result(12, data=data))["scan_entry"]
            self.assertEqual((parsed["generation"], parsed["index"], parsed["ssid_hex"]),
                             (0x1234, 2, "00ff"))
            self.assertEqual((parsed["rssi"], parsed["security"]), (-42, label))
        for offset, value in ((0, 0), (2, 18), (3, 33), (6, 1), (37, 8), (38, 1)):
            data = bytearray(63)
            data[:6] = bytes((1, 0, 0, 2, 65, 66))
            data[offset] = value
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                parse_control_result_report(result(12, data=data))
        command = build_wireless_command_report(4, 12, index=2, generation=0x1234)
        self.assertEqual(command[5:8], bytes((2, 0x34, 0x12)))

    def test_detail_namespace_and_status_applicability(self):
        valid = [(4, 3, 3, 3), (4, 5, 5, 2), (5, 3, 3, 27),
                 (5, 5, 5, 26), (6, 3, 3, 16), (7, 3, 3, 17), (8, 3, 3, 18),
                 (9, 3, 3, 20), (12, 3, 3, 22), (12, 5, 5, 26)]
        for opcode, state, error, detail in valid:
            parsed = parse_control_result_report(result(opcode, state=state, error=error, data=bytes((detail,))))
            self.assertEqual(parsed["detail"], detail)
        invalid = [(4, 6, 6, 8), (4, 6, 6, 9), (4, 6, 6, 10), (5, 5, 5, 28), (6, 5, 5, 26),
                   (13, 5, 5, 25), (10, 1, 0, 0), (6, 1, 0, 0), (5, 3, 1, 27),
                   (12, 3, 3, 16), (5, 2, 0, 255)]
        for opcode, state, error, detail in invalid:
            with self.subTest(opcode=opcode, detail=detail), self.assertRaises(ValueError):
                parse_control_result_report(result(opcode, state=state, error=error, data=bytes((detail,))))
        with self.assertRaises(ValueError):
            parse_control_result_report(result(6, state=3, error=3, data=b"\x10\x01"))
