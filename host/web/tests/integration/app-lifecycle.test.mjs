// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { appFixture, assertWirelessConsistent } from "../support/app-fixture.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const reply = body => ({ ok: true, status: 200, json: async () => body });
const statusSnapshot = connected => ({
  ...structuredClone(connected),
  memory: { ...connected.memory, msc: connected.msc, filesystem_format: connected.filesystem_format },
  board_configuration: { ...connected.board_configuration, ...connected.settings },
});

test("dialog keyboard interaction never registers additional confirmation cleanup listeners", async context => {
  const { handlers, elements, savedSettings } = await appFixture(context);
  const registrations = [];
  const configuration = elements.get("#configuration-dialog");
  const add = configuration.addEventListener;
  context.mock.method(configuration, "addEventListener", function (type, ...args) {
    registrations.push(type);
    return add.call(this, type, ...args);
  });
  elements.get("#settings-clock").value = "80";
  await handlers.get("#settings-clock:change")();
  for (const id of ["configuration", "reboot"]) {
    const dialog = elements.get(`#${id}-dialog`);
    dialog.showModal();
    for (let count = 0; count < 50; count++) await dialog.fire("keydown", { key: "Tab" });
    await dialog.fire("keydown", { key: "Escape" });
    assert.equal(dialog.open, false);
  }
  assert.deepEqual(registrations, [], "cleanup listeners belong to mount, not keyboard interaction");
  await handlers.get("#confirm-configuration:click")();
  assert.equal(savedSettings.length, 0, "closed confirmation never sends a command");
  await handlers.get("#settings-save:click")();
  await handlers.get("#confirm-configuration:click")();
  assert.equal(savedSettings.length, 1, "renewed confirmation still saves once");
});

test("fixture wireless baselines, staging and fault controls belong to their board", async context => {
  const { state, connected, boardStatuses, boardWireless, switchBoard, handlers, elements, configureRadio } =
    await appFixture(context);
  for (const board of boardStatuses.values()) board.hardware.capabilities |= 128;
  await state.tick();
  for (const id of ["board-a", "board-b"]) {
    await switchBoard(id);
    const snapshot = await (await fetch(`/api/status?board=${id}`, { signal: AbortSignal.timeout(5000) })).json();
    assertWirelessConsistent({ settings: snapshot.board_configuration }, snapshot.wireless);
    assert.equal(snapshot.wireless.wifi_enabled, false);
  }
  await switchBoard("board-a");
  configureRadio("wifi");
  elements.get("#wifi-ssid").value = "only-board-a";
  await handlers.get("#wifi-ssid:input")();
  await handlers.get("#wifi-connect:click")();
  assert.equal(boardWireless.get("board-a").wirelessStatus.ssid, "only-board-a");
  assert.equal(boardWireless.get("board-b").wirelessStatus, null);
  assert.equal(boardWireless.get("board-b").wirelessTestError, null);
  connected.connected = false;
  await state.tick();
  await switchBoard("board-b");
  state.wirelessTestError = new Error("only board B fails");
  assert.equal(boardWireless.get("board-a").wirelessTestError, null);
  assert.equal(elements.get("#settings-wifi").value, "0");
  assert.equal(elements.get("#wifi-ssid").value, "saved");
  assert.throws(() => assertWirelessConsistent({ settings: { radios: 0 } }, {
    wifi_enabled: true, ble_enabled: false,
  }), /matches boot bits/, "inconsistent observations require an explicit fault fixture");
});

test("Configure after a focused remote radio refresh never creates a credential erase", async context => {
  const { state, connected, elements, handlers, savedSettings, wirelessSettings, saveAndConfirm } =
    await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.settings.radios = 1;
  await state.tick();
  elements.get("#settings-ble").focus();
  connected.settings.radios = 3;
  state.wirelessStatus = { ble_enabled: true, ble_key_configured: true };
  await state.tick();
  await handlers.get("#ble-configure:click")();
  await handlers.get("#ble-cancel:click")();
  assert.equal(elements.get("#settings-ble").value, "1");
  assert.equal(elements.get("#settings-save").disabled, true, "Configure is not a configuration edit");
  elements.get("#settings-clock").value = "80";
  await handlers.get("#settings-clock:change")();
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 0);
  assert.equal(savedSettings[0].radios, 3);
});

test("Save uses recorded field drafts, not later DOM-only changes", async context => {
  const { state, connected, elements, handlers, savedSettings, saveAndConfirm } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.settings.radios = 1;
  await state.tick();
  elements.get("#settings-clock").value = "80";
  await handlers.get("#settings-clock:change")();
  elements.get("#settings-clock").value = "0";
  elements.get("#settings-wifi").value = "0";
  await saveAndConfirm();
  assert.deepEqual(savedSettings[0], { system_clock_mhz: 80, sdcard_profile: 0, radios: 1 });
});

test("Save confirmation rechecks the projected eligibility and reports the same blocking reason", async context => {
  const { state, connected, elements, handlers, savedSettings, wirelessSettings } = await appFixture(context);
  elements.get("#settings-clock").value = "80";
  await handlers.get("#settings-clock:change")();
  await handlers.get("#settings-save:click")();
  connected.storage_stale = true;
  await state.tick();
  const reason = elements.get("#settings-save").title;
  assert.equal(elements.get("#settings-save").disabled, true);
  assert.match(reason, /fresh storage status/);
  await handlers.get("#confirm-configuration:click")();
  assert.equal(savedSettings.length, 0);
  assert.equal(wirelessSettings.length, 0);
  assert.equal(elements.get("#settings-note").textContent, reason);
});

test("Save requires renewed confirmation when remote settings change the reviewed proposal", async context => {
  const { state, connected, elements, handlers, savedSettings } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.settings.radios = 1;
  await state.tick();
  elements.get("#settings-clock").value = "80";
  await handlers.get("#settings-clock:change")();
  await handlers.get("#settings-save:click")();
  assert.match(elements.get("#configuration-dialog-profile").textContent,
    /^System clock: 80 MHz\. Wi-Fi: Enabled\. Bluetooth: Disabled\./);
  connected.settings.radios = 3;
  state.wirelessStatus = { ble_enabled: true, ble_key_configured: true };
  await state.tick();
  await handlers.get("#confirm-configuration:click")();
  assert.equal(savedSettings.length, 0);
  assert.match(elements.get("#settings-note").textContent, /changed.*confirm again/);
  await handlers.get("#settings-save:click")();
  assert.match(elements.get("#configuration-dialog-profile").textContent, /Bluetooth: Enabled/);
  await handlers.get("#confirm-configuration:click")();
  assert.deepEqual(savedSettings[0], { system_clock_mhz: 80, sdcard_profile: 0, radios: 3 });
});

