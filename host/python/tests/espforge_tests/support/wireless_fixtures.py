"""Wireless request and report fixtures shared by host tests."""

import threading
from unittest.mock import Mock

from espforge.hid.device import ESPForgeHid

BOARD = {"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 3, "tcp_cli_enabled": False}


def settings(**overrides):
    return {"wifi_enabled": True, "ble_enabled": True, "ssid": "ESP網",
            "confirm_reboot": True, "board": BOARD, **overrides}


def status(*, wifi=2, flags=3, ssid="ESP網", scan=0, generation=0, count=0, test=0, staged=0, detail=0):
    raw = ssid.encode() if isinstance(ssid, str) else ssid
    report = bytearray(49)
    report[:6] = bytes((12, 1, wifi, detail, 0, flags))
    if wifi in (2, 5):
        report[6:10] = bytes((192, 168, 1, 2))
    report[10] = len(raw)
    report[11:11 + len(raw)] = raw
    report[43:49] = bytes((scan, generation & 255, generation >> 8, count, test, staged))
    return bytes(report)


def result(opcode, transaction=1, *, state=2, error=0, data=b""):
    return bytes((20, 1, transaction, opcode, state, error)) + data.ljust(63, b"\0")


def make_wireless_client(reports=()):
    client = ESPForgeHid.__new__(ESPForgeHid)
    client.closed = False
    client._close_error = None
    client.identity = {"supported": True, "capabilities": 0x96, "serial_number": "0123456789ABCDEF"}
    client.configuration = {"radios": 3, "tcp_cli_enabled": False}
    client._transaction_id = 0
    client._command_uncertain = False
    client._uncertain_command = None
    client._uncertain_wireless_operation = None
    client._control_lock = threading.RLock()
    client.last_command_result = None
    client._wireless_active = False
    client._tested_generation = None
    client._tested_id = None
    client._tested_at = None
    client._device = Mock()
    client._device.send_feature_report.side_effect = lambda value: len(value)
    client._device.get_feature_report.side_effect = list(reports)
    return client
