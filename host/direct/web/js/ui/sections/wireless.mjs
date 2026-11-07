// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { CAP } from "../../protocol/constants.mjs";
import { queryElement } from "../dom.mjs";

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

export function renderWirelessStatus(state) {
  const model = deriveWirelessViewModel(state);
  for (const name of ["wifi", "ble"]) {
    queryElement(`#direct-${name}-diagnostics`).hidden = model.hidden;
    const status = queryElement(`#direct-${name}-state`);
    status.textContent = model[name];
    status.title = model[`${name}Title`];
  }
}
