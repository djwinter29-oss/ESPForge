// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { bindWirelessForm, renderWirelessStatus } from "../../src/js/wireless-form.mjs";
import { renderStatus } from "../../src/js/dashboard.mjs";
import { domFixture } from "../support/dom-fixture.mjs";

function formFixture(context, overrides = {}) {
  const previous = globalThis.document;
  const fixture = domFixture();
  const el = id => fixture.el(`#${id}`);
  el("settings-wifi").value = "1";
  el("settings-ble").value = "0";
  globalThis.document = fixture.document;
  const form = bindWirelessForm({
    ready: () => true, supported: () => true,
    test: async () => ({ ipv4: "192.0.2.1", remaining_seconds: 600, test_generation: 1, test_id: "a".repeat(32) }),
    cancelTest: async () => {},
    ...overrides,
  });
  form.initialize({ ssid: "saved", wifi_enabled: true, ble_enabled: false,
    ble_key_configured: false, tcp_cli_enabled: false });
  context.after(() => { form.reset(); globalThis.document = previous; });
  return { form, el };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("Wi-Fi status stays plain text even when a snapshot includes a legacy shell URL", context => {
  const previous = globalThis.document;
  const fixture = domFixture();
  globalThis.document = fixture.document;
  context.after(() => { globalThis.document = previous; });
  const state = { connected: true, hardware: { capabilities: 128 }, wireless: {
    wifi_enabled: true, wifi_state: "connected", ssid: "<script>", ipv4: "192.168.1.9",
  } };
  renderStatus({ ...state, console_url: "/console?board=selected" });
  const status = fixture.el("#wifi-state");
  assert.equal(status.children.length, 0);
  assert.equal(status.textContent, "<script> (192.168.1.9)");
  for (const changed of [{ ...state, connected: false }, { ...state, wireless_error: "Stale" },
    { ...state, wireless: { ...state.wireless, stale: true } },
    { ...state, wireless: { ...state.wireless, wifi_state: "connecting" } }]) {
    renderStatus({ ...changed, console_url: "/console?board=selected" });
    assert.equal(status.children.length, 0);
  }
});

test("Configure opens radio dialogs without changing saved or drafted radio choices", async context => {
  let changes = 0;
  const { form, el } = formFixture(context, { changed: () => { changes++; } });
  form.initialize({ ssid: "saved", wifi_enabled: true, ble_enabled: false, ble_key_configured: true });
  for (const [radio, saved, drafted] of [["wifi", "1", "0"], ["ble", "0", "1"]]) {
    const select = el(`settings-${radio}`);
    select.value = "configure";
    await select.fire("change");
    assert.equal(el(`${radio}-dialog`).open, true);
    assert.equal(select.value, saved);
    assert.equal(form.dirty(), false);
    assert.equal(changes, 0);
    el(`${radio}-dialog`).close();
    select.value = drafted;
    await select.fire("change");
    const request = form.request();
    const previousChanges = changes;
    select.value = "configure";
    await select.fire("change");
    assert.equal(select.value, drafted);
    assert.deepEqual(form.request(), request);
    assert.equal(changes, previousChanges);
    form.reset();
    form.initialize({ ssid: "saved", wifi_enabled: true, ble_enabled: false, ble_key_configured: true });
    changes = 0;
  }
});

test("Configure respects readiness and disabled radio controls while restoring their value", async context => {
  let ready = true, supported = true;
  const { form, el } = formFixture(context, { ready: () => ready, supported: () => supported });
  for (const gate of ["ready", "supported", "disabled"]) {
    ready = gate !== "ready";
    supported = gate !== "supported";
    form.update();
    for (const radio of ["wifi", "ble"]) {
      const select = el(`settings-${radio}`);
      select.disabled = gate === "disabled";
      select.value = "configure";
      await select.fire("change");
      assert.equal(el(`${radio}-dialog`).open, false);
      assert.equal(select.value, radio === "wifi" ? "1" : "0");
      assert.equal(form.dirty(), false);
    }
  }
});

test("enabling a radio without saved or replacement credentials is blocked at serialization", async context => {
  const { form, el } = formFixture(context);
  form.initialize({ ssid: "", wifi_enabled: false, ble_enabled: false,
    ble_key_configured: false, tcp_cli_enabled: false });
  for (const [radio, reason] of [["wifi", /test.*network/i], ["ble", /generate.*key/i]]) {
    el(`settings-${radio}`).value = "1";
    await el(`settings-${radio}`).fire("change");
    assert.match(form.saveBlockReason(), reason);
    assert.throws(() => form.request(), reason);
    el(`settings-${radio}`).value = "0";
    await el(`settings-${radio}`).fire("change");
    assert.equal(form.saveBlockReason(), null);
  }
});

test("test/clear/observe sequences preserve only enables backed by saved credentials and explicit disables",
  async context => {
    for (const saved of [false, true]) for (const disable of [false, true]) {
      await context.test(`saved=${saved}, disable=${disable}`, async context => {
        let cancellations = 0;
        const { form, el } = formFixture(context, { cancelTest: async () => { cancellations++; } });
        const baseline = { ssid: saved ? "saved" : "", wifi_enabled: saved, ble_enabled: false,
          ble_key_configured: false, tcp_cli_enabled: false };
        form.initialize(baseline);
        el("wifi-ssid").value = "candidate";
        await el("wifi-ssid").fire("input");
        await el("wifi-connect").fire("click");
        if (disable) {
          el("settings-wifi").value = "0";
          await el("settings-wifi").fire("input");
          await el("settings-wifi").fire("change");
          await new Promise(resolve => setImmediate(resolve));
        } else await el("wifi-cancel").fire("click");
        for (let poll = 0; poll < 3; poll++) form.initialize(baseline);
        assert.equal(cancellations, 1);
        assert.equal(form.selectedRadios(Number(saved)), Number(saved && !disable));
        assert.equal(form.saveBlockReason(), null);
        const request = form.request();
        assert.equal(Object.hasOwn(request, "use_tested_wifi"), false);
        if (saved && disable) assert.equal(request.ssid, "");
        else assert.equal(Object.hasOwn(request, "ssid"), false);
      });
    }
  });

test("confirmation identity tracks key and tested-pair replacements without retaining credential bytes", async context => {
  let generation = 0;
  const { form, el } = formFixture(context, {
    test: async () => ({ remaining_seconds: 600, test_generation: ++generation,
      test_id: String(generation).repeat(32) }),
  });
  const initial = form.saveIdentity();
  await el("ble-generate").fire("click");
  const withKey = form.saveIdentity();
  assert.notEqual(withKey, initial);
  assert.equal(withKey.includes(el("ble-secret").value), false);
  el("wifi-password").value = "private-passphrase";
  await el("wifi-password").fire("input");
  await el("wifi-connect").fire("click");
  const firstPair = form.saveIdentity();
  assert.equal(firstPair.includes("private-passphrase"), false);
  await el("wifi-connect").fire("click");
  assert.notEqual(form.saveIdentity(), firstPair);
});

test("failed conflict cleanup preserves drafts and requires explicit retry before discard", async context => {
  for (const uncertain of [false, true]) {
    await context.test(uncertain ? "unknown delivery" : "known refusal", async context => {
      let refusing = true;
      const error = uncertain ? new TypeError("reply lost") : new Error("storage busy");
      const { form, el } = formFixture(context, {
        cancelTest: async () => { if (refusing) throw error; },
      });
      await el("wifi-connect").fire("click");
      await el("ble-generate").fire("click");
      const key = el("ble-secret").value;
      form.initialize({ ssid: "saved", wifi_enabled: true, ble_enabled: false,
        ble_key_configured: true, tcp_cli_enabled: false });
      assert.equal(form.conflicted(), true);
      assert.equal(await form.discardEdits(), false);
      assert.equal(form.conflicted(), true);
      assert.equal(el("ble-secret").value, key);
      assert.equal(el("wifi-dialog").open, true);
      assert.throws(() => form.request(), /configuration changed/);
      refusing = false;
      if (uncertain) {
        assert.equal(await form.clearTest(), false, "unknown cleanup must be reconciled, not replayed");
        form.cancelResolved(true);
      } else await el("wifi-cancel").fire("click");
      assert.equal(await form.discardEdits(), true);
      assert.equal(form.conflicted(), false);
      assert.equal(el("ble-secret").value, "");
    });
  }
});

test("only explicit radio edits can erase credentials; DOM synchronization never owns intent", async context => {
  const { form, el } = formFixture(context);
  form.initialize({ ssid: "saved", wifi_enabled: true, ble_enabled: true, ble_key_configured: true,
    tcp_cli_enabled: false });
  el("settings-wifi").value = "0";
  el("settings-ble").value = "0";
  assert.deepEqual(form.credentialActions(), { wifi: "preserve", ble: "preserve" });
  assert.equal(form.dirty(), false);
  assert.equal(form.request().wifi_enabled, true);
  assert.equal(form.request().ble_enabled, true);
  for (const radio of ["wifi", "ble"]) {
    await el(`settings-${radio}`).fire("change");
    assert.equal(form.radioEdited(radio), true);
    assert.equal(form.credentialActions()[radio], "erase");
  }
  assert.deepEqual(form.request(), { wifi_enabled: false, ble_enabled: false,
    ssid: "", password: "", ble_key: "", confirm_reboot: true });
  for (const radio of ["wifi", "ble"]) {
    el(`settings-${radio}`).value = "1";
    await el(`settings-${radio}`).fire("change");
    assert.equal(form.radioEdited(radio), false);
  }
  assert.deepEqual(form.credentialActions(), { wifi: "preserve", ble: "preserve" });
  assert.equal(form.dirty(), false);
});

test("credential requests use draft values rather than later DOM changes", async context => {
  const { form, el } = formFixture(context);
  el("wifi-ssid").value = "tested";
  await el("wifi-ssid").fire("input");
  el("wifi-password").value = "password";
  await el("wifi-password").fire("input");
  el("wifi-ssid").value = "dom-only";
  await el("wifi-connect").fire("click");
  assert.equal(form.request().ssid, "tested");
  await el("ble-generate").fire("click");
  const key = el("ble-secret").value;
  el("ble-secret").value = "dom-only";
  assert.equal(form.request().ble_key, key);
  assert.equal(Object.hasOwn(form.request(), "tcp_cli_enabled"), false, "ESPForge has no TCP CLI switch");
});

test("native input then change disables a tested pair with one cleanup and preserves the disable", async context => {
  const pending = deferred();
  let cancels = 0;
  const { form, el } = formFixture(context, {
    cancelTest: () => { cancels++; return pending.promise; },
  });
  await el("wifi-connect").fire("click");
  el("settings-wifi").value = "0";
  await el("settings-wifi").fire("input");
  await el("settings-wifi").fire("change");
  assert.equal(cancels, 1);
  assert.equal(form.inFlight(), true);
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el("settings-wifi").value, "0");
  assert.equal(form.inFlight(), false);
  assert.equal(form.request().ssid, "");
  assert.equal(form.request().password, "");
  assert.equal(Object.hasOwn(form.request(), "use_tested_wifi"), false);
});

