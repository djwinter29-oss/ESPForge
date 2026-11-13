// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("server dashboard keeps radio dialogs and confirmation controls without dropped features", () => {
  for (const path of ["../src/index.html"]) {
    const dashboard = readFileSync(new URL(path, import.meta.url), "utf8");
    const settings = dashboard.split('aria-labelledby="settings-title"')[1].split("</section>")[0];
    const footer = dashboard.split('<footer class="status-line"')[1].split("</footer>")[0];
    assert.doesNotMatch(settings, /id="settings-note"/);
    assert.doesNotMatch(settings, /wireless-actions|wifi-open|ble-open/);
    assert.doesNotMatch(settings, /id="(?:wifi|ble)-configure"/);
    for (const radio of ["wifi", "ble"])
      assert.match(settings, new RegExp(`id="settings-${radio}"[^>]*>[\\s\\S]*?value="configure"[^>]*>Configure…`));
    const board = settings.split('<div class="settings-controls">')[1].split('<p id="wireless-summary"')[0];
    assert.deepEqual([...board.matchAll(/<label for="([^"]+)"/g)].map(match => match[1]),
      ["settings-clock", "settings-wifi", "settings-ble"]);
    assert.match(board, /id="wifi-settings" hidden>[\s\S]*id="ble-settings" hidden>/);
    assert.doesNotMatch(board, /settings-storage|settings-tcp-cli|High-Speed/);
    assert.doesNotMatch(board, /type="checkbox"/);
    assert.doesNotMatch(settings, /id="wifi-ssid"|id="wifi-password"|id="ble-secret"/);
    assert.match(settings, /id="wireless-discard"[^>]*hidden disabled/);
    assert.match(dashboard, /<dialog[^>]*id="wifi-dialog"/);
    assert.match(dashboard, /id="wifi-resync"[^>]*hidden>Re-sync<\/button>/);
    assert.match(dashboard, /<dialog[^>]*id="ble-dialog"/);
    assert.match(dashboard, /id="wifi-networks"[^>]*role="group"/);
    assert.doesNotMatch(dashboard, /role="listbox"|role="option"/);
    assert.doesNotMatch(dashboard, /id="wireless-save"/);
    assert.match(dashboard, /id="configuration-wireless-warning" hidden/);
    assert.match(footer, /role="status" aria-live="polite"/);
    assert.match(footer, /id="status-message"[\s\S]*id="settings-note"/);
    assert.equal([...dashboard.matchAll(/id="settings-note"/g)].length, 1);
    assert.doesNotMatch(dashboard,
      /id="(self-test[^"]*|led-control|share-dialog|return-dialog|configuration-force-warning|cdc-state)"/);
    assert.doesNotMatch(dashboard, /\/console|Start benchmark|Board LED/);
    assert.match(dashboard, /id="msc-enable"/);
    assert.match(dashboard, /id="msc-return"/);
  }
});
