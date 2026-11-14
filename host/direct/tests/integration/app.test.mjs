// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { BoardSession } from "../../web/js/board/session.mjs";
import { decodeIdentityReport, decodeConfigReport } from "../../web/js/protocol/codec.mjs";
import { identity, config, patchState } from "../support/fixtures.mjs";
import { fakeConnection, storage, emit } from "../support/fixtures.mjs";
import { createDocument } from "../support/dom.mjs";
import { mountDashboard } from "../../web/js/ui/dashboard.mjs";
import { createTimerScope } from "../../web/js/timers.mjs";

test("save completions own their original draft", async () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    for (const outcome of ["resolve", "reject", "dispose"]) {
      const { document, element: el, fire } = createDocument();
      globalThis.document = document;
      const { client, device } = fakeConnection();
      const ready = async () => {
        await client.connect();
        emit(device, 10, storage());
        await client.readWireless();
        await null;
      };
      await ready();
      let resolveSave, rejectSave;
      client.saveConfiguration = () => new Promise((resolve, reject) => {
        resolveSave = resolve;
        rejectSave = reject;
      });
      const timers = createTimerScope();
      const dashboard = mountDashboard({ session: client, selectTransport: () => client, timers,
        environment: { secure: true, hid: true, ble: false, now: Date.now, clipboard: null } });
      try {
        await null;
        el("#settings-clock").value = "160";
        await fire("#settings-clock", "change");
        await null;
        await fire("#settings-save", "click");
        const saving = fire("#confirm-configuration", "click");
        assert.equal(typeof resolveSave, "function", outcome);
        await client.disconnect();
        await null;
        if (outcome === "dispose") dashboard.dispose();
        else await ready();
        if (outcome !== "dispose") await fire("#direct-ble-generate", "click");
        await null;
        const key = el("#direct-ble-secret").value;
        if (outcome === "resolve") resolveSave(null);
        else rejectSave(new Error("Old save failed"));
        await saving;
        await null;
        assert.equal(el("#direct-ble-secret").value, key, `${outcome}: newer key is preserved`);
        assert.doesNotMatch(el("#settings-note").textContent, /Settings saved|Old save failed/, outcome);
      } finally { dashboard.dispose(); client.dispose(); timers.dispose(); }
    }
  } finally { globalThis.document = previous.document; globalThis.window = previous.window; }
});

const memorySessionStorage = () => {
  const saved = new Map();
  return { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key) };
};

