import json
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from protocol import BoardClient, ProtocolError, demo_status, validate_request


class FakeSerial:
    def __init__(self, reply: bytes) -> None:
        self.reply = bytearray(reply)
        self.writes: list[bytes] = []

    def write(self, value: bytes) -> int:
        self.writes.append(value)
        return len(value)

    def read(self, size: int) -> bytes:
        return bytes([self.reply.pop(0)]) if self.reply else b""


def fake_client(reply: bytes) -> tuple[BoardClient, FakeSerial]:
    client = BoardClient.__new__(BoardClient)
    client._id = 0
    client._lock = threading.Lock()
    fake = FakeSerial(reply)
    client._serial = fake
    return client, fake


class ProtocolTests(unittest.TestCase):
    def test_credentials_and_schema(self) -> None:
        for value in [
            {"op": "status"},
            {"op": "wifi.connect", "ssid": "a" * 32, "psk": "a" * 63},
            {"op": "wifi.connect", "ssid": "lab", "psk": ""},
        ]:
            self.assertEqual(validate_request(value), value)
        for value in [
            [], {"op": "unknown"}, {"op": "status", "id": 1},
            {"op": "wifi.connect", "ssid": "lab"},
            {"op": "wifi.connect", "ssid": "\u00e9" * 17, "psk": ""},
            {"op": "wifi.connect", "ssid": "a" * 33, "psk": ""},
            {"op": "wifi.connect", "ssid": "lab\0", "psk": ""},
            {"op": "wifi.connect", "ssid": "lab", "psk": "short"},
        ]:
            with self.subTest(value=value), self.assertRaises(ProtocolError):
                validate_request(value)

    def test_framing_and_stale_response(self) -> None:
        expected = {"id": 1, "ok": True, "status": demo_status()}
        client, fake = fake_client(b"ESP-ROM boot\n" + b'{"id":99,"ok":true}\n' + json.dumps(expected).encode() + b"\n")
        self.assertEqual(client.request({"op": "status"}), expected)
        self.assertEqual(json.loads(fake.writes[0]), {"id": 1, "op": "status"})

    def test_credentials_roundtrip_to_wire_hex(self) -> None:
        client, fake = fake_client(b'{"id":1,"ok":true,"error":0}\n')
        value = {"op": "wifi.connect", "ssid": 'lab"\u00e9', "psk": "pass\\word"}
        client.request(value)
        wire = json.loads(fake.writes[0])
        self.assertEqual(bytes.fromhex(wire["ssid_hex"]).decode(), value["ssid"])
        self.assertEqual(bytes.fromhex(wire["psk_hex"]).decode(), value["psk"])
        self.assertLessEqual(len(fake.writes[0]), 512)
        self.assertNotIn("ssid", wire)

    def test_errors_are_not_fallback_status(self) -> None:
        for frame in [b"{bad}\n", b'{"id":1,"ok":false,"error":-22}\n',
                      b'{"id":0,"ok":false,"error":-90}\n', b'{"id":1,"ok":true}\n', b"{" + b"x" * 4096]:
            with self.subTest(frame=frame[:50]), self.assertRaises(ProtocolError):
                fake_client(frame)[0].request({"op": "status"})

    def test_timeout_does_not_retry(self) -> None:
        client, fake = fake_client(b"")
        with patch("protocol.time.monotonic", side_effect=[0, 6]):
            with self.assertRaisesRegex(ProtocolError, "not retried"):
                client.request({"op": "status"})
        self.assertEqual(len(fake.writes), 1)

    @unittest.skipUnless(os.name == "posix", "POSIX pseudo-terminal required")
    def test_real_serial_handle_with_synthetic_peer(self) -> None:
        import pty
        import select

        master, slave = pty.openpty()
        failures: list[Exception] = []

        def peer() -> None:
            try:
                if not select.select([master], [], [], 5)[0]:
                    raise TimeoutError("No host request")
                request = bytearray()
                while not request.endswith(b"\n"):
                    request.extend(os.read(master, 1))
                value = json.loads(request)
                reply = json.dumps({"id": value["id"], "ok": True, "status": demo_status()}).encode()
                os.write(master, b"ESP-ROM boot\n" + reply[:20])
                os.write(master, reply[20:] + b"\n")
            except (OSError, ValueError, TimeoutError) as error:
                failures.append(error)

        client = BoardClient(os.ttyname(slave))
        thread = threading.Thread(target=peer)
        thread.start()
        try:
            self.assertEqual(client.request({"op": "status"})["status"], demo_status())
        finally:
            client.close()
            thread.join(6)
            os.close(master)
            os.close(slave)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
