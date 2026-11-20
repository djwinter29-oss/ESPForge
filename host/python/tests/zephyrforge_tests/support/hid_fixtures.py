"""Fake HID client and reports shared by device and integration tests."""

import struct
import threading

from zephyrforge.hid.device import ZephyrForgeHid
from zephyrforge.reports import parse_identity_report


def identity():
    report = bytes([1, 1]) + struct.pack("<H", 3) + bytes.fromhex("0123456789abcdef")
    report += bytes([1, 2, 3, 3, 1, 0, 0x96]) + struct.pack("<II", 524288, 100000)
    return parse_identity_report(report)


def telemetry():
    return bytes([3]) + struct.pack("<BBhQHHIBB", 1, 0, 0, 42, 0xFFFF, 0xFFFF,
                                    240_000_000, 7, 0x01)


def control_result(opcode=2, status=2, error=0, transaction=1):
    data = struct.pack("<HBBB", 240, 0, 0, 0) if opcode == 5 and status == 2 else b""
    return bytes([20, 1, transaction, opcode, status, error]) + data.ljust(63, b"\0")


def configuration(clock=240):
    payload = bytes([1]) + struct.pack("<H", clock) + bytes([
        0, 0, 43, 44, 12, 11, 13, 14, 15, 10, 0x04, 1, 255, 255,
    ])
    return bytes([2]) + payload


class FakeTransport:
    def __init__(self, reports=None):
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
        return self.feature_reports[report_id].pop(0)


def make_hid_client(reports=None):
    client = ZephyrForgeHid.__new__(ZephyrForgeHid)
    client._device = FakeTransport(reports)
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
