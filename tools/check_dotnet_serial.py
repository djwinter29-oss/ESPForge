"""Run the .NET client against a synthetic POSIX UART, never hardware."""

import json
import os
import select
import subprocess
import sys
import threading
from pathlib import Path


def main() -> int:
    if os.name != "posix":
        print("SKIP: synthetic UART requires POSIX pseudo-terminals")
        return 0
    import pty

    root = Path(__file__).resolve().parents[1]
    dll = root / "host/dotnet/ESPForge.Tests/bin/Debug/net10.0/ESPForge.Tests.dll"
    if not dll.exists():
        print("Build/run ESPForge.Tests before this check", file=sys.stderr)
        return 1
    master, slave = pty.openpty()
    failures: list[Exception] = []

    def peer() -> None:
        try:
            for operation in ("status", "wifi.connect"):
                frame = bytearray()
                while not frame.endswith(b"\n"):
                    if not select.select([master], [], [], 10)[0]:
                        raise TimeoutError("Synthetic UART request missing")
                    frame.extend(os.read(master, 1))
                value = json.loads(frame)
                if value["op"] != operation:
                    raise ValueError("Wrong synthetic operation")
                if operation == "wifi.connect":
                    if bytes.fromhex(value["ssid_hex"]).decode() != 'lab"\u00e9':
                        raise ValueError("SSID did not round-trip")
                    if bytes.fromhex(value["psk_hex"]).decode() != "pass\\word":
                        raise ValueError("Passphrase did not round-trip")
                    reply = {"id": value["id"], "ok": True, "error": 0}
                else:
                    reply = {"id": value["id"], "ok": True, "status": {"protocol": 1}}
                encoded = json.dumps(reply).encode()
                os.write(master, b"ESP-ROM boot\n" + b'{"id":99,"ok":true}\n' + encoded[:15])
                os.write(master, encoded[15:] + b"\n")
        except (OSError, ValueError, KeyError, TimeoutError) as error:
            failures.append(error)

    thread = threading.Thread(target=peer)
    thread.start()
    try:
        result = subprocess.run(["dotnet", str(dll), "--device", os.ttyname(slave)],
                                timeout=25, check=False)
    finally:
        thread.join(11)
        os.close(master)
        os.close(slave)
    if failures or thread.is_alive():
        print(f"Synthetic UART failed: {failures}", file=sys.stderr)
        return 1
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
