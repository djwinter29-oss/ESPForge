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
                finally:
                    browser.close()
        finally:
            server.shutdown()
            thread.join()


if __name__ == "__main__":
    main()