test("clipboard feedback belongs to the current key draft and board lifecycle", async context => {
  for (const change of ["current", "regenerate", "disable", "saved", "failed-save", "reset"]) {
    for (const succeeds of [true, false]) {
      await context.test(`${change}: late clipboard ${succeeds ? "success" : "failure"}`, async context => {
        const pending = deferred();
        const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
        const copied = [];
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
          clipboard: { writeText: text => { copied.push(text); return pending.promise; } },
        } });
        context.after(() => {
          if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
          else delete globalThis.navigator;
        });
        const { form, el } = formFixture(context);
        await el("ble-generate").fire("click");
        const copy = el("ble-copy").fire("click");
        assert.equal(copied.length, 1);
        if (change === "regenerate") {
          await el("ble-generate").fire("click");
          assert.notEqual(el("ble-secret").value, copied[0]);
        } else if (change === "disable") {
          el("settings-ble").value = "0";
          await el("settings-ble").fire("change");
        } else if (change === "saved") form.finish({ ssid: "saved", ble_key_configured: true });
        else if (change === "failed-save") form.finish(null, "Save failed");
        else if (change === "reset") form.reset();
        const feedback = el("ble-status").textContent;
        if (succeeds) pending.resolve();
        else pending.reject(new Error("clipboard unavailable"));
        await copy;
        if (change === "current") {
          assert.match(el("ble-status").textContent, succeeds ? /Key copied/ : /Could not copy key: clipboard unavailable/);
        } else assert.equal(el("ble-status").textContent, feedback);
        if (change === "failed-save") {
          assert.equal(feedback, "Save failed");
          assert.notEqual(form.saveBlockReason(), null);
          assert.throws(() => form.request(), /Generate a replacement/);
          el("settings-ble").value = "0";
          await el("settings-ble").fire("change");
          assert.equal(form.saveBlockReason(), null, "disabling releases failed-key recovery");
        }
      });
    }
  }
});

