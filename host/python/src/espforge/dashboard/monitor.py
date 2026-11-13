# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Reconnectable background HID monitor for the local dashboard."""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import logging
import threading
import time
from typing import Any, Callable, Generator, ParamSpec, TypeVar, cast

from ..hid.device import ESPForgeHid, WirelessTestCancelled
from ..reports.models import (
    BoardConfiguration,
    BootSettings,
    ControlResult,
    InputReport,
    MscStatus,
    WirelessNetwork,
    WirelessStatus,
    WirelessTestResult,
)
from ..reports import ProtocolError
from ..reports.common import BoardConflict as BoardConflict, ControlOpcode
from .models import (
    ControlResponse,
    DashboardSnapshot,
    ResyncResponse,
    SettingsResponse,
    WirelessSaveResponse,
)

_LOGGER = logging.getLogger(__name__)
_INPUT_POLL_INTERVAL_SECONDS = 0.05
_IDLE_INPUT_POLL_INTERVAL_SECONDS = 0.5
_IDLE_WIRELESS_POLL_INTERVAL_SECONDS = 5.0
_WIRELESS_MAX_AGE_SECONDS = 6.0
_VIEWER_IDLE_TIMEOUT_SECONDS = 5.0
_BUSY_WAIT_SECONDS = 2.0
_P = ParamSpec("_P")
_T = TypeVar("_T")
# Input report kind -> (maximum age before the section is withheld, stale flag); matches .NET.
_REPORTS = {
    "runtime": (0.750, "telemetry_stale"),
    "memory": (1.500, "storage_stale"),
}


class CommandOutcomeUncertain(RuntimeError):
    """A control command was delivered but its final outcome was not confirmed."""


def _empty_snapshot() -> DashboardSnapshot:
    return {
        "connected": False,
        "reconnecting": False,
        "error": None,
        "hardware": None,
        "board_configuration": None,
        "runtime": None,
        "memory": None,
        "self_test": None,
        "settings_supported": False,
        "settings_message": None,
        "control_result": None,
        "command_outcome_uncertain": False,
        "command_resync_supported": True,
        "reboot_pending": False,
        "telemetry_stale": True,
        "storage_stale": True,
        "self_test_stale": True,
        "updated_at": None,
        "wireless_phase": None,
        "wireless": None,
        "wireless_error": None,
        "wireless_cleanup_required": False,
    }


def _msc(snapshot: DashboardSnapshot) -> MscStatus | None:
    memory = snapshot.get("memory")
    return memory.get("msc") if isinstance(memory, dict) else None


