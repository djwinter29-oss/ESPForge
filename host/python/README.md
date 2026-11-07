# Python dashboard

Python 3.10+ with pyserial 3.5; no framework or published package is required.
From the repository root:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r host/python/requirements.txt
python host/python/server.py --device /dev/ttyUSB0
```

Open <http://127.0.0.1:8001/> and click Connect. On Windows use `COM4` (or the actual port)
and `.venv\Scripts\activate`. `--port` changes the HTTP port. The server always binds to loopback.
Close other serial applications first. DTR/RTS are disabled; bridge/driver behavior still needs hardware validation.

For a hardware-free, explicitly labeled preview:

```sh
python host/python/server.py --demo
```

Demo cannot provision Wi-Fi and is never selected implicitly after a connection failure.
Ctrl+C closes the server and serial handle. Keep the checkout's sibling `host/web/` assets;
this is a repository application, not a pip-distributed package.

Checks: `python -m unittest discover -s host/python/tests -v`.
See [host development](../../docs/development/host-tools.md), [protocol](../../docs/reference/protocol.md)
and [getting started](../../docs/guides/getting-started.md).
