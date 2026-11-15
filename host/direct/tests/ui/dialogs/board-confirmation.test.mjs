// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { captureBoardTarget, runBoardConfirmation } from "../../../web/js/ui/dialogs/board-confirmation.mjs";

const readySession = () => ({
  connectionGeneration: 4,
  state: { connected: true, link: "usb", hardware: { serial_number: "board-1" } },
});

test("destructive confirmation requires the exact connected session, link and board", async () => {
  const session = readySession();
  const target = captureBoardTarget(session);
  let runs = 0;
  let error = null;
  const current = () => session;
  const reportError = message => { error = message; };
  const action = async () => { runs++; };
  assert.equal(await runBoardConfirmation(target, current, reportError, "changed", action), true);
  assert.equal(runs, 1);

  const stale = captureBoardTarget(session);
  session.connectionGeneration++;
  assert.equal(await runBoardConfirmation(stale, current, reportError, "changed", action), false);
  assert.equal(runs, 1);
  assert.equal(error, "changed");

  session.connectionGeneration--;
  const wrongBoard = captureBoardTarget(session);
  session.state.hardware.serial_number = "board-2";
  assert.equal(await runBoardConfirmation(wrongBoard, current, reportError, "changed", action), false);
  assert.equal(runs, 1);
  session.state.hardware.serial_number = "board-1";
  const wrongLink = captureBoardTarget(session);
  session.state.link = "ble";
  assert.equal(await runBoardConfirmation(wrongLink, current, reportError, "changed", action), false);
  assert.equal(runs, 1);
  session.state.link = "usb";
  session.state.connected = false;
  assert.equal(await runBoardConfirmation(captureBoardTarget(session), current, reportError, "changed", action), false);
  assert.equal(runs, 1);

  const replacement = readySession();
  assert.equal(await runBoardConfirmation(target, () => replacement, reportError, "changed", action), false);
  assert.equal(runs, 1);
});
