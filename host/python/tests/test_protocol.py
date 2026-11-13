# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

import json
import re
import struct
import unittest
from pathlib import Path

from espforge.reports import (
    build_control_command_report,
    build_settings_command_report,
    build_wireless_command_report,
    ControlOpcode,
    parse_configuration_report,
    parse_control_result_report,
    parse_identity_report,
    parse_memory_report,
    parse_status_report,
    IDENTITY_PAYLOAD_SIZE,
    CONFIGURATION_PAYLOAD_SIZE,
    TELEMETRY_PAYLOAD_SIZE,
    STORAGE_PAYLOAD_SIZE,
    CONTROL_PAYLOAD_SIZE,
)
from espforge.reports.wireless import WIRELESS_STATUS_SIZE

FIRMWARE_HEADER = Path(__file__).resolve().parents[3] / "firmware/src/app/usb/hid_reports.h"


def status_contract():
    return json.loads((Path(__file__).parents[2] / "web/tests/status-contract.json").read_text())


def identity_report(capabilities=0x96, mcu=3, board=1, product=3):
    payload = (
        bytes([1]) + struct.pack("<H", product) + bytes.fromhex("0123456789ab0000")
        + bytes([1, 2, 3, mcu, board, 0, capabilities])
        + struct.pack("<II", 524288, 100000)
    )
    return bytes([1]) + payload


def configuration_report(clock=240, flags=0x04):
    payload = bytes([1]) + struct.pack("<H", clock) + bytes([0, 0, 43, 44]) + bytes(
        [12, 11, 13, 14, 15, 10]) + bytes([flags, 1, 255, 255])
    return bytes([2]) + payload


def telemetry_report(flags=0x05, led_flags=0, temperature=2345, core1=0xFFFF):
    payload = struct.pack("<BBhQHHIBB", 1, led_flags, temperature, 123456, 1234, core1,
                          240_000_000, 9, flags)
    return bytes([3]) + payload


def storage_report(flags=0x6F, msc=(0, 0, 0), speed=1, cid=bytes(16)):
    if flags & 0x40 and flags & 0x08:
        sample = bytes([1, 3]) + struct.pack("<IBI", 25_000_000, speed, 4096) + cid
    elif flags & 0x40:
        sample = bytes(2 + 9) + cid
    else:
        sample = bytes(2 + 9 + 16)
    payload = bytes([1, 7, flags]) + sample + bytes([3, *msc])
    return bytes([10]) + payload


