// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Device information section: identity facts reported by the connected board. */

import { queryElement, setText } from "../dom.mjs";
import { selectControls, selectIdentity } from "../../state/selectors.mjs";

/**
 * @param {import("../../state/reducer.mjs").DashboardState} state
 * @param {Document} root
 */
export function renderDevice(state, root) {
  setText(selectIdentity(state), root);
  queryElement("p#preview-banner", root).hidden = !selectControls(state).preview;
}