test("Direct UI preserves unsaved profiles, and separates confirmed reboot", async context => {
  const saved = {
    document: globalThis.document, window: globalThis.window,
    location: globalThis.location,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    secure: Object.getOwnPropertyDescriptor(globalThis, "isSecureContext"),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
  };
  const prototypes = new Map(["connect", "saveSettings", "reboot"].map(name =>
    [name, BoardSession.prototype[name]]));
  const { document, element: el, fire } = createDocument();
  let client;
  /** Apply a client change and flush the dashboard's coalesced refresh. */
  const sync = async changes => { patchState(client, changes); await null; };
  const commands = [];
  globalThis.document = document;
  globalThis.window = { confirm() { assert.fail("Use styled dialogs, not browser confirmations"); } };
  globalThis.location = { hostname: "example.test" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { hid: new EventTarget() } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memorySessionStorage() });
  BoardSession.prototype.connect = async function () {
    client = this;
    const hardware = decodeIdentityReport(identity());
    patchState(this, { connected: true, hardware, settings: decodeConfigReport(config(), hardware),
      settings_supported: true, freshness: { 3: "fresh", 10: "fresh" },
      memory: { sample_valid: true, initialized: true } });
  };
  BoardSession.prototype.saveSettings = async function (settings) {
    commands.push(["save", settings]);
    patchState(this, { settings: { ...this.state.settings, ...settings } });
    return true;
  };
  BoardSession.prototype.reboot = async confirmed => { commands.push(["reboot", confirmed]); };
  try {
    await import(`../../web/js/app.mjs?test=${Date.now()}`);
    await fire("#usb-open", "click");
    await fire("#usb-connect", "click");
    assert.equal(el("#settings-clock").value, "240");
    assert.equal(el("#settings-note").hidden, true);
    assert.equal(el("#status-message").hidden, false);
    const label = el("#connection-label");
    let labelText = label.textContent;
    let renders = 0;
    Object.defineProperty(label, "textContent", { configurable: true, get: () => labelText,
      set: value => { renders++; labelText = value; } });
    for (const error of ["first", "second", null]) patchState(client, { error });
    assert.equal(renders, 0, "client changes render asynchronously");
    await null;
    assert.equal(renders, 0, "a coalesced refresh does not rewrite an unchanged connection label");
    await sync({ recovery_message: "Pending command result confirmed after reconnect." });
    assert.equal(el("#status-message").textContent, "Pending command result confirmed after reconnect.");
    await sync({ recovery_message: null });
    assert.equal(el("#settings-save").disabled, true);
    el("#settings-clock").value = "160"; await fire("#settings-clock", "change"); await null;
    await sync({ error: null });
    assert.equal(el("#settings-clock").value, "160");
    await fire("#settings-save", "click");
    assert.deepEqual(commands, []);
    assert.equal(el("#configuration-dialog").open, true);
    assert.match(el("#configuration-dialog-profile").textContent, /160 MHz/);
    await fire("#cancel-configuration", "click");
    await fire("#confirm-configuration", "click");
    assert.deepEqual(commands, []);
    await fire("#settings-save", "click");
    await fire("#confirm-configuration", "click");
    assert.deepEqual(commands, [["save", { system_clock_mhz: 160, sdcard_profile: 0, radios: 0 }]]);
    await fire("#settings-reboot", "click");
    assert.equal(commands.length, 1);
    assert.equal(el("#reboot-dialog").open, true);
    const escape = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    el("#reboot-dialog").dispatchEvent(escape);
    assert.equal(el("#reboot-dialog").open, false);
    await fire("#confirm-reboot", "click");
    assert.equal(commands.length, 1);
    await fire("#settings-reboot", "click");
    await fire("#confirm-reboot", "click");
    assert.deepEqual(commands[1], ["reboot", true]);
    await sync({ outcome_uncertain: true });
    assert.equal(el("#settings-save").disabled, true);
    assert.equal(el("#settings-reboot").disabled, true);
    await sync({ outcome_uncertain: false, freshness: { 3: "stale", 10: "stale" }, runtime: null });
    assert.equal(el("#settings-save").disabled, true);
    let now = Date.now();
    client.now = () => now;
    context.mock.method(Date, "now", () => now);
    let reads = 0;
    let wifiState = 2;
    let failure = false;
    let delayed = null;
    const device = new EventTarget();
    device.receiveFeatureReport = async id => {
      assert.equal(id, 12);
      reads++;
      if (failure) throw new Error("device read failed");
      if (delayed) return delayed;
      const report = new Uint8Array(48);
      report.set([1, wifiState, 0, 0, 1]);
      if (wifiState === 2) report.set([192, 168, 1, 9], 5);
      report[9] = 7;
      report.set(new TextEncoder().encode("HomeDev"), 10);
      return report;
    };
    client.transport.device = device;
    await sync({ settings: { ...client.state.settings, radios: 1 },
      hardware: { ...client.state.hardware, capabilities: client.state.hardware.capabilities | 128 } });
    client.polling.enabled = true;
    client.pollWireless();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(el("#direct-wifi-state").textContent, "HomeDev (192.168.1.9)");
    assert.equal(reads, 1);
    wifiState = 1;
    client.pollWireless();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1, "polls inside the interval must not read Feature 12");
    now += 2000;
    client.pollWireless();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(el("#direct-wifi-state").textContent, "HomeDev (connecting)");
    failure = true;
    now += 2000;
    client.pollWireless();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(el("#direct-wifi-state").textContent, "HomeDev (connecting)", "one failed poll retains a fresh snapshot");
    now += 4000;
    client.expireReports(); await null;
    assert.equal(el("#direct-wifi-state").textContent, "Unavailable");
    assert.match(el("#direct-wifi-state").title, /stale/);
    failure = false;
    let finishRead;
    delayed = new Promise(resolve => { finishRead = resolve; });
    now += 2000;
    client.pollWireless();
    client.connection.clear();
    finishRead(new Uint8Array(48));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.state.wireless, null, "a late report must not repopulate a disconnected board");
    assert.equal(el("#direct-wifi-state").textContent, "--");
  } finally {
    for (const [name, method] of prototypes) BoardSession.prototype[name] = method;
    globalThis.document = saved.document; globalThis.window = saved.window;
    if (saved.location === undefined) delete globalThis.location;
    else globalThis.location = saved.location;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
    else delete globalThis.navigator;
    if (saved.secure) Object.defineProperty(globalThis, "isSecureContext", saved.secure);
    else delete globalThis.isSecureContext;
    if (saved.sessionStorage) Object.defineProperty(globalThis, "sessionStorage", saved.sessionStorage);
    else delete globalThis.sessionStorage;
  }
});

