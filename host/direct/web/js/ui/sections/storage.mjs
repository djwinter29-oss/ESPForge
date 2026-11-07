// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Storage section: SD FAT mount state and result; no card writes, formatting or benchmarks. */

import { setText } from "../dom.mjs";
import { selectStorage } from "../../state/selectors.mjs";

/**
 * @param {import("../../state/reducer.mjs").DashboardState} state
 * @param {Document} root
 */
export function renderStorage(state, root) {
  setText(selectStorage(state), root);
}
