// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { bindIdentityDetails } from "../../../web/js/ui/sections/identity-details.mjs";

test("identity previews coordinate pointer, keyboard focus, pointer exit and Escape", () => {
  const createDetails = () => {
    const listeners = new Map();
    return {
      open: false,
      hovered: false,
      addEventListener(type, handler) {
        const handlers = listeners.get(type) ?? [];
        handlers.push(handler);
        listeners.set(type, handlers);
      },
      contains(element) { return element != null && element === active; },
      matches(selector) { return selector === ":hover" ? this.hovered : selector === ":focus-visible" && keyboard; },
      fire(type, event = {}) {
        for (const handler of listeners.get(type) ?? []) handler(event);
      },
    };
  };
  let active = null;
  let keyboard = false;
  const details = [createDetails(), createDetails()];
  const previousDocument = globalThis.document;
  globalThis.document = { get activeElement() { return active; } };
  try {
    bindIdentityDetails(details);
    details[0].fire("pointerenter", { pointerType: "mouse" });
    assert.deepEqual(details.map(item => item.open), [true, false]);
    details[1].fire("pointerenter", { pointerType: "touch" });
    assert.deepEqual(details.map(item => item.open), [true, false]);
    details[1].fire("pointerenter", { pointerType: "mouse" });
    assert.deepEqual(details.map(item => item.open), [false, true]);
    active = details[0];
    keyboard = true;
    details[0].fire("focusin");
    assert.deepEqual(details.map(item => item.open), [true, false]);
    details[0].fire("pointerleave");
    assert.equal(details[0].open, true, "focused detail remains open");
    active = null;
    details[0].fire("pointerleave");
    assert.equal(details[0].open, false);
    details[1].fire("pointerenter", { pointerType: "mouse" });
    details[1].hovered = true;
    details[1].fire("focusout");
    assert.equal(details[1].open, true, "hovered detail remains open after focus moves");
    details[1].fire("keydown", { key: "Escape" });
    assert.equal(details[1].open, false);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