test("clearing the only tested network restores disabled Wi-Fi and preserves other drafts", async context => {
  const { state, connected, elements, handlers, configureRadio, savedSettings, wirelessSettings, saveAndConfirm } =
    await appFixture(context);
  connected.hardware.capabilities |= 128;
  state.wirelessStatus = { ssid: "", wifi_enabled: false };
  await state.tick();
  elements.get("#settings-clock").value = "80";
  await handlers.get("#settings-clock:change")();
  configureRadio("wifi");
  elements.get("#wifi-ssid").value = "temporary-network";
  await handlers.get("#wifi-ssid:input")();
  await handlers.get("#wifi-connect:click")();
  configureRadio("wifi");
  state.responses.set("/api/wireless/cancel", async () => {
    state.wirelessStatus = { ssid: "", wifi_enabled: false };
    return reply({ cancelled: true });
  });
  await handlers.get("#wifi-cancel:click")();
  for (let poll = 0; poll < 3; poll++) await state.tick();
  assert.equal(elements.get("#settings-wifi").value, "0");
  assert.equal(elements.get("#settings-clock").value, "80");
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 0);
  assert.deepEqual(savedSettings[0], { system_clock_mhz: 80, sdcard_profile: 0, radios: 0 });
});

test("late fixture test replies and cancellation cannot stage credentials on another board", async context => {
  const { state, boardWireless, switchBoard } = await appFixture(context);
  const pending = deferred();
  boardWireless.get("board-a").wirelessTestGate = pending.promise;
  const send = (id, ssid) => fetch(`/api/wireless/test?board=${id}`, { method: "POST",
    signal: AbortSignal.timeout(5000), body: JSON.stringify({ ssid, password: "example-secret" }) });
  const first = send("board-a", "candidate-a");
  await switchBoard("board-b");
  await send("board-b", "candidate-b");
  pending.resolve();
  await first;
  assert.equal(boardWireless.get("board-a").wirelessStatus.ssid, "candidate-a");
  assert.equal(state.wirelessStatus.ssid, "candidate-b", "selected-board controls are not origin request state");
  await fetch("/api/wireless/cancel?board=board-a", { method: "POST", signal: AbortSignal.timeout(5000) });
  assert.equal(boardWireless.get("board-a").wirelessStatus, null);
  assert.equal(boardWireless.get("board-b").wirelessStatus.ssid, "candidate-b");
});

test("malformed diagnostics preserve a key draft and valid command capabilities", async context => {
  const { connected, state, handlers, elements, configureRadio, saveAndConfirm, wirelessSettings } =
    await appFixture(context);
  connected.hardware.capabilities |= 128;
  await state.tick();
  configureRadio("ble");
  await handlers.get("#ble-generate:click")();
  const key = elements.get("#ble-secret").value;
  connected.memory.manufacturer = { id: 3, serial_number: {} };
  await state.tick();
  assert.equal(elements.get("#ble-secret").value, key);
  assert.match(elements.get("#status-message").textContent, /Unavailable diagnostic fields/);
  assert.equal(elements.get("#reboot-control").disabled, false);
  await handlers.get("#ble-cancel:click")();
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 1);
  assert.equal(wirelessSettings[0].ble_key, key);
});

test("Save confirmation identity includes credential replacements but ignores repeated observations", async context => {
  for (const replace of [false, true]) {
    await context.test(replace ? "replacement key" : "repeated status", async context => {
      const { state, connected, elements, handlers, configureRadio, wirelessSettings } = await appFixture(context);
      connected.hardware.capabilities |= 128;
      connected.settings.radios = 1;
      await state.tick();
      configureRadio("ble");
      await handlers.get("#ble-generate:click")();
      await handlers.get("#ble-cancel:click")();
      await handlers.get("#settings-save:click")();
      if (replace) await handlers.get("#ble-generate:click")();
      else for (let poll = 0; poll < 3; poll++) await state.tick();
      await handlers.get("#confirm-configuration:click")();
      assert.equal(wirelessSettings.length, replace ? 0 : 1);
      if (replace) assert.match(elements.get("#settings-note").textContent, /changed.*confirm again/);
    });
  }
});

test("local wireless discard waits for cleanup and fresh status without losing clock drafts", async context => {
  for (const staged of [false, true]) {
    await context.test(staged ? "tested pair" : "local key", async context => {
      const { state, connected, handlers, elements, configureRadio, savedSettings, wirelessSettings, saveAndConfirm } =
        await appFixture(context);
      connected.hardware.capabilities |= 128;
      connected.settings.radios = 1;
      await state.tick();
      elements.get("#settings-clock").value = "80";
      await handlers.get("#settings-clock:change")();
      if (staged) {
        configureRadio("wifi");
        elements.get("#wifi-ssid").value = "temporary-network";
        await handlers.get("#wifi-ssid:input")();
        await handlers.get("#wifi-connect:click")();
      } else {
        configureRadio("ble");
        await handlers.get("#ble-generate:click")();
        await handlers.get("#ble-cancel:click")();
      }
      state.wirelessStatus = { ...state.wirelessStatus, ble_key_configured: true };
      await state.tick();
      assert.equal(elements.get("#wireless-discard").hidden, false);
      assert.equal(elements.get("#wireless-discard").disabled, false);
      let cleanups = 0;
      const cleanup = deferred();
      state.responses.set("/api/wireless/cancel", async () => {
        cleanups++;
        await cleanup.promise;
        state.wirelessStatus = { ssid: "saved", wifi_enabled: true };
        state.wirelessReadFails = true;
        return reply({ cancelled: true });
      });
      const discarding = handlers.get("#wireless-discard:click")();
      if (staged) {
        await settle();
        assert.equal(elements.get("#settings-save").disabled, true);
        assert.notEqual(elements.get("#wifi-ssid").value, "");
        cleanup.resolve();
      }
      await discarding;
      assert.equal(cleanups, staged ? 1 : 0);
      assert.equal(elements.get("#ble-secret").value, "");
      assert.equal(elements.get("#wireless-discard").hidden, true);
      state.wirelessReadFails = false;
      await state.tick();
      assert.equal(elements.get("#settings-clock").value, "80");
      await saveAndConfirm();
      assert.equal(wirelessSettings.length, 0);
      assert.deepEqual(savedSettings[0], { system_clock_mhz: 80, sdcard_profile: 0, radios: 1 });
    });
  }
});

