// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderStatus } from "../../src/js/dashboard.mjs";
import { appFixture } from "../support/app-fixture.mjs";

test("server dashboard presents expected USB reconnection without hiding real errors", () => {
  const saved = globalThis.document;
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      dataset: {}, valueAsNumber: 32, setAttribute() {}, replaceChildren() {},
    });
    return elements.get(selector);
  };
  globalThis.document = { querySelector: element, createElement: () => ({ append() {} }) };
  try {
    renderStatus({ connected: false, reconnecting: true });
    assert.equal(element("#connection-label").textContent, "Reconnecting");
    assert.equal(element("#status-message").textContent, "Reconnecting...");
    assert.equal(element(".status-line").dataset.error, "false");
    assert.equal(element("#settings-note").textContent, "Waiting for an ESPForge connection.");
    assert.equal(element("#status-message").hidden, true);
    renderStatus({ connected: false, reconnecting: true, error: "read error" });
    assert.equal(element("#connection-label").textContent, "Attention");
    assert.equal(element("#status-message").textContent, "read error");
    assert.equal(element(".status-line").dataset.error, "true");
    assert.equal(element("#status-message").hidden, false);
    const stale = { connected: true, settings_supported: true, storage_stale: true, hardware: { capabilities: 128 | 4 },
      wireless: { ssid: "saved", wifi_enabled: true, ble_enabled: false,
        ble_key_configured: false, tcp_cli_enabled: false },
      settings: { system_clock_mhz: 240, sdcard_profile: 0, radios: 1 },
      wireless_dirty: true, wireless_stage_valid: true, msc: { enabled: false, transition_pending: false } };
    renderStatus(stale);
    assert.equal(element("#settings-save").disabled, true);
    assert.equal(element("#settings-note").textContent, "Waiting for fresh storage status.");
    assert.equal(element("#settings-save").title, element("#settings-note").textContent);
    renderStatus({ ...stale, storage_stale: false });
    assert.equal(element("#settings-save").disabled, false);
    assert.equal(element("#settings-save").title, "");
  } finally {
    globalThis.document = saved;
  }
});

test("startup polling and drafts recover after status and scan failures", async context => {
  const { state, handlers, elements, requestedUrls } = await appFixture(context);
  assert.equal(typeof handlers.get("#reboot-control:click"), "function");
  assert.equal(typeof state.tick, "function", "startup must register status polling");
  assert.equal(elements.get("#connection-label").textContent, "Connected",
    elements.get("#status-message").textContent);
  assert.equal(elements.get("#settings-note").textContent, "");
  assert.equal(elements.get("#settings-note").hidden, true);
  const statusRequests = () => requestedUrls.filter(url => url.startsWith("/api/status?")).length;
  const visibleStatusRequests = statusRequests();
  globalThis.document.hidden = true;
  state.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(statusRequests(), visibleStatusRequests, "background tabs pause status polling");
  globalThis.document.hidden = false;
  handlers.get("document:visibilitychange")();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(statusRequests(), visibleStatusRequests + 1, "returning to the tab refreshes status immediately");
  elements.get("#settings-clock").value = "80";
  handlers.get("#settings-clock:change")();
  state.statusFails = true;
  await state.tick();
  assert.equal(elements.get("#settings-clock").value, "80", "a transient status error preserves settings drafts");
  assert.equal(elements.get("#settings-clock").disabled, true, "commands stay disabled while status is stale");
  assert.match(elements.get("#status-message").textContent, /Status unavailable/);
  state.statusFails = false;
  await state.tick();
  assert.equal(elements.get("#settings-clock").value, "80");
  const scansBefore = requestedUrls.filter(url => url === "/api/boards").length;
  state.statusUnknownBoard = true;
  await state.tick();
  await state.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requestedUrls.filter(url => url === "/api/boards").length, scansBefore + 1,
    "a restarted server's unknown-board reply triggers one rate-limited rescan");
  state.statusUnknownBoard = false;
  await state.tick();
  assert.equal(elements.get("#board-select").value, "board-a", "the rescan keeps the selected board");
  elements.get("#settings-clock").value = "160";
  handlers.get("#settings-clock:change")();
  state.boardScanFails = true;
  await handlers.get("#rescan-boards:click")();
  assert.equal(elements.get("#settings-clock").value, "160",
    "a failed rescan preserves the selected board and drafts");
  assert.match(elements.get("#status-message").textContent, /Board scan failed/);
  state.boardScanFails = false;
  await state.tick();
});