class DeviceMonitor:
    """Keep one HID handle open and publish an immutable status snapshot.

    The worker owns connection and report state; command methods publish command results
    and transitions under the same locks.
    """

    def __init__(
        self,
        serial_number: str | None = None,
        device_path: str | None = None,
        client_factory: Callable[[], ESPForgeHid] | None = None,
        *,
        autostart: bool = True,
    ) -> None:
        self._client_factory = client_factory or (lambda: ESPForgeHid(serial_number, device_path))
        self._lock = threading.RLock()
        self._device_lock = threading.RLock()
        self._active_client: ESPForgeHid | None = None
        self._close_error: Exception | None = None
        self._failed_client: ESPForgeHid | None = None
        self._stop = threading.Event()
        self._snapshot = _empty_snapshot()
        self._input_received_at: dict[str, float] = {}
        self._wireless_received_at: float | None = None
        self._last_status_request_at = time.monotonic() - _VIEWER_IDLE_TIMEOUT_SECONDS
        self._command_outcome_uncertain = False
        self._uncertain_command: tuple[int, int] | None = None
        self._uncertain_wireless_operation: tuple[str, int] | None = None
        self._wireless_test_cancel: threading.Event | None = None
        self._wireless_cleanup_required = False
        self._identity_ambiguous = False
        self._thread = threading.Thread(target=self._run, name="espforge-hid-monitor", daemon=True)
        if autostart:
            self._thread.start()

    def snapshot(self) -> DashboardSnapshot:
        # ponytail: a deep copy (~50 us for a full snapshot) keeps route code off shared state; copy only changed
        # sections if one status request exceeds 1 ms or more than ~10 tabs poll at once.
        with self._lock:
            result = deepcopy(self._snapshot)
            received_at = self._input_received_at.copy()
            wireless_received_at = self._wireless_received_at
            result["command_outcome_uncertain"] = self._command_outcome_uncertain
            result["wireless_cleanup_required"] = self._wireless_cleanup_required
        now = time.monotonic()
        for kind, (max_age, flag) in _REPORTS.items():
            stale = kind not in received_at or now - received_at[kind] >= max_age
            result[flag] = stale
            if stale:
                result[kind] = None
        wireless = result["wireless"]
        if wireless is not None and (wireless_received_at is None
                                     or now - wireless_received_at >= _WIRELESS_MAX_AGE_SECONDS):
            wireless["stale"] = True
            result["wireless_error"] = result["wireless_error"] or "Wireless status is stale; wait for a refresh"
        return result

    def status_snapshot(self) -> DashboardSnapshot:
        """Record a browser poll before returning the same freshness-filtered snapshot."""
        with self._lock:
            self._last_status_request_at = time.monotonic()
        return self.snapshot()

    def _reset_snapshot(self, **fields: Any) -> None:
        """Replace the snapshot with an empty one plus fields and forget all report receipt ages."""
        with self._lock:
            self._input_received_at = {}
            self._wireless_received_at = None
            self._snapshot = cast(DashboardSnapshot, {**_empty_snapshot(), **fields})

    def close(self) -> None:
        self._stop.set()
        if self._thread.ident is not None and threading.current_thread() is not self._thread:
            self._thread.join()
        if self._close_error is not None:
            raise RuntimeError("HID cleanup failed; restart the dashboard before reconnecting") from self._close_error

    def try_retire(self) -> bool:
        """Claim idle, resolved command ownership without waiting; prevent subsequent commands from starting."""
        if not self._device_lock.acquire(blocking=False):
            return False
        try:
            if self._command_outcome_uncertain or self._wireless_cleanup_required:
                return False
            self._stop.set()
            return True
        finally:
            self._device_lock.release()

    def set_identity_ambiguous(self, ambiguous: bool) -> None:
        """Quarantine new commands without waiting for or interrupting an accepted command."""
        with self._lock:
            self._identity_ambiguous = ambiguous

    def _client(self, *, require_configuration: bool = True) -> ESPForgeHid:
        if self._stop.is_set():
            raise BoardConflict("device monitor is shutting down")
        if self._active_client is None:
            raise ConnectionError("ESPForge HID is not connected")
        with self._lock:
            if require_configuration and self._snapshot["settings_message"] is not None \
                    and self._snapshot["board_configuration"] is None:
                raise BoardConflict("Board configuration is unavailable; reconnect before sending commands")
        return self._active_client

    @contextmanager
    def _device(self, *, allow_cleanup: bool = False) -> Generator[None, None, None]:
        """Own the board for one API command, or refuse quickly while a long Wi-Fi operation holds it."""
        # ponytail: a 2 s wait turns a 15 s scan or 35 s test into a quick 409 instead of a hung request; queue
        # commands per board if users need them to run after the operation instead of retrying.
        if not self._device_lock.acquire(timeout=_BUSY_WAIT_SECONDS):
            raise BoardConflict("Board is busy with another command; retry when it finishes")
        try:
            if self._stop.is_set():
                raise BoardConflict("device monitor is shutting down")
            with self._lock:
                if self._identity_ambiguous:
                    raise BoardConflict("Duplicate ESPForge board identity; disconnect boards with duplicate serials")
                if self._wireless_cleanup_required and not allow_cleanup:
                    raise BoardConflict("Temporary Wi-Fi credentials need cleanup; retry clearing the Wi-Fi test")
            yield
        finally:
            self._device_lock.release()

    def _send_control(self, method: Callable[_P, _T], *args: _P.args, **kwargs: _P.kwargs) -> _T:
        """Delegate transaction state to HID; preserve unresolved references across client replacement."""
        if self._command_outcome_uncertain:
            raise BoardConflict("a prior command outcome is uncertain; no further writes are allowed")
        with self._lock:
            if self._snapshot["reboot_pending"]:
                raise BoardConflict("Board reboot is pending; wait for reconnection")
        client = self._active_client
        previous_result = client.last_command_result if client is not None else None
        try:
            result = method(*args, **kwargs)
        except Exception as error:
            self._publish_command_result(client, previous_result)
            if client is not None and client.command_uncertain is True:
                self._record_uncertain_command(client)
                raise CommandOutcomeUncertain(
                    "Command outcome is uncertain; re-sync with the board before retrying"
                ) from error
            raise
        self._publish_command_result(client, previous_result, result)
        return result

    def _record_uncertain_command(self, client: ESPForgeHid) -> None:
        with self._lock:
            self._command_outcome_uncertain = True
            self._uncertain_command = client.uncertain_command
            self._uncertain_wireless_operation = client.uncertain_wireless_operation

    def _publish_command_result(
        self, client: ESPForgeHid | None, previous: object, returned: object = None,
    ) -> None:
        current = client.last_command_result if client is not None else None
        result = current if current is not previous else returned
        if not isinstance(result, dict) or "status" not in result:
            return
        self._publish_control_result(cast(ControlResult, result))

    def _publish_control_result(self, result: ControlResult) -> None:
        """Publish confirmed lifecycle effects even if subsequent response validation fails."""
        with self._lock:
            if (result["status"] == "completed"
                    and result.get("opcode") in (ControlOpcode.REBOOT, ControlOpcode.SAVE_SETTINGS)):
                self._snapshot["reboot_pending"] = True
            if result["status"] == "completed" and result.get("opcode") == ControlOpcode.WIFI_CANCEL:
                self._wireless_cleanup_required = False
            if self._snapshot.get("connected"):
                self._snapshot["control_result"] = result

    def reboot(self) -> ControlResponse:
        with self._device():
            self._require_firmware_storage()
            result = self._send_control(self._client().reboot)
            ESPForgeHid.require_completed(result, "reboot")
            return {"control_result": result}

    def _require_firmware_storage(self) -> None:
        snapshot = self.snapshot()
        memory = snapshot.get("memory")
        msc = _msc(snapshot)
        if (snapshot.get("storage_stale") or msc is None or msc.get("enabled")
                or msc.get("transition_pending") or memory is not None and memory.get("sample_valid") is False):
            raise BoardConflict("Wait for idle firmware-owned storage; safely eject and return the USB drive first")

    def set_msc(self, enabled: bool, confirm_ejected: bool = False) -> ControlResponse:
        with self._device():
            snapshot = self.snapshot()
            msc = _msc(snapshot)
            if snapshot.get("storage_stale") or msc is None or msc.get("transition_pending"):
                raise BoardConflict("Waiting for fresh, settled storage ownership status")
            if enabled and not msc.get("enabled"):
                self._require_firmware_storage()
                if snapshot["memory"] is None or not snapshot["memory"]["initialized"]:
                    raise BoardConflict("Mount an SD card before enabling USB mass storage")
            result = self._send_control(self._client().set_msc, enabled, confirm_ejected)
            ESPForgeHid.require_completed(result, "MSC ownership request")
            with self._lock:
                self._input_received_at.pop("memory", None)
            return {"control_result": result}

    def set_settings(self, settings: dict[str, object]) -> SettingsResponse:
        with self._device():
            snapshot = self.snapshot()
            client = self._client()
            if snapshot.get("settings_supported") is not True:
                raise BoardConflict("Boot settings are unavailable on this firmware")
            if not isinstance(snapshot.get("hardware"), dict):
                raise BoardConflict("Waiting for device identity")
            msc = _msc(snapshot)
            if not isinstance(msc, dict):
                raise BoardConflict("Waiting for storage ownership status")
            self._require_firmware_storage()
            saved = self._send_control(client.set_settings, settings)
            self._publish_saved_settings(saved)
            return {"settings": saved, "control_result": client.last_command_result}

    def _publish_saved_settings(self, saved: BootSettings) -> None:
        with self._lock:
            configuration = self._snapshot.get("board_configuration")
            if configuration is None:
                self._snapshot["board_configuration"] = None
            else:
                self._snapshot["board_configuration"] = cast(
                    BoardConfiguration, {**configuration, **saved},
                )
            self._snapshot["settings_message"] = "Settings saved. Waiting for the board to reboot."

    def resync_command(self) -> ResyncResponse:
        """Clear uncertainty only when the board reports the exact pending operation as final."""
        with self._device(allow_cleanup=True):
            if not self._command_outcome_uncertain:
                return {"uncertain": False, "control_result": None, "wireless": None}
            client = self._client(require_configuration=False)
            try:
                outcome = client.reconcile_outcome(
                    self._uncertain_command, self._uncertain_wireless_operation,
                )
            except (OSError, ProtocolError) as error:
                raise CommandOutcomeUncertain(
                    "Could not confirm the command result; uncertainty remains"
                ) from error
            if outcome is None:
                raise CommandOutcomeUncertain(
                    "No final result matches the pending command; uncertainty remains"
                )
            control_result, wireless = outcome
            temporary_wifi_reset = (
                control_result is None and wireless is not None and self._uncertain_command is not None
            )
            with self._lock:
                self._command_outcome_uncertain = False
                self._uncertain_command = None
                self._uncertain_wireless_operation = None
                if control_result is not None:
                    self._publish_control_result(control_result)
                if temporary_wifi_reset:
                    self._wireless_cleanup_required = False
                if self._snapshot.get("connected"):
                    if wireless is not None:
                        self._publish_wireless(wireless)
            response: ResyncResponse = {
                "uncertain": False, "control_result": control_result, "wireless": wireless,
            }
            if temporary_wifi_reset:
                _LOGGER.warning("Board reset discarded temporary Wi-Fi operation; no command was replayed")
                response["temporary_wifi_reset"] = True
            return response

    def _require_wireless_idle(self) -> ESPForgeHid:
        """Return the client when wireless staging cannot race storage work or another command."""
        snapshot = self.snapshot()
        client = self._client()
        hardware = snapshot.get("hardware")
        if (not snapshot.get("connected")
                or not isinstance(hardware, dict) or not hardware.get("wireless_supported")):
            raise BoardConflict("Wireless provisioning is unavailable on this firmware")
        if snapshot.get("command_outcome_uncertain"):
            raise BoardConflict("A prior command outcome is uncertain; no further writes are allowed")
        msc = _msc(snapshot)
        # The device lock serializes host commands and firmware answers "busy" itself; a stored busy result is history.
        if (snapshot.get("storage_stale") is not False
                or not isinstance(msc, dict) or msc.get("enabled") or msc.get("transition_pending")
                or snapshot.get("reboot_pending")):
            raise BoardConflict("Wireless scan and connection test require idle firmware-owned storage")
        return client

    def scan_wireless(self) -> dict[str, list[WirelessNetwork]]:
        with self._device():
            client = self._require_wireless_idle()
            return {"networks": self._send_control(client.scan_wireless, on_poll=self._drain_input_reports)}

    def test_wireless(self, ssid: str | bytes, password: str = "") -> dict[str, WirelessTestResult]:
        with self._device():
            client = self._require_wireless_idle()
            with self._lock:
                self._snapshot["wireless"] = None
                self._snapshot["wireless_error"] = None
                self._wireless_received_at = None
            stop = threading.Event()
            with self._lock:
                self._wireless_test_cancel = stop
            cancel_sent = False
            previous_result = client.last_command_result
            try:
                return {"test": self._send_control(client.test_wireless, ssid, password,
                                                   on_poll=self._drain_input_reports,
                                                   on_progress=self._set_wireless_phase, cancel=stop)}
            except WirelessTestCancelled:
                cancel_sent = True
                with self._lock:
                    self._wireless_cleanup_required = False
                raise
            finally:
                with self._lock:
                    self._wireless_test_cancel = None
                self._set_wireless_phase(None)
                last_result = client.last_command_result
                cancel_sent |= (last_result is not None and last_result is not previous_result
                                and last_result["opcode"] == ControlOpcode.WIFI_CANCEL)
                # A cancel that arrived after the client's last check must still clear the test credentials.
                if stop.is_set() and not cancel_sent and not self._command_outcome_uncertain:
                    self._clear_wireless_test(client)

    def _clear_wireless_test(self, client: ESPForgeHid) -> None:
        """Retain cleanup ownership until cancellation completes; only unknown delivery requires Re-sync."""
        with self._lock:
            self._wireless_cleanup_required = True
            self._snapshot["wireless"] = None
            self._snapshot["wireless_error"] = None
            self._wireless_received_at = None
        try:
            self._send_control(client.cancel_wireless_test)
        except (OSError, BoardConflict, ProtocolError) as error:
            _LOGGER.warning("Wi-Fi test cleanup failed; explicit cleanup retry is required: %s", error)
            raise BoardConflict("Could not clear temporary Wi-Fi credentials; retry clearing the Wi-Fi test") from error
        with self._lock:
            self._wireless_cleanup_required = False

    def _publish_wireless(self, wireless: WirelessStatus) -> None:
        """Publish successful Feature 12 data with its receipt time, never extend freshness on failure."""
        with self._lock:
            self._snapshot["wireless"] = wireless
            self._snapshot["wireless_error"] = None
            self._wireless_received_at = time.monotonic()

    def _set_wireless_phase(self, phase: str | None) -> None:
        with self._lock:
            self._snapshot["wireless_phase"] = phase

    def _drain_input_reports(self) -> None:
        """Apply a bounded batch of queued input reports while the caller owns the HID lock."""
        client = self._active_client
        if client is None:
            raise ConnectionError("ESPForge HID is not connected")
        for _ in range(16):
            try:
                item = client.read_input_report(timeout_ms=0)
            except ProtocolError as error:
                _LOGGER.warning("Discarding malformed HID input report: %s", error)
                continue
            if item is None:
                break
            self._apply_input_report(item)

    def _apply_input_report(self, item: InputReport) -> None:
        with self._lock:
            self._input_received_at[item["kind"]] = time.monotonic()
            if item["kind"] == "runtime":
                self._snapshot["runtime"] = item["data"]
            else:
                self._snapshot["memory"] = item["data"]
            self._snapshot["connected"] = True
            self._snapshot["error"] = None
            self._snapshot["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def cancel_wireless_test(self) -> dict[str, bool]:
        # A running test owns the board for up to 35 s; it sends the cancel at its next 0.5 s poll instead.
        with self._lock:
            if self._wireless_test_cancel is not None:
                self._wireless_cleanup_required = True
                self._wireless_test_cancel.set()
                return {"cancelled": True}
        with self._device(allow_cleanup=True):
            client = self._require_wireless_idle()
            self._clear_wireless_test(client)
            return {"cancelled": True}

    def set_wireless(self, settings: dict[str, object]) -> WirelessSaveResponse:
        with self._device():
            client = self._require_wireless_idle()
            result = self._send_control(client.set_wireless, settings)
            saved = result["settings"]
            self._publish_saved_settings(saved)
            wireless = cast(WirelessStatus, {key: value for key, value in result.items() if key != "settings"})
            return {"wireless": wireless, "settings": saved, "reboot_pending": True}

    def _run(self) -> None:
        while not self._stop.is_set():
            client = None
            try:
                client = self._client_factory()
                hardware = client.read_info()
                if hardware["supported"] is False:
                    self._reset_snapshot(connected=True, hardware=hardware,
                                         error=f"Unsupported HID product: {hardware['product_name']}")
                    continue
                try:
                    configuration = client.read_configuration()
                    settings_message = None
                except (OSError, ProtocolError, BoardConflict) as error:
                    _LOGGER.warning("Boot settings unavailable; retaining input diagnostics: %s", error)
                    configuration = None
                    settings_message = f"Boot settings unavailable: {error}"
                with self._device_lock:
                    if self._stop.is_set():
                        continue
                    self._active_client = client
                    self._reset_snapshot(
                        connected=True, hardware=hardware, board_configuration=configuration,
                        settings_supported=hardware["settings_supported"] and configuration is not None,
                        settings_message=settings_message,
                    )
                wireless_poll_at = 0.0
                viewer_active_last = False
                while not self._stop.is_set():
                    with self._device_lock:
                        self._drain_input_reports()
                        now = time.monotonic()
                        with self._lock:
                            viewer_active = now - self._last_status_request_at < _VIEWER_IDLE_TIMEOUT_SECONDS
                        if viewer_active and not viewer_active_last:
                            wireless_poll_at = now
                        viewer_active_last = viewer_active
                        poll_interval = (
                            _INPUT_POLL_INTERVAL_SECONDS if viewer_active else _IDLE_INPUT_POLL_INTERVAL_SECONDS
                        )
                        if hardware["wireless_supported"] and now >= wireless_poll_at:
                            wireless_interval = (
                                (0.5 if client.wireless_active else 2.0)
                                if viewer_active else _IDLE_WIRELESS_POLL_INTERVAL_SECONDS
                            )
                            wireless_poll_at = now + wireless_interval
                            wireless: WirelessStatus | None
                            wireless_error: str | None
                            try:
                                wireless, wireless_error = client.read_wireless(), None
                            except (OSError, ProtocolError, BoardConflict) as error:
                                wireless, wireless_error = None, str(error)
                            with self._lock:
                                if wireless is not None:
                                    self._publish_wireless(wireless)
                                else:
                                    self._snapshot["wireless_error"] = wireless_error
                                    previous_wireless = self._snapshot["wireless"]
                                    if previous_wireless is not None:
                                        previous_wireless["stale"] = True
                    self._stop.wait(poll_interval)
            except Exception as error:
                message = str(error)
                if not isinstance(error, (OSError, ProtocolError, BoardConflict)):
                    # A malformed report or code bug must not silently end the thread behind a "connected" snapshot.
                    _LOGGER.exception("HID monitor failed unexpectedly")
                    message = f"Internal monitor error: {error!r}"
                with self._device_lock:
                    self._active_client = None
                    self._reset_snapshot(error=message)
            finally:
                if client is not None:
                    with self._device_lock:
                        if self._active_client is client:
                            self._active_client = None
                            with self._lock:
                                self._input_received_at = {}
                        try:
                            client.close()
                        except Exception as error:
                            _LOGGER.exception("Failed to close HID connection; stopping monitor to prevent overlap")
                            self._close_error = error
                            self._failed_client = client
                            self._stop.set()
                            self._reset_snapshot(error="HID cleanup failed; restart the dashboard")
                # Every exit path, including the unsupported-product `continue`, must back off before reopening.
                self._stop.wait(1.0)
