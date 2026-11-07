// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Board configuration section: live radio flags; settings are not persistent in protocol v1. */

import { setText } from "../dom.mjs";
import { selectConfiguration } from "../../state/selectors.mjs";

/**
 * @param {import("../../state/reducer.mjs").DashboardState} state
 * @param {Document} root
 */
export function renderConfiguration(state, root) {
  setText(selectConfiguration(state), root);
}
