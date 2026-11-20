# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Opt-in target checks through the existing USB HID client; never flash, format, or replay commands."""

from __future__ import annotations

import argparse
import json
from time import monotonic
from typing import Callable

from zephyrforge.hid.device import ZephyrForgeHid
from zephyrforge.reports.models import BenchmarkStatus, MemoryStatus


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True, help="Exact board serial; never select the first available board")
    parser.add_argument("--cycles", type=int, default=100, help="Fresh-report samples on the initial connection")
    parser.add_argument("--reopens", type=int, default=10, help="Close/reopen the HID handle without resetting USB")
    parser.add_argument("--wifi-scans", type=int, default=0)
    parser.add_argument("--benchmark-mib", type=int, default=0, help="0 disables writes; otherwise 32..1024 MiB")
    parser.add_argument("--allow-state-changes", action="store_true")
    parser.add_argument("--allow-card-writes", action="store_true")
    parser.add_argument("--max-latency-ms", type=int, default=1000, help="Maximum sampled Feature/Input read latency")
    parser.add_argument("--timeout-seconds", type=int, default=900, help="Benchmark deadline between completed reads")
    args = parser.parse_args(argv)
    if not args.serial or args.cycles < 1 or args.reopens < 0 or args.wifi_scans < 0:
        parser.error("serial must be nonempty, cycles positive, and reopens/wifi-scans nonnegative")
    if args.max_latency_ms < 1 or args.timeout_seconds < 1:
        parser.error("latency and timeout must be positive")
    if args.benchmark_mib != 0 and not 32 <= args.benchmark_mib <= 1024:
        parser.error("benchmark-mib must be 0 or 32..1024")
    if (args.wifi_scans or args.benchmark_mib) and not args.allow_state_changes:
        parser.error("scans and benchmarks require --allow-state-changes")
    if args.benchmark_mib and not args.allow_card_writes:
        parser.error("benchmarks require --allow-card-writes and a backed-up dedicated card")
    return args


def features(client: ZephyrForgeHid, metrics: dict[str, int | float], limit_ms: int) -> None:
    reads: list[Callable[[], object]] = [client.read_configuration]
    if client.identity is not None and client.identity["wireless_supported"]:
        reads.append(client.read_wireless)
    for read in reads:
        started = monotonic()
        read()
        elapsed = (monotonic() - started) * 1000
        metrics["max_feature_ms"] = max(metrics.get("max_feature_ms", 0), elapsed)
        if elapsed > limit_ms:
            raise TimeoutError(f"Feature read exceeded {limit_ms} ms")


def sample(
    client: ZephyrForgeHid, metrics: dict[str, int | float], limit_ms: int,
) -> tuple[MemoryStatus, list[BenchmarkStatus]]:
    features(client, metrics, limit_ms)
    deadline = monotonic() + 5
    storage: MemoryStatus | None = None
    runtime_seen = False
    benchmarks: list[BenchmarkStatus] = []
    while monotonic() < deadline:
        started = monotonic()
        report = client.read_input_report(timeout_ms=250)
        elapsed = (monotonic() - started) * 1000
        metrics["max_input_ms"] = max(metrics.get("max_input_ms", 0), elapsed)
        if elapsed > limit_ms:
            raise TimeoutError(f"Input read exceeded {limit_ms} ms")
        if report is None:
            continue
        kind = report["kind"]
        sequence_key = f"last_{kind}_sequence"
        if metrics.get(sequence_key) == report["data"]["sequence"]:
            continue
        metrics[sequence_key] = report["data"]["sequence"]
        count_key = f"{kind}_reports"
        metrics[count_key] = metrics.get(count_key, 0) + 1
        if report["kind"] == "runtime":
            runtime = report["data"]
            if not runtime["usb_mounted"]:
                raise RuntimeError("Telemetry reports an unconfigured USB interface")
            previous = metrics.get("last_uptime_ms")
            if previous is not None and (runtime["uptime_ms"] - int(previous)) % (1 << 32) > (1 << 31):
                raise RuntimeError("Unexpected board reset during target checks")
            metrics["last_uptime_ms"] = runtime["uptime_ms"]
            runtime_seen = True
        elif report["kind"] == "memory":
            storage = report["data"]
        else:
            benchmarks.append(report["data"])
        if runtime_seen and storage is not None:
            return storage, benchmarks
    raise TimeoutError("Fresh telemetry and storage reports were not both received within 5 seconds")


