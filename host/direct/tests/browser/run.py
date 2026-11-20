# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Run the Direct-only browser checks against an ephemeral loopback static server."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from math import ceil
from pathlib import Path
from statistics import median
from threading import Thread

from playwright.sync_api import Browser, BrowserContext, Request, Response, expect, sync_playwright

_ASSET_TYPES = frozenset({"script", "stylesheet", "font", "image"})


def monitored_context(browser: Browser, errors: list[str], **options) -> BrowserContext:
    """Collect uncaught page errors and failed runtime assets from every page in a test context."""
    context = browser.new_context(**options)
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))

    def failed_response(response: Response) -> None:
        if response.request.resource_type in _ASSET_TYPES and response.status >= 400:
            errors.append(f"Browser asset failed ({response.status}): {response.url}")

    def failed_request(request: Request) -> None:
        if request.resource_type in _ASSET_TYPES:
            errors.append(f"Browser asset request failed ({request.failure}): {request.url}")

    context.on("response", failed_response)
    context.on("requestfailed", failed_request)
    return context


def check_accessibility(browser: Browser, origin: str, errors: list[str]) -> None:
    """Run pinned axe-core rules on both pages in light and dark modes."""
    dialogs = (None, "usb-connection-dialog", "bluetooth-connection-dialog", "msc-dialog",
               "benchmark-start-dialog", "configuration-dialog", "reboot-dialog", "direct-wifi-dialog",
               "direct-ble-dialog", "recovery-abandon-dialog", "disconnect-dialog")
    for scheme in ("light", "dark"):
        with monitored_context(browser, errors, color_scheme=scheme) as context:
            page = context.new_page()
            page.goto(f"{origin}/web/index.html")
            scheme_used = page.evaluate("getComputedStyle(document.documentElement).colorScheme")
            if scheme_used != scheme:
                raise AssertionError(f"Expected {scheme} color scheme, got {scheme_used}")
            page.add_script_tag(url=f"{origin}/tests/browser/vendor/axe.min.js")
            page.evaluate("() => document.fonts.ready")
            for dialog_id in dialogs:
                if dialog_id:
                    page.evaluate("(id) => document.querySelector(`#${id}`).showModal()", dialog_id)
                audit = audit_accessibility(page)
                if audit:
                    raise AssertionError(f"axe-core violations in {scheme} mode for "
                                         f"{dialog_id or 'dashboard'}: {audit}")
                if dialog_id:
                    page.evaluate("(id) => document.querySelector(`#${id}`).close()", dialog_id)
            page.goto(f"{origin}/web/console.html")
            page.add_script_tag(url=f"{origin}/tests/browser/vendor/axe.min.js")
            audit = audit_accessibility(page)
            if audit:
                raise AssertionError(f"axe-core violations in {scheme} mode for console page: {audit}")
    print("PASS axe-core WCAG 2.1 A/AA and best-practice checks for both pages and all dialogs in light/dark modes")


def audit_accessibility(page):
    """Run the pinned WCAG 2.1 A/AA and best-practice axe rules."""
    return page.evaluate("""async () => {
        const result = await axe.run(document, {runOnly: {
            type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']
        }});
        return result.violations.map(({ id, impact, description, nodes }) => ({
            id, impact, description, targets: nodes.map(node => node.target)
        }));
    }""")