test("failed replacement Wi-Fi testing invalidates the previous stage and blocks Save until known cleanup", async context => {
  let fails = false;
  const { form, el } = formFixture(context, {
    test: async () => {
      if (fails) throw new Error("access point refused");
      return { ipv4: "192.0.2.1", remaining_seconds: 600, test_generation: 1, test_id: "a".repeat(32) };
    },
  });
  await el("wifi-connect").fire("click");
  assert.equal(form.saveBlockReason(), null);
  fails = true;
  await el("wifi-connect").fire("click");
  assert.equal(form.dirty(), true);
  assert.notEqual(form.saveBlockReason(), null);
  assert.throws(() => form.request(), /Test the connection again or clear/);
  await el("wifi-cancel").fire("click");
  assert.equal(form.saveBlockReason(), null);
  assert.equal(form.dirty(), false);
});

test("reset fences wireless continuations, including errors", async context => {
  for (const operation of ["scan", "cancel", "test"]) {
    for (const succeeds of [true, false]) {
      await context.test(`${operation}: late ${succeeds ? "success" : "failure"}`, async context => {
        const pending = deferred();
        const { form, el } = formFixture(context, {
          scan: () => pending.promise, cancelTest: () => pending.promise,
          ...(operation === "test" ? { test: () => pending.promise } : {}),
        });
        if (operation === "cancel") await el("wifi-connect").fire("click");
        const work = el({ scan: "wifi-scan", cancel: "wifi-cancel", test: "wifi-connect" }[operation]).fire("click");
        form.reset();
        form.initialize({ ssid: "saved", tcp_cli_enabled: false });
        el("wifi-status").textContent = "Current board";
        el("wifi-dialog").showModal();
        if (succeeds) pending.resolve(operation === "scan" ? [{ ssid: "old", ssid_hex: "6f6c64" }]
          : { ipv4: "192.0.2.1", remaining_seconds: 600, test_generation: 1, test_id: "a".repeat(32) });
        else pending.reject(new Error("old board error"));
        await work;
        assert.equal(el("wifi-status").textContent, "Current board");
        assert.equal(el("wifi-networks").children.length, 0);
        assert.equal(el("wifi-dialog").open, true);
        assert.equal(form.operationBusy(), false);
        assert.equal(form.saveBlockReason(), null);
      });
    }
  }
});