def benchmark(
    client: ZephyrForgeHid, metrics: dict[str, int | float], args: argparse.Namespace,
) -> dict[str, object]:
    before, _ = sample(client, metrics, args.max_latency_ms)
    if (not before["sample_valid"] or not before["initialized"] or before["msc_enabled"]
            or before["filesystem_format"] == "unknown" or before["cid"] is None):
        raise RuntimeError("Benchmark requires an identified card mounted for firmware")
    # Discard queued reports before admission so an old terminal result cannot count as this run.
    for _ in range(100):
        if client.read_input_report(timeout_ms=0) is None:
            break
    else:
        raise RuntimeError("Input queue did not drain; benchmark was not sent")
    client.require_completed(client.benchmark(True, args.benchmark_mib), "Benchmark")
    deadline = monotonic() + args.timeout_seconds
    active_seen = False
    while monotonic() < deadline:
        _, statuses = sample(client, metrics, args.max_latency_ms)
        for status in statuses:
            if status["target_bytes"] != args.benchmark_mib * 1024 * 1024:
                if active_seen:
                    raise RuntimeError("Benchmark target changed during the run")
                continue
            active_seen |= status["active"]
            if not status["active"] and status["state"] != "idle":
                if status["state"] in ("failed", "cancelled"):
                    raise RuntimeError(f"Benchmark {status['state']}: error {status['error']}, "
                                       f"filesystem result {status['filesystem_result']}")
                if status["state"] == "passed" and active_seen:
                    if (status["written_bytes"] != status["target_bytes"]
                            or status["read_bytes"] != status["target_bytes"]
                            or status["mismatch_count"] or status["error"] or status["filesystem_result"]
                            or status["file_remains"] or not status["volume_mounted"]):
                        raise RuntimeError("Benchmark terminal counters or cleanup do not confirm success")
                    after, _ = sample(client, metrics, args.max_latency_ms)
                    if (not after["sample_valid"] or not after["initialized"] or after["msc_enabled"]
                            or after["filesystem_format"] == "unknown" or after["cid"] != before["cid"]):
                        raise RuntimeError("The original card did not return to mounted firmware ownership")
                    return {
                        "card": {key: before[key] for key in (
                            "cid", "capacity_bytes", "filesystem_format", "bus_clock_hz",
                        )},
                        **{key: status[key] for key in (
                            "target_bytes", "written_bytes", "read_bytes", "write_elapsed_ms", "read_elapsed_ms",
                            "mismatch_count", "filesystem_result", "file_remains",
                        )},
                    }
    raise TimeoutError("Benchmark result was not attributable within the deadline; inspect it without resending")


def run(args: argparse.Namespace) -> dict[str, object]:
    metrics: dict[str, int | float] = {}
    identity: dict[str, str] = {}
    benchmark_result: dict[str, object] | None = None
    for connection in range(args.reopens + 1):
        client = ZephyrForgeHid(serial_number=args.serial)
        try:
            info = client.read_info()
            if info["supported"] is not True:
                raise RuntimeError("The selected firmware identity is unsupported")
            current = {key: info[key] for key in (
                "serial_number", "firmware_version", "board_model", "storage_transport",
            )}
            if identity and current != identity:
                raise RuntimeError("Board identity or firmware changed across HID handle reopens")
            identity = current
            for _ in range(args.cycles if connection == 0 else 1):
                sample(client, metrics, args.max_latency_ms)
            if connection == 0:
                for _ in range(args.wifi_scans):
                    previous = client.read_wireless()["scan_generation"]
                    networks = client.scan_wireless(on_poll=lambda: features(client, metrics, args.max_latency_ms))
                    status = client.read_wireless()
                    if (status["scan_generation"] != previous % 65535 + 1
                            or status["scan_state"] != "complete" or status["scan_count"] != len(networks)):
                        raise RuntimeError("Wi-Fi scan lifecycle/generation did not match its acknowledged request")
                    if (len({network["ssid_hex"] for network in networks}) != len(networks)
                            or networks != sorted(networks, key=lambda network: network["rssi"], reverse=True)):
                        raise RuntimeError("Wi-Fi scan results are not unique and strongest-first")
                if args.benchmark_mib:
                    benchmark_result = benchmark(client, metrics, args)
        finally:
            client.close()
    return {
        "schema_version": 1, "result": "passed", "identity": identity,
        "checks": {"samples": args.cycles + args.reopens, "hid_handle_reopens": args.reopens,
                   "wifi_scans": args.wifi_scans, "benchmark_mib": args.benchmark_mib},
        "max_read_latency_ms": args.max_latency_ms, "metrics": metrics, "benchmark": benchmark_result,
    }


def main() -> None:
    print(json.dumps(run(arguments()), indent=2))


if __name__ == "__main__":
    main()
