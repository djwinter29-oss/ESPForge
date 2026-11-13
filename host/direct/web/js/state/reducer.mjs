// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/**
 * @file Allowlisted patch reducers for the domain (board) snapshot and the separate UI snapshot.
 */

/**
 * @brief Board facts written only by the board modules. `phase` is the connection lifecycle phase
 * (board/connection.mjs); `connected` and `reconnecting` are its projections. Pending facts live here once and
 * selectors derive the flags: `pending_request` is the persisted outstanding control request, `pending_wireless` the
 * accepted scan/test lifecycle.
 */
export const DOMAIN_KEYS = Object.freeze([
  "link", "phase", "connected", "reconnecting", "busy", "error", "hardware", "settings", "settings_supported",
  "runtime", "memory", "self_test", "filesystem_format", "wireless", "wireless_error", "wireless_poll_error",
  "recovery_message", "recovered_opcode", "freshness", "reboot_pending", "outcome_uncertain", "wireless_busy",
  "pending_request", "pending_wireless",
]);

/** @brief Per-connection facts reset when a connection opens or closes; pending request facts survive. */
export const CONNECTION_FACTS = Object.freeze([
  "hardware", "settings", "settings_supported", "runtime", "memory", "self_test", "filesystem_format",
  "wireless", "wireless_error", "wireless_poll_error", "recovery_message", "recovered_opcode", "freshness",
  "reboot_pending",
]);

const PHASE = ["phase", "connected", "reconnecting"];
const REPORTS = ["runtime", "memory", "self_test", "filesystem_format", "wireless", "wireless_error", "freshness"];
/**
 * @brief Named domain events and the only keys each may change. Phase keys appear only in `connection/*` events,
 * which board/connection.mjs alone emits (architecture.test.mjs).
 */
export const DOMAIN_EVENTS = Object.freeze({
  "connection/changed": [...PHASE, "busy", "error"],
  "connection/opened": [...PHASE, ...CONNECTION_FACTS, "busy", "error", "outcome_uncertain"],
  "connection/closed": [...PHASE, ...CONNECTION_FACTS, "busy", "error", "outcome_uncertain"],
  "command/started": ["busy", "pending_request", "error", "recovery_message", "recovered_opcode"],
  "command/retired": ["pending_request", "pending_wireless"],
  "command/finished": ["busy", "outcome_uncertain", "error", "settings", "reboot_pending"],
  "lifecycle/settled": ["pending_wireless"],
  "recovery/finished": ["outcome_uncertain", "error", "recovered_opcode", "recovery_message"],
  "report/received": [...REPORTS, "wireless_poll_error"],
  "report/expired": REPORTS,
  "report/failed": ["error", "wireless_poll_error", "wireless", "wireless_error"],
  "wireless/locked": ["wireless_busy"],
  "session/failed": ["error", "outcome_uncertain"],
});

/**
 * @brief Dashboard-only presentation facts written only by the UI layer. `action_error` is the last failed user
 * action; board errors stay in the domain `error`.
 */
export const UI_KEYS = Object.freeze([
  "settings_dirty", "wireless_form_busy", "settings_message", "action_error",
]);

/**
 * @typedef {ReturnType<typeof import("../protocol/opcodes.mjs").decodeSettings>
 *   & Partial<ReturnType<typeof import("../protocol/codec.mjs").decodeConfigReport>>} BoardSettings
 * @typedef {string | {code: string, detail: unknown} | null} ReasonValue
 * @typedef {{operation: number, generation: number}} WirelessLifecycle
 * @typedef {{transaction_id: number, opcode: number, lifecycle?: WirelessLifecycle, settings?: BoardSettings,
 *   commit_mask?: number, scan_index?: number, scan_generation?: number, msc_enabled?: boolean,
 *   benchmark_start?: boolean, benchmark_size_mib?: number, led_colour?: number}} PendingRequest
 * @typedef {{version: 2, kind: "control", uid: string, request: PendingRequest}
 *   | {version: 2, kind: "wireless-lifecycle", uid: string, operation: number, generation: number}} PendingOperation
 */