test("a status read started before wireless discard cannot initialize the replacement baseline", async context => {
  const { state, connected, handlers, elements, configureRadio } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.settings.radios = 1;
  await state.tick();
  configureRadio("ble");
  await handlers.get("#ble-generate:click")();
  await handlers.get("#ble-cancel:click")();
  state.wirelessStatus = { ble_key_configured: true };
  await state.tick();
  const pending = deferred();
  state.responses.set("/api/status", async () => {
    await pending.promise;
    return reply({ ...statusSnapshot(connected), wireless: { ssid: "pre-discard", wifi_enabled: true,
      ble_enabled: false, ble_key_configured: false, tcp_cli_enabled: false } });
  });
  const oldRead = state.tick();
  await handlers.get("#wireless-discard:click")();
  assert.equal(elements.get("#settings-ble").disabled, true, "wait for a post-discard observation");
  state.responses.delete("/api/status");
  pending.resolve();
  await oldRead;
  await settle();
  await settle();
  assert.doesNotMatch(elements.get("#wifi-state").textContent, /pre-discard/, "the pre-discard baseline was fenced out");
  assert.equal(elements.get("#settings-ble").disabled, false);
  assert.equal(elements.get("#settings-save").disabled, true, "fresh baseline must not manufacture a draft");
});

test("forced enable handlers cannot save radios with no saved or replacement credentials", async context => {
  for (const radio of ["wifi", "ble"]) {
    await context.test(radio, async context => {
      const { state, connected, handlers, elements, savedSettings, wirelessSettings } = await appFixture(context);
      connected.hardware.capabilities |= 128;
      state.wirelessStatus = { ssid: "", wifi_enabled: false, ble_enabled: false, ble_key_configured: false };
      await state.tick();
      elements.get(`#settings-${radio}`).value = "1";
      await handlers.get(`#settings-${radio}:change`)();
      assert.equal(elements.get("#settings-save").disabled, true);
      elements.get("#configuration-dialog").showModal();
      await handlers.get("#confirm-configuration:click")();
      assert.equal(savedSettings.length, 0);
      assert.equal(wirelessSettings.length, 0);
      assert.match(elements.get("#settings-note").textContent, radio === "wifi" ? /Test a network/ : /Generate.*key/);
    });
  }
});

test("clock drafts refresh untouched radios without manufacturing credential erasure", async context => {
  const { state, connected, elements, handlers, saveAndConfirm, savedSettings, wirelessSettings } =
    await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.settings.radios = 1;
  state.wirelessStatus = { ssid_hex: "7361766564", ble_enabled: false, ble_key_configured: false };
  await state.tick();
  elements.get("#settings-clock").value = "80";
  await handlers.get("#settings-clock:change")();
  connected.settings.radios = 3;
  state.wirelessStatus = { ssid_hex: "7361766564", ble_enabled: true, ble_key_configured: true };
  await state.tick();
  await state.tick();
  assert.equal(elements.get("#settings-ble").value, "1", "untouched radios follow the accepted baseline");
  assert.equal(elements.get("#settings-clock").value, "80");
  assert.equal(elements.get("#settings-save").disabled, false);
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 0, "an unrelated edit cannot stage or erase credentials");
  assert.deepEqual(savedSettings, [{ system_clock_mhz: 80, sdcard_profile: 0, radios: 3 }]);
});

test("local re-rendering cannot synchronize editable values or manufacture radio edit intent", async context => {
  const { state, connected, elements, handlers, saveAndConfirm, savedSettings, wirelessSettings } =
    await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.settings.radios = 1;
  await state.tick();
  elements.get("#settings-wifi").value = "0";
  elements.get("#settings-clock").value = "240";
  await handlers.get("#settings-clock:change")();
  assert.equal(elements.get("#settings-wifi").value, "0", "a cached re-render must not synchronize input values");
  elements.get("#settings-clock").value = "80";
  await handlers.get("#settings-clock:change")();
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 0, "DOM-only differences cannot authorize credential erasure");
  assert.equal(savedSettings[0].radios, 1, "untouched radio bits come from accepted saved settings");
});

test("missing first wireless status blocks radio changes but permits unrelated saves preserving saved radios",
  async context => {
    const { state, connected, elements, handlers, savedSettings, wirelessSettings, saveAndConfirm } =
      await appFixture(context);
    connected.hardware.capabilities |= 128;
    connected.settings.radios = 1;
    state.wirelessReadFails = true;
    await state.tick();
    assert.equal(elements.get("#settings-wifi").disabled, true);
    assert.match(elements.get("#settings-note").textContent, /Waiting for fresh wireless configuration/);
    elements.get("#settings-clock").value = "80";
    await handlers.get("#settings-clock:change")();
    await saveAndConfirm();
    assert.equal(savedSettings.length, 1);
    assert.equal(savedSettings[0].radios, 1);
    assert.equal(wirelessSettings.length, 0);
  });

test("a forced radio-disable handler cannot bypass a missing wireless baseline", async context => {
  const { state, connected, elements, handlers, savedSettings, wirelessSettings, saveAndConfirm } =
    await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.settings.radios = 1;
  state.wirelessReadFails = true;
  await state.tick();
  elements.get("#settings-wifi").value = "0";
  await handlers.get("#settings-wifi:change")();
  elements.get("#configuration-dialog").showModal();
  await handlers.get("#confirm-configuration:click")();
  assert.equal(savedSettings.length, 0);
  assert.equal(wirelessSettings.length, 0);
  state.wirelessReadFails = false;
  state.wirelessStatus = { ssid_hex: "7361766564" };
  await state.tick();
  assert.equal(elements.get("#settings-wifi").value, "0", "the explicit edit survives baseline initialization");
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 1);
  assert.equal(wirelessSettings[0].ssid, "");
  assert.equal(wirelessSettings[0].password, "");
});

test("post-command cached candidate reports wait recoverably instead of permanently conflicting", async context => {
  const { state, connected, handlers, elements, configureRadio, saveAndConfirm, wirelessSettings } =
    await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.settings.radios = 1;
  state.wirelessStatus = { ssid_hex: "7361766564" };
  await state.tick();
  let old;
  for (const ssid of ["candidate-one", "candidate-two"]) {
    configureRadio("wifi");
    elements.get("#wifi-ssid").value = ssid;
    await handlers.get("#wifi-ssid:input")();
    await handlers.get("#wifi-connect:click")();
    if (ssid === "candidate-one") { await state.tick(); old = structuredClone(state.wirelessStatus); }
  }
  const latest = state.wirelessStatus;
  state.wirelessStatus = old;
  await state.tick();
  assert.equal(elements.get("#settings-save").disabled, true);
  assert.match(elements.get("#wireless-summary").textContent, /Waiting.*tested pair/);
  assert.doesNotMatch(elements.get("#wireless-summary").textContent, /Reload/);
  state.wirelessStatus = latest;
  await state.tick();
  assert.equal(elements.get("#settings-save").disabled, false);
  await saveAndConfirm();
  assert.equal(wirelessSettings.length, 1);
  assert.equal(wirelessSettings[0].ssid, "candidate-two");
  assert.equal(wirelessSettings[0].test_generation, latest.test_generation);
  assert.equal(wirelessSettings[0].test_id, latest.test_id);
});

