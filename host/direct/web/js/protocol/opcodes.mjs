// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/**
 * @file Opcode descriptor table: the single source of every control opcode's capability, link policy, request and
 * result rules, journalled request facts, result confirmation and lifecycle limits. Adding an opcode is one row.
 * See docs/reference/usb-hid.md, docs/reference/bluetooth.md and docs/reference/espforge-profile.md.
 */
import { CAP, CLOCKS_MHZ, OP, UNSUPPORTED_OPCODES } from "./constants.mjs";

/** @brief Save-settings flag bit 1: commit the staged wireless values. Bit 0 (forced save) is unsupported. */
export const SAVE_SETTINGS_COMMIT = 2;

// radios: bit 0 Wi-Fi, bit 1 Bluetooth. ESPForge has one SD-card profile (0, Standard) and no TCP CLI switch.
export const validSettings = settings => Boolean(settings) && CLOCKS_MHZ.includes(settings.system_clock_mhz)
  && settings.sdcard_profile === 0 && [undefined, 0, 1, 2, 3].includes(settings.radios);
/** @brief Encode save-settings arguments: clock (LE16), SD profile, radio switches. */
export const encodeSettings = settings => [settings.system_clock_mhz & 255,
  settings.system_clock_mhz >> 8, settings.sdcard_profile, settings.radios ?? 0];
/** @brief Decode the four save-settings argument bytes produced by encodeSettings. @param {ArrayLike<number>} args */
export const decodeSettings = args => ({ system_clock_mhz: args[0] | args[1] << 8, sdcard_profile: args[2],
  radios: args[3] & 3 });
const sameSettings = (a, b) => a.system_clock_mhz === b.system_clock_mhz && a.sdcard_profile === b.sdcard_profile
  && (a.radios ?? 0) === (b.radios ?? 0);

const printable = bytes => bytes.every(byte => byte >= 32 && byte <= 126);
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const settingsKeys = ["system_clock_mhz", "sdcard_profile", "radios"];
const exactKeys = (value, keys) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/**
 * @typedef {object} OpcodeDescriptor
 * @property {number} capability Capability bit the board must report, or 0 when always present.
 * @property {{proof: boolean, flags: boolean} | null} ble Bluetooth policy: null = USB only; `proof` = needs a
 *   per-request HMAC; `flags` = nonzero request flags allowed over Bluetooth.
 * @property {boolean} [reboots] The board reboots after a successful result.
 * @property {(report: Uint8Array, unused: (offset: number) => boolean) => boolean} request Full 68-byte request rule:
 *   [3] flags, [4..] arguments, `unused(n)` = zero tail.
 * @property {number[]} [excluded] Result statuses this opcode never reports.
 * @property {number[]} [rejections] Error reasons allowed with status 3 (default [1, 3]).
 * @property {Record<number, number>} [details] Failure detail code to the one status that may carry it.
 * @property {(data: Uint8Array, zero: (bytes: Uint8Array) => boolean) => boolean} [completed] Completed-result data
 *   rule; default all zero.
 * @property {boolean} [returnsSettings] A completed result carries the saved settings and commit mask.
 * @property {{keys: string[], read: (report: Uint8Array, options: object) => object, valid: (facts: object) =>
 *   boolean}} [facts] Request facts journalled with the transaction and used to confirm its result.
 * @property {(result: object, request: object) => boolean} [confirms] Whether a completed result proves the
 *   requested effect; a mismatch leaves the outcome uncertain.
 * @property {boolean} [unsupported] ESPForge never runs this opcode; its only result is Unsupported/error 4 and the
 *   dashboard never sends it.
 * @property {{generationMax: number, timeoutMs: number}} [lifecycle] Accepted long-running operation tracked through
 *   Feature 12 after its result.
 */

