// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Live diagnostics section: uptime and radio result codes with sample freshness. */

import { setText } from "../dom.mjs";
import { selectDiagnostics, selectFreshness } from "../../state/selectors.mjs";

/**
 * @param {import("../../state/reducer.mjs").DashboardState} state
 * @param {Document} root
 * @param {(at: number) => string} formatTime
 */
export function renderDiagnostics(state, root, formatTime) {
  setText({ ...selectDiagnostics(state), "telemetry-freshness": selectFreshness(state, formatTime) }, root);
}