test("snapshot initialization preserves drafts and reset admits the next board", async context => {
  const { form, el } = formFixture(context);
  el("wifi-ssid").value = "edited network";
  await el("wifi-ssid").fire("input");
  form.initialize({ ssid: "poll must not overwrite edits", tcp_cli_enabled: false });
  assert.equal(el("wifi-ssid").value, "edited network");
  assert.notEqual(form.saveBlockReason(), null);
  form.reset();
  form.initialize({ ssid: "current board", tcp_cli_enabled: false });
  assert.equal(el("wifi-ssid").value, "current board");
  assert.equal(form.saveBlockReason(), null);
  await el("wifi-connect").fire("click");
  const staged = form.request();
  form.initialize({ ssid: "current board", tcp_cli_enabled: false, wifi_state: "connected" });
  assert.notEqual(form.saveBlockReason(), null, "an older saved-network observation cannot authorize a staged pair");
  assert.match(form.saveBlockReason(), /Waiting.*tested pair/);
  form.initialize({ ssid: "current board", tcp_cli_enabled: false, test_generation: 1,
    pair_tested: true, ssid_staged: true, password_staged: true });
  assert.deepEqual(form.request(), staged);
});

test("clean wireless settings follow authoritative configuration rather than the first poll forever", async context => {
  const { form, el } = formFixture(context);
  const fresh = { ssid: "new network", ssid_hex: "6e6577", wifi_enabled: true,
    ble_enabled: false, ble_key_configured: false, tcp_cli_enabled: false };
  form.initialize({ ...fresh, stale: true });
  assert.equal(el("wifi-ssid").value, "saved", "stale facts cannot replace the baseline");
  form.initialize(fresh);
  assert.equal(el("wifi-ssid").value, fresh.ssid);
  assert.equal(form.dirty(), false);
  await el("ble-generate").fire("click");
  const request = form.request();
  assert.equal(Object.hasOwn(request, "tcp_cli_enabled"), false);
  assert.equal(Object.hasOwn(request, "ssid"), false);
  assert.equal(Object.hasOwn(request, "ssid_hex"), false);
});

test("configuration changes conflict with drafts without overwriting them or treating live telemetry as configuration",
  async context => {
    for (const draft of ["wifi-input", "wifi-stage", "ble-key", "radio"]) {
      await context.test(draft, async context => {
        const { form, el } = formFixture(context);
        const baseline = { ssid: "saved", ssid_hex: "7361766564", wifi_enabled: true,
          ble_enabled: false, ble_key_configured: true, tcp_cli_enabled: false };
        form.initialize(baseline);
        if (draft === "wifi-input") {
          el("wifi-ssid").value = "draft";
          el("wifi-password").value = "password";
          await el("wifi-ssid").fire("input");
        } else if (draft === "wifi-stage") await el("wifi-connect").fire("click");
        else if (draft === "ble-key") await el("ble-generate").fire("click");
        else {
          el("settings-ble").value = "1";
          await el("settings-ble").fire("change");
        }
        const values = ["wifi-ssid", "wifi-password", "ble-secret", "settings-ble"]
          .map(id => el(id).value);
        form.initialize({ ...baseline, ipv4: "192.0.2.2", wifi_state: "connected", scan_generation: 8 });
        assert.doesNotMatch(form.saveBlockReason() ?? "", /configuration changed/);
        form.initialize({ ...baseline, ble_key_configured: false });
        assert.deepEqual(["wifi-ssid", "wifi-password", "ble-secret", "settings-ble"]
          .map(id => el(id).value), values);
        assert.match(form.saveBlockReason(), /configuration changed.*Discard wireless edits/);
        assert.notEqual(form.saveBlockReason(), null);
        assert.throws(() => form.request(), /configuration changed/);
        assert.equal(await form.discardEdits(), true);
        form.initialize({ ...baseline, ble_key_configured: false });
        assert.equal(form.saveBlockReason(), null);
        assert.equal(el("ble-secret").value, "");
      });
    }
  });