def control_result(opcode, status, error=0, transaction=11, data=b""):
    return bytes([20, 1, transaction, opcode, status, error]) + data.ljust(63, b"\0")


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.identity = parse_identity_report(identity_report())

    def test_report_sizes_match_the_contract(self):
        self.assertEqual((IDENTITY_PAYLOAD_SIZE, CONFIGURATION_PAYLOAD_SIZE, TELEMETRY_PAYLOAD_SIZE,
                          STORAGE_PAYLOAD_SIZE, WIRELESS_STATUS_SIZE, CONTROL_PAYLOAD_SIZE),
                         (26, 17, 22, 34, 48, 68))

    @unittest.skipUnless(FIRMWARE_HEADER.is_file(), "firmware HID header is unavailable")
    def test_profile_values_match_firmware_header_when_present(self):
        macros = dict(re.findall(r"^#define (EF_\w+) (0x[0-9A-Fa-f]+|\d+)u?\b", FIRMWARE_HEADER.read_text(),
                                 re.MULTILINE))
        expected = {"EF_PRODUCT_ID": 3, "EF_MCU_ESP32S3": 3, "EF_BOARD_DEVKITC": 1, "EF_IDENTITY_SIZE": 26,
                    "EF_CONFIG_SIZE": 17, "EF_TELEMETRY_SIZE": 22, "EF_STORAGE_SIZE": 34,
                    "EF_WIRELESS_SIZE": 48, "EF_CONTROL_SIZE": 68}
        self.assertEqual({name: int(macros[name], 0) for name in expected if name in macros},
                         {name: value for name, value in expected.items() if name in macros})

    def test_identity_and_board_configuration_decode(self):
        self.assertEqual(self.identity["device_uid"], "0123456789AB0000")
        self.assertEqual(self.identity["product_id"], 3)
        self.assertEqual(self.identity["product_name"], "ESPForge")
        self.assertEqual(self.identity["mcu"], "ESP32-S3")
        self.assertEqual(self.identity["board_model"], "ESP32-S3-DevKitC-1")
        self.assertEqual(self.identity["storage_transport"], "sdmmc")
        self.assertFalse(self.identity["led_available"])
        self.assertFalse(self.identity["self_test_supported"])
        self.assertTrue(self.identity["wireless_supported"])
        config = parse_configuration_report(configuration_report(), self.identity)
        self.assertEqual(config["system_clock_mhz"], 240)
        self.assertEqual(config["sdcard_profile"], 0)
        self.assertEqual(config["storage_gpios"], (12, 11, 13, 14, 15, 10))
        self.assertEqual((config["monitor_uart_tx_gpio"], config["monitor_uart_rx_gpio"]), (43, 44))
        self.assertFalse(config["tcp_cli_enabled"])
        self.assertLessEqual(set(status_contract()["nested"]["board_configuration"]), set(config))
        for clock in (0, 80, 160, 240):
            with self.subTest(clock=clock):
                self.assertEqual(parse_configuration_report(configuration_report(clock), self.identity)
                                 ["system_clock_mhz"], clock)
        raw = identity_report()
        for framed in (bytes([0]) + raw + bytes(4), raw + bytes(4)):
            with self.assertRaises(ValueError):
                parse_identity_report(framed)
        with self.assertRaises(ValueError):
            parse_identity_report(raw + bytes(3) + b"\x01")

    def test_identity_accepts_only_the_espforge_product_and_profile(self):
        for product, name in ((2, "PicoForge"), (1, "PicoUart"), (0x1234, "Unknown product (0x1234)")):
            with self.subTest(product=product):
                other = parse_identity_report(identity_report(product=product))
                self.assertFalse(other["supported"])
                self.assertEqual(other["product_name"], name)
        for invalid in (identity_report(capabilities=0), identity_report(capabilities=0x8F),
                        identity_report(capabilities=0xCE), identity_report(capabilities=0xAE),
                        identity_report(capabilities=0x8e), identity_report(mcu=2, board=1)):
            with self.subTest(report=invalid), self.assertRaises(ValueError):
                parse_identity_report(invalid)
        unknown_mcu = parse_identity_report(identity_report(mcu=9, board=0))
        self.assertEqual(unknown_mcu["mcu"], "unknown (9)")
        self.assertEqual(unknown_mcu["board_model"], "Unknown / unspecified")

    def test_configuration_rejects_values_outside_the_profile(self):
        for clock in (150, 200, 250, 1):
            with self.subTest(clock=clock), self.assertRaisesRegex(ValueError, "profile"):
                parse_configuration_report(configuration_report(clock), self.identity)
        sd_profile = bytearray(configuration_report())
        sd_profile[4] = 1
        with self.assertRaisesRegex(ValueError, "profile"):
            parse_configuration_report(sd_profile, self.identity)
        for flags in (0x00, 0x05, 0x06, 0x24, 0x84):
            with self.subTest(flags=flags), self.assertRaisesRegex(ValueError, "flags|flag"):
                parse_configuration_report(configuration_report(flags=flags), self.identity)
        self.assertEqual(parse_configuration_report(configuration_report(flags=0x1C), self.identity)["radios"], 3)
        self.assertEqual(parse_configuration_report(configuration_report(flags=0x0C), self.identity)["radios"], 1)
        high_gpio = bytearray(configuration_report())
        high_gpio[8] = 49
        with self.assertRaisesRegex(ValueError, "GPIO"):
            parse_configuration_report(high_gpio, self.identity)
        led = bytearray(configuration_report())
        led[16] = 2
        with self.assertRaisesRegex(ValueError, "LED"):
            parse_configuration_report(led, self.identity)
        spi_layout = bytearray(configuration_report())
        spi_layout[12:14] = bytes([255, 255])
        with self.assertRaisesRegex(ValueError, "SDMMC"):
            parse_configuration_report(spi_layout, self.identity)

    def test_telemetry_decodes_profile_values_and_rejects_unavailable_features(self):
        result = parse_status_report(telemetry_report(), self.identity)
        self.assertEqual(result["sequence"], 9)
        self.assertEqual(result["temperature_centidegrees"], 2345)
        self.assertIsNone(result["cpu_usage_core1_basis_points"])
        self.assertFalse(result["cdc_open"])
        self.assertFalse(result["led_available"])
        self.assertTrue(result["usb_mounted"])
        with self.assertRaisesRegex(ValueError, "temperature"):
            parse_status_report(telemetry_report(flags=0x01), self.identity)
        for report in (telemetry_report(flags=0x07), telemetry_report(flags=0x0D),
                       telemetry_report(led_flags=1), telemetry_report(core1=5678)):
            with self.subTest(report=report), self.assertRaisesRegex(ValueError, "ESPForge profile"):
                parse_status_report(report, self.identity)
        bad_load = bytes([3]) + struct.pack("<BBhQHHIBB", 1, 0, 0, 1, 10001, 0xFFFF, 240_000_000, 0, 0)
        with self.assertRaisesRegex(ValueError, "CPU usage"):
            parse_status_report(bad_load)
        with self.assertRaisesRegex(ValueError, "exactly"):
            parse_status_report(telemetry_report() + b"\0")

    def test_storage_snapshot_decodes_sdmmc_samples_without_cid(self):
        data = parse_memory_report(storage_report(), self.identity)
        self.assertTrue(data["sample_valid"])
        self.assertLessEqual(set(status_contract()["nested"]["memory"]), set(data))
        self.assertTrue(data["initialized"])
        self.assertEqual(data["mode"], "sdmmc")
        self.assertEqual(data["speed_mode"], "standard")
        self.assertEqual(data["bus_clock_hz"], 25_000_000)
        self.assertEqual(data["capacity_bytes"], 4096 * 512)
        self.assertEqual(data["filesystem_format"], "fat32")
        self.assertIsNone(data["manufacturer"])
        self.assertEqual(data["msc"], {"enabled": False, "transition_pending": False, "request_rejected": False})
        failed_mount = parse_memory_report(storage_report(flags=0x41), self.identity)
        self.assertTrue(failed_mount["sample_valid"])
        self.assertFalse(failed_mount["initialized"])
        unconfigured = parse_memory_report(storage_report(flags=0), self.identity)
        self.assertFalse(unconfigured["sample_valid"])
        self.assertIsNone(unconfigured["present"])

    def test_storage_rejects_inconsistent_state_and_profile_violations(self):
        for flags in (0xFF, 0x03, 0x5F):
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                parse_memory_report(storage_report(flags=flags), self.identity)
        bad_mode = bytearray(storage_report())
        bad_mode[5] = 2
        with self.assertRaisesRegex(ValueError, "bus mode"):
            parse_memory_report(bad_mode, self.identity)
        for report in (storage_report(flags=0x7F, cid=bytes.fromhex("1b53444341524431211234567801aaff")),
                       storage_report(speed=2)):
            with self.subTest(report=report), self.assertRaisesRegex(ValueError, "ESPForge profile"):
                parse_memory_report(report, self.identity)

    def test_card_detection_msc_availability_and_invalidated_sd_samples(self):
        config = bytearray(configuration_report(flags=0x45))
        config[17] = 8
        decoded = parse_configuration_report(config, self.identity)
        self.assertEqual(decoded["card_detect_gpio"], 8)
        for msc in ((1, 0, 0), (0, 1, 0), (1, 1, 1)):
            data = parse_memory_report(storage_report(flags=1, msc=msc), self.identity)
            self.assertFalse(data["sample_valid"])
            self.assertFalse(data["initialized"])
            self.assertIsNone(data["capacity_bytes"])
            self.assertEqual(data["msc"]["enabled"], bool(msc[0]))
            with self.assertRaises(ValueError):
                parse_memory_report(storage_report(msc=msc), self.identity)

    def test_msc_commands_require_confirmed_return_and_zero_unused_arguments(self):
        self.assertEqual(build_control_command_report(9, ControlOpcode.MSC, arguments=b"\x01"),
                         bytes([20, 1, 9, 3, 0, 1]) + bytes(63))
        self.assertEqual(build_control_command_report(10, ControlOpcode.MSC, flags=1),
                         bytes([20, 1, 10, 3, 1]) + bytes(64))
        for flags, arguments in ((0, b"\0"), (1, b"\x01"), (1, b"\x02"), (0, b"\x01\x01")):
            with self.subTest(flags=flags, arguments=arguments), self.assertRaises(ValueError):
                build_control_command_report(1, ControlOpcode.MSC, flags=flags, arguments=arguments)

    def test_control_commands_use_report_20_and_validate_profile_fields(self):
        settings = {"system_clock_mhz": 160, "sdcard_profile": 0, "radios": 3, "tcp_cli_enabled": False}
        self.assertEqual(build_settings_command_report(settings, 2),
                         bytes([20, 1, 2, 5, 0, 160, 0, 0, 3]) + bytes(60))
        self.assertEqual(build_settings_command_report(settings, 2, commit=True)[4], 2)
        self.assertEqual(build_control_command_report(4, ControlOpcode.REBOOT, flags=1),
                         bytes([20, 1, 4, 2, 1]) + bytes(64))
        for invalid in ({**settings, "system_clock_mhz": 200}, {**settings, "sdcard_profile": 1},
                        {**settings, "tcp_cli_enabled": True}, {**settings, "radios": 4},
                        {"system_clock_mhz": 100, "sdcard_profile": 0, "radios": 0}):
            with self.subTest(settings=invalid), self.assertRaises(ValueError):
                build_settings_command_report(invalid)
        with self.assertRaises(TypeError):
            build_settings_command_report(settings, force=True)
        for opcode in (ControlOpcode.LED, ControlOpcode.SELF_TEST, ControlOpcode.TCP_PROOF):
            with self.subTest(opcode=opcode), self.assertRaisesRegex(ValueError, "not available"):
                build_control_command_report(1, opcode)
        for flags, arguments in ((1, struct.pack("<HBB", 240, 0, 0)), (0, struct.pack("<HBB", 240, 0, 4)),
                                 (0, struct.pack("<HBB", 240, 1, 0)), (0, struct.pack("<HBB", 250, 0, 0))):
            with self.subTest(flags=flags, arguments=arguments), self.assertRaises(ValueError):
                build_control_command_report(1, ControlOpcode.SAVE_SETTINGS, flags=flags, arguments=arguments)
        with self.assertRaises(ValueError):
            build_control_command_report(1, 2)
        with self.assertRaises(ValueError):
            build_control_command_report(0, 2, flags=1)

    def test_wireless_command_rejects_non_integer_and_unavailable_operations(self):
        for operation in (True, 3.0, "3", 0, 5, 13):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                build_wireless_command_report(1, operation)
        for operation in (9, 10, 11):
            with self.subTest(operation=operation):
                report = build_wireless_command_report(1, operation)
                self.assertEqual(report[3], operation)

    def test_control_result_validates_transaction_status_and_data(self):
        def result_report(switches, clock=240):
            return control_result(5, 2, data=struct.pack("<HBBB", clock, 0, switches, 0))
        result = parse_control_result_report(result_report(0))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["saved_settings"],
                         {"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 0, "tcp_cli_enabled": False})
        self.assertEqual(parse_control_result_report(result_report(2, 80))["saved_settings"],
                         {"system_clock_mhz": 80, "sdcard_profile": 0, "radios": 2, "tcp_cli_enabled": False})
        self.assertIsNone(result["proof"])
        for malformed in (
            bytes([20, 1, 0, 5, 2, 0]) + bytes(63),
            control_result(5, 3, 5),
            result_report(4),
            result_report(8),
            result_report(0, clock=200),
            control_result(5, 2, data=struct.pack("<HBBB", 240, 1, 0, 0)),
            control_result(13, 2, data=bytes(range(16))),
            control_result(1, 2),
            control_result(4, 1),
        ):
            with self.subTest(report=malformed), self.assertRaises(ValueError):
                parse_control_result_report(malformed, self.identity)

    def test_profile_unsupported_results_do_not_contradict_capabilities(self):
        for opcode in (1, 3, 4, 5, 13):
            with self.subTest(opcode=opcode):
                result = parse_control_result_report(control_result(opcode, 4, 4), self.identity)
                self.assertEqual((result["status"], result["error"]), ("unsupported", "capability unavailable"))
        for opcode in (2, 6, 9, 12):
            with self.subTest(opcode=opcode), self.assertRaisesRegex(ValueError, "advertised capabilities"):
                parse_control_result_report(control_result(opcode, 4, 4), self.identity)


if __name__ == "__main__":
    unittest.main()
