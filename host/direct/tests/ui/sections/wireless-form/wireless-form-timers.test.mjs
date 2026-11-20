// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createWirelessFormTimers } from "../../../../web/js/ui/sections/wireless-form/wireless-form-timers.mjs";

function fakeTimers() {
  let next = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setInterval(callback, delay) {
      const id = ++next;
      callbacks.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) { callbacks.delete(id); },
  };
}

test("wireless operation timers stop progress and refresh until staging expires", () => {
  const timers = fakeTimers();
  let expired = false;
  let progress = 0;
  let refreshes = 0;
  let expiryNotifications = 0;
  const formTimers = createWirelessFormTimers({
    timers, onStageTick: () => refreshes++, isExpired: () => expired, onExpired: () => expiryNotifications++,
  });
  formTimers.startTest(() => progress++);
  const progressTimer = [...timers.callbacks.values()][0];
  assert.equal(progressTimer.delay, 1000);
  progressTimer.callback();
  assert.equal(progress, 1);
  formTimers.stopTest();
  assert.equal(timers.callbacks.size, 0);

  formTimers.startStaged();
  const stagedTimer = [...timers.callbacks.values()][0];
  stagedTimer.callback();
  assert.equal(refreshes, 1);
  assert.equal(expiryNotifications, 0);
  expired = true;
  stagedTimer.callback();
  assert.equal(refreshes, 2);
  assert.equal(expiryNotifications, 1);
  assert.equal(timers.callbacks.size, 0);
  formTimers.clear();
});
