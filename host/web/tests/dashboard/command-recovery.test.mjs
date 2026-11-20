// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { createCommandRecovery } from "../../src/js/dashboard/command-recovery.mjs";

function setup(reply = async () => ({ ok: true, status: 200, json: async () => ({ uncertain: false }) })) {
  const session = { selectedBoard: "board-a", selectionVersion: 1, statusReads: 0 };
  const snapshot = { connected: true, error: null };
  const calls = [];
  const cancels = [];
  const recovery = createCommandRecovery({
    session: {
      boardUrl: path => `${path}?board=${session.selectedBoard}`,
      commandChanged: () => {},
      state: () => ({ selectedBoard: session.selectedBoard, selectionVersion: session.selectionVersion }),
      updateControls: () => {},
      updateStatus: async () => { session.statusReads++; },
    },
    getCurrentSnapshot: () => snapshot,
    operationState: () => ({ canRecover: true, recovery: "resync" }),
    fetchWithDeadline: async (url, options) => { calls.push({ url, options }); return reply(); },
    wifiCancelResolved: (completed, message) => cancels.push({ completed, message }),
    clearWirelessTest: async () => true,
    changed: () => {},
  });
  recovery.selectBoard("board-a");
  return { calls, cancels, recovery, session, snapshot };
}

test("uncertain outcomes stay with their originating board across selection changes", () => {
  const { recovery, session, snapshot } = setup();
  assert.equal(recovery.markUncertain(new Error("rejected")), false, "definite failures are not uncertain");

  session.selectedBoard = "board-b";
  recovery.selectBoard("board-b");
  assert.equal(recovery.markUncertain(new TypeError("lost"), undefined, { kind: "resync" }, "board-a"), true);
  assert.equal(recovery.state().uncertainCommand, null, "the visible board stays admissible");
  assert.equal(snapshot.error, null);

  session.selectedBoard = "board-a";
  recovery.selectBoard("board-a");
  assert.equal(recovery.state().uncertainCommand.kind, "resync");
});

test("Re-sync clears uncertainty and applies the reconciled acknowledgement once", async () => {
  const { calls, cancels, recovery, session, snapshot } = setup(async () => ({ ok: true, status: 200,
    json: async () => ({ uncertain: false, control_result: { opcode: 5, status: "completed" } }) }));
  recovery.markUncertain(new TypeError("lost"), undefined, { kind: "resync" });
  await recovery.resync();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/control/resync?board=board-a");
  assert.deepEqual(JSON.parse(calls[0].options.body), { confirm: true });
  assert.equal(recovery.state().uncertainCommand, null);
  assert.equal(recovery.state().rebootPending, "requested");
  assert.equal(snapshot.error, null);
  assert.deepEqual(cancels, [{ completed: false, message: undefined }]);
  assert.equal(session.statusReads, 1);
  assert.equal(recovery.resyncing(), false);
});

test("Re-sync replies for a replaced board selection are ignored", async () => {
  let release;
  const { recovery, session } = setup(() => new Promise(resolve => {
    release = () => resolve({ ok: true, status: 200, json: async () => ({ uncertain: false }) });
  }));
  recovery.markUncertain(new TypeError("lost"), undefined, { kind: "resync" });
  const pending = recovery.resync();
  assert.equal(recovery.resyncing(), true);
  assert.equal(recovery.observeStatus({ connected: true }), null, "Re-sync owns reconciliation meanwhile");
  session.selectionVersion++;
  release();
  await pending;
  assert.equal(recovery.state().uncertainCommand.kind, "resync");
  assert.equal(session.statusReads, 0);
});

test("acknowledged reboot captures uptime and recognizes a missed disconnect", () => {
  const { recovery, snapshot } = setup();
  snapshot.runtime = { uptime_milliseconds: 120000 };
  recovery.publish({ opcode: 2, status: "completed" });
  assert.equal(recovery.state().rebootPending, "requested");
  assert.equal(recovery.state().rebootUptimeMs, 120000);

  snapshot.runtime = { uptime_milliseconds: 1000 };
  const observation = recovery.observeStatus({ connected: true, reboot_pending: false, runtime: snapshot.runtime });
  assert.equal(observation.rebootSettled, true);
  assert.equal(recovery.state().rebootPending, null);
  assert.equal(recovery.state().rebootUptimeMs, null);
});
