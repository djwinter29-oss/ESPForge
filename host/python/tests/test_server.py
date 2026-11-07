import http.client
import json
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import DashboardServer


class ServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = DashboardServer(0, None)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.client = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)

    def tearDown(self) -> None:
        self.client.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path: str, value=None, headers=None):
        self.client.request("GET" if value is None else "POST", path,
                            body=None if value is None else json.dumps(value),
                            headers=headers or ({"Content-Type": "application/json"} if value is not None else {}))
        response = self.client.getresponse()
        return response.status, response.read()

    def test_assets_and_mode(self) -> None:
        for path in ["/", "/app.js", "/protocol.js", "/transports.js", "/dashboard.css"]:
            self.assertEqual(self.request(path)[0], 200)
        self.assertEqual(json.loads(self.request("/api/host")[1]), {"name": "Python", "demo": True})
        self.assertEqual(self.request("/../../LICENSE")[0], 404)

    def test_demo_status_and_command_rejection(self) -> None:
        status, body = self.request("/api/request", {"op": "status"})
        self.assertEqual(status, 200)
        self.assertIn("simulated", json.loads(body)["status"]["firmware"])
        self.assertEqual(self.request("/api/request", {"op": "wifi.connect", "ssid": "lab", "psk": ""})[0], 502)

    def test_origin_and_media_type(self) -> None:
        self.assertEqual(self.request("/api/request", {"op": "status"},
                                     {"Content-Type": "application/json", "Origin": "http://foreign.invalid"})[0], 403)
        self.assertEqual(self.request("/api/host", headers={"Host": "foreign.invalid"})[0], 403)
        self.assertEqual(self.request("/api/request", {"op": "status"}, {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("/api/request", {"op": "unsupported"})[0], 400)
