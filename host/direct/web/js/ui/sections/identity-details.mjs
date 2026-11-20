// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/** @file Coordinate the product and memory detail previews across pointer and keyboard input. */

/**
 * @brief Keep the identity popovers mutually exclusive and dismissible without breaking keyboard focus.
 * @param {HTMLDetailsElement[]} details
 */
export function bindIdentityDetails(details) {
  for (const current of details) {
    const show = () => {
      for (const other of details) other.open = other === current;
    };
    current.addEventListener("pointerenter", event => {
      if (event.pointerType === "mouse") show();
    });
    current.addEventListener("pointerleave", () => {
      if (!current.contains(document.activeElement)) current.open = false;
    });
    // Pointer focus precedes the native summary toggle; only keyboard focus opens a preview.
    current.addEventListener("focusin", () => {
      if (document.activeElement?.matches(":focus-visible")) show();
    });
    current.addEventListener("focusout", () => {
      if (!current.matches(":hover")) current.open = false;
    });
    current.addEventListener("keydown", event => {
      if (event.key === "Escape") current.open = false;
    });
  }
}
