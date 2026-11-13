# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

import json
import unittest
from pathlib import Path
from unittest.mock import patch
from unittest.mock import Mock

from espforge.dashboard.server import create_app
from espforge.dashboard.monitor import BoardConflict, CommandOutcomeUncertain
from espforge.cli import parse_args
from espforge.reports import ProtocolError
from espforge.reports.common import _validate_settings


class FakeMonitor:
    """Board monitor double; command fakes call the same report validators the HID client uses."""

    def snapshot(self):
        return {
            "connected": True,
            "error": None,
            "hardware": {
                "product_name": "ESPForge",
                "mcu": "ESP32-S3",
                "mcu_id": 3,
                "serial_number": "0123456789abcdef",
                "storage_transport": "sdmmc",
                "led_available": False,
                "self_test_supported": False,
                "settings_supported": True,
            },
            "runtime": {
                "version": 1,
                "sequence": 7,
                "uptime_ms": 42_000,
                "system_clock_hz": 240_000_000,
                "usb_mounted": True,
                "cdc_open": False,
                "temperature_valid": True,
                "temperature_centidegrees": 2345,
                "led_available": False,
                "led_on": False,
                "cpu_usage_core0_basis_points": 1234,
                "cpu_usage_core1_basis_points": None,
                "ram_used_bytes": 65536,
                "ram_total_bytes": 524288,
            },
            "memory": {"msc": {"enabled": False, "transition_pending": False, "request_rejected": False}},
            "board_configuration": {
                "stored_sysclk_profile": 0, "stored_sdcard_profile": 0,
                "system_clock_mhz": 0, "sdcard_profile": 0, "radios": 0, "tcp_cli_enabled": False,
            },
            "settings_supported": True,
            "settings_message": None,
            "control_result": None,
            "wireless": {
                "wifi_state": "connected",
                "wifi_state_id": 2,
                "detail": 0,
                "error": 0,
                "ble_key_configured": True,
                "tcp_cli_auth_required": True,
                "age_ms": 0,
            },
            "telemetry_stale": False,
            "storage_stale": False,
            "self_test": None,
            "self_test_stale": True,
            "updated_at": "2026-10-10T12:00:00+00:00",
        }

    def status_snapshot(self):
        return self.snapshot()

    def set_settings(self, settings):
        _validate_settings(settings)
        self.last_settings = settings
        return {"settings": settings, "control_result": None}

    def reboot(self):
        return {"control_result": {"status": "completed", "opcode": 2, "transaction_id": 1}}


class FakeBoards:
    def __init__(self, monitor=None):
        self.board_monitor = monitor or FakeMonitor()
        self.last_board_id = None

    def boards(self):
        return {"boards": [{"id": "board-a", "product_name": "ESPForge",
                            "serial_number": "0123456789abcdef", "device_path": "/hid/a"}],
                "default_board_id": "board-a"}

    def monitor(self, board_id):
        self.last_board_id = board_id
        return self.board_monitor


class FalseyBoards(FakeBoards):
    def __bool__(self) -> bool:
        return False


