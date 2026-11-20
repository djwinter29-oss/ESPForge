# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Check the shared dashboard through real Python and .NET hosting without hardware requests."""

from contextlib import contextmanager
from pathlib import Path
from threading import Thread
import argparse
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import Browser, Page, expect, sync_playwright
from werkzeug.serving import make_server

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "host/python/src"))
from zephyrforge.dashboard.boards import DashboardBoards
from zephyrforge.dashboard.server import create_app

CHECKS = Path(__file__).with_name("checks.mjs").read_text()
MOCK = re.search(r"const mock = `<script>\n(.*?)</script>", CHECKS, re.DOTALL).group(1)


@contextmanager
def python_host():
    """Serve actual Python templates, asset routes, and response headers."""
    boards = DashboardBoards(discover=lambda: [])
    server = make_server("127.0.0.1", 0, create_app(boards, ROOT / "host/web/src"), threaded=True)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
        boards.close()


@contextmanager
def dotnet_host():
    """Run the built .NET host and stop only the process owned by this test."""
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    dll = ROOT / "host/dotnet/ZephyrForge/bin/Debug/net10.0/ZephyrForge.dll"
    with tempfile.TemporaryFile(mode="w+") as output:
        process = subprocess.Popen(["dotnet", str(dll), "--port", str(port)], stdout=output, stderr=output)
        try:
            deadline = time.monotonic() + 20
            while True:
                if process.poll() is not None:
                    output.seek(0)
                    raise RuntimeError(f".NET host exited during startup:\n{output.read()}")
                try:
                    with urllib.request.urlopen(origin, timeout=1) as response:
                        if response.status == 200:
                            break
                except (OSError, urllib.error.URLError):
                    if time.monotonic() >= deadline:
                        output.seek(0)
                        raise RuntimeError(f".NET host did not become ready:\n{output.read()}")
                    time.sleep(0.1)
            yield origin
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def check_native_drafts(page: Page, origin: str, host_name: str) -> None:
    """Use native control events to verify Configure is never an edit and only explicit disables erase credentials."""
    for radio, bit in (("wifi", 1), ("ble", 2)):
        for enabled in (True, False):
            page.goto(origin)
            page.wait_for_function("!document.querySelector('#settings-ble').disabled")
            page.locator(f"#settings-{radio}").focus()
            page.evaluate("""({radio, bit, enabled}) => {
                const state = window.sharedBrowserState;
                state.connected.board_configuration.radios = enabled ? bit : 0;
                Object.assign(state.connected.wireless, {
                    ssid: 'saved', ssid_hex: '7361766564', ble_key_configured: true,
                    wifi_enabled: radio === 'wifi' && enabled, ble_enabled: radio === 'ble' && enabled
                });
                document.dispatchEvent(new Event('visibilitychange'));
            }""", {"radio": radio, "bit": bit, "enabled": enabled})
            value = "1" if enabled else "0"
            page.wait_for_function(
                "({radio, value}) => document.querySelector('#settings-' + radio).value === value",
                arg={"radio": radio, "value": value})
            configure = page.locator(f"#{radio}-configure")
            configure.focus()
            configure.click()
            assert page.locator(f"#{radio}-dialog").evaluate("(dialog) => dialog.open")
            page.keyboard.press("Escape")
            page.wait_for_function("(radio) => !document.querySelector('#' + radio + '-dialog').open", arg=radio)
            assert configure.evaluate("(button) => button === document.activeElement")
            assert page.locator(f"#settings-{radio}").input_value() == value
            assert page.locator("#settings-save").is_disabled(), "Configure manufactured an edit"
            page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_timeout(30)
            assert page.locator("#settings-save").is_disabled(), "Repeated status manufactured an edit"
            if enabled:
                page.select_option(f"#settings-{radio}", "0")
                page.locator("#settings-save").click()
                page.locator("#confirm-configuration").click()
                page.wait_for_function("window.sharedBrowserState.wirelessRequests.length === 1")
                request = page.evaluate("window.sharedBrowserState.wirelessRequests[0]")
                if radio == "wifi":
                    assert request["ssid"] == request["password"] == "" and "ble_key" not in request
                else:
                    assert request["ble_key"] == "" and "ssid" not in request and "password" not in request
            else:
                page.select_option("#settings-clock", "80")
                page.evaluate("""(radio) => {
                    document.querySelector('#settings-clock').value = '0';
                    document.querySelector('#settings-' + radio).value = '1';
                }""", radio)
                page.locator("#settings-save").click()
                page.locator("#confirm-configuration").click()
                page.wait_for_function("window.sharedBrowserState.settingsRequests.length === 1")
                assert page.evaluate("window.sharedBrowserState.settingsRequests[0]") == {
                    "system_clock_mhz": 80, "sdcard_profile": 0, "radios": 0}
                assert page.evaluate("window.sharedBrowserState.wirelessRequests.length") == 0
            print(f"{host_name}: PASS native {radio} Configure after remote {'enable' if enabled else 'disable'}")