test("board identity warnings stay visible across status polls and clear on a clean rescan", async context => {
  const { state, handlers, elements } = await appFixture(context);
  state.boardWarnings = ["Duplicate ESPForge board identity; disconnect boards with duplicate serials"];
  await handlers.get("#rescan-boards:click")();
  assert.match(elements.get("#status-message").textContent, /Duplicate ESPForge/);
  await state.tick();
  assert.match(elements.get("#status-message").textContent, /Duplicate ESPForge/);
  state.boardWarnings = [];
  await handlers.get("#rescan-boards:click")();
  assert.doesNotMatch(elements.get("#status-message").textContent, /Duplicate ESPForge/);
});

test("settings presentation waits for fresh storage status", async context => {
  const { connected, elements } = await appFixture(context);
  for (const storageState of [{ storage_stale: true }, { msc: null }]) {
    renderStatus({ ...connected, ...storageState });
    assert.equal(elements.get("#settings-note").textContent, "Waiting for fresh storage status.");
    assert.equal(elements.get("#settings-note").hidden, false);
    for (const selector of ["#settings-clock", "#settings-save", "#reboot-control"]) {
      assert.equal(elements.get(selector).disabled, true);
    }
    renderStatus({ ...connected, ...storageState, settings_dirty: true });
    assert.equal(elements.get("#settings-save").disabled, true);
    assert.equal(elements.get("#settings-note").textContent, "Waiting for fresh storage status.");
    renderStatus({ ...connected, ...storageState, settings_message: "Save failed: device busy" });
    assert.equal(elements.get("#settings-note").textContent, "Save failed: device busy");
    assert.equal(elements.get("#settings-note").hidden, false);
  }
  renderStatus(connected);
  assert.equal(elements.get("#product-name").textContent, "ESPForge (SDMMC)");
  assert.equal(elements.get("#settings-clock").disabled, false);
  assert.equal(Boolean(elements.get("#reboot-control").disabled), false);
  renderStatus({ ...connected, hardware: { ...connected.hardware, capabilities: 4 | 16 } });
  assert.equal(elements.get("#reboot-control").disabled, true, "reboot requires capability bit 1");
  renderStatus({ ...connected, hardware: { ...connected.hardware, capabilities: 2 | 16 }, settings_dirty: true });
  assert.equal(elements.get("#settings-save").disabled, true, "saving requires capability bit 2");
  assert.equal(elements.get("#settings-save").title, "Firmware does not support saving boot settings.");
  renderStatus({ ...connected, settings_dirty: true });
  assert.equal(elements.get("#settings-save").disabled, false);
  assert.equal(elements.get("#settings-note").textContent, "");
  assert.equal(elements.get("#settings-note").hidden, true);
});

