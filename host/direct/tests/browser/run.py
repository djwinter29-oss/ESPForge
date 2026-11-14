# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026 Ji Dong

"""Run the Direct-only browser checks against an ephemeral loopback static server."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import Browser, expect, sync_playwright


def check_history(browser: Browser, origin: str) -> None:
    """Navigate a real cached page; require reload without resuming drafts or the board connection."""
    with browser.new_context() as context:
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
            sessionStorage.setItem('espforge.direct.pending-operation', JSON.stringify({
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
            const record = JSON.parse(sessionStorage.getItem('espforge.direct.pending-operation'));
            return record?.uid === '0102030405060708' && record.version === 2
                && record.request.transaction_id === 1 && record.request.opcode === 2;
        }""")
        if not retained:
            raise AssertionError("History restoration lost the recovery journal")
        print("PASS index history-cache restoration reloads without replay")


def check_version_label(browser: Browser, origin: str) -> None:
    """Long development versions must remain readable without horizontal page overflow."""
    with browser.new_context() as context:
        page = context.new_page()
        page.goto(f"{origin}/web/index.html")
        label = page.get_by_label("Host application version")
        label.evaluate("(element) => element.textContent = '1.2.4-dev.123+g0123456789ab.dirty'")
        for width in (1440, 720, 320):
            page.set_viewport_size({"width": width, "height": 900})
            if not page.evaluate("document.documentElement.scrollWidth <= innerWidth"):
                raise AssertionError(f"Development version overflows the page at {width}px")
        print("PASS long Direct development versions fit desktop, tablet and mobile widths")


def check_identity_details(browser: Browser, origin: str) -> None:
    """Verify aligned identity values and both disclosures with native mouse, keyboard and touch events."""
    with browser.new_context() as context:
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
    with browser.new_context(has_touch=True, viewport={"width": 320, "height": 800}) as context:
        page = context.new_page()
        page.goto(f"{origin}/web/index.html")
        for identity in ("product-information", "module-memory"):
            page.locator(f"#{identity} > summary").tap()
            expect(page.locator(f"#{identity} .identity-popover")).to_be_visible()
            page.locator(f"#{identity} > summary").tap()
            expect(page.locator(f"#{identity} .identity-popover")).to_be_hidden()
    print("PASS aligned identity and product/memory hover, keyboard, touch and responsive details")


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
                    page = browser.new_page()
                    errors: list[str] = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    origin = f"http://127.0.0.1:{server.server_port}"
                    page.goto(f"{origin}/tests/browser/index.html")
                    page.wait_for_function("document.querySelector('#results').dataset.complete === 'true'")
                    results = page.locator("#results li").all_text_contents()
                    print("\n".join(results))
                    print(f"Dashboard telemetry burst: "
                          f"{page.locator('#results').get_attribute('data-dashboard-median-ms')}ms median, "
                          f"{page.locator('#results').get_attribute('data-dashboard-p95-ms')}ms p95")
                    failures = page.locator('#results li[data-result="fail"]').count()
                    if len(results) != 8 or failures or errors:
                        raise AssertionError(f"Expected 8 checks, got {len(results)}; "
                                             f"failed assertions: {failures}; page errors: {errors}")
                    check_history(browser, origin)
                    check_version_label(browser, origin)
                    check_identity_details(browser, origin)
                finally:
                    browser.close()
        finally:
            server.shutdown()
            thread.join()


if __name__ == "__main__":
    main()
