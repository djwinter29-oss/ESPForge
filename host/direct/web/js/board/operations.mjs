// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/**
 * @file User use cases: readiness-gated reboot and settings commands, the exclusive wireless workflows and the
 * combined configuration save. Composite use cases call their parts through the session facade, the public API.
 */
import {
  buildControlRequest, bytesToHex as hex, decodeScanEntry, displaySsid, parseHexBytes, requireValid, ssidBytes,
} from "../protocol/codec.mjs";
import { OP, STAGED_EXPIRED } from "../protocol/constants.mjs";
import { encodeSettings, validSettings } from "../protocol/opcodes.mjs";
import { BoardError, errorValue, REASON } from "../state/errors.mjs";
import { canRun } from "../state/selectors.mjs";

/**
 * @typedef {{ssid?: string, ssid_hex?: string, password?: string}} WirelessPair
 * @typedef {WirelessPair & {wifi_enabled: boolean, ble_enabled: boolean, use_tested_wifi?: boolean,
 *   ble_key?: string}} WirelessConfiguration
 * @typedef {Pick<import("../state/reducer.mjs").BoardSettings, "system_clock_mhz" | "sdcard_profile" | "radios">}
 *   BootSettings
 * @typedef {{settings: BootSettings, wireless: WirelessConfiguration | null}} ConfigurationIntent
 */

async function stage(context, opcode, bytes, signal) {
  try { return await context.command(opcode, { args: [bytes.length, ...bytes], signal }); }
  finally { bytes.fill(0); }
}

function passwordBytes(password) {
  if (typeof password !== "string" || password !== "" && !/^[\x20-\x7e]{8,63}$/.test(password)) {
    throw new BoardError(REASON.PASSWORD_INVALID);
  }
  return new TextEncoder().encode(password);
}

async function stagePair(context, settings, signal) {
  const ssid = ssidBytes(settings);
  const same = hex(ssid) === context.savedSsidHex();
  if (ssid.length && settings.password === undefined && !same) throw new BoardError(REASON.PASSWORD_REQUIRED);
  // Validate both fields before any write.
  const password = settings.password === undefined ? null : passwordBytes(settings.password);
  try {
    await stage(context, OP.STAGE_SSID, ssid, signal);
    if (password && ssid.length !== 0) await stage(context, OP.STAGE_PASSWORD, password, signal);
  } finally { ssid.fill(0); password?.fill(0); }
}

/** @brief Wait for an accepted lifecycle; a reported failure becomes an error. */
async function finish(context, pending, onProgress, signal) {
  const outcome = await context.finishLifecycle(pending, onProgress, signal);
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.result;
}

export class Operations {
  /** @param {import("./session.mjs").BoardSession} session */
  constructor(session) {
    this.session = session;
    /** Token of the wireless workflow that holds the queue while `wireless_busy` is set. */
    this.wirelessOperation = null;
  }

  /** @brief Throw the first failing precondition of a user operation; the UI uses the same `canRun` rule. */
  require(operation) {
    this.session.polling.expireReports();
    const { reason } = canRun(this.session.state, operation);
    if (reason) throw new BoardError(reason);
  }

  async reboot(confirmed = false) {
    if (confirmed !== true) throw new BoardError(REASON.REBOOT_CONFIRMATION);
    this.require("reboot");
    return this.session.command(OP.REBOOT, { flags: 1 });
  }

  async setMsc(enabled, confirmEjected = false) {
    this.require("msc");
    requireValid(typeof enabled === "boolean" && typeof confirmEjected === "boolean"
      && (enabled || confirmEjected), "command-arguments");
    if (enabled && !this.session.state.memory?.msc?.enabled && !this.session.state.memory?.initialized)
      throw new BoardError(REASON.COMMAND_BLOCKED);
    return this.session.command(OP.MSC, { flags: enabled ? 0 : 1, args: [Number(enabled)] });
  }

  /** @brief Save next-boot settings; throws on refusal or failure, and marks the board as rebooting on success. */
  async saveSettings(settings) {
    requireValid(validSettings(settings), "boot-settings");
    this.require("settings");
    return this.session.command(OP.SAVE_SETTINGS, { args: encodeSettings(settings) });
  }

  /**
   * @brief The dashboard's one Save action: boot settings alone, or with staged wireless credentials over USB.
   * @param {ConfigurationIntent} intent `wireless` is the credential form request, or null.
   * @return Wireless facts the form should adopt (the `saveWireless` result), or null.
   */
  async saveConfiguration({ settings, wireless }) {
    const s = this.session;
    if (wireless && s.state.link === "usb") {
      return s.saveWireless({ ...wireless, wifi_enabled: Boolean(settings.radios & 1),
        ble_enabled: Boolean(settings.radios & 2), board: settings });
    }
    await s.saveSettings(settings);
    return null;
  }

  /** @brief Wait for a lifecycle outcome and settle its record; an unknown outcome stays pending and uncertain. */
  async finishLifecycle(pending, onProgress, signal) {
    const s = this.session;
    try {
      const outcome = await s.polling.waitLifecycle(pending, onProgress, signal);
      s.commands.settleWireless();
      return outcome;
    } catch (error) {
      if (s.state.pending_wireless) s.emit("session/failed", { outcome_uncertain: true, error: errorValue(error) });
      throw error;
    }
  }

