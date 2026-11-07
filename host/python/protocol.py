"""ESPForge's bounded, single-owner UART client."""

import json
import threading
import time
from typing import Any

import serial


class ProtocolError(Exception):
    """A frame, device error, or timeout invalidated the request."""


def validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("op") not in ("status", "wifi.connect"):
        raise ProtocolError("Unsupported operation")
    if value["op"] == "status":
        if set(value) != {"op"}:
            raise ProtocolError("Unexpected status fields")
    else:
        if set(value) != {"op", "ssid", "psk"}:
            raise ProtocolError("Wi-Fi requires ssid and psk")
        ssid, psk = value["ssid"], value["psk"]
        if not isinstance(ssid, str) or not isinstance(psk, str):
            raise ProtocolError("Wi-Fi credentials must be strings")
        if "\0" in ssid or "\0" in psk:
            raise ProtocolError("Wi-Fi credentials cannot contain NUL")
        if not 1 <= len(ssid.encode("utf-8")) <= 32:
            raise ProtocolError("SSID must be 1-32 UTF-8 bytes")
        if psk and not 8 <= len(psk.encode("utf-8")) <= 63:
            raise ProtocolError("Passphrase must be empty or 8-63 UTF-8 bytes")
    return value


class BoardClient:
    def __init__(self, port: str) -> None:
        self._serial = serial.Serial()
        self._serial.port = port
        self._serial.baudrate = 115200
        self._serial.timeout = 0.25
        self._serial.write_timeout = 2
        self._serial.dtr = False
        self._serial.rts = False
        self._serial.open()
        self._lock = threading.Lock()
        self._id = 0

    def close(self) -> None:
        self._serial.close()

    def request(self, value: dict[str, Any]) -> dict[str, Any]:
        validate_request(value)
        with self._lock:
            self._id = self._id % 2147483647 + 1
            wire = dict(value)
            if wire["op"] == "wifi.connect":
                wire = {
                    "op": "wifi.connect",
                    "ssid_hex": value["ssid"].encode("utf-8").hex(),
                    "psk_hex": value["psk"].encode("utf-8").hex(),
                }
            frame = json.dumps({**wire, "id": self._id}).encode("ascii") + b"\n"
            if len(frame) > 512:
                raise ProtocolError("Request exceeds 512 bytes")
            self._serial.write(frame)
            deadline = time.monotonic() + 5
            line = bytearray()
            while time.monotonic() < deadline:
                byte = self._serial.read(1)
                if byte != b"\n":
                    line.extend(byte)
                    if len(line) > 4096:
                        raise ProtocolError("Serial receive frame too large")
                    continue
                if not line.lstrip().startswith(b"{"):
                    line.clear()
                    continue
                try:
                    reply = json.loads(line)
                except (ValueError, UnicodeDecodeError) as error:
                    raise ProtocolError("Malformed board JSON") from error
                line.clear()
                if not isinstance(reply, dict):
                    raise ProtocolError("Malformed board response")
                if reply.get("id") == 0 and reply.get("ok") is False:
                    raise ProtocolError(f"Device rejected frame ({reply.get('error')})")
                if reply.get("id") != self._id:
                    continue
                if reply.get("ok") is not True:
                    raise ProtocolError(f"Device error {reply.get('error')}")
                if value["op"] == "status" and not isinstance(reply.get("status"), dict):
                    raise ProtocolError("Board status missing")
                return reply
            raise ProtocolError("Board timeout; command was not retried")


def demo_status() -> dict[str, Any]:
    return {
        "protocol": 1, "product": "ESPForge", "board": "ESP32-S3-DevKitC",
        "firmware": "0.1.0 (simulated)", "uptime_ms": 123000,
        "wifi_enabled": True, "ble_enabled": True, "wifi_connected": False,
        "wifi_error": 0, "ble_error": 0, "sd_mounted": False, "sd_error": -19,
    }