test("Bluetooth dialog takes the control key, then scans, and preserves transport safety", async () => {
  const saved = {
    document: globalThis.document, window: globalThis.window,
    location: globalThis.location,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    secure: Object.getOwnPropertyDescriptor(globalThis, "isSecureContext"),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
    crypto: Object.getOwnPropertyDescriptor(globalThis, "crypto"),
  };
  const prototypes = new Map(["connect", "disconnect", "saveSettings", "reboot"].map(name =>
    [name, BoardSession.prototype[name]]));
  const { document, element: el, fire } = createDocument();
  const windowHandlers = new Map();
  let reloads = 0;
  globalThis.document = document;
  globalThis.location = { origin: "http://localhost", href: "http://localhost/", reload() { reloads++; } };
  globalThis.window = { addEventListener(type, handler) { windowHandlers.set(type, handler); } };
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { hid: new EventTarget(), bluetooth: {} } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memorySessionStorage() });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  let client;
  const sync = async changes => { patchState(client, changes); await null; };
  let scans = 0;
  let failure = false;
  let finishScan;
  let usedKey;
  const settingsCommands = [];
  BoardSession.prototype.saveSettings = async function (settings) {
    settingsCommands.push(["save", settings]);
    patchState(this, { settings: { ...this.state.settings, ...settings }, reboot_pending: true });
    return true;
  };
  BoardSession.prototype.reboot = async confirmed => { settingsCommands.push(["reboot", confirmed]); };
  BoardSession.prototype.connect = async function (key) {
    client = this;
    scans++;
    usedKey = Buffer.from(key).toString("hex");
    patchState(this, { busy: true, error: null });
    await new Promise(resolve => { finishScan = resolve; });
    if (failure) {
      patchState(this, { busy: false, error: "The board rejected the control key." });
      return;
    }
    this.transport.bleKey = {};
    this.transport.device = Object.assign(new EventTarget(), {
      name: "ESPForge-0102", gatt: { connected: true, disconnect() {} },
    });
    const hardware = decodeIdentityReport(identity());
    const wirelessReport = new Uint8Array(53);
    wirelessReport[0] = 1;
    this.transport.readReport = async () => wirelessReport;
    patchState(this, { connected: true, busy: false, hardware,
      settings: decodeConfigReport(config(), hardware), settings_supported: true,
      freshness: { 3: "fresh", 10: "fresh" },
      memory: { sample_valid: true, initialized: true },
      wireless: { ssid: "HomeDev", wifi_enabled: true, ble_enabled: true,
        ble_key_configured: true } });
  };
  BoardSession.prototype.disconnect = async function () {
    this.transport.bleKey = null;
    this.transport.device = null;
    this.connection.clear();
  };
  try {
    await import(`../../web/js/app.mjs?connections=${Date.now()}`);
    windowHandlers.get("pageshow")({ persisted: false });
    assert.equal(reloads, 0, "initial page display must not reload");
    await fire("#usb-open", "click"); await null;
    assert.equal(el("#usb-connection-dialog").open, true);
    await fire("#usb-connection-close", "click");
    await fire("#bluetooth-open", "click"); await null;
    assert.equal(el("#bluetooth-connection-dialog").open, true);
    assert.equal(scans, 0, "opening a dialog must not scan without another user gesture");
    assert.match(el("#bluetooth-connection-status").textContent, /Enter the control key/);
    assert.equal(el("#direct-ble-control-key").disabled, false);
    el("#direct-ble-control-key").value = "not-a-key";
    await fire("#bluetooth-scan", "click");
    await null;
    assert.equal(scans, 0, "invalid input must not open the device chooser");
    assert.match(el("#bluetooth-connection-status").textContent, /Invalid Control key/);
    assert.match(el("#status-message").textContent, /Invalid Control key/);
    await fire("#bluetooth-open", "click"); await null;
    assert.match(el("#bluetooth-connection-status").textContent, /Invalid Control key/,
      "another disconnected render preserves the error");
    failure = true;
    el("#direct-ble-control-key").value = "cd".repeat(32);
    let scan = fire("#bluetooth-scan", "click");
    assert.equal(usedKey, "cd".repeat(32));
    assert.equal(el("#direct-ble-control-key").value, "", "the key input is cleared as soon as it is submitted");
    await null;
    assert.equal(el("#bluetooth-scan").disabled, true);
    assert.equal(el("#direct-ble-control-key").disabled, true);
    const cancel = new Event("cancel", { cancelable: true });
    el("#bluetooth-connection-dialog").dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true, "do not dismiss while a picker/connection is pending");
    finishScan(); await scan;
    assert.match(el("#bluetooth-connection-status").textContent, /rejected the control key/);
    assert.equal(el("#bluetooth-connection-dialog").open, true);
    assert.equal(el("#bluetooth-scan").disabled, false);
    failure = false;
    el("#direct-ble-control-key").value = "ab".repeat(32);
    scan = fire("#bluetooth-scan", "click");
    finishScan(); await scan;
    assert.equal(scans, 2);
    assert.equal(usedKey, "ab".repeat(32));
    assert.equal(el("#bluetooth-connection-dialog").open, false, "a successful unlock closes the dialog");
    assert.equal(el("#usb-open").disabled, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(el("#settings-clock").disabled, false, "BLE enables clock configuration");
    assert.equal(el("#direct-settings-wifi").disabled, true, "radio assignments stay USB-only");
    assert.equal(el("#direct-settings-ble").disabled, true, "radio assignments stay USB-only");
    assert.equal(el("#direct-wifi-scan").disabled, true, "Wi-Fi provisioning actions stay USB-only");
    assert.equal(el("#direct-ble-generate").disabled, true, "Control-key provisioning stays USB-only");
    await fire("#settings-reboot", "click");
    await fire("#confirm-reboot", "click");
    assert.deepEqual(settingsCommands, [["reboot", true]]);
    el("#settings-clock").value = "160";
    await fire("#settings-clock", "change"); await null;
    await fire("#settings-save", "click");
    assert.equal(el("#configuration-dialog-profile").textContent, "System clock: 160 MHz.",
      "Bluetooth saves keep the saved radio switches");
    assert.equal(el("#direct-configuration-wireless-warning").hidden, true);
    await fire("#confirm-configuration", "click");
    assert.deepEqual(settingsCommands[1], ["save",
      { system_clock_mhz: 160, sdcard_profile: 0, radios: 0 }]);
    await sync({ reboot_pending: false });
    await sync({ wireless: { wifi_enabled: true, wifi_state: "connected", ssid: "HomeDev", ipv4: "192.168.66.87" } });
    assert.equal(el("#direct-wifi-state").textContent, "HomeDev (192.168.66.87)");
    assert.equal(el("#direct-wifi-state").children.length, 0, "ESPForge has no TCP console link");
    await sync({ pending_request: { opcode: 2, transaction_id: 1 }, outcome_uncertain: true });
    assert.equal(el("#usb-open").disabled, true);
    await fire("#bluetooth-open", "click"); await null;
    assert.match(el("#bluetooth-connection-status").textContent, /Connected to ESPForge-0102/);
    assert.equal(el("#direct-ble-control-key").disabled, true);
    assert.equal(el("#bluetooth-scan").textContent, "Disconnect", "one button toggles while connected");
    assert.equal(el("#bluetooth-scan").disabled, false);
    await fire("#bluetooth-scan", "click");
    assert.equal(client.transport.bleKey, null);
    assert.equal(el("#usb-open").disabled, true, "disconnect must not discard a pending command to switch transport");
    await sync({ outcome_uncertain: false, pending_request: null });
    assert.equal(el("#usb-open").disabled, false);
    el("#direct-ble-control-key").value = "ab".repeat(32);
    await fire("#bluetooth-connection-close", "click");
    assert.equal(el("#direct-ble-control-key").value, "", "closing the dialog discards an unsubmitted key");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    await fire("#usb-open", "click"); await null;
    await fire("#bluetooth-open", "click"); await null;
    await sync({});
    assert.equal(el("#bluetooth-scan").disabled, true);
    assert.match(el("#bluetooth-connection-status").textContent, /supported browser/);
    Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: false });
    await sync({});
    assert.equal(el("#usb-connect").disabled, true);
    windowHandlers.get("pagehide")({ persisted: true });
    assert.equal(client.disposed, true, "cached pages still release board resources");
    windowHandlers.get("pageshow")({ persisted: true });
    assert.equal(reloads, 1, "history-cache restoration loads a fresh disconnected dashboard");
    assert.equal(scans, 2, "restoration must not reconnect or replay operations");
  } finally {
    for (const [name, method] of prototypes) BoardSession.prototype[name] = method;
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    if (saved.location === undefined) delete globalThis.location;
    else globalThis.location = saved.location;
    for (const [name, descriptor] of [["navigator", saved.navigator], ["isSecureContext", saved.secure],
      ["sessionStorage", saved.sessionStorage], ["crypto", saved.crypto]]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
