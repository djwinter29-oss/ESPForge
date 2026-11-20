// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "../../support/dom.mjs";
import { mountBoardOperationDialogs } from "../../../web/js/ui/dialogs/board-operations.mjs";

test("benchmark confirmation refuses a replacement board and MSC remains USB-only", async () => {
  const dom = createDocument();
  const previousDocument = globalThis.document;
  globalThis.document = dom.document;
  const calls = [];
  const errors = [];
  const session = {
    connectionGeneration: 1,
    state: { connected: true, link: "usb", hardware: { serial_number: "board-1" } },
    async benchmark(...args) { calls.push(["benchmark", ...args]); },
    async setMsc(...args) { calls.push(["msc", ...args]); },
  };
  const dialogs = mountBoardOperationDialogs({
    getSession: () => session,
    run: async operation => operation(),
    reportError: message => errors.push(message),
  });
  try {
    await dom.fire("#benchmark-start", "click");
    assert.equal(dom.element("#benchmark-start-dialog").open, true);
    session.connectionGeneration++;
    session.state.hardware.serial_number = "board-2";
    await dom.fire("#confirm-benchmark-start", "click");
    assert.deepEqual(calls, []);
    assert.equal(errors.length, 1);
    await dom.fire("button#msc-enable", "click");
    session.state.link = "ble";
    await dom.fire("#confirm-msc", "click");
    assert.deepEqual(calls, []);
    assert.equal(errors.length, 2);
  } finally {
    dialogs.close();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
