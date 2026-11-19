// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createCommandLifecycle } from "../../src/js/dashboard/command-lifecycle.mjs";

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