const STAGED = { excluded: [1] };
/** @type {OpcodeDescriptor} */
const UNSUPPORTED = Object.freeze({ capability: 0, ble: null, unsupported: true, request: () => false });
/** @type {Readonly<Record<number, OpcodeDescriptor>>} */
export const OPCODES = Object.freeze({
  ...Object.fromEntries(UNSUPPORTED_OPCODES.map(opcode => [opcode, UNSUPPORTED])),
  [OP.REBOOT]: { capability: CAP.REBOOT, ble: { proof: true, flags: true }, reboots: true, excluded: [4],
    rejections: [1, 2], details: { 1: 5, 2: 5, 28: 5 }, request: (r, unused) => r[3] === 1 && unused(4) },
  [OP.SAVE_SETTINGS]: { capability: CAP.SETTINGS, ble: { proof: true, flags: false }, reboots: true,
    details: { 1: 5, 2: 5, 19: 3, 20: 3, 21: 3, 25: 5, 26: 5, 27: 3, 28: 5 }, returnsSettings: true,
    request: (r, unused) => (r[3] & ~SAVE_SETTINGS_COMMIT) === 0 && CLOCKS_MHZ.includes(r[4] | r[5] << 8)
      && r[6] === 0 && r[7] <= 3 && unused(8),
    completed: (data, zero) => validSettings(decodeSettings(data)) && data[3] <= 3 && data[4] <= 7
      && zero(data.subarray(5)),
    facts: { keys: ["settings", "commit_mask"],
      read: (r, options) => ({ settings: decodeSettings(r.subarray(4, 8)), commit_mask: options.commitMask ?? 0 }),
      // Exact keys require a stored radios value, so validSettings alone cannot accept an omitted one.
      valid: facts => exactKeys(facts.settings, settingsKeys) && validSettings(facts.settings)
        && inRange(facts.commit_mask, 0, 7) },
    confirms: (result, request) => sameSettings(result.settings, request.settings)
      && result.commit_mask === request.commit_mask },
  [OP.STAGE_SSID]: { ...STAGED, capability: CAP.WIRELESS, ble: null, details: { 16: 3, 25: 5 },
    request: (r, unused) => r[3] === 0 && r[4] <= 32 && unused(5 + r[4]) },
  [OP.STAGE_PASSWORD]: { ...STAGED, capability: CAP.WIRELESS, ble: null, details: { 17: 3, 25: 5 },
    request: (r, unused) => r[3] === 0 && (r[4] === 0 || r[4] >= 8 && r[4] <= 63)
      && printable(r.subarray(5, 5 + r[4])) && unused(5 + r[4]) },
  [OP.STAGE_KEY]: { ...STAGED, capability: CAP.WIRELESS, ble: null, details: { 18: 3, 25: 5 },
    request: (r, unused) => r[3] === 0 && [0, 32].includes(r[4]) && unused(5 + r[4]) },
  [OP.TEST_WIFI]: { capability: CAP.WIRELESS, ble: null, details: { 19: 3, 20: 3, 21: 3, 25: 5, 26: 5 },
    request: (r, unused) => r[3] === 0 && unused(4), lifecycle: { generationMax: 255, timeoutMs: 35000 } },
  [OP.CANCEL_TEST]: { capability: CAP.WIRELESS, ble: null, excluded: [1, 5],
    request: (r, unused) => r[3] === 0 && unused(4) },
  [OP.SCAN]: { capability: CAP.WIRELESS, ble: null, details: { 25: 5, 26: 5 },
    request: (r, unused) => r[3] === 0 && unused(4), lifecycle: { generationMax: 65535, timeoutMs: 15000 } },
  [OP.SCAN_ENTRY]: { ...STAGED, capability: CAP.WIRELESS, ble: null, details: { 22: 3, 23: 3, 26: 5 },
    request: (r, unused) => r[3] === 0 && r[4] < 18 && (r[5] | r[6] << 8) !== 0 && unused(7),
    completed: (data, zero) => (data[0] | data[1] << 8) !== 0 && data[2] < 18 && data[3] <= 32
      && zero(data.subarray(4 + data[3], 36)) && data[37] <= 7 && zero(data.subarray(38)),
    facts: { keys: ["scan_generation", "scan_index"],
      read: r => ({ scan_index: r[4], scan_generation: r[5] | r[6] << 8 }),
      valid: facts => inRange(facts.scan_generation, 1, 65535) && inRange(facts.scan_index, 0, 17) },
    confirms: (result, request) => (result.data[0] | result.data[1] << 8) === request.scan_generation
      && result.data[2] === request.scan_index },
});

/** @brief Whether the active link may carry this request; Bluetooth carries only the restricted command set. */
export function allowedOnLink(link, opcode, flags = 0) {
  const ble = OPCODES[opcode]?.ble;
  return link !== "ble" || Boolean(ble) && (ble.flags || flags === 0);
}