test("foreign staging cannot become a clean baseline or join an unrelated key save", async context => {
  for (const initialized of [false, true]) {
    await context.test(initialized ? "existing saved baseline" : "first ready poll", async context => {
      const { state, connected, handlers, elements, configureRadio, saveAndConfirm, wirelessSettings } =
        await appFixture(context);
      connected.hardware.capabilities |= 128;
      connected.settings.radios = 1;
      if (initialized) await state.tick();
      state.wirelessStatus = { ssid: "foreign", ssid_hex: "666f726569676e", test_generation: 9,
        ssid_staged: true, password_staged: true, pair_tested: true };
      await state.tick();
      assert.notEqual(elements.get("#wifi-ssid").value, "foreign");
      assert.match(elements.get("#wireless-summary").textContent, /Clear.*temporary.*credentials/);
      configureRadio("ble");
      await handlers.get("#ble-generate:click")();
      const key = elements.get("#ble-secret").value;
      await saveAndConfirm();
      assert.equal(wirelessSettings.length, 0);
      configureRadio("wifi");
      state.responses.set("/api/wireless/cancel", () => {
        state.wirelessStatus = { ssid: "saved", ssid_hex: "7361766564",
          ssid_staged: false, password_staged: false, pair_tested: false };
        return reply({ cancelled: true });
      });
      await handlers.get("#wifi-cancel:click")();
      await state.tick();
      assert.equal(elements.get("#ble-secret").value, key);
      assert.equal(elements.get("#settings-save").disabled, false);
      await saveAndConfirm();
      assert.equal(wirelessSettings.length, 1);
      for (const field of ["ssid", "ssid_hex", "password", "test_id", "test_generation"])
        assert.equal(Object.hasOwn(wirelessSettings[0], field), false, `unrelated save must omit ${field}`);
    });
  }
});

test("successful testing of another network survives candidate-SSID polls and saves the exact tested pair",
  async context => {
    for (const network of [
      { ssid: "new-network", ssid_hex: "6e65772d6e6574776f726b" },
      { ssid: "\\xFF\\x00", ssid_hex: "ff00" },
    ]) {
      await context.test(network.ssid, async context => {
        const { state, connected, handlers, elements, configureRadio, saveAndConfirm, wirelessSettings } =
          await appFixture(context);
        connected.hardware.capabilities |= 128;
        connected.storage_stale = false;
        connected.settings.radios = 1;
        state.wirelessStatus = { ssid_hex: "7361766564", ble_key_configured: false };
        await state.tick();
        configureRadio("wifi");
        if (network.ssid === "new-network") {
          elements.get("#wifi-ssid").value = network.ssid;
          await handlers.get("#wifi-ssid:input")();
        } else {
          state.responses.set("/api/wireless/scan", () => reply({ networks: [
            { ...network, rssi: -30, secured: false },
          ] }));
          await handlers.get("#wifi-scan:click")();
          await elements.get("#wifi-networks").children[0].fire("click");
        }
        state.responses.set("/api/wireless/test", () => reply({ test: {
          ipv4: "192.0.2.2", remaining_seconds: 600, test_generation: 255, test_id: "a".repeat(32),
        } }));
        await handlers.get("#wifi-connect:click")();
        assert.equal(elements.get("#settings-save").disabled, false);
        state.wirelessStatus = { ...network, ble_key_configured: false, wifi_state: "test_joined",
          wifi_state_id: 5, test_generation: 255, pair_tested: true, ssid_staged: true, password_staged: true };
        for (let poll = 0; poll < 3; poll++) await state.tick();
        assert.equal(elements.get("#settings-save").disabled, false,
          "the board reports the candidate SSID, not a change to the saved network");
        assert.doesNotMatch(elements.get("#wireless-summary").textContent, /configuration changed/);
        await saveAndConfirm();
        assert.equal(wirelessSettings.length, 1);
        assert.equal(wirelessSettings[0].ssid_hex ?? Buffer.from(wirelessSettings[0].ssid).toString("hex"),
          network.ssid_hex);
        assert.equal(wirelessSettings[0].use_tested_wifi, true);
        assert.match(elements.get("#settings-note").textContent, /Settings saved/);
      });
    }
  });

test("a replacement Wi-Fi test cannot mistake the previous rendered candidate for an external configuration change",
  async context => {
    const { state, connected, handlers, elements, configureRadio, saveAndConfirm, wirelessSettings } =
      await appFixture(context);
    connected.hardware.capabilities |= 128;
    connected.settings.radios = 1;
    state.wirelessStatus = { ssid_hex: "7361766564" };
    await state.tick();
    for (const ssid of ["first-candidate", "replacement-candidate"]) {
      configureRadio("wifi");
      elements.get("#wifi-ssid").value = ssid;
      await handlers.get("#wifi-ssid:input")();
      await handlers.get("#wifi-connect:click")();
      assert.equal(elements.get("#settings-save").disabled, false, "local rendering must not re-observe old status");
      await state.tick();
      assert.equal(elements.get("#settings-save").disabled, false);
    }
    await saveAndConfirm();
    assert.equal(wirelessSettings.length, 1);
    assert.equal(wirelessSettings[0].ssid, "replacement-candidate");
    assert.equal(wirelessSettings[0].use_tested_wifi, true);
  });

test("invalid status cannot discard drafts or settle unknown reboot delivery", async context => {
  for (const invalid of [{}, { connected: null }, { connected: "false" }, { connected: false, reboot_pending: "true" }]) {
    await context.test(JSON.stringify(invalid), async context => {
      const { state, connected, handlers, elements, configureRadio } = await appFixture(context);
      connected.hardware.capabilities |= 128;
      connected.storage_stale = false;
      connected.settings.radios = 1;
      connected.command_resync_supported = true;
      await state.tick();
      configureRadio("ble");
      await handlers.get("#ble-generate:click")();
      const key = elements.get("#ble-secret").value;
      state.responses.set("/api/reboot", () => { throw new TypeError("response lost"); });
      await handlers.get("#reboot-control:click")();
      await handlers.get("#confirm-reboot:click")();
      await settle();
      state.responses.set("/api/status", () => reply(invalid));
      await state.tick();
      assert.equal(elements.get("#ble-secret").value, key);
      assert.equal(elements.get("#ble-dialog").open, true);
      assert.match(elements.get("#status-message").textContent, /Status unavailable: Invalid status/);
      assert.equal(elements.get("#reboot-control").disabled, true);
      state.responses.delete("/api/status");
      await state.tick();
      assert.equal(elements.get("#reboot-control").disabled, true, "valid connected status is not a disconnect");
      assert.equal(elements.get("#command-resync").hidden, false);
      connected.connected = false;
      await state.tick();
      assert.equal(elements.get("#ble-secret").value, "", "a real disconnect still clears the draft");
      connected.connected = true;
      await state.tick();
      assert.equal(elements.get("#reboot-control").disabled, false);
    });
  }
});

