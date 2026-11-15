// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "../../support/dom.mjs";
import { mountConnectionDialogs } from "../../../web/js/ui/dialogs/connection.mjs";

test("connection dialogs select transports, validate credentials and stay open while busy", async () => {
  const dom = createDocument();
  const previousDocument = globalThis.document;
  globalThis.document = dom.document;
  const calls = [];
  let session = {
    state: { link: "usb", connected: false, reconnecting: false, busy: false },
    async connect(options) { calls.push(["connect", options]); this.state.connected = true; },
    async disconnect() { calls.push(["disconnect"]); this.state.connected = false; },
  };
  const dialogs = mountConnectionDialogs({
    getSession: () => session,
    setSession: next => { session = next; },
    selectTransport: kind => ({ ...session, state: { ...session.state, link: kind, connected: false, busy: false } }),
    run: async operation => operation(),
  });
  try {
    await dom.fire("#bluetooth-open", "click");
    assert.equal(session.state.link, "ble");
    assert.equal(dialogs[1].open, true);
    dom.element("#direct-ble-control-key").value = "ab".repeat(32);
    await dom.fire("#bluetooth-scan", "click");
    assert.deepEqual(calls, [["connect", new Uint8Array(32).fill(0xab)]]);
    assert.equal(dom.element("#direct-ble-control-key").value, "");
    assert.equal(dialogs[1].open, false);

    await dom.fire("#usb-open", "click");
    assert.equal(session.state.link, "usb");
    assert.equal(dialogs[0].open, true);
    session.state.busy = true;
    const cancel = new Event("cancel", { cancelable: true });
    dialogs[0].dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    await dom.fire("#usb-connection-close", "click");
    assert.equal(dialogs[0].open, true);
    session.state.busy = false;
    await dom.fire("#usb-connect", "click");
    assert.equal(session.state.connected, true);
    assert.equal(dialogs[0].open, false);
  } finally {
    dialogs.forEach(dialog => dialog.close());
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
