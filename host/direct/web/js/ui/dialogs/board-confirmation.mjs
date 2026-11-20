// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check

/**
 * @file Shared stale-target guard for destructive dashboard confirmations.
 */

/**
 * @typedef {{session: import("../../board/session.mjs").BoardSession, generation: number,
 *   serial: string | undefined, link: string | null}} BoardTarget
 */

/**
 * @brief Capture the exact board connection a user reviewed before confirming a destructive operation.
 * @param {import("../../board/session.mjs").BoardSession} session
 * @return {BoardTarget}
 */
export function captureBoardTarget(session) {
  return {
    session,
    generation: session.connectionGeneration,
    serial: session.state.hardware?.serial_number,
    link: session.state.link,
  };
}

/**
 * @brief Human-readable identity shown alongside a state-changing confirmation.
 * @param {import("../../board/session.mjs").BoardSession} session
 */
export function boardTargetDescription(session) {
  const hardware = session.state.hardware;
  const name = hardware?.board_name ?? hardware?.board_model ?? hardware?.product_name ?? "ESPForge board";
  return `Target: ${name}${hardware?.serial_number ? ` · serial ${hardware.serial_number}` : ""}`
    + ` over ${session.state.link === "ble" ? "Bluetooth LE" : "USB HID"}.`;
}

/**
 * @brief Run an action only if its confirmation still targets the same connected board and link.
 * @param {BoardTarget | null} target Captured when the confirmation dialog opens.
 * @param {() => import("../../board/session.mjs").BoardSession} currentSession
 * @param {(message: string) => void} reportChanged
 * @param {string} changedMessage
 * @param {(session: import("../../board/session.mjs").BoardSession) => Promise<unknown>} action
 * @return {Promise<boolean>} Whether the action ran.
 */
export async function runBoardConfirmation(target, currentSession, reportChanged, changedMessage, action) {
  const session = currentSession();
  const state = session.state;
  if (!target || target.session !== session || target.generation !== session.connectionGeneration
      || !state.connected || !target.serial || target.serial !== state.hardware?.serial_number
      || target.link !== state.link) {
    reportChanged(changedMessage);
    return false;
  }
  await action(session);
  return true;
}