def check_forced_colors(browser: Browser, origin: str, errors: list[str]) -> None:
    """Ensure forced-colors mode retains visible keyboard focus."""
    with monitored_context(browser, errors) as context:
        page = context.new_page()
        page.goto(f"{origin}/web/index.html")
        page.emulate_media(forced_colors="active")
        if not page.evaluate("matchMedia('(forced-colors: active)').matches"):
            raise AssertionError("Chromium did not enable forced-colors mode")
        page.locator("#usb-open").focus()
        focus = page.locator("#usb-open").evaluate("""node => {
            const style = getComputedStyle(node);
            return {outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth)};
        }""")
        if focus["outlineStyle"] != "solid" or focus["outlineWidth"] < 2:
            raise AssertionError(f"Forced-colors focus indicator is not visible: {focus}")
        page.locator(".pin-map-disclosure > summary").focus()
        focus = page.locator(".pin-map-disclosure > summary").evaluate("""node => {
            const style = getComputedStyle(node);
            return {outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth)};
        }""")
        if focus["outlineStyle"] != "solid" or focus["outlineWidth"] < 2:
            raise AssertionError(f"Forced-colors pin-map focus indicator is not visible: {focus}")
    print("PASS forced-colors mode retains a visible keyboard focus outline")

def check_focus_contrast(browser: Browser, origin: str, errors: list[str]) -> None:
    """Keep regular keyboard-focus indicators above the 3:1 non-text contrast minimum."""
    for scheme in ("light", "dark"):
        with monitored_context(browser, errors, color_scheme=scheme) as context:
            page = context.new_page()
            page.goto(f"{origin}/web/index.html")
            report = page.evaluate("""() => {
                const root = getComputedStyle(document.documentElement);
                const rules = [];
                const visit = list => [...list].forEach(rule => {
                    if (rule.selectorText) rules.push(rule);
                    if (rule.cssRules) visit(rule.cssRules);
                });
                [...document.styleSheets].forEach(sheet => visit(sheet.cssRules));
                const rgb = value => {
                    const hex = value.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
                    return hex ? [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16))
                        : value.match(/\\d+/g).slice(0, 3).map(Number);
                };
                const luminance = value => {
                    const [r, g, b] = rgb(value).map(channel => {
                        const scaled = channel / 255;
                        return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
                    });
                    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
                };
                const ratio = (a, b) => {
                    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
                    return (high + 0.05) / (low + 0.05);
                };
                const targets = [
                    ['.brand:focus-visible', '--lime', '--teal-dark'],
                    ['.button:focus-visible', '--focus', '--canvas'],
                    ['.topbar .button:focus-visible', '--lime', '--teal-dark'],
                    ['.identity-details > summary:focus-visible', '--focus', '--paper'],
                    ['.pin-map-disclosure > summary:focus-visible', '--focus', '--paper'],
                    ['.wireless-dialog input:focus-visible', '--focus', '--paper'],
                    ['.settings-controls select:focus-visible', '--focus', '--paper'],
                    ['.wifi-network:focus-visible', '--teal', '--paper'],
                ].map(([selector, foreground, background]) => {
                    const find = value => rules.find(item => item.selectorText.split(',')
                        .some(part => part.trim() === value));
                    const rule = find(selector);
                    const declaration = rule?.style;
                    const outline = selector === '.topbar .button:focus-visible'
                        ? find('.button:focus-visible')?.style.getPropertyValue('outline') : declaration?.outline;
                    const color = declaration?.getPropertyValue('outline-color')
                        || outline.match(/var\\([^)]+\\)/)?.[0] || '';
                    const width = parseFloat(outline);
                    const style = outline.split(' ').find(part => part === 'solid' || part === 'dashed') || '';
                    return {selector, color, expectedColor: `var(${foreground})`, width,
                        style,
                        ratio: ratio(root.getPropertyValue(foreground), root.getPropertyValue(background))};
                });
                return targets;
            }""")
            for target in report:
                if (target["color"] != target["expectedColor"] or target["style"] != "solid"
                        or target["width"] < 2 or target["ratio"] < 3):
                    raise AssertionError(f"Focus indicator fails on {target['selector']} in {scheme} mode: {report}")
    print("PASS keyboard focus indicator contrast is at least 3:1 in light and dark modes")


