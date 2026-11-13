// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @param {import("../state/reducer.mjs").DashboardState} state */
export function consoleTarget(state) {
  const wireless = state.wireless;
  if (!state.connected || state.wireless_error || !wireless || state.freshness?.[6] !== "fresh"
      || !wireless.wifi_enabled || wireless.wifi_state !== "connected" || !state.hardware?.serial_number) return null;
  const address = wireless.ipv4;
  if (typeof address !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return null;
  const octets = address.split(".").map(Number);
  if (octets.some(octet => octet > 255)) return null;
  if (!(octets[0] === 10 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
      || octets[0] === 192 && octets[1] === 168)) return null;
  return { ipv4: address, serial: state.hardware.serial_number };
}

/**
 * @param {BroadcastChannel} channel
 * @param {() => import("../state/reducer.mjs").DashboardState} state
 */
export function serveConsoleTarget(channel, state) {
  channel.addEventListener("message", event => {
    const request = event.data;
    if (request?.type !== "console-target" || typeof request.id !== "string" || request.id.length > 64) return;
    const target = consoleTarget(state());
    const matches = target !== null && request.ipv4 === target.ipv4 && request.serial === target.serial;
    channel.postMessage(matches ? { id: request.id, ...target }
      : { id: request.id, error: "The dashboard no longer has fresh Wi-Fi status for this board and address" });
  });
}

/** @param {BroadcastChannel} channel @param {{ipv4: string, serial: string}} target */
export function checkConsoleTarget(channel, target) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      channel.removeEventListener("message", receive);
      reject(new Error("The owning Direct dashboard is unavailable; keep it open and connected"));
    }, 1000);
    /** @param {MessageEvent} event */
    function receive(event) {
      const response = event.data;
      if (response?.id !== id) return;
      clearTimeout(timer);
      channel.removeEventListener("message", receive);
      if (response.ipv4 === target.ipv4 && response.serial === target.serial) resolve(undefined);
      else reject(new Error(typeof response.error === "string" ? response.error : "The console target changed"));
    }
    channel.addEventListener("message", receive);
    channel.postMessage({ type: "console-target", id, ...target });
  });
}