# Malformed requests every ESPForge host must reject with 400 before any board lookup.
INVALID_REQUESTS = [
    {"route": "/api/wireless/test", "body": {"ssid": "ESP32", "password": None}},
    {"route": "/api/wireless/test", "body": {"ssid": "ESP32", "passwrod": "password"}},
    {"route": "/api/wireless/test", "body": {"ssid": "ESP32", "password": "password", "unknown": True}},
    {"route": "/api/wireless/test", "body": {"ssid": None, "password": "password"}},
    {"route": "/api/wireless/test", "body": {"ssid": "ESP32", "ssid_hex": None}},
    {"route": "/api/wireless/test", "body": {"ssid": "ESP32", "password": "short"}},
    {"route": "/api/wireless/test", "body": {"ssid": "ESP32", "password": 123}},
    {"route": "/api/settings", "body": {"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 0, "unknown": True}},
    {"route": "/api/settings", "body": {"system_clock_mhz": None, "sdcard_profile": 0, "radios": 0}},
    {"route": "/api/settings", "body": {"system_clock_mhz": 200, "sdcard_profile": 0, "radios": 0}},
    {"route": "/api/settings", "body": {"system_clock_mhz": 240, "sdcard_profile": 1, "radios": 0}},
    {"route": "/api/settings", "body": {"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 4}},
    {"route": "/api/settings", "body": {"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 0,
                                        "confirm_data_loss": "yes"}},
]

DROPPED_ROUTES = [
    ("GET", "/console"), ("GET", "/api/console"), ("POST", "/api/console"), ("PUT", "/api/console"),
    ("POST", "/api/led"), ("POST", "/api/msc/force-return"), ("POST", "/api/self-test"),
]


class WebTests(unittest.TestCase):
    def test_shared_malformed_request_contract_precedes_board_lookup(self):
        cases = INVALID_REQUESTS
        boards = Mock()
        client = create_app(boards).test_client()
        for state in (LookupError("unknown"), ConnectionError("disconnected"), RuntimeError("busy"), None):
            boards.monitor.side_effect = state
            for case in cases:
                with self.subTest(state=state, case=case):
                    response = client.post(case["route"] + "?board=a", json=case["body"])
                    self.assertEqual(response.status_code, 400, response.json)
                    self.assertTrue(response.json["error"])
                    boards.monitor.assert_not_called()

    def test_invalid_requests_are_rejected_before_board_lookup_in_every_board_state(self):
        board_settings = {"system_clock_mhz": 0, "sdcard_profile": 0, "radios": 1}
        cases = [
            ("/api/settings", {**board_settings, "system_clock_mhz": 1}),
            ("/api/settings", {**board_settings, "extra": True}),
            ("/api/settings", {**board_settings, "tcp_cli_enabled": True}),
            ("/api/wireless/test", {"ssid": "ESP32", "password": "short"}),
            ("/api/wireless/test", {"ssid": "x" * 33}),
            ("/api/wireless/test", {"ssid_hex": "zz"}),
        ]
        for state in (LookupError("unknown board"), ConnectionError("disconnected"),
                      RuntimeError("busy"), None):
            boards = Mock()
            boards.monitor.side_effect = state
            client = create_app(boards).test_client()
            for path, body in cases:
                with self.subTest(state=state, path=path, body=body):
                    response = client.post(path + "?board=a", json=body)
                    self.assertEqual(response.status_code, 400, response.json)
                    boards.monitor.assert_not_called()

    def test_resync_uses_the_same_public_wireless_shape_without_mutating_the_monitor_result(self):
        boards = Mock()
        wireless = {"wifi_state": "connected", "wifi_state_id": 2, "tcp_cli_auth_required": True,
                    "age_ms": 1, "error": 0, "ssid_hex": "4100ff"}
        result = {"uncertain": False, "control_result": None, "wireless": wireless}
        boards.monitor.return_value.resync_command.return_value = result
        client = create_app(boards).test_client()
        response = client.post("/api/control/resync?board=a", json={"confirm": True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["wireless"], {"wifi_state": "connected", "ssid_hex": "4100ff"})
        self.assertEqual(wireless["wifi_state_id"], 2)
        self.assertIs(result["wireless"], wireless)
        result["wireless"] = None
        self.assertIsNone(client.post("/api/control/resync?board=a", json={"confirm": True}).json["wireless"])

    def test_monitor_lifecycle_conflicts_have_an_explicit_http_mapping(self):
        from espforge.dashboard.monitor import BoardConflict

        boards = Mock()
        boards.monitor.side_effect = BoardConflict("device monitor is shutting down")
        response = create_app(boards).test_client().post("/api/reboot", json={"confirm": True})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json, {"error": "device monitor is shutting down"})

    def test_write_body_limits_are_json_errors_before_any_board_operation(self):
        boards = FakeBoards()
        client = create_app(boards).test_client()
        for path in ("/api/settings", "/api/reboot", "/api/control/resync", "/api/wireless",
                     "/api/wireless/test", "/api/wireless/scan", "/api/wireless/cancel"):
            with self.subTest(path=path):
                response = client.post(path + "?board=board-a", data=b" " * 4097,
                                       content_type="application/json")
                self.assertEqual(response.status_code, 413)
                self.assertIn("size limit", response.json["error"])
                self.assertIsNone(boards.last_board_id)

    def test_pages_display_the_resolved_package_version(self):
        from espforge import __version__

        client = create_app(FakeBoards()).test_client()
        for route in ("/",):
            with self.subTest(route=route):
                page = client.get(route).get_data(as_text=True)
                self.assertIn(f"Python · App v{__version__}<", page)

    def test_release_pages_display_the_stamped_app_version(self):
        with patch("espforge.dashboard.server.__version__", "1.2.3"):
            client = create_app(FakeBoards()).test_client()
            for route in ("/",):
                with self.subTest(route=route):
                    page = client.get(route).get_data(as_text=True)
                    self.assertIn("Python · App v1.2.3<", page)
                    self.assertNotIn("App v0.0.0-debug", page)

    def test_create_app_keeps_an_injected_falsey_dashboard(self):
        boards = FalseyBoards()

        app = create_app(boards)

        self.assertIs(app.extensions["espforge_monitor"], boards)

    def test_server_dashboard_does_not_serve_browser_bluetooth_page(self):
        client = create_app(FakeBoards()).test_client()
        self.assertEqual(client.get("/ble/").status_code, 404)
        self.assertEqual(client.get("/ble/js/app.mjs").status_code, 404)
        page = client.get("/").get_data(as_text=True)
        self.assertNotIn("/ble/", page)
        self.assertIn('<option value="configure">', page)
        for radio in ("wifi", "ble"):
            self.assertNotIn(f'id="{radio}-configure"', page)
            self.assertIn(f'id="{radio}-dialog"', page)

    def test_forced_save_is_refused_and_false_confirmation_is_a_normal_save(self):
        monitor = FakeMonitor()
        client = create_app(FakeBoards(monitor)).test_client()
        settings = {"system_clock_mhz": 240, "sdcard_profile": 0, "radios": 0}
        for invalid in ["yes", 1, None]:
            response = client.post("/api/settings", json={**settings, "confirm_data_loss": invalid},
                                   base_url="http://127.0.0.1")
            self.assertEqual(response.status_code, 400)
        response = client.post("/api/settings", json={**settings, "confirm_data_loss": True},
                               base_url="http://127.0.0.1")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json["error"], "Forced save is not available on ESPForge")
        self.assertFalse(hasattr(monitor, "last_settings"))
        response = client.post("/api/settings", json={**settings, "confirm_data_loss": False},
                               base_url="http://127.0.0.1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(monitor.last_settings, settings)

    def test_dropped_feature_routes_are_not_served(self):
        client = create_app(FakeBoards()).test_client()
        for method, path in DROPPED_ROUTES:
            with self.subTest(method=method, path=path):
                response = client.open(path + "?board=board-a", method=method, json={},
                                       base_url="http://127.0.0.1")
                self.assertEqual(response.status_code, 404)
        page = client.get("/").get_data(as_text=True)
        for marker in ('id="led-control"', 'id="msc-control"', 'id="self-test', "/console"):
            self.assertNotIn(marker, page)

    def test_msc_route_requires_boolean_intent_and_explicit_eject_confirmation(self):
        monitor = FakeMonitor()
        result = {"control_result": {"opcode": 3, "status": "completed"}}
        monitor.set_msc = Mock(return_value=result)
        client = create_app(FakeBoards(monitor)).test_client()
        for payload in ({}, {"enabled": None}, {"enabled": 1}, {"enabled": "true"},
                        {"enabled": False}, {"enabled": False, "confirm_ejected": 1},
                        {"enabled": True, "extra": True}):
            with self.subTest(payload=payload):
                response = client.post("/api/msc?board=board-a", json=payload, base_url="http://127.0.0.1")
                self.assertEqual(response.status_code, 400)
        monitor.set_msc.assert_not_called()
        for enabled in (True, False):
            payload = {"enabled": enabled}
            if not enabled:
                payload["confirm_ejected"] = True
            response = client.post("/api/msc?board=board-a", json=payload, base_url="http://127.0.0.1")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json, result)
            monitor.set_msc.assert_called_with(enabled, not enabled)

    def test_dashboard_port_defaults_to_8001_and_can_be_overridden(self):
        self.assertEqual(parse_args(["web"]).port, 8001)
        self.assertEqual(parse_args(["web", "--port", "5001"]).port, 5001)
        self.assertTrue(parse_args(["reboot", "--confirm"]).confirm)

    def test_home_uses_python_in_browser_title_and_wordmark(self):
        response = create_app(FakeBoards()).test_client().get(
            "/", base_url="http://127.0.0.1"
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"<title>ESPForge Dashboard | Python</title>", response.data)
        self.assertRegex(response.data, rb"<small>Python \xc2\xb7 App v[0-9][^<]*</small>")

    def test_status_route_returns_snapshot_and_security_headers(self):
        app = create_app(FakeBoards())
        client = app.test_client()
        response = client.get("/api/status?board=board-a", base_url="http://127.0.0.1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["hardware"]["product_name"], "ESPForge")
        self.assertEqual(response.json["runtime"]["uptime_ms"], 42_000)
        self.assertEqual(response.json["runtime"]["cpu_usage_core0_basis_points"], 1234)
        self.assertIsNone(response.json["runtime"]["cpu_usage_core1_basis_points"])
        self.assertEqual(response.json["runtime"]["ram_used_bytes"], 65536)
        self.assertEqual(response.json["runtime"]["ram_total_bytes"], 524288)
        self.assertEqual(response.json["runtime"]["temperature_centidegrees"], 2345)
        self.assertEqual(response.json["memory"]["msc"]["enabled"], False)
        self.assertEqual(response.json["wireless"]["wifi_state"], "connected")
        for field in ("wifi_state_id", "error", "tcp_cli_auth_required", "age_ms"):
            self.assertNotIn(field, response.json["wireless"])
        self.assertIn("board_configuration", response.json)
        self.assertFalse(response.json["telemetry_stale"])
        for derived in ("board_status", "msc", "filesystem_format", "settings", "report_freshness"):
            self.assertNotIn(derived, response.json)
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_api_error_statuses_distinguish_bad_input_conflicts_and_unavailable_devices(self):
        class FailingBoards(FakeBoards):
            def monitor(self, board_id):
                raise BoardConflict("device busy")

            def boards(self):
                raise OSError("HID enumeration failed")

        client = create_app(FailingBoards()).test_client()

        self.assertEqual(client.post("/api/reboot", json={"confirm": 1}).status_code, 400)
        invalid_wireless = client.post("/api/wireless?board=a", json={"confirm_reboot": False})
        self.assertEqual(invalid_wireless.status_code, 400, "bad input is 400 even while the board is busy")
        conflict = client.get("/api/status?board=a")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json["error"], "device busy")
        unavailable = client.get("/api/boards")
        self.assertEqual(unavailable.status_code, 503)
        self.assertEqual(unavailable.json["error"], "HID enumeration failed")

    def test_status_without_board_is_an_empty_disconnected_snapshot(self):
        client = create_app(FakeBoards()).test_client()
        response = client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json["connected"])
        self.assertTrue(response.json["telemetry_stale"])
        contract = json.loads((Path(__file__).parents[2] / "web/tests/status-contract.json").read_text())
        self.assertLessEqual(set(contract["required"]), set(response.json), "shared status contract with .NET")
        self.assertFalse(set(contract["absent"]) & set(response.json))
        for method, path in contract["removed_routes"]:
            self.assertEqual(client.open(f"{path}?board=a", method=method).status_code, 405, path)

    def test_cross_origin_api_writes_are_rejected_before_routing(self):
        boards = FakeBoards()
        client = create_app(boards).test_client()
        for method, url in (("POST", "/api/reboot?board=a"), ("POST", "/api/settings?board=a"),
                            ("POST", "/api/wireless/scan?board=a")):
            with self.subTest(url=url, method=method):
                response = client.open(url, method=method, json={"confirm": True}, base_url="http://127.0.0.1",
                                       headers={"Origin": "http://evil.example"})
                self.assertEqual(response.status_code, 403)
        self.assertIsNone(boards.last_board_id)
        self.assertEqual(client.get("/api/boards", headers={"Origin": "http://evil.example"}).status_code, 200)
        same = client.post("/api/reboot?board=a", json={"confirm": True}, base_url="http://127.0.0.1",
                           headers={"Origin": "http://127.0.0.1"})
        self.assertEqual(same.status_code, 200)

    def test_route_error_mapping_is_uniform(self):
        """Pin status and message for each route and error type at the HTTP boundary."""
        class Raising:
            def __init__(self, error):
                self.error = error

            def monitor(self, _board_id):
                return self

            def __getattr__(self, _name):
                def fail(*_args, **_kwargs):
                    raise self.error
                return fail

        board = {"system_clock_mhz": 0, "sdcard_profile": 0, "radios": 1}
        routes = {
            "status": ("GET", "/api/status?board=a", None),
            "boards": ("GET", "/api/boards", None),
            "settings": ("POST", "/api/settings?board=a", board),
            "reboot": ("POST", "/api/reboot?board=a", {"confirm": True}),
            "scan": ("POST", "/api/wireless/scan?board=a", None),
            "test": ("POST", "/api/wireless/test?board=a", {"ssid": "net", "password": ""}),
            "cancel": ("POST", "/api/wireless/cancel?board=a", None),
            "save": ("POST", "/api/wireless?board=a", {"wifi_enabled": True, "ble_enabled": False,
                                                       "confirm_reboot": True, "board": board}),
        }
        unavailable = {
            "scan": "Wireless scan failed",
            "test": "Wi-Fi test is unavailable",
            "cancel": "Could not clear the wireless test credentials",
            "save": "Wireless provisioning is unavailable",
        }
        timed_out = {"test": "Wi-Fi test timed out; confirm the result before retrying"}
        for route, (method, url, body) in routes.items():
            for error, status in ((BoardConflict("busy"), 409), (LookupError("unknown board"), 404),
                                  (OSError("io"), 503), (ConnectionError("ESPForge HID is not connected"), 503),
                                  (TimeoutError("late"), 503), (ProtocolError("bad reply"), 503),
                                  (ValueError("bug"), 500), (RuntimeError("bug"), 500),
                                  (NotImplementedError("todo"), 500)):
                with self.subTest(route=route, error=type(error).__name__):
                    client = create_app(Raising(error)).test_client()
                    response = client.open(url, method=method, json=body, base_url="http://127.0.0.1")
                    self.assertEqual(response.status_code, status)
                    if status in (404, 409):
                        expected = str(error)
                    elif status == 500:
                        expected = "Internal server error"
                    elif isinstance(error, TimeoutError) and route in timed_out:
                        expected = timed_out[route]
                    else:
                        expected = unavailable.get(route, str(error))
                    self.assertEqual(response.json["error"], expected)
        with self.assertLogs("espforge.dashboard.server", "ERROR"):
            bug = create_app(Raising(KeyError("bug"))).test_client().get("/api/status?board=a")
        self.assertEqual(bug.status_code, 500, "programming errors must not be reported as unknown boards")

    def test_uncertain_command_errors_are_machine_readable(self):
        class UncertainMonitor(FakeMonitor):
            def test_wireless(self, *_args, **_kwargs):
                raise CommandOutcomeUncertain("Re-sync before retrying")

        monitor = UncertainMonitor()
        client = create_app(FakeBoards(monitor)).test_client()
        response = client.post(
            "/api/wireless/test?board=a", json={"ssid": "net", "password": ""},
        )
        self.assertEqual(response.status_code, 503)
        self.assertTrue(response.json["uncertain"])
        self.assertEqual(response.json["error"], "Re-sync before retrying")

    def test_control_resync_requires_explicit_confirmation(self):
        class ResyncMonitor(FakeMonitor):
            def resync_command(self):
                return {"uncertain": False, "control_result": None, "wireless": None}

        client = create_app(FakeBoards(ResyncMonitor())).test_client()
        self.assertEqual(client.post("/api/control/resync?board=a", json={}).status_code, 400)
        response = client.post("/api/control/resync?board=a", json={"confirm": True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"uncertain": False, "control_result": None, "wireless": None})

    def test_boards_route_lists_selectable_devices(self):
        response = create_app(FakeBoards()).test_client().get(
            "/api/boards", base_url="http://127.0.0.1"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["default_board_id"], "board-a")
        self.assertEqual(response.json["boards"][0]["serial_number"], "0123456789abcdef")

    def test_serves_svg_favicon(self):
        response = create_app(FakeBoards()).test_client().get(
            "/favicon.svg", base_url="http://127.0.0.1"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/svg+xml")
        self.assertIn(b"<svg", response.data)
        response.close()

    def test_settings_endpoint_validates_and_returns_confirmed_values(self):
        monitor = FakeMonitor()
        client = create_app(FakeBoards(monitor)).test_client()
        settings = {"system_clock_mhz": 160, "sdcard_profile": 0, "radios": 2}
        for invalid in (
            {**settings, "system_clock_mhz": 100},
            {**settings, "system_clock_mhz": 200},
            {**settings, "sdcard_profile": 1},
            {**settings, "radios": True},
            {"system_clock_mhz": 160, "sdcard_profile": 0},
        ):
            response = client.post("/api/settings?board=board-a", json=invalid, base_url="http://127.0.0.1")
            self.assertEqual(response.status_code, 400)
        response = client.post("/api/settings?board=board-a", json=settings, base_url="http://127.0.0.1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["settings"], settings)
        self.assertEqual(monitor.last_settings, settings)

    def test_settings_endpoint_reports_invalid_device_readback_as_service_error(self):
        class InvalidReadbackMonitor(FakeMonitor):
            def set_settings(self, settings):
                raise ProtocolError("invalid HID settings report")

        response = create_app(FakeBoards(InvalidReadbackMonitor())).test_client().post(
            "/api/settings?board=board-a",
            json={"system_clock_mhz": 80, "sdcard_profile": 0, "radios": 0},
            base_url="http://127.0.0.1",
        )
        self.assertEqual(response.status_code, 503)

    def test_reboot_requires_explicit_confirmation_and_returns_status(self):
        boards = FakeBoards()
        client = create_app(boards).test_client()
        response = client.post("/api/reboot", json={"confirm": 1}, base_url="http://127.0.0.1")
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(boards.last_board_id)
        response = client.post("/api/reboot?board=board-a", json={"confirm": True},
                               base_url="http://127.0.0.1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["control_result"]["opcode"], 2)
        self.assertEqual(boards.last_board_id, "board-a")



if __name__ == "__main__":
    unittest.main()