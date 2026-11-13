// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";

test("standalone dashboard labels profiles, active measurements, controls and accessible statuses", () => {
  const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  assert.match(html, /<title>ESPForge Dashboard \| Direct<\/title>/);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /rel="icon"[^>]*href="favicon\.svg"/);
  assert.match(html, /src="js\/app\.mjs"/);
  assert.doesNotMatch(html, /id="connection-control"|id="connection-transport"/);
  for (const name of ["usb", "bluetooth"]) {
    assert.match(html, new RegExp(`id="${name}-open"[\\s\\S]*?aria-haspopup="dialog"`));
    assert.match(html, new RegExp(`<dialog[^>]*id="${name}-connection-dialog"[\\s\\S]*?aria-labelledby=`));
    assert.match(html, new RegExp(`id="${name}-connection-status" role="status" aria-live="polite"`));
  }
  assert.doesNotMatch(html, /settings-tcp-auth|ble-view-only|ble-authorize|bluetooth-access-step/);
  assert.match(html, /id="direct-ble-control-key"[^>]*type="password"/);
  assert.doesNotMatch(html, /settings-storage|High-Speed|tcp-cli|TCP CLI/, "ESPForge has one SD profile and no TCP CLI");
  assert.match(html, /id="settings-save"[^>]*>Save&amp;Reboot/);
  assert.match(html, /id="settings-reboot"[^>]*>Reboot/);
  for (const path of ["../../web/index.html"]) {
    const dashboard = readFileSync(new URL(path, import.meta.url), "utf8");
    const settings = dashboard.split('aria-labelledby="settings-title"')[1].split("</section>")[0];
    const footer = dashboard.split('<footer class="status-line"')[1].split("</footer>")[0];
    assert.doesNotMatch(settings, /id="settings-note"/);
    assert.doesNotMatch(settings, /wireless-actions|wifi-open|ble-open/);
    assert.match(settings, /id="direct-settings-wifi"[\s\S]*?<option value="configure">Configure…<\/option>/);
    assert.match(settings, /id="direct-settings-ble"[\s\S]*?<option value="configure">Configure…<\/option>/);
    const board = settings.split('<div class="settings-controls">')[1].split("</div>")[0];
    assert.deepEqual([...board.matchAll(/<label for="([^"]+)"/g)].map(match => match[1]),
      ["settings-clock", "direct-settings-wifi", "direct-settings-ble"]);
    assert.match(board, /<label for="direct-settings-wifi" hidden>[\s\S]*<label for="direct-settings-ble" hidden>/);
    assert.doesNotMatch(board, /type="checkbox"/);
    assert.doesNotMatch(settings, /id="direct-wifi-ssid"|id="direct-wifi-password"|id="direct-ble-secret"/);
    assert.match(dashboard, /<dialog[^>]*id="direct-wifi-dialog"/);
    assert.match(dashboard, /<dialog[^>]*id="direct-ble-dialog"/);
    assert.doesNotMatch(dashboard, /id="wireless-save"/);
    assert.match(dashboard, /id="direct-configuration-wireless-warning" hidden/);
    assert.match(footer, /role="status" aria-live="polite"/);
    assert.match(footer, /id="status-message"[\s\S]*id="settings-note"/);
    assert.equal([...dashboard.matchAll(/id="settings-note"/g)].length, 1);
    assert.doesNotMatch(dashboard, /self-test|console/);
    assert.match(dashboard, /id="led-colour"/);
    assert.match(dashboard, /id="benchmark-start"/);
    assert.match(dashboard, /id="benchmark-cancel"/);
    assert.match(dashboard, /id="msc-controls"/);
  }
  assert.doesNotMatch(html, /25 MHz|50 MHz|Core 1 \/ Core 2|PicoForge|RP2350/);
  assert.match(html, /Internal SRAM reserved \/ total/);
  assert.match(html, /External PSRAM reserved \/ total/);
  assert.match(html, /Module SPI flash capacity/);
  assert.match(html, /Service load \(Core 0 \/ Core 1\)/);
  assert.match(html, /<dt>Filesystem<\/dt>/);
  assert.doesNotMatch(html, /class="eyebrow"|id="mcu"|id="memory-timing"|id="board-config"/);
  assert.doesNotMatch(html, /metric-product/);
  assert.match(html, /id="settings-title">Board configuration/);
  const identity = html.split('aria-label="Hardware identity"')[1].split("</section>")[0];
  assert.deepEqual([...identity.matchAll(/<strong id="([^"]+)"/g)].map(match => match[1]),
    ["product-name", "board-model", "serial", "identity-clock", "firmware-version"]);
  const runtime = html.split('<dl class="runtime-grid runtime-summary">')[1].split("</dl>")[0];
  assert.deepEqual([...runtime.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]),
    ["Uptime", "Reset cause", "Service load (Core 0 / Core 1)", "Board temperature", "Storage bus speed",
      "Wi-Fi", "Bluetooth"]);
  const storage = html.split('aria-labelledby="memory-title"')[1].split("</section>")[0];
  assert.deepEqual([...storage.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]),
    ["Memory state", "Capacity", "Filesystem", "Manufacturer", "Product", "Serial",
      "Benchmark state", "Write throughput", "Read/verify throughput", "Result"]);
  assert.doesNotMatch(html, /id="memory-mode"/);
  assert.match(html, /<details class="pin-map-disclosure">/);
  assert.match(html, /id="board-uart"[\s\S]*id="board-storage-pins"/);
  assert.deepEqual([...html.matchAll(/<dialog class="confirmation-dialog" id="([^"]+)-dialog"/g)].map(match => match[1]),
    ["msc", "configuration", "reboot", "usb-connection"]);
  for (const name of ["telemetry", "storage"]) {
    assert.match(html, new RegExp(`id="${name}-freshness" role="status"`));
  }
});

test("page assets and local modules use stable same-origin URLs without hand-maintained cache versions", () => {
  const read = path => readFileSync(new URL(`../../web/${path}`, import.meta.url), "utf8");
  const sources = ["index.html",
    ...readdirSync(new URL("../../web/js/", import.meta.url), { recursive: true })
      .filter(name => name.endsWith(".mjs")).map(name => `js/${name}`)];
  for (const path of sources) {
    const text = read(path);
    assert.doesNotMatch(text, /\?v=\d+/, `${path} must not require a synchronized query version`);
    for (const [specifier] of text.matchAll(/(?:from |import\()"\.\/[^"]+"/g)) {
      assert.doesNotMatch(specifier, /\?v=/, `${path}: ${specifier} must use a stable local URL`);
    }
  }
});