  /**
   * @brief Run one wireless workflow exclusively. The action receives a context whose `command` carries the
   * workflow token, so only this workflow may use the queue while `wireless_busy` is set.
   */
  async runWirelessWorkflow(action) {
    const s = this.session;
    this.require("wireless");
    const token = Symbol("wireless operation");
    this.wirelessOperation = token;
    s.emit("wireless/locked", { wireless_busy: true });
    const context = {
      command: (opcode, options) => s.command(opcode, { ...options, workflow: token }),
      read: signal => s.polling.readWireless(signal),
      finishLifecycle: (pending, onProgress, signal) => this.finishLifecycle(pending, onProgress, signal),
      invalidateWireless: error => s.emit("report/failed", { wireless: null, wireless_error: errorValue(error) }),
      savedSsidHex: () => s.polling.savedSsidHex,
    };
    try { return await action(context); }
    finally {
      this.wirelessOperation = null;
      s.emit("wireless/locked", { wireless_busy: false });
    }
  }

  async scanWireless(signal) {
    return this.runWirelessWorkflow(async context => {
      const previous = await context.read(signal);
      const pending = { operation: OP.SCAN, generation: previous.scan_generation % 65535 + 1 };
      await context.command(OP.SCAN, { lifecycle: pending, signal });
      const status = await finish(context, pending, undefined, signal);
      const networks = [];
      for (let index = 0; index < status.scan_count; index++) {
        networks.push(decodeScanEntry(await context.command(OP.SCAN_ENTRY, { signal,
          args: [index, status.scan_generation & 255, status.scan_generation >> 8] })));
      }
      return networks;
    });
  }

  /**
   * @param {WirelessPair} settings
   * @param {(progress: import("../state/reducer.mjs").ReasonValue) => void} [onProgress]
   * @param {AbortSignal} [signal]
   */
  async testWireless(settings, onProgress, signal) {
    return this.runWirelessWorkflow(async context => {
      const previous = await context.read(signal);
      if (!ssidBytes(settings).length) throw new BoardError(REASON.SSID_REQUIRED);
      await stagePair(context, settings, signal);
      const pending = { operation: OP.TEST_WIFI, generation: previous.test_generation % 255 + 1 };
      await context.command(OP.TEST_WIFI, { lifecycle: pending, signal });
      return finish(context, pending, onProgress, signal);
    });
  }

  async cancelWireless(signal) {
    return this.runWirelessWorkflow(async context => {
      await context.command(OP.CANCEL_TEST, { signal });
      try { await context.read(signal); }
      catch (error) { context.invalidateWireless(error); }
    });
  }

  /**
   * @param {WirelessConfiguration & {board: BootSettings}} settings
   * @param {AbortSignal} [signal]
   */
  async saveWireless(settings, signal) {
    return this.runWirelessWorkflow(async context => {
      const previous = await context.read(signal);
      const board = settings.board;
      if (typeof settings.wifi_enabled !== "boolean" || typeof settings.ble_enabled !== "boolean"
        || settings.use_tested_wifi !== undefined && typeof settings.use_tested_wifi !== "boolean"
        || !validSettings(board)
        || board.radios !== (Number(settings.wifi_enabled) | Number(settings.ble_enabled) << 1)) {
        throw new BoardError(REASON.WIRELESS_CONFIG_INVALID);
      }
      const args = encodeSettings(board);
      buildControlRequest(1, OP.SAVE_SETTINGS, { args }); // Validate board settings before staging.
      const target = ssidBytes(settings);
      const targetHex = hex(target);
      const targetLabel = displaySsid(target);
      const key = settings.ble_key === "" ? new Uint8Array()
        : settings.ble_key === undefined ? null : parseHexBytes(settings.ble_key, 32, "control-key");
      if (settings.wifi_enabled && !target.length) throw new BoardError(REASON.NETWORK_REQUIRED);
      if (settings.use_tested_wifi) {
        if (!previous.pair_tested || previous.staged_state & STAGED_EXPIRED || previous.ssid_hex !== targetHex
          || settings.password !== undefined) throw new BoardError(REASON.TESTED_PAIR_CHANGED);
      } else if (targetHex !== previous.ssid_hex || settings.password !== undefined) {
        await stagePair(context, settings, signal);
      }
      try {
        if (key) await stage(context, OP.STAGE_KEY, key, signal);
      } finally { key?.fill(0); target.fill(0); }
      const staged = await context.read(signal);
      const result = await context.command(OP.SAVE_SETTINGS, { flags: staged.staged_mask ? 2 : 0,
        args, commitMask: staged.staged_mask, signal });
      return { ...result.settings, wifi_enabled: settings.wifi_enabled, ble_enabled: settings.ble_enabled,
        ssid: targetLabel, ssid_hex: targetHex,
        ble_key_configured: settings.ble_key === undefined ? previous.ble_key_configured : Boolean(settings.ble_key) };
    });
  }
}