test("Wi-Fi expiry notifies Save eligibility once and stops its countdown", async context => {
  let now = 0, wall = 0, changes = 0;
  const ticks = new Map();
  let timer = 0;
  context.mock.method(Date, "now", () => wall);
  context.mock.method(performance, "now", () => now);
  context.mock.method(globalThis, "setInterval", callback => { ticks.set(++timer, callback); return timer; });
  context.mock.method(globalThis, "clearInterval", id => ticks.delete(id));
  const { form, el } = formFixture(context, {
    changed: () => changes++,
    test: async () => ({ ipv4: "192.0.2.1", remaining_seconds: 1, test_generation: 1, test_id: "a".repeat(32) }),
  });
  await el("wifi-connect").fire("click");
  assert.equal(form.saveBlockReason(), null);
  const before = changes;
  wall = 3600000;
  now = 999;
  for (const tick of ticks.values()) tick();
  assert.equal(form.saveBlockReason(), null, "wall-clock changes cannot expire the stage");
  assert.equal(changes, before);
  wall = -3600000;
  now = 1000;
  for (const tick of ticks.values()) tick();
  assert.notEqual(form.saveBlockReason(), null);
  assert.equal(changes, before + 1);
  assert.equal(ticks.size, 0);
  assert.notEqual(form.saveBlockReason(), null, "a backward clock change cannot extend the stage");
});

test("candidate mismatches are recoverable while saved-configuration changes still require explicit reload",
  async context => {
  const baseline = { ssid: "saved", ssid_hex: "7361766564", wifi_enabled: true,
    ble_enabled: false, ble_key_configured: false, tcp_cli_enabled: false };
  const candidate = { ...baseline, ssid: "different", ssid_hex: "646966666572656e74",
    test_generation: 255, pair_tested: true, ssid_staged: true, password_staged: true, wifi_state: "test_joined" };
  for (const changes of [{}, { test_generation: 1 }, { pair_tested: false }, { ssid_staged: false },
    { password_staged: false }, { ssid_hex: "666f726569676e" },
    { ble_enabled: true }, { wifi_enabled: false }, { ble_key_configured: true }, { stale: true }]) {
    await context.test(JSON.stringify(changes), async context => {
      const { form, el } = formFixture(context, {
        test: async () => ({ ipv4: "192.0.2.1", remaining_seconds: 600, test_generation: 255, test_id: "a".repeat(32) }),
      });
      form.initialize(baseline);
      el("wifi-ssid").value = candidate.ssid;
      await el("wifi-ssid").fire("input");
      await el("wifi-connect").fire("click");
      form.initialize({ ...candidate, ...changes });
      const accepted = !Object.keys(changes).length || changes.stale === true;
      assert.equal((form.saveBlockReason() === null), accepted);
      assert.equal(form.dirty(), true);
      assert.equal(el("wifi-ssid").value, candidate.ssid, "conflicts must not erase the local draft");
      if (accepted) assert.equal(form.request().ssid, candidate.ssid);
      else if (Object.keys(changes).some(field =>
        ["ble_enabled", "wifi_enabled", "ble_key_configured"].includes(field)))
        assert.match(form.saveBlockReason(), /configuration changed.*Discard wireless edits/);
      else {
        assert.match(form.saveBlockReason(), /Waiting.*tested pair/);
        form.initialize(candidate);
        assert.equal(form.saveBlockReason(), null, "a matching newer observation clears the recoverable gate");
      }
    });
  }
});

test("a failed new-network candidate stays cleanup-blocked without creating a permanent saved-configuration conflict",
  async context => {
    const { form, el } = formFixture(context, {
      test: async () => { throw new Error("password rejected"); },
    });
    const baseline = { ssid: "saved", ssid_hex: "7361766564", wifi_enabled: true,
      ble_enabled: false, ble_key_configured: false, tcp_cli_enabled: false };
    form.initialize(baseline);
    el("wifi-ssid").value = "different";
    await el("wifi-ssid").fire("input");
    await el("wifi-connect").fire("click");
    form.initialize({ ...baseline, ssid: "different", ssid_hex: "646966666572656e74",
      test_generation: 1, pair_tested: false, ssid_staged: true, password_staged: true,
      wifi_state: "test_failed", wifi_state_id: 6 });
    assert.notEqual(form.saveBlockReason(), null, "a failed candidate can never authorize Save");
    assert.match(form.saveBlockReason(), /Test the connection again or clear/);
    await el("wifi-cancel").fire("click");
    form.initialize({ ...baseline, test_generation: 1, pair_tested: false,
      ssid_staged: false, password_staged: false, wifi_state: "connected" });
    assert.equal(form.saveBlockReason(), null, "known cleanup restores the saved baseline without a reload");
    assert.equal(Object.hasOwn(form.request(), "ssid_hex"), false);
  });