def check_native_transitions(page: Page, origin: str, host_name: str) -> None:
    """Verify confirmation identity, dependent cleanup and local conflict recovery with native events."""
    page.goto(origin)
    page.wait_for_function("!document.querySelector('#settings-clock').disabled")
    page.select_option("#settings-clock", "80")
    page.locator("#settings-save").click()
    assert "Bluetooth radio: unchanged" in page.locator("#configuration-dialog-wireless").inner_text()
    page.evaluate("""() => {
        const state = window.sharedBrowserState.connected;
        state.board_configuration.radios = 2;
        Object.assign(state.wireless, {ble_enabled: true, ble_key_configured: true});
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    page.wait_for_function("document.querySelector('#settings-ble').value === '1'")
    page.locator("#confirm-configuration").click()
    assert page.evaluate("window.sharedBrowserState.settingsRequests.length") == 0
    assert "confirm again" in page.locator("#settings-note").inner_text()
    page.locator("#settings-save").click()
    assert "Bluetooth radio: unchanged" in page.locator("#configuration-dialog-wireless").inner_text()
    page.locator("#confirm-configuration").click()
    page.wait_for_function("window.sharedBrowserState.settingsRequests.length === 1")
    assert page.evaluate("window.sharedBrowserState.settingsRequests[0]") == {
        "system_clock_mhz": 80, "sdcard_profile": 0, "radios": 2}
    print(f"{host_name}: PASS native renewed confirmation after a remote proposal change")

    for conflicting in (False, True):
        page.goto(origin)
        page.wait_for_function("!document.querySelector('#settings-wifi').disabled")
        page.select_option("#settings-clock", "80")
        page.locator("#wifi-configure").click()
        page.locator("#wifi-ssid").fill("temporary-network")
        page.locator("#wifi-connect").click()
        page.wait_for_function("!document.querySelector('#wifi-dialog').open")
        if conflicting:
            page.locator("#ble-configure").click()
            page.locator("#ble-generate").click()
            page.locator("#ble-cancel").click()
            page.evaluate("""() => {
                const state = window.sharedBrowserState;
                state.connected.wireless.ble_key_configured = true;
                state.savedWireless.ble_key_configured = true;
                document.dispatchEvent(new Event('visibilitychange'));
            }""")
            page.locator("#wireless-discard").wait_for(state="visible")
            assert page.locator("#settings-save").is_disabled()
            page.locator("#wireless-discard").click()
        else:
            page.locator("#wifi-configure").click()
            page.locator("#wifi-cancel").click()
        page.wait_for_function("document.querySelector('#wifi-cancel').textContent === 'Retry clearing test'")
        assert page.locator("#wifi-dialog").evaluate("(dialog) => dialog.open")
        assert page.locator("#settings-save").is_disabled()
        if conflicting:
            assert page.locator("#ble-secret").input_value(), "failed cleanup lost the replacement key"
        page.locator("#wifi-cancel").click()
        page.wait_for_function("!document.querySelector('#wifi-dialog').open")
        if conflicting:
            page.locator("#wireless-discard").click()
            page.wait_for_function("document.querySelector('#wireless-discard').hidden")
            assert page.locator("#ble-secret").input_value() == ""
        for _ in range(3):
            page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_timeout(30)
        assert page.locator("#settings-wifi").input_value() == "0"
        assert page.locator("#settings-ble").input_value() == "0"
        assert page.locator("#settings-clock").input_value() == "80"
        page.locator("#settings-save").click()
        page.locator("#confirm-configuration").click()
        page.wait_for_function("window.sharedBrowserState.settingsRequests.length === 1")
        assert page.evaluate("window.sharedBrowserState.settingsRequests[0]") == {
            "system_clock_mhz": 80, "sdcard_profile": 0, "radios": 0}
        assert page.evaluate("window.sharedBrowserState.wirelessRequests.length") == 0
        print(f"{host_name}: PASS native {'local conflict discard' if conflicting else 'dependent Wi-Fi cleanup'}"
              " preserves unrelated drafts")


def check_diagnostic_rows(page: Page, origin: str, host_name: str) -> None:
    """Each visible diagnostics row fills its container, including partial rows and hidden radios."""
    page.goto(origin)
    expect(page.locator("#connection-label")).to_have_text("Connected")
    viewport = page.viewport_size
    for width in (1440, 960, 720, 320):
        page.set_viewport_size({"width": width, "height": 900})
        for radios in (0, 1, 2):
            rows = page.evaluate("""(radios) => {
                const summary = document.querySelector('.runtime-summary');
                const wireless = ['wifi-diagnostics', 'ble-diagnostics'].map(id => document.getElementById(id));
                const hidden = wireless.map(element => element.hidden);
                wireless.forEach((element, index) => { element.hidden = index >= radios; });
                const bounds = summary.getBoundingClientRect();
                const rows = new Map();
                for (const element of summary.children) {
                    if (element.hidden) continue;
                    const rect = element.getBoundingClientRect();
                    const row = rows.get(rect.top) ?? [];
                    row.push({left: rect.left, right: rect.right});
                    rows.set(rect.top, row);
                }
                const result = [...rows.values()].map(row => ({
                    left: row[0].left - bounds.left, right: bounds.right - row.at(-1).right,
                    count: row.length, gaps: row.slice(1).map((cell, index) => cell.left - row[index].right)
                }));
                wireless.forEach((element, index) => { element.hidden = hidden[index]; });
                return result;
            }""", radios)
            for row in rows:
                assert 0 <= row["left"] <= 3 and 0 <= row["right"] <= 3, (width, radios, row)
                assert all(abs(gap - 1) < 0.5 for gap in row["gaps"]), (width, radios, row)
            if width == 1440:
                assert [row["count"] for row in rows] == ([5, radios] if radios else [5]), (width, radios, rows)
            assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    page.set_viewport_size(viewport)
    print(f"{host_name}: PASS diagnostics fill every row at desktop and mobile widths")


def check_accessibility_smoke(page: Page, origin: str, host_name: str) -> None:
    """Traverse native focus order, check visible focus, and exercise confirmation and clipboard refusal."""
    page.add_init_script("""
        window.confirmationCloseListeners = 0;
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, listener, options) {
            if (this.id === 'configuration-dialog' && type === 'close') window.confirmationCloseListeners++;
            return add.call(this, type, listener, options);
        };
    """)
    page.goto(origin)
    expect(page.locator("#settings-clock")).to_be_enabled()

    def check_focus() -> None:
        focus = page.evaluate("""() => {
            const element = document.activeElement;
            if (element === document.body) return {visible: true, contrasts: []};
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            const visible = rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0
                && rect.bottom <= innerHeight && rect.right <= innerWidth
                && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
                && (hit === element || element.contains(hit));
            const rgb = colour => colour.match(/[\\d.]+/g).slice(0, 3).map(Number);
            const luminance = colour => {
                const channels = rgb(colour).map(value => value / 255).map(value =>
                    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
                return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
            };
            const outline = luminance(style.outlineColor);
            const contrasts = [];
            for (let surface = element.parentElement; surface; surface = surface.parentElement) {
                const background = getComputedStyle(surface).backgroundColor;
                if (!background.endsWith(', 0)')) {
                    const value = luminance(background);
                    contrasts.push((Math.max(outline, value) + 0.05) / (Math.min(outline, value) + 0.05));
                    break;
                }
            }
            return {visible, contrasts};
        }""")
        assert focus["visible"], "Keyboard focus must have a visible outline and remain in-view and unobscured"
        assert not focus["contrasts"] or min(focus["contrasts"]) >= 3, (
            "The focus indicator must have at least 3:1 contrast against adjacent surfaces",
            focus["contrasts"],
        )

    def tab_to(selector: str, reverse: bool = False) -> None:
        for _ in range(40):
            page.keyboard.press("Shift+Tab" if reverse else "Tab")
            check_focus()
            if page.locator(selector).evaluate("(element) => element === document.activeElement"):
                return
        raise AssertionError(f"Keyboard traversal did not reach {selector}")

    tab_to("#settings-clock")
    page.keyboard.press("ArrowDown")
    tab_to("#settings-save", reverse=True)
    page.keyboard.press("Enter")
    dialog = page.get_by_role("dialog", name="Save and reboot?")
    expect(dialog).to_be_visible()
    assert dialog.get_by_role("button", name="Cancel", exact=True).evaluate(
        "(button) => button === document.activeElement")
    check_focus()
    tab_to("#confirm-configuration")
    tab_to("#cancel-configuration", reverse=True)
    for _ in range(50):
        page.keyboard.press("Tab")
    assert page.evaluate("window.confirmationCloseListeners") == 1
    page.keyboard.press("Escape")
    expect(dialog).not_to_be_visible()
    assert page.locator("#settings-save").evaluate("(button) => button === document.activeElement")
    check_focus()
    assert page.evaluate("window.sharedBrowserState.settingsRequests.length") == 0
    print(f"{host_name}: PASS native Tab/Shift+Tab journey, visible focus, confirmation and bounded close listeners")

    page.set_viewport_size({"width": 1280, "height": 900})
    page.evaluate("document.documentElement.style.zoom = '2'")
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    page.evaluate("document.documentElement.style.zoom = ''")
    page.set_viewport_size({"width": 320, "height": 800})
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    tab_to("#ble-configure")
    page.keyboard.press("Enter")
    tab_to("#ble-generate")
    page.keyboard.press("Enter")
    page.evaluate("""() => Object.defineProperty(navigator, 'clipboard', {configurable: true,
        value: {writeText: async () => {throw new DOMException('Clipboard denied', 'NotAllowedError');}}})""")
    tab_to("#ble-copy")
    page.keyboard.press("Enter")
    expect(page.locator("#ble-status")).to_contain_text("Could not copy key")
    assert "Key copied" not in page.locator("#ble-status").inner_text()
    assert page.get_by_role("dialog", name="Bluetooth control key").is_visible()
    assert page.evaluate("document.querySelector('#ble-dialog').scrollWidth <= "
                         "document.querySelector('#ble-dialog').clientWidth")
    page.keyboard.press("Escape")
    assert page.locator("#ble-configure").evaluate("(button) => button === document.activeElement")
    check_focus()
    print(f"{host_name}: PASS 200-percent zoom, 320-pixel reflow and clipboard refusal feedback")


def check_recovery_presentation(page: Page, origin: str, host_name: str) -> None:
    """Keep host-owned uncertainty actionable, accessible and visually legible."""
    page.goto(origin)
    expect(page.locator("#settings-clock")).to_be_enabled()
    expect(page.locator("#settings-dirty-indicator")).to_be_hidden()
    normal_mark = page.locator(".status-mark").evaluate("(node) => getComputedStyle(node).backgroundColor")
    page.evaluate("""() => {
        window.sharedBrowserState.connected.command_outcome_uncertain = true;
        window.sharedBrowserState.connected.command_resync_supported = true;
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    expect(page.locator("#status-message")).to_contain_text("previous command outcome is uncertain")
    expect(page.locator("#connection-label")).to_have_text("Connected")
    expect(page.locator("#settings-save")).to_be_disabled()
    expect(page.locator("#reboot-control")).to_be_disabled()
    expect(page.locator("#settings-save-help")).to_have_text(
        "Wait for the current operation or recovery to finish before saving or rebooting.")
    expect(page.locator("#reboot-help")).to_be_hidden()
    assert page.locator("#reboot-control").get_attribute("aria-describedby") == "settings-save-help"
    recovery = page.locator("#command-resync")
    expect(recovery).to_be_visible()
    bounds = recovery.evaluate("""node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {width: rect.width, left: rect.left, right: rect.right,
            scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
            gridColumn: style.gridColumnStart, viewport: innerWidth,
            footerRight: node.parentElement.getBoundingClientRect().right};
    }""")
    assert bounds["width"] >= 80 and bounds["scrollWidth"] <= bounds["clientWidth"], bounds
    assert bounds["gridColumn"] == "2" and bounds["right"] <= bounds["footerRight"], bounds

    page.evaluate("""() => {
        window.sharedBrowserState.statusFails = true;
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    expect(page.locator("#status-message")).to_contain_text("Status unavailable")
    expect(page.locator("#recovery-help")).to_be_visible()
    for width in (1440, 320):
        page.set_viewport_size({"width": width, "height": 900})
        guidance = page.locator("#recovery-help").evaluate("""node => {
            const rect = node.getBoundingClientRect();
            return {width: rect.width, height: rect.height, column: getComputedStyle(node).gridColumnStart};
        }""")
        assert guidance["width"] > 180 and guidance["height"] < 160 and guidance["column"] == "2", guidance
    page.evaluate("""() => {
        window.sharedBrowserState.statusFails = false;
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    expect(page.locator("#status-message")).not_to_contain_text("Status unavailable")
    page.set_viewport_size({"width": 1440, "height": 900})

    def contrast(selector: str) -> float:
        return page.locator(selector).evaluate("""node => {
            const channel = value => {
                value /= 255;
                return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            };
            const luminance = colour => {
                const values = colour.match(/[\\d.]+/g).slice(0, 3).map(Number);
                return values.map(channel).reduce((sum, value, index) =>
                    sum + value * [0.2126, 0.7152, 0.0722][index], 0);
            };
            const foreground = luminance(getComputedStyle(node).color);
            for (let surface = node; surface; surface = surface.parentElement) {
                const background = getComputedStyle(surface).backgroundColor;
                if (!background.endsWith(', 0)')) {
                    const backgroundLuminance = luminance(background);
                    return (Math.max(foreground, backgroundLuminance) + 0.05)
                        / (Math.min(foreground, backgroundLuminance) + 0.05);
                }
            }
            throw new Error('No opaque background found for text');
        }""")

    assert contrast("#status-message") >= 4.5, "normal status text must meet WCAG AA contrast"
    assert contrast("#memory-note") >= 4.5, "storage guidance must meet WCAG AA contrast"
    page.evaluate("""() => {
        window.sharedBrowserState.connected.error = 'A rejected operation';
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    expect(page.locator("#status-message")).to_contain_text("A rejected operation")
    assert contrast("#status-message") >= 4.5, "error status text must meet WCAG AA contrast"
    error_mark = page.locator(".status-line").evaluate("(node) => getComputedStyle(node.querySelector('.status-mark')).backgroundColor")
    assert normal_mark != error_mark, "the live-telemetry marker must not override an error marker"
    assert page.locator("footer.status-line").get_attribute("role") is None
    assert page.locator("#status-message").get_attribute("role") == "status"
    print(f"{host_name}: PASS host-owned recovery explanation, usable action and rendered text contrast")


def check_dirty_navigation(page: Page, origin: str, host_name: str) -> None:
    """Prevent browser reloads from silently discarding an active dashboard draft."""
    page.goto(origin)
    page.wait_for_function("() => !document.querySelector('#settings-clock').disabled")
    assert page.locator("a.brand").count() == 0, "the current-page brand must not reload the dashboard"
    clean = page.evaluate("""() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    }""")
    assert not clean, "clean dashboard state must not prompt before leaving"
    expect(page.locator("#settings-dirty-indicator")).to_be_hidden()
    page.locator("#settings-clock").select_option("80")
    expect(page.locator("#settings-dirty-indicator")).to_be_visible()
    dirty = page.evaluate("""() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    }""")
    assert dirty, "unsaved configuration must prevent an unconfirmed unload"
    page.goto(origin)
    page.wait_for_function("() => !document.querySelector('#settings-wifi').disabled")
    page.locator("#wifi-configure").click()
    page.locator("#wifi-ssid").fill("untested-network")
    page.locator("#wifi-password").fill("not-tested")
    expect(page.locator("#settings-dirty-indicator")).to_be_visible()
    expect(page.locator("#settings-save")).to_be_disabled()
    expect(page.locator("#settings-note")).to_contain_text("Untested Wi-Fi details are a local draft")
    dialogs: list[str] = []

    def accept_before_unload(dialog) -> None:
        dialogs.append(dialog.type)
        dialog.accept()

    page.on("dialog", accept_before_unload)
    page.reload()
    page.remove_listener("dialog", accept_before_unload)
    assert dialogs == ["beforeunload"], "native reload must warn for an untested wireless draft"
    expect(page.locator("#settings-dirty-indicator")).to_be_hidden()
    print(f"{host_name}: PASS native reload warning for untested wireless drafts")


def check_status_error_survives_local_edit(page: Page, origin: str, host_name: str) -> None:
    """Keep fetch failures visible across local renders and clear them only after a successful status read."""
    page.goto(origin)
    page.wait_for_function("() => window.sharedBrowserState.statusReads > 0")
    page.locator("#wifi-configure").click()
    page.locator("#wifi-status").evaluate("(status) => { status.textContent = 'Current dialog progress'; }")
    page.evaluate("""() => {
        window.sharedBrowserState.statusFails = true;
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    expect(page.locator("#status-message")).to_contain_text("Status unavailable: status endpoint offline")
    expect(page.locator("#status-freshness")).to_contain_text("Last successful status fetch")
    expect(page.locator("#wifi-readiness")).to_contain_text("Board status unavailable")
    expect(page.locator("#wifi-scan")).to_be_disabled()
    expect(page.locator("#wifi-connect")).to_be_disabled()
    expect(page.locator("#wifi-status")).to_have_text("Current dialog progress")
    page.locator("#wifi-ssid").fill("untested-network")
    page.locator("#wifi-password").fill("not-tested")
    expect(page.locator("#status-message")).to_contain_text("Status unavailable: status endpoint offline")
    expect(page.locator("#connection-label")).to_have_text("Connected")
    page.evaluate("""() => {
        window.sharedBrowserState.statusFails = false;
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    expect(page.locator("#status-message")).to_have_text("HID telemetry is live")
    expect(page.locator("#status-freshness")).to_be_hidden()
    expect(page.locator("#wifi-readiness")).to_be_hidden()
    expect(page.locator("#wifi-ssid")).to_have_value("untested-network")
    expect(page.locator("#wifi-password")).to_have_value("not-tested")
    print(f"{host_name}: PASS status failure persists through edits and clears on recovery")


def check_wireless_readiness_guidance(page: Page, origin: str, host_name: str) -> None:
    """Keep local Bluetooth keys recoverable and actionable when board status is unavailable."""
    page.goto(origin)
    page.wait_for_function("() => window.sharedBrowserState.statusReads > 0")
    page.locator("#ble-configure").click()
    page.locator("#ble-generate").click()
    key = page.locator("#ble-secret").input_value()
    page.evaluate("""() => {
        window.sharedBrowserState.statusFails = true;
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    expect(page.locator("#ble-readiness")).to_contain_text("Board status unavailable")
    expect(page.locator("#ble-generate")).to_be_disabled()
    expect(page.locator("#ble-copy")).to_be_enabled()
    expect(page.locator("#ble-secret")).to_have_value(key)
    page.evaluate("""() => Object.defineProperty(navigator, 'clipboard', {configurable: true,
        value: {writeText: async text => { window.copiedWirelessKey = text; }}})""")
    page.locator("#ble-copy").click()
    expect(page.locator("#ble-status")).to_contain_text("Key copied")
    assert page.evaluate("window.copiedWirelessKey") == key
    page.evaluate("""() => {
        window.sharedBrowserState.statusFails = false;
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    expect(page.locator("#ble-readiness")).to_be_hidden()
    expect(page.locator("#ble-secret")).to_have_value(key)
    page.locator("#ble-cancel").click()
    print(f"{host_name}: PASS local Bluetooth key remains copyable through status failure")


def check_active_wifi_progress(page: Page, origin: str, host_name: str) -> None:
    """Keep the per-second connection-test progress out of the polite Wi-Fi status region."""
    page.goto(origin)
    page.wait_for_function("() => window.sharedBrowserState.statusReads > 0")
    page.evaluate("""() => {
        const request = window.fetch;
        window.resumeWirelessTest = null;
        window.fetch = (input, options) => {
            if (new URL(input, document.baseURI).pathname !== '/api/wireless/test')
                return request(input, options);
            return new Promise(resolve => {
                window.resumeWirelessTest = () => request(input, options).then(resolve);
            });
        };
    }""")
    page.locator("#wifi-configure").click()
    page.locator("#wifi-ssid").fill("progress-network")
    page.locator("#wifi-connect").click()
    page.wait_for_function("() => document.querySelector('#wifi-status').textContent.includes('Testing')")
    initial_status = page.locator("#wifi-status").inner_text()
    initial_progress = page.locator("#wifi-progress").inner_text()
    page.evaluate("""() => {
        const status = document.querySelector('#wifi-status');
        window.progressStatusMutations = 0;
        window.progressStatusObserver = new MutationObserver(records => {
            window.progressStatusMutations += records.length;
        });
        window.progressStatusObserver.observe(status, {subtree: true, childList: true, characterData: true});
    }""")
    page.wait_for_timeout(2200)
    mutations = page.evaluate("""() => {
        window.progressStatusObserver.disconnect();
        return window.progressStatusMutations;
    }""")
    assert mutations == 0 and page.locator("#wifi-status").inner_text() == initial_status, (
        f"{host_name}: active test changed the polite status region {mutations} times")
    assert page.locator("#wifi-progress").inner_text() != initial_progress
    assert page.locator("#wifi-progress").get_attribute("aria-live") == "off"
    expect(page.locator("#wifi-readiness")).to_be_hidden()
    page.evaluate("window.resumeWirelessTest()")
    expect(page.locator("#wifi-dialog")).not_to_be_visible()
    print(f"{host_name}: PASS active Wi-Fi progress does not repeatedly announce")


def confirmation_description(page: Page) -> str:
    """Read Chromium's computed dialog description; use referenced visible text in other engines."""
    create_session = getattr(page.context, "new_cdp_session", None)
    if create_session is not None:
        session = create_session(page)
        try:
            nodes = session.send("Accessibility.getFullAXTree")["nodes"]
            dialog = next(node for node in nodes
                          if node.get("role", {}).get("value") == "dialog"
                          and node.get("name", {}).get("value") == "Save and reboot?")
            return dialog.get("description", {}).get("value", "")
        finally:
            session.detach()
    return page.locator("#configuration-dialog").evaluate("""dialog =>
        (dialog.getAttribute('aria-describedby') ?? '').split(/\\s+/)
            .map(id => document.getElementById(id))
            .filter(node => node && !node.hidden)
            .map(node => node.innerText)
            .join(' ')""")


def check_hidden_display_and_responsive_confirmation(page: Page, origin: str, host_name: str) -> None:
    """Verify hidden optional controls stay hidden and confirmations remain reachable on narrow displays."""
    page.goto(origin)
    page.wait_for_function("() => window.sharedBrowserState.statusReads > 0")
    hidden = page.evaluate("""() => ['#msc-controls', '#wifi-manual-label',
        '#configuration-wireless-row'].map(selector => {
        const element = document.querySelector(selector);
        return element.hidden && getComputedStyle(element).display === 'none';
    })""")
    assert all(hidden), f"{host_name}: a hidden optional control still occupies layout"

    page.locator("#wifi-configure").click()
    boundary = page.locator("#wifi-password").evaluate("""node => {
        const values = getComputedStyle(node).borderTopColor.match(/[\\d.]+/g).slice(0, 3).map(Number);
        const luminance = values.map(value => {
            value /= 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        return (1.05) / (luminance + 0.05);
    }""")
    assert boundary >= 3, f"{host_name}: wireless form border contrast is only {boundary:.2f}:1"
    page.locator("#wifi-cancel").click()

    page.set_viewport_size({"width": 320, "height": 600})
    page.goto(origin)
    page.wait_for_function("() => window.sharedBrowserState.statusReads > 0")
    radio_controls = page.evaluate("""() => ['wifi', 'ble'].map(radio => {
        const setting = document.querySelector('#' + radio + '-settings');
        const select = setting.querySelector('select').getBoundingClientRect();
        const button = setting.querySelector('button').getBoundingClientRect();
        const bounds = setting.getBoundingClientRect();
        return {height: bounds.height, right: button.right, viewport: innerWidth,
            aligned: Math.abs(select.bottom - button.bottom) <= 1};
    })""")
    assert all(row["height"] < 100 and row["right"] <= row["viewport"] and row["aligned"]
               for row in radio_controls), radio_controls
    page.locator("#settings-clock").select_option("80")
    page.locator("#settings-save").click()
    dialog = page.locator("#configuration-dialog")
    expect(dialog).to_be_visible()
    description = confirmation_description(page)
    assert "Untested Wi-Fi details" not in description, description
    assert "not encrypted" not in description, description
    dimensions = dialog.evaluate("""dialog => {
        const rect = dialog.getBoundingClientRect();
        return {top: rect.top, bottom: rect.bottom, height: rect.height, scrollHeight: dialog.scrollHeight};
    }""")
    assert 0 <= dimensions["top"] and dimensions["bottom"] <= 600, (
        f"{host_name}: confirmation extends outside the viewport: {dimensions}")
    assert dimensions["scrollHeight"] <= 600, (
        f"{host_name}: unchanged wireless details make the confirmation unnecessarily scroll: {dimensions}")
    page.locator("#confirm-configuration").scroll_into_view_if_needed()
    expect(page.locator("#confirm-configuration")).to_be_visible()
    page.locator("#cancel-configuration").click()

    page.goto(origin)
    page.wait_for_function("() => window.sharedBrowserState.statusReads > 0")
    page.locator("#wifi-configure").click()
    page.locator("#wifi-other").click()
    page.locator("#wifi-ssid").fill("review-network")
    page.locator("#wifi-password").fill("review-passphrase")
    page.locator("#wifi-connect").click()
    expect(page.locator("#wifi-dialog")).not_to_be_visible()
    page.locator("#settings-save").click()
    description = confirmation_description(page)
    assert "review-network" in description and "not encrypted" in description, description
    assert "Untested Wi-Fi details" not in description, description
    page.keyboard.press("Escape")

    page.set_viewport_size({"width": 1280, "height": 800})
    print(f"{host_name}: PASS hidden controls and narrow-screen confirmation")


def check_live_region_updates_are_stable(page: Page, origin: str, host_name: str) -> None:
    """Avoid replacing unchanged text in the polite live regions during normal polling."""
    page.goto(origin)
    page.wait_for_function("() => window.sharedBrowserState.statusReads > 0")
    before = page.evaluate("""() => {
        const regions = ['#status-message', '#settings-note'].map(selector =>
            document.querySelector(selector));
        window.liveRegionMutations = 0;
        window.liveRegionObserver = new MutationObserver(records => {
            window.liveRegionMutations += records.length;
        });
        for (const region of regions)
            window.liveRegionObserver.observe(region, {subtree: true, childList: true, characterData: true});
        return window.sharedBrowserState.statusReads;
    }""")
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_function("(reads) => window.sharedBrowserState.statusReads > reads", arg=before)
    page.wait_for_timeout(20)
    mutations = page.evaluate("""() => {
        window.liveRegionObserver.disconnect();
        return window.liveRegionMutations;
    }""")
    assert mutations == 0, f"unchanged live-region text caused {mutations} DOM mutations"
    print(f"{host_name}: PASS unchanged live regions are not rewritten during polling")


def check_shell_link_focus_survives_poll(page: Page, origin: str, host_name: str) -> None:
    """Keep keyboard focus on the Wi-Fi shell link when its status is refreshed."""
    page.goto(origin)
    page.wait_for_function("() => window.sharedBrowserState.statusReads > 0")
    page.evaluate("""() => {
        const board = window.sharedBrowserState.connected;
        board.board_configuration.radios = 1;
        Object.assign(board.wireless, { ssid: 'focus-network', wifi_enabled: true,
            wifi_state: 'connected', ipv4: '192.0.2.2' });
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    page.wait_for_selector("#wifi-shell-action")
    page.wait_for_timeout(50)
    link = page.locator("#wifi-shell-action")
    expect(link).to_have_text("Open Wi-Fi shell")
    assert link.get_attribute("target") == "_blank"
    assert link.get_attribute("rel") == "noopener noreferrer"
    assert link.get_attribute("aria-label") == "Open Wi-Fi shell through focus-network (192.0.2.2)"
    expect(page.locator("#wifi-state")).to_have_text("focus-network (192.0.2.2)")
    page.locator("#wifi-shell-action").focus()
    before = page.evaluate("""() => {
        window.focusedShellLink = document.querySelector('#wifi-shell-action');
        const reads = window.sharedBrowserState.statusReads;
        document.dispatchEvent(new Event('visibilitychange'));
        return reads;
    }""")
    page.wait_for_function("(reads) => window.sharedBrowserState.statusReads > reads", arg=before)
    focused = page.evaluate("() => document.activeElement === window.focusedShellLink")
    assert focused, "a status poll must not move keyboard focus away from the unchanged shell link"
    print(f"{host_name}: PASS Wi-Fi shell-link focus survives a status poll")


def check_console_brand_keyboard_focus(page: Page, origin: str, host_name: str) -> None:
    """Keep the linked shell-page brand visibly focused against the dark header."""
    page.goto(f"{origin}/console?board=browser-board")
    page.keyboard.press("Tab")
    brand = page.locator("a.brand")
    assert brand.evaluate("(node) => node === document.activeElement")
    contrast = brand.evaluate("""node => {
        const parse = colour => colour.match(/[\\d.]+/g).slice(0, 3).map(Number);
        const luminance = colour => parse(colour).map(value => {
            value /= 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        const style = getComputedStyle(node);
        const foreground = luminance(style.outlineColor);
        const background = luminance(getComputedStyle(node.parentElement).backgroundColor);
        return {width: style.outlineWidth, ratio: (Math.max(foreground, background) + 0.05)
            / (Math.min(foreground, background) + 0.05)};
    }""")
    assert contrast["width"] == "3px" and contrast["ratio"] >= 3, contrast
    print(f"{host_name}: PASS linked shell brand has a high-contrast keyboard focus indicator")


def check_partial_diagnostics(page: Page, origin: str, host_name: str) -> None:
    """Prove optional diagnostic failures do not invent observed states or discard the settings draft."""
    page.goto(origin)
    expect(page.locator("#settings-clock")).to_be_enabled()
    page.locator("#settings-clock").select_option("80")
    page.evaluate("""() => {
        const state = window.sharedBrowserState.connected;
        state.runtime.cdc_open = 'invalid';
        state.hardware.product_name = {};
        delete state.hardware.board_model;
        state.board_configuration.monitor_uart_index = 'invalid';
        state.board_configuration.monitor_uart_tx_gpio = -1;
        state.board_configuration.monitor_uart_rx_gpio = 255;
        state.board_configuration.storage_gpios = [0, 255];
        state.board_configuration.reset_cause = 'invalid';
    }""")
    expect(page.locator("#status-message")).to_contain_text("runtime.cdc_open")
    expect(page.locator("#product-name")).to_have_text("--")
    expect(page.locator("#board-model")).to_have_text("--")
    expect(page.locator("#board-mcu")).to_have_text("ESP32-S3")
    expect(page.locator("#board-uart-title")).to_have_text("Monitor UART")
    expect(page.locator("#board-uart td").nth(0)).to_have_text("--")
    expect(page.locator("#board-uart td").nth(1)).to_have_text("Unassigned")
    expect(page.locator("#board-storage-pins td").nth(0)).to_have_text("GPIO0")
    expect(page.locator("#board-storage-pins td").nth(1)).to_have_text("Unassigned")
    expect(page.locator("#board-storage-pins td").nth(2)).to_have_text("--")
    expect(page.locator("#board-reset-cause")).to_have_text("--")
    expect(page.locator("#settings-clock")).to_have_value("80")
    expect(page.locator("#reboot-control")).to_be_enabled()
    expect(page.locator("#settings-save")).to_be_enabled()
    page.evaluate("""() => {
        const state = window.sharedBrowserState.connected;
        state.runtime.cdc_open = false;
        state.board_configuration.monitor_uart_index = 0;
        state.board_configuration.monitor_uart_tx_gpio = 0;
        state.board_configuration.reset_cause = 0;
    }""")
    expect(page.locator("#board-uart-title")).to_have_text("Monitor UART0")
    expect(page.locator("#board-uart td").nth(0)).to_have_text("GPIO0")
    expect(page.locator("#board-reset-cause")).to_have_text("Unknown")
    print(f"{host_name}: PASS unknown/false/sentinel diagnostics preserve valid commands and settings drafts")


def check_msc_handoff(page: Page, origin: str, host_name: str) -> None:
    """Exercise explicit ownership controls and detected-only storage using synthetic status snapshots."""
    page.goto(origin)
    page.evaluate("""() => {
        const board = window.sharedBrowserState.connected;
        board.board_configuration.board_flags = 0x45;
        board.board_configuration.card_detect_gpio = 8;
        Object.assign(board.memory, { configured: true, sample_valid: true, initialized: true,
            presence_known: true, present: true, filesystem_format: 'fat32' });
    }""")
    enable = page.locator("#msc-enable")
    returned = page.locator("#msc-return")
    dialog = page.locator("#msc-dialog")
    expect(enable).to_be_enabled()
    enable.click()
    expect(dialog).to_be_visible()
    page.keyboard.press("Escape")
    expect(dialog).not_to_be_visible()
    assert page.evaluate("window.sharedBrowserState.mscRequests.length") == 0
    enable.click()
    page.locator("#confirm-msc").click()
    expect(returned).to_be_enabled()
    expect(enable).to_be_disabled()
    returned.click()
    expect(page.locator("#confirm-msc")).to_have_text("I have safely ejected")
    page.locator("#confirm-msc").click()
    expect(enable).to_be_enabled()
    assert page.evaluate("window.sharedBrowserState.mscRequests") == [
        {"enabled": True, "confirm_ejected": False},
        {"enabled": False, "confirm_ejected": True},
    ]
    section = page.locator('section[aria-labelledby="memory-title"]')
    page.evaluate("""() => Object.assign(window.sharedBrowserState.connected.memory,
        { sample_valid: true, initialized: false, present: false })""")
    expect(section).to_be_hidden()
    page.evaluate("""() => Object.assign(window.sharedBrowserState.connected.memory,
        { sample_valid: true, initialized: true, present: true })""")
    expect(section).to_be_visible()
    expect(enable).to_be_enabled()
    assert page.evaluate("window.sharedBrowserState.mscRequests.length") == 2
    print(f"{host_name}: PASS MSC confirmation, Escape, returned ownership and replacement without re-export")


def check_identity_details(browser: Browser, page: Page, origin: str, host_name: str) -> None:
    """Align the identity values and expose product/memory details by mouse, keyboard and touch."""
    page.goto(origin)
    page.wait_for_function("document.querySelector('#product-name').textContent.includes('ZephyrForge')")
    assert page.locator(".identity > .metric").count() == 5
    page.set_viewport_size({"width": 1440, "height": 900})
    tops = page.locator(".identity strong").evaluate_all(
        "(nodes) => nodes.map(node => node.getBoundingClientRect().top)")
    assert max(tops) - min(tops) <= 1, tops
    for identity in ("product-information", "module-memory"):
        page.set_viewport_size({"width": 1440, "height": 900})
        details = page.locator(f"#{identity} .identity-popover")
        summary = page.locator(f"#{identity} > summary")
        page.mouse.move(0, 0)
        expect(details).to_be_hidden()
        summary.hover()
        expect(details).to_be_visible()
        if identity == "product-information":
            expect(page.locator("#board-model")).to_contain_text("ESP32-S3")
            expect(page.locator("#board-mcu")).to_have_text("ESP32-S3")
            assert page.locator("#board-mcu").evaluate(
                "(node) => node.getBoundingClientRect().top"
                " > document.querySelector('#board-model').getBoundingClientRect().bottom")
        details.hover()
        expect(details).to_be_visible()
        page.mouse.move(0, 0)
        expect(details).to_be_hidden()
        summary.focus()
        page.keyboard.press("Tab")
        page.keyboard.press("Shift+Tab")
        expect(details).to_be_visible()
        summary.press("Escape")
        expect(details).to_be_hidden()
        summary.press("Enter")
        expect(details).to_be_visible()
        summary.press("Enter")
        expect(details).to_be_hidden()
        for width in (1440, 720, 320):
            page.set_viewport_size({"width": width, "height": 900})
            summary.press("Enter")
            expect(details).to_be_visible()
            assert details.evaluate("(node) => node.getBoundingClientRect().left >= 0"
                                    " && node.getBoundingClientRect().right <= innerWidth")
            summary.press("Escape")
            summary.press("Tab")
            summary.hover()
            details.hover()
            expect(details).to_be_visible()
            page.mouse.move(0, 0)
            expect(details).to_be_hidden()
            summary.press("Escape")
    page.set_viewport_size({"width": 1440, "height": 900})
    page.locator("#product-information > summary").hover()
    page.locator("#module-memory > summary").hover()
    expect(page.locator("#product-information .identity-popover")).to_be_hidden()
    expect(page.locator("#module-memory .identity-popover")).to_be_visible()
    with browser.new_context(has_touch=True, viewport={"width": 320, "height": 800}) as context:
        touch = context.new_page()
        touch.add_init_script(MOCK)
        touch.goto(origin)
        touch.wait_for_function("document.querySelector('#product-name').textContent.includes('ZephyrForge')")
        for identity in ("product-information", "module-memory"):
            touch.locator(f"#{identity} > summary").tap()
            expect(touch.locator(f"#{identity} .identity-popover")).to_be_visible()
            touch.locator(f"#{identity} > summary").tap()
            expect(touch.locator(f"#{identity} .identity-popover")).to_be_hidden()
    print(f"{host_name}: PASS aligned identity and product/memory hover, keyboard, touch and responsive details")


def main() -> None:
    """Fail on incomplete checks, assertion failures, page errors, or missing hosting assets."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", nargs="+", choices=("chromium", "firefox", "webkit"), default=["chromium"])
    args = parser.parse_args()
    subprocess.run(["dotnet", "build", str(ROOT / "host/dotnet/ZephyrForge/ZephyrForge.csproj"), "--nologo"],
                   check=True)
    with sync_playwright() as playwright:
        for engine in args.browser:
            browser = getattr(playwright, engine).launch()
            try:
                for name, host in (("Python", python_host), (".NET", dotnet_host)):
                    label = f"{engine}/{name}"
                    with host() as origin, browser.new_context(viewport={"width": 360, "height": 800}) as context:
                        page = context.new_page()
                        errors: list[str] = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.add_init_script(MOCK)
                        page.route("**/__browser_checks__.mjs", lambda route: route.fulfill(
                            status=200, content_type="text/javascript", body=CHECKS))
                        response = page.goto(origin)
                        assert response.status == 200
                        assert "script-src 'self'" in response.headers["content-security-policy"]
                        assert name in page.locator(".brand-copy").inner_text()
                        reports = page.evaluate("""async () => {
                            globalThis.sharedBrowserHosted = true;
                            await import('/__browser_checks__.mjs');
                            return globalThis.sharedBrowserResults;
                        }""")
                        for report in reports:
                            print(f"{label}: {'FAIL' if report['error'] else 'PASS'} {report['name']}"
                                  + (f": {report['error']}" if report["error"] else ""))
                        assert len(reports) == 15 and not any(report["error"] for report in reports) and not errors, errors
                        check_native_drafts(page, origin, label)
                        check_native_transitions(page, origin, label)
                        check_diagnostic_rows(page, origin, label)
                        check_accessibility_smoke(page, origin, label)
                        check_partial_diagnostics(page, origin, label)
                        check_msc_handoff(page, origin, label)
                        check_identity_details(browser, page, origin, label)
                        check_dirty_navigation(page, origin, label)
                        check_status_error_survives_local_edit(page, origin, label)
                        check_wireless_readiness_guidance(page, origin, label)
                        check_active_wifi_progress(page, origin, label)
                        check_hidden_display_and_responsive_confirmation(page, origin, label)
                        check_live_region_updates_are_stable(page, origin, label)
                        check_shell_link_focus_survives_poll(page, origin, label)
                        check_recovery_presentation(page, origin, label)
                        console = page.request.get(f"{origin}/console")
                        assert console.status == 200
                        assert "<h1>Wi-Fi shell</h1>" in console.text()
                        check_console_brand_keyboard_focus(page, origin, label)
                        assert not errors, errors
            finally:
                browser.close()


if __name__ == "__main__":
    main()