test("clean wireless polls refresh the displayed baseline and an unrelated save uses the latest settings",
  async context => {
    const { state, connected, handlers, elements, configureRadio, saveAndConfirm, wirelessSettings } =
      await appFixture(context);
    connected.hardware.capabilities |= 128;
    connected.storage_stale = false;
    connected.settings.radios = 1;
    state.wirelessStatus = { ssid_hex: "7361766564", ble_key_configured: false };
    await state.tick();
    assert.equal(elements.get("#wifi-state").textContent, "saved (192.168.1.9)");
    state.wirelessStatus = { ssid: "new", ssid_hex: "6e6577", ble_key_configured: false };
    await state.tick();
    assert.equal(elements.get("#wifi-state").textContent, "new (192.168.1.9)");
    assert.equal(elements.get("#settings-save").disabled, true, "baseline synchronization is not a user edit");
    configureRadio("ble");
    await handlers.get("#ble-generate:click")();
    await saveAndConfirm();
    assert.equal(wirelessSettings.length, 1);
    assert.equal(Object.hasOwn(wirelessSettings[0], "tcp_cli_enabled"), false);
    assert.equal(Object.hasOwn(wirelessSettings[0], "ssid_hex"), false);
    assert.equal(Object.hasOwn(wirelessSettings[0], "ssid"), false);
  });

test("changed authoritative wireless configuration preserves a dirty draft and blocks both Save and its handler",
  async context => {
    const { state, connected, handlers, elements, configureRadio, wirelessSettings } = await appFixture(context);
    connected.hardware.capabilities |= 128;
    connected.storage_stale = false;
    connected.settings.radios = 1;
    state.wirelessStatus = { ssid_hex: "7361766564", ble_key_configured: false };
    await state.tick();
    configureRadio("ble");
    await handlers.get("#ble-generate:click")();
    const key = elements.get("#ble-secret").value;
    state.wirelessStatus = { ssid_hex: "7361766564", ble_key_configured: true };
    await state.tick();
    assert.equal(elements.get("#ble-secret").value, key);
    assert.equal(elements.get("#settings-ble").value, "1");
    assert.match(elements.get("#wireless-summary").textContent, /configuration changed.*Discard wireless edits/);
    assert.equal(elements.get("#settings-save").disabled, true);
    elements.get("#configuration-dialog").showModal();
    await handlers.get("#confirm-configuration:click")();
    assert.equal(wirelessSettings.length, 0);
  });

test("lost reboot delivery waits for the originating board's disconnect without replay", async context => {
  for (const resync of [false, true]) {
    await context.test(resync ? "clean-host Re-sync" : "no Re-sync support", async context => {
      const { state, connected, boardStatuses, handlers, elements, requestedUrls, switchBoard } =
        await appFixture(context);
      connected.command_resync_supported = resync;
      await state.tick();
      state.responses.set("/api/reboot", () => { throw new TypeError("request never delivered"); });
      const reboots = () => requestedUrls.filter(url => url.startsWith("/api/reboot?")).length;
      const send = async () => {
        await handlers.get("#reboot-control:click")();
        await handlers.get("#confirm-reboot:click")();
      };
      await send();
      await settle();
      assert.equal(connected.command_outcome_uncertain, false, "host has no uncertainty to reconcile");
      assert.match(elements.get("#settings-note").textContent, /Reboot outcome is uncertain/);
      assert.equal(elements.get("#reboot-control").disabled, true);
      if (resync) {
        assert.equal(elements.get("#command-resync").hidden, false, "local reboot failures expose Re-sync");
        state.resyncResult = { uncertain: false, control_result: { opcode: 6, status: "failed" } };
        await handlers.get("#command-resync:click")();
        for (let poll = 0; poll < 2; poll++) await state.tick();
        assert.equal(elements.get("#reboot-control").disabled, false, "Re-sync releases the unrelated outcome");
        assert.match(elements.get("#status-message").textContent, /Command 6 failed/);
        await send();
        assert.equal(reboots(), 2, "only an explicit user action retries the command");
        return;
      }
      assert.equal(elements.get("#command-resync").hidden, true);
      assert.match(elements.get("#status-message").textContent, /Reconnect the board/);
      await send();
      assert.equal(reboots(), 1);
      await switchBoard("board-b");
      assert.equal(elements.get("#board-model").textContent, "ESP32-S3-DevKitC-1 (ESP32-S3)");
      assert.equal(elements.get("#settings-clock").value, "160");
      assert.equal(elements.get("#reboot-control").disabled, false);
      boardStatuses.get("board-b").connected = false;
      await state.tick();
      boardStatuses.get("board-b").connected = true;
      await state.tick();
      await switchBoard("board-a");
      assert.equal(elements.get("#reboot-control").disabled, true, "another board's reconnect cannot settle A");
      state.statusFails = true;
      await state.tick();
      state.statusFails = false;
      await state.tick();
      assert.equal(elements.get("#reboot-control").disabled, true, "HTTP failure is not an observed disconnect");
      state.responses.set("/api/status", () => reply({}));
      await state.tick();
      state.responses.delete("/api/status");
      await state.tick();
      assert.equal(elements.get("#reboot-control").disabled, true, "missing connection state is not a disconnect");
      connected.connected = false;
      await state.tick();
      connected.connected = true;
      await state.tick();
      assert.equal(elements.get("#reboot-control").disabled, false, "the observed disconnect settles the reboot");
      assert.equal(reboots(), 1);
      state.responses.set("/api/reboot", () => reply({}));
      await send();
      assert.equal(reboots(), 2, "only an explicit user action retries the command");
    });
  }
});