def check_history(browser: Browser, origin: str, errors: list[str]) -> None:
    """Navigate a real cached page; require reload without resuming drafts or the board connection."""
    with monitored_context(browser, errors) as context:
        page = context.new_page()
        page.add_init_script("""
            // Registering WebHID listeners makes Chromium pages ineligible for its history cache.
            Object.defineProperty(navigator, 'hid', {configurable: true, value: undefined});
            if (location.pathname.endsWith('/index.html')) {
                sessionStorage.setItem('test-history-loads',
                    String(Number(sessionStorage.getItem('test-history-loads') || 0) + 1));
                addEventListener('pageshow', event => {
                    if (event.persisted) sessionStorage.setItem('test-history-restored', 'yes');
                });
            }
        """)
        page.goto(f"{origin}/web/index.html")
        page.wait_for_selector("#settings-clock")
        page.evaluate("""() => {
            sessionStorage.setItem('zephyrforge.direct.pending-operation', JSON.stringify({
                version: 2, kind: 'control', uid: '0102030405060708',
                request: {transaction_id: 1, opcode: 2}
            }));
            document.querySelector('#direct-ble-control-key').value = 'old draft';
        }""")
        page.goto(f"{origin}/")
        page.go_back()
        expect(page.locator("#direct-ble-control-key")).to_have_value("")
        if page.locator("#connection").get_attribute("data-state") == "connected":
            raise AssertionError("History restoration resumed the board connection")
        restored = page.evaluate("""() => sessionStorage.getItem('test-history-restored') === 'yes'
            && Number(sessionStorage.getItem('test-history-loads')) >= 2""")
        if not restored:
            reasons = page.evaluate("() => performance.getEntriesByType('navigation')[0]?.notRestoredReasons")
            raise AssertionError(f"Navigation did not exercise history-cache restoration followed by reload: "
                                 f"{reasons}")
        retained = page.evaluate("""() => {
            const record = JSON.parse(sessionStorage.getItem('zephyrforge.direct.pending-operation'));
            return record?.uid === '0102030405060708' && record.version === 2
                && record.request.transaction_id === 1 && record.request.opcode === 2;
        }""")
        if not retained:
            raise AssertionError("History restoration lost the recovery journal")
        print("PASS index history-cache restoration reloads without replay")


def check_version_label(browser: Browser, origin: str, errors: list[str]) -> None:
    """Long development versions must remain readable without horizontal page overflow."""
    with monitored_context(browser, errors) as context:
        page = context.new_page()
        page.goto(f"{origin}/web/index.html")
        label = page.get_by_label("Host application version")
        label.evaluate("(element) => element.textContent = '1.2.4-dev.123+g0123456789ab.dirty'")
        for width in (1440, 720, 320):
            page.set_viewport_size({"width": width, "height": 900})
            if not page.evaluate("document.documentElement.scrollWidth <= innerWidth"):
                raise AssertionError(f"Development version overflows the page at {width}px")
        print("PASS long Direct development versions fit desktop, tablet and mobile widths")


def check_identity_details(browser: Browser, origin: str, errors: list[str]) -> None:
    """Verify aligned identity values and both disclosures with native mouse, keyboard and touch events."""
    with monitored_context(browser, errors) as context:
        page = context.new_page()
        page.goto(f"{origin}/web/index.html")
        assert page.locator(".identity > .metric").count() == 5
        tops = page.locator(".identity strong").evaluate_all(
            "(nodes) => nodes.map(node => node.getBoundingClientRect().top)")
        assert max(tops) - min(tops) <= 1, tops
        for identity in ("product-information", "module-memory"):
            page.set_viewport_size({"width": 1440, "height": 900})
            summary = page.locator(f"#{identity} > summary")
            details = page.locator(f"#{identity} .identity-popover")
            expect(details).to_be_hidden()
            summary.hover()
            expect(details).to_be_visible()
            if identity == "product-information":
                expect(page.locator("#board-model")).to_be_visible()
                expect(page.locator("#board-mcu")).to_be_visible()
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
    with monitored_context(browser, errors, has_touch=True, viewport={"width": 320, "height": 800}) as context:
        page = context.new_page()
        page.goto(f"{origin}/web/index.html")
        for identity in ("product-information", "module-memory"):
            page.locator(f"#{identity} > summary").tap()
            expect(page.locator(f"#{identity} .identity-popover")).to_be_visible()
            page.locator(f"#{identity} > summary").tap()
            expect(page.locator(f"#{identity} .identity-popover")).to_be_hidden()
    print("PASS aligned identity and product/memory hover, keyboard, touch and responsive details")


