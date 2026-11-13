# Diagnostic shells

ESPForge enables Zephyr's native diagnostic shell on the UART connector and as a raw TCP stream on port **2323**.
Neither shell carries dashboard commands or changes saved settings, wireless credentials or SD ownership.
USB HID and authenticated BLE remain the management interfaces.

## UART

Open the board's USB-to-UART bridge port in a serial terminal at **115200 baud, 8N1**, with flow control and local
echo disabled. The prompt is `ESPForge> `. Enter submits a command; Tab lists or completes native commands.
Boot messages and logs share this UART and may interrupt the prompt. Close the terminal before flashing.
The native USB connector has HID and MSC, not a CDC serial shell.

## Raw TCP

First provision Wi-Fi through a dashboard and wait for an IPv4 address in its live wireless diagnostics.
Connect to that address:

```sh
nc <board-ip> 2323
```

In PuTTY select **Raw**, port `2323`, and enable local echo and local line editing. Do not use Telnet negotiation.
The firmware uses Zephyr's Telnet backend with command negotiation disabled; ordinary ASCII command lines need
no protocol framing. TCP echo is disabled on connection, so a normal line-buffered terminal provides local editing.
Press Enter once if no prompt appears after connecting. Close and reconnect the client after network loss.

One TCP client is accepted at a time. UART and TCP have independent shell contexts and may be used concurrently.
The listener is compiled in and reachable whenever the board has a usable IPv4 connection, including a temporary
Wi-Fi test connection. There is no saved TCP switch, HID serving flag, proof exchange or mDNS discovery.
Disabling automatic Wi-Fi joining does not disable access during an explicit Wi-Fi test.

**TCP is unauthenticated and unencrypted.** Any reachable network peer can use the diagnostic shell; the BLE
Control key does not protect it. Use only on a trusted, isolated network, never port-forward it, and do not enter
secrets. Logs are not forwarded to TCP, and command history is disabled on both shells.
To omit network access in a firmware build, set `CONFIG_SHELL_BACKEND_TELNET=n`; the default-configuration checker
intentionally rejects that non-default build.

### In-browser terminal

In the Python and .NET dashboards, click fresh connected Wi-Fi status to open a browser terminal for the selected
board. Direct offers the same link when served by its local ESPForge server; keep its connected dashboard tab
open. Static hosting cannot provide a TCP relay. The host connects only to the reported address on port 2323,
and reports connection errors rather than treating connected Wi-Fi as listener readiness.

The browser relay first sends two Ctrl-C bytes to discard any unfinished input left by a previous TCP client,
then sends `shell echo on` once so native per-key editing and completion are visible.
This changes only that shell session; the TCP backend disables echo again on each new connection. It is not an
authentication exchange. No application command is injected, and failed or partial input is never replayed.
The terminal confirms pasted newlines, preserves Control keys and Tab, and lets Shift+Tab move focus outside it.
It has bounded plain-text scrollback and native editing/erase support, not full VT100 or colour emulation.
For automatic terminal-size probing, use a full terminal; `resize default` retains native default dimensions.
Close the shell tab to disconnect. Unused relay sessions expire after 15 seconds.

The relay remains loopback-only and does not protect the board's network listener. For HTTP packet limits and
session-header details see the [bridge contract](../../host/web/README.md#browser-shell); Direct-specific admission
is described in its [dashboard guide](../../host/direct/README.md#wi-fi-shell).

## Commands and limits

Start with `help` to list the compiled native commands, or `device --help` for device inspection:

```text
help
device list
```

Native shell utilities also manage the current terminal and report shell statistics. Commands use Zephyr grammar,
not PicoForge's application command grammar. No application-specific board, settings, wireless or file commands
are included.

The kernel shell is intentionally disabled because it bundles reboot and thread-control commands that bypass
management and storage safety gates. Memory access, device initialization, date changes, flash, filesystem,
network configuration and Bluetooth shell commands are also disabled. Shell I/O runs in Zephyr's backend threads,
not in the management loop or under the application lock.

Target compilation and configuration checks do not qualify serial input, TCP connections, reconnect behavior or
management responsiveness on hardware. See the [qualification gaps](../validation/qualification-gaps.md).