test("connection-test progress uses monotonic elapsed time despite wall-clock changes", async context => {
  let now = 0, wall = 0;
  const ticks = new Map();
  let timer = 0;
  context.mock.method(performance, "now", () => now);
  context.mock.method(Date, "now", () => wall);
  context.mock.method(globalThis, "setInterval", callback => { ticks.set(++timer, callback); return timer; });
  context.mock.method(globalThis, "clearInterval", id => ticks.delete(id));
  const pending = deferred();
  const { el } = formFixture(context, { test: () => pending.promise });
  const work = el("wifi-connect").fire("click");
  wall = 3600000;
  now = 2000;
  for (const tick of ticks.values()) tick();
  assert.match(el("wifi-status").textContent, /2s \(up to 30s\)/);
  wall = -3600000;
  now = 30000;
  for (const tick of ticks.values()) tick();
  assert.match(el("wifi-status").textContent, /30s; waiting for the final result/);
  pending.resolve({ ipv4: "192.0.2.1", remaining_seconds: 600, test_generation: 1, test_id: "a".repeat(32) });
  await work;
});

test("scanned network buttons expose raw-SSID selection and clear it for manual entry", async context => {
  const { form, el } = formFixture(context, {
    scan: async () => [{ ssid: "one", ssid_hex: "6f6e65" }, { ssid: "two", ssid_hex: "74776f" }],
  });
  await el("wifi-scan").fire("click");
  const [one, two] = el("wifi-networks").children;
  await one.fire("click");
  assert.equal(one.attributes["aria-pressed"], "true");
  assert.equal(two.attributes["aria-pressed"], "false");
  await two.fire("click");
  assert.equal(one.attributes["aria-pressed"], "false");
  assert.equal(two.attributes["aria-pressed"], "true");
  await el("wifi-other").fire("click");
  assert.equal(two.attributes["aria-pressed"], "false");
  assert.equal(el("wifi-ssid").value, "");
  assert.notEqual(form.saveBlockReason(), null);
});

test("keyless Bluetooth reports that a control key is needed; unavailable reports stay distinct", () => {
  const previous = globalThis.document;
  const elements = new Map();
  globalThis.document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {});
    return elements.get(selector);
  } };
  const snapshot = { connected: true, hardware: { capabilities: 128, serial_number: "AB" }, wireless: {
    wifi_enabled: true, ssid: "saved", wifi_state: "failed", ble_enabled: true, ble_state: "off",
    ble_key_configured: false, restart_required: false,
  } };
  try {
    renderWirelessStatus(snapshot);
    assert.equal(elements.get("#ble-state").textContent, "Off (no control key)");
    assert.doesNotMatch(elements.get("#wifi-state").textContent, /key/);
    renderWirelessStatus({ ...snapshot, wireless: { ...snapshot.wireless, ble_key_configured: true } });
    assert.equal(elements.get("#ble-state").textContent, "ESPForge-AB (starting)");
    renderWirelessStatus({ ...snapshot, connected: false });
    assert.equal(elements.get("#wifi-state").textContent, "--");
    renderWirelessStatus({ ...snapshot, wireless_error: "Read failed" });
    assert.equal(elements.get("#wifi-state").textContent, "Unavailable");
    assert.equal(elements.get("#wifi-state").title, "Read failed");
  } finally { globalThis.document = previous; }
});