test("final failed Re-sync releases only the reboot gate and retains explicit-retry feedback", async context => {
  for (const status of ["failed", "busy", "invalid", "unsupported"]) {
    await context.test(status, async context => {
      const { state, connected, handlers, elements, requestedUrls, switchBoard } = await appFixture(context);
      connected.command_resync_supported = true;
      await state.tick();
      state.responses.set("/api/reboot", () => { throw new TypeError("response lost"); });
      const reboots = () => requestedUrls.filter(url => url.startsWith("/api/reboot?")).length;
      await handlers.get("#reboot-control:click")();
      await handlers.get("#confirm-reboot:click")();
      await settle();
      connected.command_outcome_uncertain = true;
      await state.tick();
      state.resyncResult = { uncertain: false, control_result: { opcode: 2, status, error: "storage_busy", detail: 2 } };
      await handlers.get("#command-resync:click")();
      for (let poll = 0; poll < 2; poll++) await state.tick();
      assert.equal(elements.get("#command-resync").hidden, true);
      assert.equal(elements.get("#reboot-control").disabled, false);
      assert.match(elements.get("#status-message").textContent, new RegExp(status));
      assert.match(elements.get("#status-message").textContent, /storage_busy.*detail 2/);
      assert.match(elements.get("#status-message").textContent, /retry/i);
      assert.equal(reboots(), 1);
      await switchBoard("board-b");
      assert.doesNotMatch(elements.get("#status-message").textContent, /Retry explicitly/);
      await switchBoard("board-a");
      assert.match(elements.get("#status-message").textContent, new RegExp(status));
      state.responses.set("/api/reboot", () => reply({}));
      await handlers.get("#reboot-control:click")();
      await handlers.get("#confirm-reboot:click")();
      assert.equal(reboots(), 2);
      assert.doesNotMatch(elements.get("#status-message").textContent, /Retry explicitly/);
    });
  }
});

test("an old cancellation acknowledgement cannot erase a new draft after reconnecting the same board", async context => {
  const { state, connected, handlers, elements, configureRadio, reconnect } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.storage_stale = false;
  await state.tick();
  configureRadio("wifi");
  await handlers.get("#wifi-connect:click")();
  configureRadio("wifi");
  const pending = deferred();
  state.responses.set("/api/wireless/cancel", () => pending.promise);
  const cancelling = handlers.get("#wifi-cancel:click")();
  state.wirelessStatus = null;
  await reconnect();
  configureRadio("wifi");
  elements.get("#wifi-ssid").value = "new-network";
  await handlers.get("#wifi-ssid:input")();
  await handlers.get("#wifi-connect:click")();
  const summary = elements.get("#wireless-summary").textContent;
  assert.match(summary, /new-network.*tested/);
  pending.resolve(reply({ cancelled: true }));
  await cancelling;
  assert.equal(elements.get("#wireless-summary").textContent, summary);
});

test("late wireless failures stay owned by the originating board", async context => {
  for (const [operation, control] of [["scan", "scan"], ["test", "connect"], ["cancel", "cancel"]]) {
    await context.test(operation, async context => {
      const { state, connected, handlers, elements, configureRadio, switchBoard } = await appFixture(context);
      connected.hardware.capabilities |= 128;
      connected.storage_stale = false;
      connected.command_resync_supported = true;
      await state.tick();
      await settle();
      configureRadio("wifi");
      if (operation === "cancel") {
        await handlers.get("#wifi-connect:click")();
        configureRadio("wifi");
      }
      const pending = deferred();
      state.responses.set(`/api/wireless/${operation}`, () => pending.promise);
      const work = handlers.get(`#wifi-${control}:click`)();
      connected.connected = false;
      await state.tick();
      connected.connected = true;
      await switchBoard("board-b");
      assert.equal(elements.get("#reboot-control").disabled, false);
      pending.reject(new TypeError("board A response lost"));
      await work;
      await state.tick();
      assert.equal(elements.get("#reboot-control").disabled, false);
      assert.equal(elements.get("#command-resync").hidden, true);
      await switchBoard("board-a");
      assert.equal(elements.get("#reboot-control").disabled, true, "A retains its unresolved response");
      assert.equal(elements.get("#command-resync").hidden, false);
    });
  }
});

test("local scan uncertainty survives polling and failed recovery, then clears only on explicit confirmation", async context => {
  const { state, connected, handlers, elements, configureRadio, requestedUrls } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.storage_stale = false;
  connected.command_resync_supported = true;
  connected.command_outcome_uncertain = false;
  await state.tick();
  await settle();
  configureRadio("wifi");
  state.responses.set("/api/wireless/scan", () => reply({ invalid: true }));
  await handlers.get("#wifi-scan:click")();
  await state.tick();
  assert.equal(elements.get("#reboot-control").disabled, true);
  assert.equal(elements.get("#command-resync").hidden, false);
  assert.match(elements.get("#status-message").textContent, /uncertain.*Re-sync/i);
  await handlers.get("#wifi-scan:click")();
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/scan?")).length, 1);
  state.resyncResult = {};
  assert.equal(elements.get("#wifi-resync").hidden, false, "modal recovery remains reachable");
  await handlers.get("#wifi-resync:click")();
  assert.equal(elements.get("#reboot-control").disabled, true);
  assert.match(elements.get("#status-message").textContent, /did not establish/);
  await state.tick();
  assert.match(elements.get("#status-message").textContent, /Re-sync/i);
  state.resyncResult = { uncertain: false };
  await handlers.get("#command-resync:click")();
  assert.equal(elements.get("#command-resync").hidden, true);
  assert.equal(elements.get("#reboot-control").disabled, false);
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/scan?")).length, 1);
});

test("local uncertainty without firmware reconciliation support explains manual recovery", async context => {
  const { state, connected, handlers, elements, configureRadio } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.storage_stale = false;
  await state.tick();
  configureRadio("wifi");
  state.responses.set("/api/wireless/scan", () => reply({ networks: [null] }));
  await handlers.get("#wifi-scan:click")();
  await state.tick();
  assert.equal(elements.get("#reboot-control").disabled, true);
  assert.equal(elements.get("#command-resync").hidden, true);
  assert.match(elements.get("#status-message").textContent, /Reconnect.*reload/i);
});

test("clean-host Re-sync releases a lost cancellation for explicit retry, without assuming cleanup succeeded", async context => {
  const { state, connected, handlers, elements, configureRadio, requestedUrls } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.storage_stale = false;
  connected.command_resync_supported = true;
  connected.command_outcome_uncertain = false;
  await state.tick();
  configureRadio("wifi");
  await handlers.get("#wifi-connect:click")();
  configureRadio("wifi");
  state.responses.set("/api/wireless/cancel", () => { throw new TypeError("lost cancellation reply"); });
  await handlers.get("#wifi-cancel:click")();
  assert.equal(elements.get("#wifi-cancel").disabled, true);
  assert.equal(elements.get("#wifi-resync").hidden, false);
  await handlers.get("#wifi-resync:click")();
  assert.equal(elements.get("#wifi-cancel").disabled, false);
  assert.equal(elements.get("#settings-save").disabled, true, "unknown cleanup is not successful cleanup");
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/cancel?")).length, 1);
  state.responses.set("/api/wireless/cancel", () => reply({ cancelled: true }));
  await handlers.get("#wifi-cancel:click")();
  assert.equal(elements.get("#wifi-dialog").open, false);
  assert.equal(elements.get("#wireless-summary").hidden, true);
  assert.equal(elements.get("#reboot-control").disabled, false);
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/cancel?")).length, 2);
});

