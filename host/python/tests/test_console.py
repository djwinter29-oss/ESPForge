# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

import base64
import select
import socket
import threading
import time
import unittest
from unittest.mock import Mock, patch

from espforge.dashboard.console import ConsoleBridge, ConsoleConflict, console_address, console_input
from espforge.dashboard.server import create_app


class ConsoleTests(unittest.TestCase):
    def setUp(self):
        self.bridge = ConsoleBridge()
        self.addCleanup(self.bridge.close_all)

    def pair(self, guard=lambda: None):
        connection, peer = socket.socketpair()
        peer.settimeout(2)
        self.addCleanup(peer.close)
        with patch("espforge.dashboard.console.socket.create_connection", return_value=connection) as connect:
            token = self.bridge.open("192.168.1.9", guard)
        connect.assert_called_once_with(("192.168.1.9", 2323), timeout=3)
        self.assertEqual(peer.recv(1024), b"\x03\x03shell echo on\r")
        return token, peer

    def test_transparent_read_write_eof_and_header_ownership(self):
        token, peer = self.pair()
        with self.assertRaises(ConsoleConflict):
            self.bridge.write("wrong", b"help\r")
        self.assertEqual(self.bridge.write(token, b"help\r"), 5)
        self.assertEqual(peer.recv(1024), b"help\r")
        peer.sendall(b"\x1b[31m<shell>\r\n")
        self.assertEqual(self.bridge.read(token), (b"\x1b[31m<shell>\r\n", False))
        peer.close()
        self.assertEqual(self.bridge.read(token), (b"", True))
        self.bridge.close(token)
        with self.assertRaises(ConsoleConflict):
            self.bridge.read(token)

    def test_long_poll_does_not_block_input(self):
        token, peer = self.pair()
        polling = threading.Event()
        result = []
        original_select = select.select

        def wait(*args):
            polling.set()
            return original_select(*args)

        with patch("espforge.dashboard.console.select.select", side_effect=wait):
            thread = threading.Thread(target=lambda: result.append(self.bridge.read(token)))
            thread.start()
            self.assertTrue(polling.wait(1))
            started = time.monotonic()
            self.assertEqual(self.bridge.write(token, b"help\r"), 5)
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertEqual(peer.recv(1024), b"help\r")
            peer.sendall(b"native output")
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result, [(b"native output", False)])

    def test_stale_target_closes_without_sending_input(self):
        fresh = True

        def guard():
            if not fresh:
                raise ConsoleConflict("Stale board")

        token, peer = self.pair(guard)
        fresh = False
        with self.assertRaisesRegex(ConsoleConflict, "Stale"):
            self.bridge.write(token, b"help\r")
        self.assertEqual(peer.recv(1024), b"")

    def test_setup_and_application_short_sends_are_not_replayed(self):
        connection = Mock()
        connection.send.side_effect = [16, 2]
        with patch("espforge.dashboard.console.socket.create_connection", return_value=connection):
            token = self.bridge.open("192.168.1.9")
        self.assertEqual(self.bridge.write(token, b"help\r"), 2)
        with self.assertRaises(ConsoleConflict):
            self.bridge.write(token, b"help\r")
        self.assertEqual(connection.send.call_count, 2)
        connection.close.assert_called_once()
        self.bridge.close(token)
        connection = Mock()
        connection.send.return_value = 1
        with patch("espforge.dashboard.console.socket.create_connection", return_value=connection):
            with self.assertRaisesRegex(OSError, "not retried"):
                self.bridge.open("192.168.1.9")
        connection.send.assert_called_once_with(b"\x03\x03shell echo on\r")
        connection.close.assert_called_once()

    def test_expiry_and_busy_session(self):
        token, peer = self.pair()
        with self.assertRaises(ConsoleConflict):
            self.bridge.open("192.168.1.9")
        with patch("espforge.dashboard.console.time.monotonic", return_value=self.bridge._last_request + 16):
            self.bridge._expire(token)
        self.assertEqual(peer.recv(1024), b"")
        with self.assertRaises(ConsoleConflict):
            self.bridge.read(token)

    def test_expiry_is_fifteen_seconds_after_last_activity_not_next_periodic_tick(self):
        clock = [0.0]
        timers = []

        class Timer:
            def __init__(self, delay, callback, args=()):
                self.when = clock[0] + delay
                self.callback = lambda: callback(*args)
                timers.append(self)

            def start(self):
                pass

            def cancel(self):
                pass

        with patch("espforge.dashboard.console.time.monotonic", side_effect=lambda: clock[0]), \
                patch("espforge.dashboard.console.threading.Timer", Timer):
            token, peer = self.pair()
            clock[0] = 1
            self.bridge.write(token, b"help\r")
            self.assertEqual(peer.recv(1024), b"help\r")
            clock[0] = timers[0].when
            timers[0].callback()
            self.assertEqual(timers[1].when, 16)
            clock[0] = timers[1].when
            timers[1].callback()
            self.assertEqual(peer.recv(1024), b"")

    def test_address_and_packet_boundaries(self):
        for address in ("127.0.0.1", "0.0.0.0", "224.1.2.3", "255.255.255.255", "localhost", "::1"):
            with self.subTest(address=address), self.assertRaises(ValueError):
                console_address(address)
        self.assertEqual(console_input({"data": base64.b64encode(b"a" * 1024).decode()}), b"a" * 1024)
        for payload in (None, [], {}, {"data": ""}, {"data": True}, {"data": "aGVs cA=="},
                        {"data": "===="}, {"data": "aA==", "extra": 1},
                        {"data": base64.b64encode(b"a" * 1025).decode()}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                console_input(payload)


class ConsoleApiTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {"connected": True, "wireless_error": None, "wireless": {
            "wifi_enabled": True, "wifi_state": "connected", "ipv4": "192.168.1.9", "stale": False,
        }}
        self.monitor = Mock(status_snapshot=lambda: self.snapshot)
        self.boards = Mock(monitor=Mock(return_value=self.monitor))
        self.app = create_app(self.boards)
        self.addCleanup(self.app.extensions["espforge_console"].close_all)
        self.client = self.app.test_client()

    def test_open_uses_selected_monitor_and_revalidates_address(self):
        bridge = self.app.extensions["espforge_console"]
        with patch.object(bridge, "open", return_value="x" * 43) as connect:
            response = self.client.post("/api/console?board=board-a", json={})
        self.assertEqual(response.json, {"session": "x" * 43, "ipv4": "192.168.1.9"})
        self.boards.monitor.assert_called_with("board-a")
        address, guard = connect.call_args.args
        self.assertEqual(address, "192.168.1.9")
        self.snapshot["wireless"]["ipv4"] = "192.168.1.10"
        with self.assertRaises(ConsoleConflict):
            guard()
        self.boards.monitor.return_value = Mock()
        with self.assertRaises(ConsoleConflict):
            guard()

    def test_unavailable_and_malformed_requests_never_connect(self):
        bridge = self.app.extensions["espforge_console"]
        with patch.object(bridge, "open") as connect:
            for field, value in (("stale", True), ("wifi_state", "connecting"), ("ipv4", "127.0.0.1")):
                previous = self.snapshot["wireless"][field]
                self.snapshot["wireless"][field] = value
                self.assertEqual(self.client.post("/api/console?board=a", json={}).status_code, 409)
                self.snapshot["wireless"][field] = previous
            for body in (None, [], {"ipv4": "192.168.1.9"}):
                self.assertEqual(self.client.post("/api/console", json=body).status_code, 400)
            self.assertEqual(self.client.post("/api/console", json={},
                headers={"Origin": "https://foreign.example"}).status_code, 403)
            connect.assert_not_called()

    def test_packets_use_only_header_session_and_validate_before_io(self):
        bridge = self.app.extensions["espforge_console"]
        self.assertEqual(self.client.get("/api/console?session=ignored").status_code, 409)
        with patch.object(bridge, "read", return_value=(b"<raw>", False)) as read:
            response = self.client.get("/api/console", headers={"X-Console-Session": "owned"})
        read.assert_called_once_with("owned")
        self.assertEqual(response.json, {"data": "PHJhdz4=", "closed": False})
        with patch.object(bridge, "write", return_value=5) as write:
            response = self.client.post("/api/console/input", json={"data": "aGVscA0="},
                                       headers={"X-Console-Session": "owned"})
            self.assertEqual(response.json, {"written": 5})
            write.assert_called_once_with("owned", b"help\r")
            self.assertEqual(self.client.post("/api/console/input", json={"data": 1}).status_code, 400)
            self.assertEqual(write.call_count, 1)
        self.assertEqual(self.client.put("/api/console", json={"data": "aA=="}).status_code, 405)
        self.assertEqual(self.client.get("/console?board=a").status_code, 200)


if __name__ == "__main__":
    unittest.main()
