// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Board command policy checked before anything is sent; rejected commands never touch the link. */

import { validateWifiCredentials } from "../protocol/codec.mjs";

export class CommandRejected extends Error {
  name = "CommandRejected";
}

/**
 * @brief Validate a Wi-Fi request against the current link and firmware limits.
 * @param {import("../state/reducer.mjs").DashboardState} state
 * @param {unknown} input
 * @return {import("../protocol/codec.mjs").WifiCredentials}
 */
export function prepareWifiCommand(state, input) {
  if (state.link !== "connected" || !state.transport) throw new CommandRejected("Connect a board first");
  if (state.transport.simulated) throw new CommandRejected("Simulated preview does not send board commands");
  if (!state.transport.writable) {
    throw new CommandRejected("Bluetooth is read-only; connect over USB to configure Wi-Fi");
  }
  let credentials;
  try {
    credentials = validateWifiCredentials(input);
  } catch (error) {
    throw new CommandRejected(error instanceof Error ? error.message : String(error));
  }
  if (state.status?.wifi_connected) {
    throw new CommandRejected("Already associated. Firmware cannot change networks without a board reboot.");
  }
  return credentials;
}
