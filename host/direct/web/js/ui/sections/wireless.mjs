// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/** @file Device-information Wi-Fi and Bluetooth status rows, including the optional Wi-Fi shell link. */
import { CAP } from "../../protocol/constants.mjs";
import { queryElement } from "../dom.mjs";
import { consoleTarget } from "../console/console-target.mjs";

/**
 * @brief Display text for the wireless status rows. Unavailable reports stay distinct from disabled radios.
 * @param {import("./status-model.mjs").DashboardPresentation} state Snapshot with display-text errors.
 */
export function deriveWirelessViewModel(state) {
  const wireless = state.wireless;
  const unavailable = !state.connected ? "--" : state.wireless_error ? "Unavailable" : !wireless ? "--" : null;
  const name = state.hardware?.serial_number ? `ESPForge-${state.hardware.serial_number}` : "ESPForge";
  const wifi = unavailable ?? (!wireless.wifi_enabled || !wireless.ssid ? "Disabled"
    : wireless.wifi_state === "connected" ? `${wireless.ssid} (${wireless.ipv4})`
      : `${wireless.ssid} (${wireless.wifi_state === "connecting" ? "connecting" : "disconnected"})`);
  const ble = unavailable ?? (!wireless.ble_enabled ? "Disabled"
    : !wireless.ble_key_configured && wireless.ble_state === "off" ? "Off (no control key)"
      : `${name} (${wireless.ble_state === "connected" ? "connected"
        : wireless.ble_state === "advertising" ? "advertising" : "starting"})`);
  return {
    hidden: !(state.hardware?.capabilities & CAP.WIRELESS),
    wifi, ble,
    wifiTitle: state.wireless_error ?? state.wireless_poll_error ?? "",
    bleTitle: state.wireless_error ?? state.wireless_poll_error ?? "",
  };
}

/**
 * @brief Render both wireless rows. The Wi-Fi row becomes a shell link only while a console URL is served and the
 * board reports a fresh connected station; an existing link is updated in place so focus survives polling.
 * @param {import("./status-model.mjs").DashboardPresentation} state
 * @param {string | null} [consoleUrl] Same-origin console page for the current board, or null when not served.
 */
export function renderWirelessStatus(state, consoleUrl = null) {
  const model = deriveWirelessViewModel(state);
  for (const name of ["wifi", "ble"]) {
    queryElement(`#direct-${name}-diagnostics`).hidden = model.hidden;
    const status = queryElement(`#direct-${name}-state`);
    status.title = model[`${name}Title`];
    if (name !== "wifi" || !consoleUrl || !consoleTarget(state)) {
      status.textContent = model[name];
      continue;
    }
    let link = /** @type {HTMLAnchorElement | undefined} */ (status.children[0]);
    if (status.children.length !== 1 || link?.localName !== "a") {
      link = document.createElement("a");
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Open the unauthenticated Wi-Fi shell; keep this dashboard open";
      status.replaceChildren(link);
    }
    link.href = consoleUrl;
    link.textContent = model.wifi;
  }
}
