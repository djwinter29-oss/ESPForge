// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { matchesEspForge } from "../../web/js/protocol/codec.mjs";
import { describe } from "../../web/js/ui/messages.mjs";
import { fakeConnection } from "../support/fixtures.mjs";

test("explicit connect always requests selection regardless of previously authorized devices", async () => {
  for (const count of [0, 1, 2]) {
    const { client, hid, device } = fakeConnection();
    const other = fakeConnection().device;
    let selections = 0;
    hid.getDevices = async () => [other, device].slice(0, count);
    hid.requestDevice = async options => {
      selections++;
      assert.deepEqual(options.filters, [{ vendorId: 0xcafe, usagePage: 0xff00, usage: 1, productId: 0x4021 }]);
      return [device];
    };
    await client.connect();
    assert.equal(selections, 1);
    assert.equal(client.state.connected, true);
    assert.equal(client.device, device);
    assert.equal(other.opened, false);
    await client.disconnect();
  }
});

test("cancelled or denied selection never opens a previously authorized device", async () => {
  for (const denied of [false, true]) {
    const { client, hid, device } = fakeConnection();
    hid.requestDevice = async () => {
      if (denied) throw new Error("Device permission denied");
      return [];
    };
    await client.connect();
    assert.equal(client.state.connected, false);
    assert.equal(client.state.busy, false);
    assert.equal(device.opened, false);
    assert.equal(describe(client.state.error), denied ? "Unexpected error: Device permission denied" : null);
  }
});

test("development HID filter uses the ESPForge VID:PID and the authorized vendor collection", () => {
  const { device } = fakeConnection();
  assert.equal(matchesEspForge(device), true);
  device.productId = 0x4011; assert.equal(matchesEspForge(device), false);
  device.productId = 0x4021; device.collections[0].usage = 2; assert.equal(matchesEspForge(device), false);
});
