// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Pure dashboard reducer; every link loss or failure clears device facts so nothing stale is shown. */

/**
 * @typedef {"disconnected" | "connecting" | "connected" | "error"} LinkState
 * @typedef {{ kind: import("../transport/transport.mjs").TransportKind, label: string, writable: boolean,
 *   simulated: boolean }} LinkInfo
 * @typedef {{
 *   link: LinkState, kind: import("../transport/transport.mjs").TransportKind | null, transport: LinkInfo | null,
 *   status: import("../protocol/codec.mjs").BoardStatus | null, sampled_at: number | null, busy: boolean,
 *   command: "wifi" | null, error: string | null, cleanup_pending: boolean, notice: string | null,
 * }} DashboardState
 * @typedef {{ type: "connecting", kind: import("../transport/transport.mjs").TransportKind }
 *   | { type: "connected", transport: LinkInfo }
 *   | { type: "sample", status: import("../protocol/codec.mjs").BoardStatus, at: number }
 *   | { type: "busy", busy: boolean, command?: "wifi" | null }
 *   | { type: "notice", message: string | null }
 *   | { type: "failed", error: string, cleanup_pending?: boolean }
 *   | { type: "disconnected", notice?: string | null }} DashboardAction
 */

/** @type {Readonly<DashboardState>} */
export const INITIAL_STATE = Object.freeze({
  link: "disconnected", kind: null, transport: null, status: null, sampled_at: null, busy: false, command: null,
  error: null, cleanup_pending: false, notice: null,
});

/**
 * @param {DashboardState} state
 * @param {DashboardAction} action
 * @return {DashboardState}
 */
export function dashboardReducer(state, action) {
  switch (action.type) {
    case "connecting":
      return { ...INITIAL_STATE, link: "connecting", kind: action.kind };
    case "connected":
      return { ...state, link: "connected", kind: action.transport.kind, transport: action.transport, error: null };
    case "sample":
      if (state.link !== "connected") return state;
      return { ...state, status: action.status, sampled_at: action.at, error: null };
    case "busy":
      return { ...state, busy: action.busy, command: action.busy ? action.command ?? null : null };
    case "notice":
      return { ...state, notice: action.message };
    case "failed":
      return {
        ...state, link: "error", status: null, sampled_at: null, busy: false, command: null, notice: null,
        error: action.error, cleanup_pending: Boolean(action.cleanup_pending),
      };
    case "disconnected":
      return { ...INITIAL_STATE, notice: action.notice ?? null };
    default:
      return state;
  }
}