test("mounted Re-sync locks selection, preserves failure, and resets disconnected UI once", async context => {
  for (const success of [true, false]) {
    await context.test(success ? "confirmed result" : "known refusal", async context => {
      const { state, connected, elements, handlers } = await appFixture(context);
      connected.command_outcome_uncertain = true;
      connected.command_resync_supported = true;
      await state.tick();
      const pending = deferred();
      state.resyncGate = pending.promise;
      const work = handlers.get("#command-resync:click")();
      assert.equal(elements.get("#board-select").disabled, true);
      assert.equal(elements.get("#rescan-boards").disabled, true);
      elements.get("#board-select").value = "board-b";
      await handlers.get("#board-select:change")();
      assert.equal(elements.get("#board-select").value, "board-a");
      if (!success) state.resyncError = new Error("Could not confirm result");
      pending.resolve();
      await work;
      assert.equal(elements.get("#board-select").disabled, false);
      assert.equal(elements.get("#command-resync").hidden, success);
      if (!success) assert.match(elements.get("#status-message").textContent, /Could not confirm/);
      connected.connected = false;
      await state.tick();
      globalThis.document.querySelector("#wifi-status").textContent = "retained disconnected feedback";
      let clears = 0;
      elements.get("#wifi-networks").replaceChildren = () => { clears++; };
      await state.tick();
      await state.tick();
      assert.equal(clears, 0);
      assert.equal(elements.get("#wifi-status").textContent, "retained disconnected feedback");
    });
  }
});

test("acknowledged rebooting operations remain gated across old polls and board switches", async context => {
  for (const operation of ["save", "reboot", "resync"]) {
    await context.test(operation, async context => {
      const fixture = await appFixture(context);
      const { state, connected, handlers, elements, requestedUrls, saveAndConfirm, switchBoard } = fixture;
      connected.hardware.capabilities |= 128;
      connected.storage_stale = false;
      await state.tick();
      await settle();
      if (operation === "save") {
        elements.get("#settings-clock").value = "80";
        await handlers.get("#settings-clock:change")();
        await saveAndConfirm();
      } else if (operation === "resync") {
        connected.command_outcome_uncertain = true;
        connected.command_resync_supported = true;
        state.resyncResult.control_result = { status: "completed", opcode: 5 };
        await state.tick();
        await handlers.get("#command-resync:click")();
      } else {
        await handlers.get("#reboot-control:click")();
        await handlers.get("#confirm-reboot:click")();
      }
      for (let poll = 0; poll < 2; poll++) await state.tick();
      for (const id of ["#reboot-control", "#settings-save"]) assert.equal(elements.get(id).disabled, true, id);
      const count = requestedUrls.filter(url => url.startsWith("/api/reboot")).length;
      await handlers.get("#reboot-control:click")();
      await handlers.get("#confirm-reboot:click")();
      assert.equal(requestedUrls.filter(url => url.startsWith("/api/reboot")).length, count);
      const wirelessCount = requestedUrls.filter(url => url.startsWith("/api/wireless/")).length;
      await handlers.get("#wifi-scan:click")();
      elements.get("#wifi-ssid").value = "network";
      await handlers.get("#wifi-connect:click")();
      assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/")).length, wirelessCount);
      await switchBoard("board-b");
      assert.equal(elements.get("#reboot-control").disabled, false, "local gate belongs only to board A");
      await switchBoard("board-a");
      assert.equal(elements.get("#reboot-control").disabled, true);
      await fixture.reconnect();
      assert.equal(elements.get("#reboot-control").disabled, false);
    });
  }
});

test("successful save readback mismatch stays unresolved and does not replay", async context => {
  const { state, handlers, elements, savedSettings, saveAndConfirm, switchBoard, connected } = await appFixture(context);
  state.readbackMismatch = true;
  elements.get("#settings-clock").value = "80";
  await handlers.get("#settings-clock:change")();
  await saveAndConfirm();
  await settle();
  assert.match(elements.get("#settings-note").textContent, /outcome is uncertain/);
  for (let poll = 0; poll < 2; poll++) await state.tick();
  await saveAndConfirm();
  assert.equal(savedSettings.length, 1);
  assert.equal(elements.get("#reboot-control").disabled, true);
  await switchBoard("board-b");
  await switchBoard("board-a");
  await saveAndConfirm();
  assert.equal(savedSettings.length, 1);
  connected.command_outcome_uncertain = true;
  connected.command_resync_supported = true;
  await state.tick();
  await handlers.get("#command-resync:click")();
  assert.equal(elements.get("#reboot-control").disabled, true, "Re-sync cannot erase the confirmed reboot effect");
});

test("malformed mutation success bodies are unresolved, not safe retry signals", async context => {
  for (const mutation of ["settings", "reboot"]) {
    for (const invalid of ["json", "shape"]) {
      await context.test(`${mutation}: ${invalid}`, async context => {
        const fixture = await appFixture(context);
        const { state, handlers, elements, requestedUrls } = fixture;
        state.responses.set(`/api/${mutation}`, () => invalid === "json"
          ? { ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); } }
          : reply({ ok: false }));
        const execute = async () => {
          if (mutation === "settings") {
            elements.get("#settings-clock").value = "80";
            await handlers.get("#settings-clock:change")();
            await fixture.saveAndConfirm();
          }
          if (mutation === "reboot") {
            await handlers.get("#reboot-control:click")();
            await handlers.get("#confirm-reboot:click")();
          }
        };
        await execute();
        await settle();
        const count = () => requestedUrls.filter(url => url.startsWith(`/api/${mutation}?`)).length;
        assert.equal(count(), 1);
        assert.equal(elements.get("#reboot-control").disabled, true);
        await execute();
        assert.equal(count(), 1, "an unusable success reply never authorizes replay");
      });
    }
  }
});

test("malformed Re-sync cannot clear server uncertainty", async context => {
  const { state, connected, handlers, elements } = await appFixture(context);
  connected.command_outcome_uncertain = true;
  connected.command_resync_supported = true;
  await state.tick();
  state.resyncResult = {};
  await handlers.get("#command-resync:click")();
  assert.equal(elements.get("#command-resync").hidden, false);
  assert.equal(elements.get("#reboot-control").disabled, true);
  assert.match(elements.get("#status-message").textContent, /did not establish/);
});