def check_wifi_layout(browser: Browser, origin: str, errors: list[str]) -> None:
    """Check Wi-Fi status, network selection and responsive styling with injected read-only test data."""
    with monitored_context(browser, errors) as context:
        page = context.new_page()
        page.route("**/js/app.mjs", lambda route: route.fulfill(content_type="text/javascript", body="""
            import { bindWirelessForm } from "./ui/sections/wireless-form/wireless-form.mjs";
            import { renderWirelessStatus } from "./ui/sections/wireless.mjs";
            const wireless = {ssid: "Home", ssid_hex: "486f6d65", wifi_enabled: true,
                wifi_state: "connected", ipv4: "192.168.1.9", ble_enabled: false};
            const form = bindWirelessForm({
                supported: () => true, ready: () => true,
                scan: async () => [
                    {ssid: "0123456789ABCDEF0123456789ABCDEF",
                        ssid_hex: "3031323334353637383941424344454630313233343536373839414243444546",
                        secured: true, security: "RSN (WPA2/WPA3)", rssi: -40},
                    {ssid: "Open", ssid_hex: "4f70656e", secured: false, rssi: -60},
                ],
                test: async () => { throw new Error("Layout checks must not test a real network"); },
                cancelTest: async () => {},
            });
            form.update({wireless});
            renderWirelessStatus({connected: true, hardware: {capabilities: 128}, wireless});
            window.wifiLayoutForm = form;
        """))
        page.goto(f"{origin}/web/index.html")
        expect(page.locator("#direct-wifi-state")).to_have_text("Home (192.168.1.9)")
        wifi = page.locator("#direct-settings-wifi")
        expect(wifi).to_be_visible()
        expect(wifi).to_have_value("1")
        wifi.select_option("configure")
        dialog = page.locator("#direct-wifi-dialog")
        expect(dialog).to_be_visible()
        page.locator("#direct-wifi-scan").click()
        networks = page.locator("#direct-wifi-networks button")
        expect(networks).to_have_count(2)
        networks.first.click()
        expect(networks.first).to_have_attribute("aria-pressed", "true")
        networks.nth(1).hover()
        assert networks.evaluate_all("""nodes => getComputedStyle(nodes[0]).backgroundColor
            === getComputedStyle(nodes[1]).backgroundColor""")
        password = page.locator("#direct-wifi-password")
        expect(password).to_be_visible()
        password.focus()
        assert password.evaluate("""node => {
            const style = getComputedStyle(node);
            return style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 3;
        }""")
        for width in (1440, 720, 320):
            page.set_viewport_size({"width": width, "height": 900})
            assert dialog.evaluate("(node) => node.scrollWidth <= node.clientWidth"), width
            assert page.locator("#direct-wifi-networks").evaluate(
                "(node) => node.scrollWidth <= node.clientWidth"), width
            assert networks.first.evaluate("(node) => node.scrollWidth <= node.clientWidth"), width
            assert dialog.evaluate("""node => [...node.querySelectorAll('.dialog-actions button')].every(button => {
                const bounds = button.getBoundingClientRect();
                const dialog = node.getBoundingClientRect();
                return bounds.left >= dialog.left && bounds.right <= dialog.right;
            })"""), width
        networks.nth(1).click()
        expect(password).to_be_hidden()
        page.locator("#direct-wifi-other").click()
        expect(page.locator("#direct-wifi-ssid")).to_be_visible()
        expect(password).to_be_visible()
        page.locator("#direct-wifi-cancel").click()
        expect(dialog).to_be_hidden()
        page.evaluate("""() => window.wifiLayoutForm.update(null, {wireless: false, settings: false})""")
        expect(wifi).to_be_disabled()
        assert wifi.locator('option[value="configure"]').is_disabled()
        page.evaluate("() => window.wifiLayoutForm.dispose()")
    print("PASS Wi-Fi controls, live status, secured/open selection and responsive dialog layout")