test("ESP32-S3 clock choices are fixed and storage stays on the Standard profile", async context => {
  const { connected, elements, saveAndConfirm, savedSettings, state } = await appFixture(context);
  assert.deepEqual(elements.get("#settings-clock").children.map(option => [option.value, option.textContent]),
    [["0", "Default (240 MHz)"], ["80", "80 MHz"], ["160", "160 MHz"], ["240", "240 MHz"]]);
  const html = readFileSync(new URL("../../src/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="settings-storage"|High-Speed|id="settings-tcp-cli"/);
  connected.settings.sdcard_profile = 1;
  await state.tick();
  assert.equal(elements.get("#settings-save").disabled, false, "a non-Standard saved profile is repaired by Save");
  await saveAndConfirm();
  assert.deepEqual(savedSettings.at(-1), { system_clock_mhz: 240, sdcard_profile: 0, radios: 0 });
});

test("storage telemetry, pin rows, and dashboard layout preserve presentation", async context => {
  const { connected, elements } = await appFixture(context);
  connected.memory = { mode: "sdmmc" };
  delete connected.filesystem_format;
  renderStatus({ ...connected, memory: { configured: true, sample_valid: false, initialized: false } });
  assert.equal(elements.get("#memory-state").textContent, "Busy");
  assert.equal(elements.get("#memory-note").textContent, "");
  assert.equal(elements.get("#memory-speed").textContent, "--");
  for (const speedMode of ["standard", 1]) {
    renderStatus({ ...connected, memory: { configured: true, sample_valid: true, initialized: true,
      present: true, bus_clock_hz: 25000000, speed_mode: speedMode } });
    assert.equal(elements.get("#memory-state").textContent, "Ready");
    assert.equal(elements.get("#memory-speed").textContent, "25 MHz");
  }
  renderStatus({ ...connected, memory: { configured: true, sample_valid: true, initialized: false } });
  assert.equal(elements.get("#memory-state").textContent, "Not initialized");
  assert.equal(elements.get("#memory-note").textContent,
    "Card not mounted; check card insertion, UART logs and SD wiring.");
  const validStorage = { ...connected, filesystem_format: "exfat", memory: {
    configured: true, sample_valid: true, initialized: true, present: true, mode: "sdmmc",
    bus_clock_hz: 25000000, speed_mode: "standard", capacity_bytes: 127865454592,
    manufacturer: { id: 3, product_name: "SB128", product_revision: "8.0", manufacture_year: 2020,
      manufacture_month: 1, serial_number: 4089330880 },
  } };
  const busyStorage = { ...connected, memory: { configured: true, sample_valid: false } };
  renderStatus(validStorage);
  const detailIds = ["#memory-speed", "#memory-size", "#memory-filesystem",
    "#memory-manufacturer", "#memory-product", "#memory-serial"];
  const details = detailIds.map(id => elements.get(id).textContent);
  for (let sample = 0; sample < 3; sample++) {
    renderStatus(busyStorage);
    assert.equal(elements.get("#memory-state").textContent, "Busy");
    assert.equal(elements.get("#memory-note").textContent, "");
    assert.deepEqual(detailIds.map(id => elements.get(id).textContent), details);
  }
  for (const invalidation of [
    { connected: false },
    { ...connected, storage_stale: true },
    { ...connected, memory: { configured: true, sample_valid: true, presence_known: true, present: false } },
    { ...connected, memory: { configured: true, sample_valid: true, present: true, initialized: false } },
  ]) {
    renderStatus(validStorage);
    renderStatus(invalidation);
    renderStatus(busyStorage);
    assert.equal(elements.get("#memory-speed").textContent, "--", "invalidated details must not return");
  }
  renderStatus(connected);
  const rows = id => elements.get(id).children.map(row => row.children.map(cell => cell.textContent));
  renderStatus(connected);
  assert.equal(elements.get("#board-uart-title").textContent, "Monitor UART0");
  assert.equal(elements.get("#board-storage-title").textContent, "Storage (SDMMC)");
  assert.deepEqual(rows("#board-uart"), [["TX", "RX"], ["GPIO43", "GPIO44"]]);
  assert.deepEqual(rows("#board-storage-pins"),
    [["CLK", "CMD", "DAT0", "DAT1", "DAT2", "DAT3", "Card detect"],
      ["GPIO12", "GPIO11", "GPIO13", "GPIO14", "GPIO15", "GPIO10", "Unassigned"]]);
  assert.equal(elements.get("#board-reset-cause").textContent, "Power-on");
  const uartRows = elements.get("#board-uart").children;
  const storageRows = elements.get("#board-storage-pins").children;
  renderStatus({ ...connected, board_configuration: structuredClone(connected.board_configuration) });
  assert.strictEqual(elements.get("#board-uart").children, uartRows,
    "unchanged UART pin configuration keeps its rendered rows");
  assert.strictEqual(elements.get("#board-storage-pins").children, storageRows,
    "unchanged storage pin configuration keeps its rendered rows");
  for (const [cause, label] of [[0, "Unknown"], [2, "Watchdog"], [3, "Software request"], [4, "Unassigned (4)"]]) {
    renderStatus({ ...connected, board_configuration: { ...connected.board_configuration, reset_cause: cause } });
    assert.equal(elements.get("#board-reset-cause").textContent, label);
  }
  renderStatus(connected);
  assert.equal(elements.get("#board-model").textContent, "ESP32-S3-DevKitC-1");
  assert.equal(elements.get("#board-mcu").textContent, "ESP32-S3");
  assert.equal(elements.get("#ram-usage").textContent, "118.2 / 512 KiB (23.1%)");
  renderStatus({ ...connected, hardware: { ...connected.hardware, psram_total_bytes: 8 << 20,
    psram_reserved_bytes: 1 << 20, flash_total_bytes: 16 << 20 } });
  assert.equal(elements.get("#ram-usage").textContent, "118.2 / 512 KiB (23.1%)");
  assert.equal(elements.get("#psram-usage").textContent, "1.0 / 8.0 MiB (12.5%)");
  assert.equal(elements.get("#flash-capacity").textContent, "16.0 MiB");
  assert.equal(elements.get("#memory-capacity").textContent, "16 MiB flash · 8 MiB PSRAM");
  renderStatus({ ...connected, hardware: { ...connected.hardware, psram_total_bytes: null, flash_total_bytes: null } });
  assert.equal(elements.get("#psram-usage").textContent, "--");
  assert.equal(elements.get("#flash-capacity").textContent, "--");
  assert.equal(elements.get("#memory-capacity").textContent, "-- MiB flash · -- MiB PSRAM");
  renderStatus({ ...connected, hardware: { ...connected.hardware, board_model: 1, mcu: undefined } });
  assert.equal(elements.get("#board-model").textContent, "ESP32-S3-DevKitC-1");
  assert.equal(elements.get("#board-mcu").textContent, "--");
  renderStatus({ ...connected, runtime: { cpu_usage_core0_basis_points: 1234, cpu_usage_core1_basis_points: null } });
  assert.equal(elements.get("#cpu-usage-core0").textContent, "12.3% / --");
  const html = readFileSync(new URL("../../src/index.html", import.meta.url), "utf8");
  const identity = html.split('aria-label="Hardware identity"')[1].split("</section>")[0];
  assert.deepEqual([...identity.matchAll(/<strong id="([^"]+)"/g)].map(match => match[1]),
    ["product-name", "serial", "identity-clock", "firmware-version", "memory-capacity"]);
  assert.match(identity, /<details[^>]*id="product-information"[\s\S]*?id="product-name"[\s\S]*?<dd id="board-model">/);
  const product = identity.split('id="product-information"')[1].split("</details>")[0];
  assert.deepEqual([...product.matchAll(/<dd id="([^"]+)"/g)].map(match => match[1]), ["board-model", "board-mcu"]);
  assert.match(identity, /<details[^>]*id="module-memory"[\s\S]*?<summary>[\s\S]*?id="ram-usage"/);
  assert.doesNotMatch(html, /memory-inventory-title/);
  assert.doesNotMatch(html, /id="ram-reserved"|id="ram-total"/);
  assert.doesNotMatch(html, /id="mcu"|Microcontroller/);
  assert.match(html, />Save&amp;Reboot<\/button>/);
  assert.match(html, />Reboot Board<\/button>/);
  assert.match(html, /id="settings-title">Boot configuration<\/h2>/);
  assert.doesNotMatch(html, /Board configuration/);
  assert.doesNotMatch(html, /BOOT CONFIGURATION/);
  assert.doesNotMatch(html, /class="eyebrow"/);
  assert.doesNotMatch(html, /metric-product/);
  const diagnostics = html.split('<dl class="runtime-grid runtime-summary">')[1].split("</dl>")[0];
  assert.deepEqual([...diagnostics.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]),
    ["Uptime", "Reset cause", "Service load (Core 0 / Core 1)", "Board temperature", "Storage bus speed",
      "Wi-Fi", "Bluetooth"]);
  assert.doesNotMatch(html, /id="cpu-usage-core1"|id="cdc-state"|id="msc-control"|id="self-test/);
  assert.doesNotMatch(html, /\bPico\b|>PF</);
  const storage = html.split('aria-labelledby="memory-title"')[1].split("</section>")[0];
  assert.deepEqual([...storage.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]),
    ["Memory state", "Capacity", "Filesystem", "Manufacturer", "Product", "Serial"]);
  assert.doesNotMatch(html, /id="memory-mode"/);
  const pins = html.match(/<details class="pin-map-disclosure"([^>]*)>(\s*<summary>Pin configuration[\s\S]*?)<\/details>/);
  assert.ok(pins);
  assert.doesNotMatch(pins[1], /\bopen\b/);
  assert.match(pins[2], /<summary>Pin configuration<\/summary>/);
  assert.doesNotMatch(pins[2], /board-reset-cause/);
  assert.match(diagnostics, /<dt>Reset cause<\/dt><dd id="board-reset-cause">/);
  for (const id of ["board-uart", "board-storage-pins"]) {
    assert.ok(pins[2].includes(`id="${id}"`));
  }
});

test("settings and reboot recovery preserve per-board command ownership", async context => {
  const {
    state, connected, handlers, elements, requestedUrls, savedSettings, saveAndConfirm, switchBoard,
    reconnect,
  } = await appFixture(context);
  assert.equal(elements.get("#board-select").value, "board-a");
  assert.equal(elements.get("#board-select").children.find(option => option.value === "board-a").textContent,
    "ESPForge / board-A");
  assert.equal(elements.get("#board-select").children.find(option => option.value === "board-b").textContent,
    "ESPForge / HID /hid/b");
  assert.ok(requestedUrls.includes("/api/status?board=board-a"));
  elements.get("#settings-clock").value = "80";
  handlers.get("#settings-clock:change")();
  const beforeCancel = requestedUrls.length;
  await handlers.get("#settings-save:click")();
  assert.equal(elements.get("#configuration-dialog").open, true);
  assert.match(elements.get("#configuration-dialog-profile").textContent, /^System clock: 80 MHz\.$/);
  handlers.get("#cancel-configuration:click")();
  assert.equal(elements.get("#configuration-dialog").open, false);
  await handlers.get("#reboot-control:click")();
  assert.equal(elements.get("#reboot-dialog").open, true);
  assert.match(elements.get("#reboot-consequence").textContent, /Unsaved.*lost/);
  handlers.get("#cancel-reboot:click")();
  handlers.get("#reboot-control:click")();
  handlers.get("#reboot-dialog:keydown")({ key: "Escape", preventDefault() {} });
  assert.equal(elements.get("#reboot-dialog").open, false);
  await handlers.get("#confirm-reboot:click")();
  await handlers.get("#confirm-configuration:click")();
  assert.equal(requestedUrls.length, beforeCancel);
  await saveAndConfirm();
  assert.deepEqual(savedSettings[0], { system_clock_mhz: 80, sdcard_profile: 0, radios: 0 });
  assert.equal(requestedUrls.at(-1), "/api/settings?board=board-a");
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/reboot")).length, 0);
  connected.settings = { ...savedSettings[0] };
  await reconnect();
  elements.get("#settings-clock").value = "0";
  handlers.get("#settings-clock:change")();
  await saveAndConfirm();
  assert.deepEqual(savedSettings[1], { system_clock_mhz: 0, sdcard_profile: 0, radios: 0 });
  connected.settings = { ...savedSettings[1] };
  await reconnect();
  elements.get("#settings-clock").value = "160";
  handlers.get("#settings-clock:change")();
  for (const failure of ["save", "readback", "unsupported"]) {
    state.saveFails = failure !== "readback";
    state.settingsFailure = failure;
    state.readbackMismatch = failure === "readback";
    await saveAndConfirm();
    assert.equal(savedSettings.length, 3 + ["save", "readback", "unsupported"].indexOf(failure));
    assert.equal(requestedUrls.filter(url => url.startsWith("/api/reboot")).length, 0,
      "failed save must not send a separate reboot");
    assert.match(elements.get("#settings-note").textContent, failure === "readback" ? /outcome is uncertain/ : /Save failed/);
    assert.equal(elements.get("#settings-note").hidden, false);
    if (failure === "readback") {
      connected.settings = { ...savedSettings.at(-1) };
      await reconnect();
      elements.get("#settings-clock").value = "80";
      handlers.get("#settings-clock:change")();
    }
  }
  state.saveFails = false;
  state.readbackMismatch = false;
  await saveAndConfirm();
  assert.match(elements.get("#settings-note").textContent, /Settings saved. Reboot requested/);
  connected.settings = { ...savedSettings.at(-1) };
  await reconnect();
  state.settingsOutcomeConflict = true;
  elements.get("#settings-clock").value = "160";
  handlers.get("#settings-clock:change")();
  const beforeUncertainConflict = savedSettings.length;
  await saveAndConfirm();
  assert.equal(savedSettings.length, beforeUncertainConflict + 1);
  assert.match(elements.get("#settings-note").textContent, /outcome is uncertain/);
  await saveAndConfirm();
  assert.equal(savedSettings.length, beforeUncertainConflict + 1,
    "an explicit uncertain HTTP 409 is not treated as a definite rejection");
  state.settingsOutcomeConflict = false;
  connected.settings = { ...connected.settings, ...savedSettings.at(-1) };
  await state.tick();
  assert.match(elements.get("#settings-note").textContent, /readback matches/);
  connected.settings = { ...connected.settings, system_clock_mhz: 160, sdcard_profile: 0 };
  await state.tick();
  state.settingsTimeout = true;
  elements.get("#settings-clock").value = "80";
  handlers.get("#settings-clock:change")();
  const beforeUncertainSave = savedSettings.length;
  await saveAndConfirm();
  assert.equal(savedSettings.length, beforeUncertainSave + 1);
  assert.match(elements.get("#settings-note").textContent, /outcome is uncertain/);
  assert.equal(elements.get("#settings-save").disabled, true);
  await saveAndConfirm();
  assert.equal(savedSettings.length, beforeUncertainSave + 1, "an uncertain save is not resent");
  state.settingsTimeout = false;
  const oldSettings = { ...connected.settings };
  await switchBoard("board-b");
  await switchBoard("board-a");
  assert.equal(elements.get("#settings-save").disabled, true,
    "switching back restores the unresolved settings outcome");
  await saveAndConfirm();
  assert.equal(savedSettings.length, beforeUncertainSave + 1,
    "the unresolved settings save is not replayed after switching boards");
  connected.settings = oldSettings;
  connected.connected = false;
  await state.tick();
  connected.connected = true;
  await state.tick();
  assert.equal(elements.get("#settings-clock").disabled, true,
    "disconnect alone does not clear an uncertain settings outcome");
  connected.settings = { ...connected.settings, ...savedSettings.at(-1) };
  for (let attempt = 0; attempt < 3; attempt++) {
    await state.tick();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.match(elements.get("#settings-note").textContent, /readback matches/);
  assert.equal(elements.get("#settings-save").disabled, true, "matching status resolves the pending save");
  await switchBoard("board-b");
  await switchBoard("board-a");
  assert.equal(elements.get("#settings-clock").disabled, false,
    "reconciliation remains cleared after switching away and back again");
  connected.settings = { ...connected.settings, system_clock_mhz: 160, sdcard_profile: 0 };
  await state.tick();
  state.rebootFails = true;
  await handlers.get("#reboot-control:click")();
  await handlers.get("#confirm-reboot:click")();
  assert.match(elements.get("#settings-note").textContent, /outcome is uncertain/);
  state.rebootFails = false;
  const rebootRequests = requestedUrls.filter(url => url.startsWith("/api/reboot?")).length;
  await handlers.get("#reboot-control:click")();
  await handlers.get("#confirm-reboot:click")();
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/reboot?")).length, rebootRequests,
    "a server error with an unknown reboot outcome is not resent");
  await reconnect();
  await handlers.get("#reboot-control:click")();
  await handlers.get("#confirm-reboot:click")();
  assert.equal(requestedUrls.at(-1), "/api/reboot?board=board-a");
  await reconnect();
  state.rebootResponseError = true;
  const rebootBeforeConflict = requestedUrls.filter(url => url.startsWith("/api/reboot?")).length;
  await handlers.get("#reboot-control:click")();
  await handlers.get("#confirm-reboot:click")();
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/reboot?")).length, rebootBeforeConflict + 1,
    `${elements.get("#reboot-control").disabled}; ${elements.get("#status-message").textContent}; `
    + elements.get("#settings-note").textContent);
  assert.match(elements.get("#settings-note").textContent, /Reboot outcome is uncertain; command was not resent/);
  state.rebootResponseError = false;
  await reconnect();
  let finishReboot;
  const rebootGate = new Promise(resolve => { finishReboot = resolve; });
  state.responses.set("/api/reboot", async options => {
    assert.deepEqual(JSON.parse(options.body), { confirm: true });
    await rebootGate;
    return { ok: true, json: async () => ({}) };
  });
  await handlers.get("#reboot-control:click")();
  const pendingReboot = handlers.get("#confirm-reboot:click")();
  await new Promise(resolve => setImmediate(resolve));
  elements.get("#board-select").value = "board-b";
  handlers.get("#board-select:change")();
  assert.equal(elements.get("#board-select").value, "board-a",
    "board selection stays locked while a command request is in flight");
  finishReboot();
  await pendingReboot;
  state.responses.delete("/api/reboot");
  assert.match(elements.get("#settings-note").textContent, /Reboot requested/);
  await reconnect();
  for (const name of ["#led-control:click", "#msc-control:click", "#self-test-start:click", "#confirm-share:click",
    "#confirm-return:click", "#settings-storage:change", "#settings-tcp-cli:change"]) {
    assert.equal(handlers.get(name), undefined, `${name} is not bound on ESPForge`);
  }
  assert.equal(requestedUrls.some(url => /^\/api\/(led|msc|self-test|console)/.test(url)), false);
  elements.get("#board-select").value = "board-b";
  handlers.get("#board-select:change")();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(requestedUrls.includes("/api/status?board=board-b"));
  assert.equal(elements.get("#wifi-settings").hidden, true);
});

test("wireless provisioning and cancellation preserve draft and uncertainty invariants", async context => {
  const {
    state, boardStatuses, handlers, elements, configureRadio, requestedUrls, savedSettings, wirelessSettings,
    testedWireless, requestTimeouts, saveAndConfirm, switchBoard, reconnect,
  } = await appFixture(context);
  const connected = boardStatuses.get("board-b");
  await switchBoard("board-b");
  connected.hardware.capabilities = 0x96;
  connected.settings.radios = 3;
  state.wirelessStatus = { ble_enabled: true, ble_key_configured: true };
  connected.storage_stale = false;
  connected.msc = { enabled: false, transition_pending: false };
  await state.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("#wifi-settings").hidden, false);
  assert.equal(elements.get("#ble-settings").hidden, false);
  assert.equal(elements.get("#settings-wifi").value, "1");
  assert.equal(elements.get("#settings-ble").value, "1");
  assert.equal(elements.get("#wifi-ssid").value, "saved");
  assert.equal(elements.get("#wifi-state").textContent, "saved (192.168.1.9)");
  await switchBoard("board-b");
  const beforeWirelessReads = requestedUrls.filter(url => url.startsWith("/api/wireless?")).length;
  state.wirelessState = "connecting";
  await state.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("#wifi-state").textContent, "saved (connecting)");
  state.wirelessState = "failed";
  await state.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("#wifi-state").textContent, "saved (disconnected)");
  state.wirelessReadFails = true;
  await state.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("#wifi-state").textContent, "Unavailable");
  assert.match(elements.get("#wifi-state").title, /wireless down/);
  assert.equal(elements.get("#connection-label").textContent, "Connected");
  state.wirelessReadFails = false;
  state.wirelessState = "connected";
  await state.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("#wifi-state").textContent, "saved (192.168.1.9)");
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless?")).length, beforeWirelessReads,
    "Wi-Fi status arrives with /api/status; no separate wireless polling");
  assert.equal(elements.get("#settings-save").disabled, true);
  configureRadio("wifi");
  handlers.get("#wifi-other:click")();
  elements.get("#wifi-ssid").value = "new-network";
  handlers.get("#wifi-ssid:input")();
  elements.get("#wifi-password").value = "new-passphrase";
  handlers.get("#wifi-password:input")();
  assert.equal(elements.get("#settings-save").disabled, true, "unverified Wi-Fi credentials cannot be saved");
  let finishWirelessTest;
  state.wirelessTestGate = new Promise(resolve => { finishWirelessTest = resolve; });
  const testing = handlers.get("#wifi-connect:click")();
  assert.equal(elements.get("#board-select").disabled, true, "board selection locks immediately during a test");
  assert.equal(elements.get("#rescan-boards").disabled, true, "board rescan locks immediately during a test");
  await state.tick();
  assert.equal(elements.get("#board-select").disabled, true);
  assert.equal(elements.get("#rescan-boards").disabled, true);
  assert.equal(elements.get("#reboot-control").disabled, true);
  assert.equal(elements.get("#wifi-connect").textContent, "Testing…");
  const beforeSwitch = requestedUrls.length;
  elements.get("#board-select").value = "board-a";
  handlers.get("#board-select:change")();
  assert.equal(elements.get("#board-select").value, "board-b", "a rejected selection restores the actual board");
  assert.equal(requestedUrls.length, beforeSwitch, "board switching must not interrupt a pending test");
  finishWirelessTest();
  await testing;
  for (const timeout of [5000, 10000, 40000]) {
    assert.ok(requestTimeouts.includes(timeout), `expected a ${timeout} ms request deadline`);
  }
  state.wirelessTestGate = null;
  assert.deepEqual(testedWireless.at(-1), { ssid: "new-network", password: "new-passphrase" });
  elements.get("#wifi-ssid").value = "edited-network";
  handlers.get("#wifi-ssid:input")();
  elements.get("#wifi-password").value = "edited-passphrase";
  handlers.get("#wifi-password:input")();
  assert.equal(elements.get("#settings-save").disabled, true,
    "editing either credential invalidates the previously tested stage");
  await handlers.get("#wifi-connect:click")();
  assert.deepEqual(testedWireless.at(-1), { ssid: "edited-network", password: "edited-passphrase" });
  assert.equal(elements.get("#settings-save").disabled, false);
  assert.equal(elements.get("#settings-save").disabled, false, "staged wireless settings enable combined save");
  configureRadio("ble");
  handlers.get("#ble-generate:click")();
  assert.match(elements.get("#ble-secret").value, /^[0-9a-f]{64}$/);
  handlers.get("#settings-save:click")();
  assert.equal(elements.get("#configuration-wireless-warning").hidden, false);
  handlers.get("#cancel-configuration:click")();
  await handlers.get("#confirm-configuration:click")();
  assert.equal(wirelessSettings.length, 0);
  const settingsBefore = savedSettings.length;
  state.wirelessFailure = 409;
  await saveAndConfirm();
  assert.ok(requestTimeouts.includes(15000), "expected a 15000 ms save deadline");
  assert.equal(wirelessSettings.length, 1);
  assert.match(elements.get("#wifi-status").textContent, /Storage busy/);
  assert.match(elements.get("#settings-note").textContent, /Save failed: Storage busy/);
  assert.equal(elements.get("#settings-save").disabled, true, "a rejected key save requires regeneration before retry");
  assert.match(elements.get("#settings-save").title, /Generate a replacement/);
  assert.equal(elements.get("#wifi-password").value, "");
  assert.equal(elements.get("#ble-secret").value, "");
  state.wirelessFailure = 0;
  handlers.get("#ble-generate:click")();
  assert.equal(elements.get("#settings-save").disabled, false, "regeneration makes the rejected save retryable");
  handlers.get("#settings-save:click")();
  const saving = handlers.get("#confirm-configuration:click")();
  assert.equal(elements.get("#board-select").disabled, true);
  assert.equal(elements.get("#rescan-boards").disabled, true);
  await saving;
  assert.equal(wirelessSettings.length, 2);
  assert.equal(savedSettings.length, settingsBefore, "one combined request, no separate settings save");
  assert.equal(requestedUrls.at(-1), "/api/wireless?board=board-b");
  assert.equal(wirelessSettings[1].confirm_reboot, true);
  assert.equal(wirelessSettings[1].wifi_enabled, true);
  assert.equal(wirelessSettings[1].ble_enabled, true);
  assert.equal(wirelessSettings[1].use_tested_wifi, true);
  assert.equal(wirelessSettings[1].ssid, "edited-network");
  assert.equal(Object.hasOwn(wirelessSettings[1], "password"), false);
  assert.deepEqual(wirelessSettings[1].board, { system_clock_mhz: 160, sdcard_profile: 0, radios: 3 });
  assert.match(elements.get("#wifi-status").textContent, /saved/);
  assert.match(elements.get("#settings-note").textContent, /Settings saved. Reboot requested/);
  assert.equal(elements.get("#settings-save").disabled, true);
  await reconnect();
  state.wirelessFailure = 503;
  configureRadio("wifi");
  handlers.get("#wifi-other:click")();
  elements.get("#wifi-ssid").value = "uncertain-network";
  handlers.get("#wifi-ssid:input")();
  elements.get("#wifi-password").value = "new-passphrase";
  handlers.get("#wifi-password:input")();
  await handlers.get("#wifi-connect:click")();
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 3);
  assert.match(elements.get("#wifi-status").textContent, /uncertain/);
  await state.tick();
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 3);
  elements.get("#board-select").value = "board-a";
  handlers.get("#board-select:change")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("#wifi-password").value, "");
  assert.equal(elements.get("#ble-secret").value, "");
  const firstBoard = boardStatuses.get("board-a");
  state.wirelessStatus = null;
  firstBoard.hardware.capabilities |= 128;
  firstBoard.storage_stale = false;
  await state.tick();
  state.wirelessFailure = 409;
  state.wirelessError = "Wireless outcome is uncertain";
  configureRadio("wifi");
  handlers.get("#wifi-other:click")();
  elements.get("#wifi-ssid").value = "mismatched-network";
  handlers.get("#wifi-ssid:input")();
  elements.get("#wifi-password").value = "new-passphrase";
  handlers.get("#wifi-password:input")();
  await handlers.get("#wifi-connect:click")();
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 4);
  assert.match(elements.get("#wifi-status").textContent, /Wireless outcome is uncertain/);
  await state.tick();
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 4);
  elements.get("#board-select").value = "board-b";
  handlers.get("#board-select:change")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("#wifi-connect").disabled, true, "board B retains its earlier unresolved save");
  connected.command_outcome_uncertain = true;
  connected.command_resync_supported = true;
  await state.tick();
  await handlers.get("#command-resync:click")();
  configureRadio("wifi");
  elements.get("#wifi-ssid").value = "timed-out-network";
  handlers.get("#wifi-ssid:input")();
  state.wirelessTestError = new DOMException("HTTP deadline", "TimeoutError");
  const beforeTimeout = testedWireless.length;
  await handlers.get("#wifi-connect:click")();
  assert.equal(testedWireless.length, beforeTimeout + 1, "timed-out tests are not replayed");
  assert.match(elements.get("#wifi-status").textContent, /timed out.*uncertain/);
  await state.tick();
  assert.equal(elements.get("#wifi-connect").disabled, true);
  assert.equal(elements.get("#settings-save").disabled, true);
  connected.command_outcome_uncertain = true;
  connected.command_resync_supported = true;
  await state.tick();
  assert.equal(elements.get("#command-resync").hidden, false);
  await handlers.get("#command-resync:click")();
  assert.equal(connected.command_outcome_uncertain, false);
  assert.equal(elements.get("#command-resync").hidden, true);
  assert.equal(requestedUrls.at(-1), "/api/status?board=board-b");
});