test("unknown-board discovery uses the production 404 and the exact five-second retry limit", async context => {
  const { state, requestedUrls, elements } = await appFixture(context);
  const scans = () => requestedUrls.filter(url => url === "/api/boards").length;
  const initial = scans();
  state.statusUnknownBoard = true;
  await state.tick();
  await settle();
  assert.equal(scans(), initial + 1);
  state.now += 4999;
  await state.tick();
  await settle();
  assert.equal(scans(), initial + 1);
  state.now++;
  await state.tick();
  await settle();
  assert.equal(scans(), initial + 2);
  state.statusUnknownBoard = false;
  await state.tick();
  assert.equal(elements.get("#reboot-control").disabled, false);
  assert.equal(elements.get("#board-select").value, "board-a");
});

test("known command refusals remain explicitly retryable without waiting for reconnection", async context => {
  const { state, handlers, requestedUrls, elements } = await appFixture(context);
  state.responses.set("/api/reboot", () => ({
    ok: false, status: 409, json: async () => ({ error: "Board is busy", uncertain: false }),
  }));
  for (let attempt = 0; attempt < 2; attempt++) {
    await handlers.get("#reboot-control:click")();
    await handlers.get("#confirm-reboot:click")();
    assert.equal(elements.get("#reboot-control").disabled, false);
    assert.match(elements.get("#settings-note").textContent, /Reboot failed: Board is busy/);
  }
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/reboot?")).length, 2);
});

test("wireless mutation contract failures retain uncertainty and prevent replay", async context => {
  for (const action of ["scan", "test", "cancel", "save"]) {
    await context.test(action, async context => {
      const fixture = await appFixture(context);
      const { connected, state, handlers, elements, requestedUrls, configureRadio } = fixture;
      connected.hardware.capabilities |= 128;
      connected.storage_stale = false;
      await state.tick();
      await settle();
      configureRadio("wifi");
      elements.get("#wifi-ssid").value = "network";
      if (["cancel", "save"].includes(action)) await handlers.get("#wifi-connect:click")();
      const path = `/api/wireless${action === "save" ? "" : `/${action}`}`;
      state.responses.set(path, () => reply({}));
      const perform = () => action === "scan" ? handlers.get("#wifi-scan:click")()
        : action === "test" ? handlers.get("#wifi-connect:click")()
          : action === "cancel" ? handlers.get("#wifi-cancel:click")() : fixture.saveAndConfirm();
      await perform();
      await settle();
      const count = () => requestedUrls.filter(url => url.startsWith(`${path}?`)).length;
      assert.equal(count(), 1);
      assert.equal(elements.get("#reboot-control").disabled, true);
      await perform();
      assert.equal(count(), 1);
    });

  }
});

test("known server cleanup failures offer explicit retry without another test or Re-sync", async context => {
  const { connected, state, handlers, elements, requestedUrls } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.storage_stale = false;
  connected.wireless_cleanup_required = true;
  await state.tick();
  await settle();
  assert.equal(elements.get("#command-resync").hidden, false);
  assert.equal(elements.get("#command-resync").textContent, "Clear Wi-Fi test");
  assert.equal(elements.get("#board-select").disabled, false);
  assert.match(elements.get("#status-message").textContent, /credentials need cleanup/);
  for (const id of ["#reboot-control", "#settings-save"]) assert.equal(elements.get(id).disabled, true, id);
  const before = requestedUrls.length;
  await handlers.get("#reboot-control:click")();
  await handlers.get("#wifi-scan:click")();
  assert.equal(requestedUrls.length, before);
  state.responses.set("/api/wireless/cancel", () => ({
    ok: false, status: 409, json: async () => ({ error: "Cleanup failed", uncertain: false }),
  }));
  await handlers.get("#command-resync:click")();
  assert.match(elements.get("#wireless-summary").textContent, /Cleanup failed/);
  assert.equal(elements.get("#command-resync").disabled, false);
  state.responses.set("/api/wireless/cancel", () => {
    connected.wireless_cleanup_required = false;
    return reply({ cancelled: true });
  });
  await handlers.get("#command-resync:click")();
  assert.equal(elements.get("#command-resync").hidden, true);
  assert.equal(elements.get("#reboot-control").disabled, false);
  assert.equal(elements.get("#wireless-summary").hidden, true);
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/cancel?")).length, 2);
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/test?")).length, 0);
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/control/resync?")).length, 0);
});

test("unknown cleanup result requires Re-sync and a confirmed cancel clears local recovery state", async context => {
  const { connected, state, handlers, elements, requestedUrls } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.storage_stale = false;
  connected.wireless_cleanup_required = true;
  await state.tick();
  state.responses.set("/api/wireless/cancel", () => {
    connected.command_outcome_uncertain = true;
    connected.command_resync_supported = true;
    throw new TypeError("lost reply");
  });
  await handlers.get("#command-resync:click")();
  await state.tick();
  assert.equal(elements.get("#command-resync").textContent, "Re-sync");
  assert.equal(elements.get("#reboot-control").disabled, true);
  state.resyncResult.control_result = { status: "completed", opcode: 10 };
  state.responses.set("/api/control/resync", () => {
    connected.command_outcome_uncertain = false;
    connected.wireless_cleanup_required = false;
    return reply(state.resyncResult);
  });
  await handlers.get("#command-resync:click")();
  assert.equal(elements.get("#command-resync").hidden, true);
  assert.equal(elements.get("#reboot-control").disabled, false);
  assert.equal(elements.get("#wireless-summary").hidden, true);
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/cancel?")).length, 1);
});

test("Re-sync of a failed cancel allows only an explicit cleanup retry", async context => {
  const { connected, state, handlers, elements, requestedUrls } = await appFixture(context);
  connected.hardware.capabilities |= 128;
  connected.storage_stale = false;
  connected.wireless_cleanup_required = true;
  await state.tick();
  state.responses.set("/api/wireless/cancel", () => {
    connected.command_outcome_uncertain = true;
    connected.command_resync_supported = true;
    throw new TypeError("lost reply");
  });
  await handlers.get("#command-resync:click")();
  await state.tick();
  state.resyncResult.control_result = { status: "failed", opcode: 10 };
  await handlers.get("#command-resync:click")();
  assert.equal(elements.get("#command-resync").textContent, "Clear Wi-Fi test");
  assert.equal(elements.get("#reboot-control").disabled, true);
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/cancel?")).length, 1);
  state.responses.set("/api/wireless/cancel", () => {
    connected.wireless_cleanup_required = false;
    return reply({ cancelled: true });
  });
  await handlers.get("#command-resync:click")();
  assert.equal(elements.get("#reboot-control").disabled, false);
  assert.equal(requestedUrls.filter(url => url.startsWith("/api/wireless/cancel?")).length, 2);
});
