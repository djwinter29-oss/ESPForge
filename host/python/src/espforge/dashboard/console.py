# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Standard-library, bounded raw TCP console relay; no firmware authentication handshake."""

from __future__ import annotations

import ipaddress
import base64
import binascii
import errno
import logging
import secrets
import select
import socket
import threading
import time
from collections.abc import Callable

_LOGGER = logging.getLogger(__name__)


class ConsoleConflict(RuntimeError):
    """The console is unavailable, already owned, or no longer belongs to this request."""


def console_address(value: object) -> str:
    """Accept a unicast IPv4 target, never a loopback service or broadcast address."""
    if not isinstance(value, str):
        raise ValueError("Expected a board IPv4 address")
    address = ipaddress.IPv4Address(value)
    if address.is_loopback or address.is_multicast or address.is_unspecified or int(address) == 0xFFFFFFFF:
        raise ValueError("Invalid board IPv4 address")
    return str(address)


class ConsoleBridge:
    """One raw TCP session; tokens stay in memory and unused sessions expire after 15 seconds."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._socket: socket.socket | None = None
        self._session: str | None = None
        self._guard: Callable[[], None] = lambda: None
        self._timer: threading.Timer | None = None
        self._last_request = 0.0
        self._opening = False
        self._stopped = False

    def open(self, address: str, guard: Callable[[], None] = lambda: None) -> str:
        address = console_address(address)
        guard()
        with self._lock:
            if self._stopped or self._opening or self._session is not None:
                raise ConsoleConflict("A console is already open or the relay is shutting down")
            self._opening = True
        connection = None
        try:
            connection = socket.create_connection((address, 2323), timeout=3)
            connection.settimeout(1)
            guard()
            with self._lock:
                if self._stopped:
                    raise ConsoleConflict("Console connection cancelled during shutdown")
            # TCP retains unfinished input and disables echo. Escape pending ANSI input, discard the draft, then echo.
            setup = b"\x03\x03shell echo on\r"
            try:
                if connection.send(setup) != len(setup):
                    raise OSError("Incomplete shell echo setup; it was not retried")
            except OSError as error:
                raise OSError("Shell echo setup may have reached the board; it was not retried") from error
            guard()
            with self._lock:
                if self._stopped:
                    raise ConsoleConflict("Console connection cancelled during shutdown")
                self._socket = connection
                connection = None
                self._session = secrets.token_urlsafe(32)
                self._guard = guard
                self._last_request = time.monotonic()
                self._schedule_expiry()
                return self._session
        finally:
            with self._lock:
                self._opening = False
            if connection is not None:
                connection.close()

    def _schedule_expiry(self) -> None:
        remaining = max(0, 15 - (time.monotonic() - self._last_request))
        timer = threading.Timer(remaining, self._expire, args=(self._session,))
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _expire(self, session: str | None) -> None:
        with self._lock:
            if self._session is None or self._session != session:
                return
            if time.monotonic() - self._last_request >= 15:
                try:
                    self._close()
                except OSError:
                    _LOGGER.exception("Failed to close an expired console")
            else:
                self._schedule_expiry()

    def _require(self, token: str | None) -> socket.socket | None:
        if (self._session is None or not isinstance(token, str) or not token.isascii()
                or not secrets.compare_digest(self._session, token)):
            raise ConsoleConflict("Console disconnected; connect again")
        try:
            self._guard()
        except ConsoleConflict:
            self._close()
            raise
        self._last_request = time.monotonic()
        return self._socket

    def _close_socket(self) -> None:
        connection, self._socket = self._socket, None
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError as error:
                if error.errno not in (errno.ENOTCONN, 10057):
                    raise
            finally:
                connection.close()

    def _close(self) -> None:
        self._session = None
        self._guard = lambda: None
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        self._close_socket()

    def read(self, token: str | None) -> tuple[bytes, bool]:
        """Long-poll output without holding the state lock, so input and disconnect remain responsive."""
        with self._lock:
            connection = self._require(token)
            if connection is None:
                return b"", True
        try:
            ready = select.select([connection], [], [], 2)[0]
        except (OSError, ValueError) as error:
            with self._lock:
                if self._socket is not connection:
                    raise ConsoleConflict("Console disconnected; connect again") from error
                self._close_socket()
            raise OSError("Console read failed") from error
        with self._lock:
            if self._require(token) is not connection:
                raise ConsoleConflict("Console disconnected; connect again")
            if not ready:
                return b"", False
            try:
                data = connection.recv(4096)
            except OSError:
                self._close_socket()
                raise
            if not data:
                self._close_socket()
            return data, not data

    def write(self, token: str | None, data: bytes) -> int:
        """Send once; a short write closes the session and is never replayed."""
        if not data or len(data) > 1024:
            raise ValueError("Console input must contain 1..1024 bytes")
        with self._lock:
            connection = self._require(token)
            if connection is None:
                raise ConsoleConflict("The board closed the console")
            try:
                written = connection.send(data)
            except OSError:
                self._close_socket()
                raise
            if written != len(data):
                self._close_socket()
            return written

    def close(self, token: str | None) -> None:
        with self._lock:
            # Cleanup does not require the board to remain connected.
            if (self._session is None or not isinstance(token, str) or not token.isascii()
                    or not secrets.compare_digest(self._session, token)):
                raise ConsoleConflict("Console disconnected; connect again")
            self._close()

    def close_all(self) -> None:
        with self._lock:
            self._stopped = True
            self._close()


def console_input(payload: object) -> bytes:
    """Decode one strictly bounded input packet before touching a socket."""
    if not isinstance(payload, dict) or set(payload) != {"data"} or not isinstance(payload["data"], str):
        raise ValueError("Expected exactly one base64 data field")
    encoded = payload["data"]
    if len(encoded) > 1368:
        raise ValueError("Console input must contain 1..1024 bytes")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("Invalid base64 console input") from error
    if not data or len(data) > 1024:
        raise ValueError("Console input must contain 1..1024 bytes")
    return data