test("radio choices follow credentials and expired test credentials block saving", async context => {
  const previous = globalThis.document;
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, {
      value: "", children: [], handlers: {},
      label: { hidden: true, toggleAttribute(name, hidden) { this[name] = hidden; } },
      closest() { return this.label; },
      options: ["0", "1", "configure"].map(value => ({ value })),
      addEventListener(event, callback) { this.handlers[event] = callback; },
      replaceChildren() {}, close() {}, showModal() {},
    });

    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => el(selector.slice(1)) };
  let now = 100;
  const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  context.mock.method(performance, "now", () => now);
  const status = { ssid: "saved", wifi_enabled: true, tcp_cli_enabled: false,
    ble_key_configured: false };
  let supported = true, ready = true;
  try {
    el("settings-wifi").value = "1";
    el("settings-ble").value = "0";
    const form = bindWirelessForm({ ready: () => ready, supported: () => supported,
      test: async () => ({ ipv4: "192.168.1.2", remaining_seconds: 600, test_generation: 1, test_id: "a".repeat(32) }),
      cancelTest: async () => {} });
    form.initialize(status);
    assert.equal(form.dirty(), false);
    assert.equal(Object.hasOwn(form.request(), "tcp_cli_enabled"), false);
    const bleOn = () => el("settings-ble").options.find(option => option.value === "1");
    assert.equal(bleOn().disabled, true, "Bluetooth cannot be enabled without a saved or staged key");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: bytes => bytes.fill(1) } });
    el("ble-generate").handlers.click();
    assert.equal(bleOn().disabled, false);
    assert.equal(el("settings-ble").value, "1", "generating a key enables Bluetooth");
    assert.equal(Object.hasOwn(form.request(), "tcp_cli_auth_required"), false);
    el("settings-ble").value = "0";
    form.update();
    ready = false;
    form.update();
    ready = true;
    form.update();
    el("wifi-ssid").value = "tested";
    el("wifi-ssid").handlers.input();
    await el("wifi-connect").handlers.click();
    assert.equal(form.request().use_tested_wifi, true);
    assert.equal(form.saveBlockReason(), null);
    el("wifi-ssid").value = "edited-network";
    el("wifi-ssid").handlers.input();
    assert.notEqual(form.saveBlockReason(), null);
    assert.throws(() => form.request(), /test the connection again/);
    el("wifi-password").value = "new-passphrase";
    el("wifi-password").handlers.input();
    assert.notEqual(form.saveBlockReason(), null);
    await el("wifi-connect").handlers.click();
    assert.equal(form.request().ssid, "edited-network");
    assert.equal(form.request().use_tested_wifi, true);
    now += 600000;
    form.update();
    assert.notEqual(form.saveBlockReason(), null);
    assert.throws(() => form.request(), /expired/);
    assert.match(el("wireless-summary").textContent, /expired/);
    el("settings-wifi").value = "0";
    el("settings-wifi").handlers.change();
    await new Promise(resolve => setImmediate(resolve));
    form.update();
    assert.equal(form.saveBlockReason(), null, "expired credentials do not prevent disabling Wi-Fi");
    const disabled = form.request();
    assert.equal(disabled.wifi_enabled, false);
    assert.equal(disabled.password, "");
    assert.equal(disabled.ssid, "");
    assert.equal(Object.hasOwn(disabled, "use_tested_wifi"), false);
    assert.equal(el("wireless-summary").hidden, true);
    form.reset();
    form.update();
    supported = false;
    form.update();
    for (const radio of ["wifi", "ble"])
      assert.equal(el(`settings-${radio}`).options.find(option => option.value === "configure").disabled, true,
        "non-wireless boards lock wireless configuration");
  } finally {
    globalThis.document = previous;
    if (previousCrypto) Object.defineProperty(globalThis, "crypto", previousCrypto);
    else delete globalThis.crypto;
  }
});

test("scanned opaque SSIDs retain their bytes through testing and saving; manual edits use UTF-8", async () => {
  const previous = globalThis.document;
  const elements = new Map();
  const node = () => ({
    value: "", children: [], handlers: {}, dataset: {}, setAttribute() {},
    options: ["0", "1", "configure"].map(value => ({ value })),
    label: { toggleAttribute() {} }, closest() { return this.label; },
    addEventListener(event, callback) { this.handlers[event] = callback; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    showModal() { this.open = true; }, close() { this.open = false; },
  });
  const el = id => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => el(selector.slice(1)), createElement: node };
  const requests = [];
  let form;
  try {
    el("settings-wifi").value = "1";
    el("settings-ble").value = "0";
    form = bindWirelessForm({
      ready: () => true, supported: () => true,
      scan: async () => [{ ssid: "\\xFF\\x00", ssid_hex: "ff00", rssi: -30, secured: false }],
      test: async request => {
        requests.push(request);
        return { ipv4: "192.0.2.1", remaining_seconds: 600, test_generation: requests.length,
          test_id: "a".repeat(32) };
      },
      cancelTest: async () => {},
    });
    form.initialize({ ssid: "saved", ssid_hex: "7361766564", tcp_cli_enabled: false });
    await el("wifi-scan").handlers.click();
    el("wifi-networks").children[0].handlers.click();
    await el("wifi-connect").handlers.click();
    assert.equal(requests[0].ssid_hex, "ff00");
    assert.equal(form.request().ssid_hex, "ff00");
    assert.equal(form.request().use_tested_wifi, true);
    el("wifi-ssid").value = "manual";
    el("wifi-ssid").handlers.input();
    await el("wifi-connect").handlers.click();
    assert.equal(Object.hasOwn(requests[1], "ssid_hex"), false);
    assert.equal(Object.hasOwn(form.request(), "ssid_hex"), false);
  } finally {
    form?.reset();
    globalThis.document = previous;
  }
});

