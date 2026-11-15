// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "../../support/dom.mjs";
import { bindDialogEscape } from "../../../web/js/ui/dialogs/keyboard.mjs";

test("Escape keeps a busy connection dialog open but closes other dialogs", () => {
  const dom = createDocument();
  const connection = dom.element("dialog#connection");
  const settings = dom.element("dialog#settings");
  connection.showModal();
  settings.showModal();
  let busy = true;
  bindDialogEscape([connection, settings], [connection], () => busy);
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: "Escape" });
  connection.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(connection.open, true);
  settings.dispatchEvent(new Event("keydown"));
  assert.equal(settings.open, true, "unrelated keys do not close dialogs");
  const escape = new Event("keydown", { cancelable: true });
  Object.defineProperty(escape, "key", { value: "Escape" });
  settings.dispatchEvent(escape);
  assert.equal(settings.open, false);
  busy = false;
  const idleEscape = new Event("keydown", { cancelable: true });
  Object.defineProperty(idleEscape, "key", { value: "Escape" });
  connection.dispatchEvent(idleEscape);
  assert.equal(connection.open, false);
});
