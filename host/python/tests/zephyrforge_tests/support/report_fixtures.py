"""Wire-format fixtures shared by report, HID, and integration tests."""

import json
import struct

from .paths import WEB_ROOT


def status_contract():
    return json.loads((WEB_ROOT / "tests/status-contract.json").read_text())


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
