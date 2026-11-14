// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { withDocument, snapshot } from "../../support/view.mjs";
import { deriveStorageViewModel } from "../../../web/js/ui/sections/storage.mjs";

test("storage does not infer absence from an unavailable sample or mount from cached format", () =>
  withDocument((el, renderStatus) => {
  const state = snapshot();
  state.memory.sample_valid = false; state.memory.presence_known = false; state.memory.initialized = false;
  renderStatus(state);
  assert.equal(el('[aria-labelledby="memory-title"]').hidden, true);
  assert.equal(el("#memory-note").textContent, "");
  assert.equal(el("#memory-state").textContent, "Busy");
  state.memory.sample_valid = true; state.memory.presence_known = true; state.memory.present = false;
  renderStatus(state);
  assert.equal(el('[aria-labelledby="memory-title"]').hidden, true);
  state.memory.present = true; state.memory.initialized = false;
  renderStatus(state);
  assert.equal(el('[aria-labelledby="memory-title"]').hidden, false);
  assert.equal(el("#memory-note").textContent, "Card detected but not initialized; check UART logs and SD-card wiring.");
  state.memory.presence_known = false; state.memory.present = false;
  renderStatus(state);
  assert.equal(el("#memory-note").textContent, "No card mounted; check card insertion and SD-card wiring.");
}));

test("Direct dashboard retains storage visibility through stale reports without showing cached readings", () =>
  withDocument((el, renderStatus) => {
    for (const render of [renderStatus]) {
      render({ connected: false });
      const state = snapshot();
      state.memory.present = false;
      render(state);
      assert.equal(el('[aria-labelledby="memory-title"]').hidden, true);

      state.memory = null;
      state.storage_stale = true;
      state.freshness[10] = "stale";
      render(state);
      assert.equal(el('[aria-labelledby="memory-title"]').hidden, true, "A missing report must not reveal absent storage");

      state.memory = { sample_valid: true, presence_known: true, present: true, initialized: true, configured: true };
      state.storage_stale = false;
      state.freshness[10] = "fresh";
      render(state);
      assert.equal(el('[aria-labelledby="memory-title"]').hidden, false, "Confirmed card insertion must update layout");
      state.memory = null;
      state.storage_stale = true;
      state.freshness[10] = "stale";
      render(state);
      assert.equal(el('[aria-labelledby="memory-title"]').hidden, false);
      assert.equal(el("#memory-size").textContent, "--", "Stale readings must not be presented as live");

      render({ connected: false });
      assert.equal(el('[aria-labelledby="memory-title"]').hidden, true, "Disconnect must clear confirmed presence");
    }
  }));

test("storage stays hidden until detected but keeps detected initialization failures visible", () =>
  withDocument((el, renderStatus) => {
    const section = el('[aria-labelledby="memory-title"]');
    renderStatus({ connected: false });
    assert.equal(section.hidden, true);
    const state = snapshot();
    state.memory = { configured: true, sample_valid: true, initialized: false, presence_known: false, present: null };
    renderStatus(state);
    assert.equal(section.hidden, true);
    state.memory = { ...state.memory, presence_known: true, present: true };
    renderStatus(state);
    assert.equal(section.hidden, false);
    assert.match(el("#memory-note").textContent, /not initialized/);
    renderStatus({ ...state, memory: { configured: true, sample_valid: false } });
    assert.equal(section.hidden, false);
    renderStatus({ ...state, memory: null, freshness: { 10: "stale" } });
    assert.equal(section.hidden, false);
    state.memory = { ...state.memory, presence_known: false, present: null };
    renderStatus(state);
    assert.equal(section.hidden, true);
    state.memory.initialized = true;
    renderStatus(state);
    assert.equal(section.hidden, false, "Successful initialization establishes card detection");
  }));

test("busy storage retains card details without a message, but stale or replaced media clears them", () =>
  withDocument((el, renderStatus) => {
    const state = snapshot();
    state.memory = { ...state.memory, mode: "sdmmc", bus_clock_hz: 25000000, speed_mode: 1,
      capacity_bytes: 127865454592, manufacturer: { id: 3, product_name: "SB128", product_revision: "8.0",
        manufacture_year: 2020, manufacture_month: 1, serial_number: 4089330880 } };
    const busy = { ...state, memory: { configured: true, sample_valid: false } };
    renderStatus(state);
    const ids = ["#memory-speed", "#memory-size", "#memory-filesystem",
      "#memory-manufacturer", "#memory-product", "#memory-serial"];
    const details = ids.map(id => el(id).textContent);
    assert.equal(el("#memory-speed").textContent, "25 MHz");
    assert.equal(el("#memory-manufacturer").textContent, "SanDisk (0x03)");
    assert.equal(el("#storage-freshness").hidden, true);
    for (let sample = 0; sample < 3; sample++) {
      renderStatus(busy);
      assert.equal(el("#memory-state").textContent, "Busy");
      assert.equal(el("#memory-note").hidden, true);
      assert.deepEqual(ids.map(id => el(id).textContent), details);
    }
    for (const invalidation of [
      { ...state, connected: false, memory: null },
      { ...state, memory: null, freshness: { 10: "stale" } },
      { ...state, memory: { configured: true, sample_valid: true, initialized: false, present: false } },
    ]) {
      renderStatus(state);
      renderStatus(invalidation);
      renderStatus(busy);
      assert.equal(el("#memory-speed").textContent, "--");
    }
  }));

test("storage view models retain only their explicitly supplied display history", () => {
  const snapshot = { connected: true, memory: {
    configured: true, initialized: true, sample_valid: true, capacity_bytes: 1048576,
  } };
  const previous = deriveStorageViewModel(snapshot).retained;
  Object.freeze(previous);
  const busy = { ...snapshot, memory: { configured: true, sample_valid: false } };
  assert.equal(deriveStorageViewModel(busy, previous).text["memory-size"], "1.00 MiB");
  assert.equal(deriveStorageViewModel(busy).text["memory-size"], "--",
    "a separate view cannot inherit another view's retained card details");
  assert.equal(deriveStorageViewModel({ connected: false }).retained.details, null);
});