def check_module_loading(browser: Browser, origin: str, errors: list[str]) -> None:
    """Measure cold runtime-module loading and keep request count/transfer size within a reviewed budget."""
    samples = []
    for _ in range(5):
        with monitored_context(browser, errors) as context:
            page = context.new_page()
            page.goto(f"{origin}/web/index.html", wait_until="load")
            sample = page.evaluate("""() => {
                const navigation = performance.getEntriesByType('navigation')[0];
                const modules = performance.getEntriesByType('resource')
                    .filter(entry => new URL(entry.name).pathname.endsWith('.mjs'));
                return {
                    count: modules.length,
                    bytes: modules.reduce((total, entry) =>
                        total + (entry.transferSize || entry.encodedBodySize), 0),
                    duration: Math.max(...modules.map(entry => entry.responseEnd)) - navigation.startTime,
                    load: navigation.loadEventEnd - navigation.startTime,
                };
            }""")
            samples.append(sample)
    if any(sample["count"] < 1 or sample["count"] > 45 or sample["bytes"] > 300_000 for sample in samples):
        raise AssertionError(f"Cold module graph exceeds its 45-request/300 kB budget: {samples}")
    durations = sorted(sample["duration"] for sample in samples)
    p95 = durations[ceil(0.95 * len(durations)) - 1]
    print(f"PASS cold module graph budget: {samples[0]['count']} modules, "
          f"{max(sample['bytes'] for sample in samples)} bytes; "
          f"median {median(durations):.1f}ms, p95 {p95:.1f}ms, "
          f"load median {median(sample['load'] for sample in samples):.1f}ms")


def main() -> None:
    """Fail on browser errors, incomplete checks, or any reported assertion failure."""
    root = Path(__file__).resolve().parents[2]
    with ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(root))) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chromium",
                                                     ignore_default_args=["--disable-back-forward-cache"])
                try:
                    errors: list[str] = []
                    with monitored_context(browser, errors) as context:
                        page = context.new_page()
                        origin = f"http://127.0.0.1:{server.server_port}"
                        page.goto(f"{origin}/tests/browser/index.html")
                        page.wait_for_function("document.querySelector('#results').dataset.complete === 'true'")
                        results = page.locator("#results li").all_text_contents()
                        print("\n".join(results))
                        print(f"Dashboard telemetry burst: "
                              f"{page.locator('#results').get_attribute('data-dashboard-median-ms')}ms median, "
                              f"{page.locator('#results').get_attribute('data-dashboard-p95-ms')}ms p95")
                        failures = page.locator('#results li[data-result="fail"]').count()
                        if len(results) != 8 or failures:
                            raise AssertionError(f"Expected 8 checks, got {len(results)}; "
                                                 f"failed assertions: {failures}")
                    check_module_loading(browser, origin, errors)
                    check_history(browser, origin, errors)
                    check_version_label(browser, origin, errors)
                    check_identity_details(browser, origin, errors)
                    check_wifi_layout(browser, origin, errors)
                    check_accessibility(browser, origin, errors)
                    check_focus_contrast(browser, origin, errors)
                    check_forced_colors(browser, origin, errors)
                    if errors:
                        raise AssertionError(f"Browser page errors: {errors}")
                finally:
                    browser.close()
        finally:
            server.shutdown()
            thread.join()


if __name__ == "__main__":
    main()