/**
 * @typedef {object} DashboardState
 * @property {"usb" | "ble"} [link]
 * @property {typeof import("../board/connection.mjs").PHASE[keyof typeof import("../board/connection.mjs").PHASE]} [phase]
 * @property {boolean} [connected]
 * @property {boolean} [reconnecting]
 * @property {boolean} [busy]
 * @property {ReasonValue} [error]
 * @property {(ReturnType<typeof import("../protocol/codec.mjs").decodeIdentityReport>
 *   & Partial<ReturnType<typeof import("../protocol/codec.mjs").decodeMemoryInventory>>) | null} [hardware]
 * @property {BoardSettings | null} [settings]
 * @property {boolean} [settings_supported]
 * @property {ReturnType<typeof import("../protocol/codec.mjs").decodeTelemetryReport> | null} [runtime]
 * @property {ReturnType<typeof import("../protocol/codec.mjs").decodeStorageReport>["memory"] | null} [memory]
 * @property {ReturnType<typeof import("../protocol/codec.mjs").decodeBenchmarkReport> | null} [self_test]
 * @property {string | null} [filesystem_format]
 * @property {ReturnType<typeof import("../protocol/codec.mjs").decodeWireless> | null} [wireless]
 * @property {ReasonValue} [wireless_error]
 * @property {ReasonValue} [wireless_poll_error]
 * @property {ReasonValue} [recovery_message]
 * @property {number | null} [recovered_opcode]
 * @property {Record<number, "fresh" | "stale" | "unavailable">} [freshness]
 * @property {boolean} [reboot_pending]
 * @property {boolean} [outcome_uncertain]
 * @property {boolean} [wireless_busy]
 * @property {PendingRequest | null} [pending_request]
 * @property {WirelessLifecycle | null} [pending_wireless]
 */

/**
 * @typedef {object} UiState
 * @property {boolean} settings_dirty
 * @property {boolean} wireless_form_busy
 * @property {string | null} settings_message
 * @property {string | null} action_error
 */

/**
 * @template State
 * @typedef {{type: string, changes?: Partial<State>, state?: State}} StateAction
 *   `replace` carries `state`; `patch` (UI store) and named domain events carry `changes`.
 */
/** @typedef {StateAction<DashboardState>} DashboardAction */

const checkKeys = (object, keys, label) => {
  const unknown = Object.keys(object).filter(key => !keys.includes(key));
  if (unknown.length) throw new Error(`Unknown ${label} keys: ${unknown.join(", ")}`);
};

/**
 * @brief Domain reducer: `replace` (session start) or a named event from DOMAIN_EVENTS changing only its keys.
 * @type {(state: DashboardState, action: DashboardAction) => DashboardState}
 */
export function dashboardReducer(state, action) {
  if (action.type === "replace") { checkKeys(action.state, DOMAIN_KEYS, "state"); return action.state; }
  const keys = Object.hasOwn(DOMAIN_EVENTS, action.type) ? DOMAIN_EVENTS[action.type] : null;
  if (!keys || !("changes" in action)) throw new Error(`Unknown domain event ${action.type}`);
  checkKeys(action.changes, keys, action.type);
  return { ...state, ...action.changes };
}

/**
 * @brief Allowlisted UI snapshots; board facts cannot enter this store.
 * ponytail: one generic patch action is enough for a single UI writer with no state transitions.
 * @type {(state: UiState, action: StateAction<UiState>) => UiState}
 */
export function uiReducer(state, action) {
  if (action.type === "replace") { checkKeys(action.state, UI_KEYS, "state"); return action.state; }
  if (action.type === "patch") { checkKeys(action.changes, UI_KEYS, "state"); return { ...state, ...action.changes }; }
  throw new Error("Unknown state action");
}
