// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { DashboardError } from "../../src/js/dashboard/api.mjs";
import {
  createCommandLifecycle, hasUnknownOutcome, isUncertainOutcome, uncertainMessage,
} from "../../src/js/dashboard/command-lifecycle.mjs";

test("command lifecycle always begins and finishes without hiding non-Error throws", async () => {
  const calls = [];
  const lifecycle = createCommandLifecycle({
    begin: options => calls.push(`begin:${options.refresh}`),
    finish: options => calls.push(`finish:${options.refresh}`),
  });
  await lifecycle({ refresh: "always" }, async () => { throw new Error("failed"); },
    error => calls.push(error.message));
  assert.deepEqual(calls, ["begin:always", "failed", "finish:always"]);

  await assert.rejects(lifecycle({}, async () => { throw "unexpected"; },
    () => calls.push("failed")), error => error === "unexpected");
  assert.deepEqual(calls, ["begin:always", "failed", "finish:always", "begin:undefined", "finish:undefined"]);
});

test("outcome classifiers separate lost replies from definite rejections", () => {
  assert.equal(hasUnknownOutcome(new TypeError("network")), true);
  assert.equal(hasUnknownOutcome(Object.assign(new Error("deadline"), { name: "TimeoutError" })), true);
  assert.equal(hasUnknownOutcome(new DashboardError("busy", 409, false)), false);
  assert.equal(isUncertainOutcome(new DashboardError("Outcome is uncertain", 503, false)), false,
    "an explicit host flag overrides message wording");
  const reported = new DashboardError("Reboot outcome is uncertain; not resent", 503, true);
  assert.equal(uncertainMessage(reported, "fallback"), reported.message);
  assert.equal(uncertainMessage(new TypeError("network"), "fallback"), "fallback");
});