test("failed temporary Wi-Fi cancellation retains the stage and permits a safe retry", async () => {
  const previous = globalThis.document;
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, {
      value: id === "settings-wifi" ? "1" : "", textContent: "", children: [], handlers: {},
      options: ["0", "1", "configure"].map(value => ({ value })),
      label: { hidden: false, toggleAttribute(name, hidden) { this[name] = hidden; } },
      closest() { return this.label; },
      addEventListener(event, callback) { this.handlers[event] = callback; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      showModal() { this.open = true; },
      close() { this.open = false; },
    });
    return elements.get(id);
  };
  globalThis.document = {
    querySelector: selector => el(selector.slice(1)),
    createElement: () => ({ children: [], append(...children) { this.children.push(...children); } }),
  };
  let cancelCalls = 0;
  let cancelFailure = "busy";
  let testFailure = false;
  try {
    const form = bindWirelessForm({
      scan: async () => [],
      test: async () => {
        if (testFailure) throw new Error("test could not connect");
        return { ipv4: "192.168.1.2", remaining_seconds: 600, test_generation: 1, test_id: "a".repeat(32) };
      },
      cancelTest: async () => {
        cancelCalls++;
        if (cancelFailure === "busy") throw new Error("device is busy");
        if (cancelFailure === "timeout") throw new DOMException("request timed out", "TimeoutError");
      },
      ready: () => true,
      supported: () => true,
    });
    form.initialize({ ssid: "saved", wifi_enabled: true, ble_key_configured: false });
    el("wifi-ssid").value = "tested-network";
    el("wifi-ssid").handlers.input();
    await el("wifi-connect").handlers.click();
    el("wifi-dialog").showModal();
    await el("wifi-cancel").handlers.click();

    assert.equal(cancelCalls, 1);
    assert.equal(el("wifi-dialog").open, true, "keep the dialog open when cleanup fails");
    assert.equal(el("wifi-cancel").textContent, "Retry clearing test");
    assert.match(el("wifi-status").textContent, /device is busy/);
    assert.match(el("wireless-summary").textContent, /Open Wi-Fi settings to retry/);
    assert.notEqual(form.saveBlockReason(), null);
    assert.equal(form.operationBusy(), true, "board selection stays locked until temporary credentials are cleared");
    assert.equal(el("wifi-connect").disabled, true, "block another wireless operation until cleanup succeeds");
    assert.throws(() => form.request(), /Clear the temporary Wi-Fi test/);

    cancelFailure = "";
    await el("wifi-cancel").handlers.click();
    assert.equal(cancelCalls, 2);
    assert.equal(el("wifi-dialog").open, false);
    assert.equal(form.saveBlockReason(), null);
    assert.equal(Object.hasOwn(form.request(), "use_tested_wifi"), false);
    assert.equal(el("wireless-summary").hidden, true);

    testFailure = true;
    el("wifi-ssid").value = "failed-network";
    el("wifi-ssid").handlers.input();
    await el("wifi-connect").handlers.click();
    el("wifi-dialog").showModal();
    await el("wifi-cancel").handlers.click();
    assert.equal(cancelCalls, 3, "failed tests still leave candidates that require explicit discard");
    assert.equal(el("wifi-dialog").open, false);

    testFailure = false;
    el("wifi-ssid").value = "second-network";
    el("wifi-ssid").handlers.input();
    await el("wifi-connect").handlers.click();
    el("wifi-dialog").showModal();
    cancelFailure = "timeout";
    await el("wifi-cancel").handlers.click();
    assert.equal(form.operationBusy(), true, "unknown cleanup outcomes keep board operations locked");
    assert.match(el("wireless-summary").textContent, /Use Re-sync.*reconnect the board and reload the dashboard/);
    assert.equal(el("wifi-dialog").open, true);
    form.reset();
  } finally {
    globalThis.document = previous;
  }
});

test("Wi-Fi label stays plain text", () => {
  const saved = globalThis.document;
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      children: [],
      set textContent(value) { this.text = value; this.children = []; },
      get textContent() { return this.text; },
      querySelector() { return this.children[0]; },
      replaceChildren(...children) { this.children = children; },
    });
    return elements.get(selector);
  };
  globalThis.document = { querySelector: element, createElement: () => ({}) };
  try {
    const state = { connected: true, hardware: { capabilities: 128 },
      wireless: { wifi_enabled: true, wifi_state: "connected", tcp_cli_started: true,
        ssid: "HomeDev", ipv4: "192.168.66.87" } };
    renderWirelessStatus(state);
    assert.equal(element("#wifi-state").textContent, "HomeDev (192.168.66.87)");
    assert.equal(element("#wifi-state").children.length, 0);
  } finally { globalThis.document = saved; }
});
