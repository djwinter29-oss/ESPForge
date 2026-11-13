// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/**
 * @file Single source of operation readiness. BoardSession guards and every view gate derive from these functions
 * so buttons and device writes cannot disagree.
 */
import { CAP } from "../protocol/constants.mjs";
import { REASON } from "./errors.mjs";

const { COMMAND_BLOCKED: BLOCKED, CAPABILITY_UNAVAILABLE: NO_CAPABILITY } = REASON;
/** @typedef {import("./reducer.mjs").DashboardState} DashboardState */
/** @typedef {"reboot" | "settings" | "wireless" | "msc"} Operation */

/** @brief True while a control request or an accepted wireless lifecycle has no known outcome.
 * @param {DashboardState} state */
export const commandPending = state => Boolean(state.pending_request || state.pending_wireless);

/**
 * @brief Whether the single command queue may accept a request, ignoring the wireless workflow lock (the session
 * admits only the workflow that holds it).
 * @param {DashboardState} state
 */
export function commandBlocked(state) {
  return Boolean(state.busy || commandPending(state) || state.outcome_uncertain || state.reboot_pending
    || !state.connected);
}

/**
 * @brief Derive operation readiness from a domain snapshot.
 * @param {DashboardState} state Domain state snapshot.
 * @return Readiness flags: storageReady (a fresh storage report) and per-operation gates.
 */
export function deriveOperationEligibility(state) {
  const bluetooth = state.link === "ble";
  const caps = state.hardware?.capabilities ?? 0;
  const storageFresh = state.freshness?.[10] === "fresh" && Boolean(state.memory);
  const storageReady = storageFresh && state.memory?.sample_valid !== false
    && !state.memory?.msc?.enabled && !state.memory?.msc?.transition_pending;
  const blocked = commandBlocked(state) || Boolean(state.wireless_busy);
  return {
    blocked,
    storageReady,
    settingsReady: !blocked && storageReady,
    wirelessReady: !blocked && !bluetooth && storageReady && Boolean(caps & CAP.WIRELESS),
    mscReady: !blocked && !bluetooth && storageFresh && Boolean((state.settings?.board_flags ?? 0) & 64)
      && !state.memory?.msc?.transition_pending && (state.memory?.msc?.enabled || state.memory?.sample_valid !== false),
    connectionLocked: Boolean(state.connected || state.reconnecting || commandPending(state)
      || state.outcome_uncertain),
  };
}

/**
 * @brief Per-operation precondition: return the first failing reason code (state/errors.mjs), or null.
 */
/** @type {Record<Operation, (state: DashboardState, eligibility: ReturnType<typeof deriveOperationEligibility>,
 *   capabilities: number) => string | null>} */
const RULES = {
  reboot: (state, e, caps) => !e.storageReady ? REASON.REBOOT_STORAGE
    : !(caps & CAP.REBOOT) ? NO_CAPABILITY : e.blocked ? BLOCKED : null,
  settings: (state, e, caps) => !e.storageReady ? REASON.SETTINGS_STORAGE
    : !(caps & CAP.SETTINGS) ? NO_CAPABILITY : e.blocked ? BLOCKED : null,
  wireless: (state, e) => e.wirelessReady ? null : REASON.WIRELESS_STORAGE,
  msc: (state, e) => e.mscReady ? null : BLOCKED,
};

/**
 * @brief The one readiness gate for user operations, shared by BoardSession methods and UI disabling.
 * @param {DashboardState} state Domain state snapshot.
 * @param {Operation} operation
 * @param {ReturnType<typeof deriveOperationEligibility>} [eligibility] Same-snapshot render cache; actions omit it.
 * @return {{allowed: boolean, reason: string | null}} `reason` is a REASON code; ui/messages.mjs has its text.
 */
export function canRun(state, operation, eligibility = deriveOperationEligibility(state)) {
  const reason = RULES[operation](state, eligibility, state.hardware?.capabilities ?? 0);
  return { allowed: reason === null, reason };
}
