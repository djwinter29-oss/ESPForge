// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/**
 * Pure version-1 HID report codecs and shared value rules for the Direct dashboard. No browser or device state.
 */
import {
  CAP, CONFIG_FLAGS, DEVICE_FILTER, ESPFORGE_CAPABILITIES, PRODUCT_ID, PRODUCT_IDS,
} from "./constants.mjs";
import { decodeSettings, OPCODES, validSettings } from "./opcodes.mjs";
import { BoardError, REASON } from "../state/errors.mjs";

function payload(report, size) {
  const view = report instanceof DataView ? report
    : report instanceof Uint8Array ? new DataView(report.buffer, report.byteOffset, report.byteLength) : null;
  // WebHID exposes the ID separately; no value-based framing or padding removal.
  if (!view || view.byteLength !== size) throw new BoardError(REASON.REPORT_LENGTH, size);
  if (view.getUint8(0) !== 1) throw new BoardError(REASON.LAYOUT_VERSION, view.getUint8(0));
  return view;
}

/** @brief Throw INVALID_REPORT naming `field` (a field ID shown by ui/messages.mjs) unless `condition` holds. */
export function requireValid(condition, field) {
  if (!condition) throw new BoardError(REASON.INVALID_REPORT, field);
}

export const bytesToHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
/** Decode already-validated even-length hex; use parseHexBytes at trust boundaries. */
export const hexToBytes = hex => Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16));
export function parseHexBytes(value, length, field = "control-key") {
  if (typeof value !== "string" || value.length !== length * 2 || !/^[a-f0-9]+$/i.test(value)) {
    throw new BoardError(REASON.INVALID_INPUT, field);
  }
  return hexToBytes(value);
}
const bytesAt = (view, offset, size) => new Uint8Array(view.buffer, view.byteOffset + offset, size);
const zero = bytes => bytes.every(byte => byte === 0);

/** @brief Highest ESP32-S3 GPIO number. */
const MAX_GPIO = 48;

export function decodeIdentityReport(report) {
  const view = payload(report, 26);
  const product = view.getUint16(1, true);
  if (product !== PRODUCT_ID) throw new BoardError(REASON.UNKNOWN_PRODUCT, product);
  const mcu = view.getUint8(14);
  const board = view.getUint8(15);
  const capabilities = view.getUint8(17);
  const total = view.getUint32(18, true);
  const reserved = view.getUint32(22, true);
  requireValid(Boolean(capabilities & CAP.SPI) && !(capabilities & ~ESPFORGE_CAPABILITIES)
    && total > 0 && reserved <= total && (board !== 1 || mcu === 3), "identity");
  return {
    version: 1, product_id: product, product_name: "ESPForge",
    serial_number: bytesToHex(bytesAt(view, 3, 8)).toUpperCase(),
    firmware_version: [11, 12, 13].map(offset => view.getUint8(offset)).join("."),
    mcu_id: mcu, mcu: ({ 3: "ESP32-S3" })[mcu] ?? null,
    board_model: board, board_name: ({ 0: "Unspecified", 1: "ESP32-S3-DevKitC-1" })[board] ?? null,
    capabilities, transport: "spi",
    ram_total_bytes: total, ram_reserved_bytes: reserved,
  };
}

export function decodeConfigReport(report, identity) {
  const view = payload(report, 17);
  const flags = view.getUint8(13);
  const gpios = [...bytesAt(view, 7, 6)];
  const uart = view.getUint8(4);
  const tx = view.getUint8(5);
  const rx = view.getUint8(6);
  const led = view.getUint8(15);
  const detect = view.getUint8(16);
  const settings = { system_clock_mhz: view.getUint16(1, true), sdcard_profile: view.getUint8(3),
    radios: (flags & CONFIG_FLAGS.RADIO_MASK) >> 3 };
  requireValid(validSettings(settings) && !(flags & ~CONFIG_FLAGS.VALID_MASK)
    && Boolean(flags & CONFIG_FLAGS.MONITOR_UART)
    && (identity.capabilities & CAP.WIRELESS || !(flags & CONFIG_FLAGS.RADIO_MASK))
    && [0, 1].includes(uart) && tx !== 255 && rx !== 255 && led === 255 && detect === 255
    && [tx, rx, ...gpios].every(pin => pin === 255 || pin <= MAX_GPIO)
    && gpios.slice(0, 4).every(pin => pin !== 255) && gpios.slice(4).every(pin => pin === 255),
  "board-configuration");
  return { ...settings, monitor_uart_index: uart, monitor_uart_tx_gpio: tx, monitor_uart_rx_gpio: rx,
    storage_gpios: gpios, board_flags: flags, reset_cause: view.getUint8(14) };
}

export function decodeTelemetryReport(report) {
  const view = payload(report, 22);
  const flags = view.getUint8(21);
  const loads = [view.getUint16(12, true), view.getUint16(14, true)];
  const temperature = view.getInt16(2, true);
  const clock = view.getUint32(16, true);
  // No LED, no CDC: the LED byte and extension bits 1 and 3 stay clear; the APP CPU reports no load.
  requireValid(view.getUint8(1) === 0 && !(flags & ~5) && (Boolean(flags & 4) || temperature === 0) && clock > 0
    && (loads[0] <= 10000 || loads[0] === 65535) && loads[1] === 65535, "telemetry");
  return { version: 1, sequence: view.getUint8(20), uptime_ms: view.getBigUint64(4, true),
    system_clock_hz: clock, usb_mounted: Boolean(flags & 1),
    temperature_valid: Boolean(flags & 4), temperature_centidegrees: flags & 4 ? temperature : null,
    cpu_usage_core0_basis_points: loads[0] === 65535 ? null : loads[0] };
}

function decodeCid(cid) {
  const ascii = (start, end) => String.fromCharCode(...cid.slice(start, end)).replace(/[\0 ]+$/, "");
  return { id: cid[0], oem_id: ascii(1, 3), product_name: ascii(3, 8),
    product_revision: `${cid[8] >> 4}.${cid[8] & 15}`,
    serial_number: new DataView(cid.buffer, cid.byteOffset, cid.byteLength).getUint32(9, false),
    manufacture_year: 2000 + ((cid[13] & 15) << 4) + (cid[14] >> 4), manufacture_month: cid[14] & 15 };
}

export function decodeStorageReport(report) {
  const view = payload(report, 34);
  const flags = view.getUint8(2);
  const component = view.getUint8(3);
  const mode = view.getUint8(4);
  const clock = view.getUint32(5, true);
  const speed = view.getUint8(9);
  const blocks = view.getUint32(10, true);
  const cid = bytesAt(view, 14, 16);
  const format = view.getUint8(30);
  const configured = Boolean(flags & 1);
  const sampleValid = Boolean(flags & 64);
  const initialized = Boolean(flags & 8);
  // ESPForge has no MSC: bytes 31-33 (enabled, transition pending, request rejected) are always zero.
  requireValid(!(flags & 128) && format <= 4 && zero(bytesAt(view, 31, 3))
    && (!sampleValid || configured) && (configured || !(flags & 126))
    && (sampleValid || (!(flags & 62) && zero(bytesAt(view, 3, 27))))
    && (!sampleValid || (component === 1 && mode === 2))
    && (!initialized || (flags & 15) === 15)
    && (!(flags & 48) || (sampleValid && initialized))
    && (!(flags & 4) || Boolean(flags & 2))
    && (initialized ? clock > 0 && [1, 2].includes(speed) : clock === 0 && speed === 0)
    && (Boolean(flags & 32) ? blocks > 0 : blocks === 0)
    && (Boolean(flags & 16) || zero(cid)), "storage-status");
  return {
    memory: { version: 1, sequence: view.getUint8(1), configured, sample_valid: sampleValid,
      presence_known: sampleValid && Boolean(flags & 2), present: sampleValid && Boolean(flags & 4),
      initialized, mode: sampleValid ? "spi" : null, speed_mode: speed,
      bus_clock_hz: clock, capacity_bytes: flags & 32 ? blocks * 512 : null,
      cid: [...cid], manufacturer: flags & 16 ? decodeCid(cid) : null },
    filesystem_format: ["unknown", "fat12", "fat16", "fat32", "exfat"][format],
  };
}

export function buildControlRequest(transaction, opcode, { flags = 0, args = [] } = {}) {
  requireValid(Number.isInteger(transaction) && transaction >= 1 && transaction <= 255, "transaction-id");
  requireValid(Number.isInteger(opcode) && opcode >= 0 && opcode <= 255
    && Number.isInteger(flags) && flags >= 0 && flags <= 255
    && args.length <= 64 && [...args].every(value => Number.isInteger(value) && value >= 0 && value <= 255),
  "command-arguments");
  const report = Uint8Array.from([1, transaction, opcode, flags, ...args, ...Array(64 - args.length).fill(0)]);
  requireValid(OPCODES[opcode]?.request(report, offset => zero(report.subarray(offset))), "control-request");
  return report;
}

export function decodeControlResult(report, { ble = false } = {}) {
  const view = payload(report, 68);
  const transaction = view.getUint8(1);
  const opcode = view.getUint8(2);
  const status = view.getUint8(3);
  const error = view.getUint8(4);
  const descriptor = OPCODES[opcode];
  const allowedErrors = [[0], [0], [0], [1, 2, 3], [4, 7], [5], [6]];
  requireValid(allowedErrors[status]?.includes(error)
    && (status === 0 ? transaction === 0 && opcode === 0
      : transaction !== 0 && (descriptor?.unsupported ? status === 4 && error === 4
        : descriptor ? error !== 7 && !descriptor.excluded?.includes(status)
        && (status !== 3 || (descriptor.rejections ?? [1, 3]).includes(error)) : status === 4 && error === 7))
    , "control-result");
  const data = bytesAt(view, 5, 63).slice();
  const detail = [3, 5, 6].includes(status) ? data[0] : 0;
  requireValid((ble || detail !== 28) && (!ble || !descriptor || descriptor.ble || status === 4 && error === 4),
    "transport-result");
  if ([3, 5, 6].includes(status)) {
    requireValid(zero(data.subarray(1)) && (!detail || descriptor?.details?.[detail] === status
      && (status !== 3 || error === 3)), "result-detail");
  } else if (status === 2 && descriptor?.completed) {
    requireValid(descriptor.completed(data, zero), "completed-result-data");
  } else {
    requireValid(zero(data), "result-data");
  }
  const saved = status === 2 && Boolean(descriptor?.returnsSettings);
  return { transaction_id: transaction, opcode, status, error_reason: error, detail, data,
    commit_mask: saved ? data[4] : 0, settings: saved ? decodeSettings(data) : null };
}

export function matchesEspForge(device) {
  return device.vendorId === DEVICE_FILTER.vendorId && PRODUCT_IDS.includes(device.productId)
    && device.collections.some(collection => collection.usagePage === DEVICE_FILTER.usagePage
      && collection.usage === DEVICE_FILTER.usage);
}

const bytesOf = report => report instanceof DataView
  ? new Uint8Array(report.buffer, report.byteOffset, report.byteLength) : report;

/** Preserve opaque bytes separately from the printable, never round-tripped label. */
export function displaySsid(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index];
    const size = byte < 128 ? 1 : byte >= 194 && byte <= 223 ? 2 : byte <= 239 && byte >= 224 ? 3
      : byte >= 240 && byte <= 244 ? 4 : 0;
    let decoded;
    try {
      if (!size || index + size > bytes.length) throw new Error();
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(index, index + size));
    } catch { decoded = null; }
    if (!decoded || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(decoded)) {
      text += `\\x${byte.toString(16).padStart(2, "0").toUpperCase()}`;
      index++;
    } else { text += decoded; index += size; }
  }
  return text;
}

export function ssidBytes(settings) {
  if (settings.ssid_hex !== undefined) {
    if (typeof settings.ssid_hex !== "string" || !/^(?:[a-f0-9]{2}){0,32}$/i.test(settings.ssid_hex)) {
      throw new BoardError(REASON.SSID_HEX_LENGTH);
    }
    return hexToBytes(settings.ssid_hex);
  }
  if (typeof settings.ssid !== "string") throw new BoardError(REASON.SSID_MISSING);
  const bytes = new TextEncoder().encode(settings.ssid);
  if (bytes.length > 32) throw new BoardError(REASON.SSID_LENGTH);
  return bytes;
}

export function decodeWireless(report, settings) {
  const bytes = bytesOf(report);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 48 || bytes[0] !== 1 || bytes[1] > 6
    || bytes[3] > 2 || bytes[9] > 32 || !zero(bytes.subarray(10 + bytes[9], 42))
    || bytes[42] > 3 || bytes[45] > 18 || bytes[42] !== 2 && bytes[45] !== 0
    || bytes[42] !== 0 && !(bytes[43] | bytes[44] << 8)
    || bytes[1] >= 4 && !bytes[46]
    || bytes[47] & 8 && bytes[4] & 240
    || bytes[47] & 1 && !(bytes[4] & 16) || bytes[47] & 2 && !(bytes[4] & 32)
    || bytes[47] & 4 && !(bytes[4] & 64)
    || bytes[4] & 128 && (!(bytes[4] & 48) || !bytes[46])
    || bytes[4] & 4
    || bytes[47] & 1 && (!(bytes[47] & 2) || !(bytes[4] & 32))) {
    throw new BoardError(REASON.WIRELESS_STATUS_INVALID);
  }
  const ssid = bytes.subarray(10, 10 + bytes[9]);
  return {
    ...(settings ? { wifi_enabled: Boolean(settings.radios & 1), ble_enabled: Boolean(settings.radios & 2) } : {}),
    wifi_state: ["disabled", "connecting", "connected", "failed", "testing", "test_joined", "test_failed"][bytes[1]],
    state: bytes[1], detail: bytes[2] <= 6 ? bytes[2] : 0,
    ble_state: ["off", "advertising", "connected"][bytes[3]],
    network_configured: Boolean(bytes[4] & 1), ble_key_configured: Boolean(bytes[4] & 2),
    staged_mask: bytes[4] >> 4 & 7, pair_tested: Boolean(bytes[4] & 128), staged_state: bytes[47] & 15,
    ssid_staged: Boolean(bytes[4] & 16), password_staged: Boolean(bytes[4] & 32), key_staged: Boolean(bytes[4] & 64),
    ipv4: [...bytes.subarray(5, 9)].join("."), ssid: displaySsid(ssid), ssid_hex: bytesToHex(ssid),
    scan_state: bytes[42], scan_generation: bytes[43] | bytes[44] << 8, scan_count: bytes[45],
    test_generation: bytes[46],
  };
}

export function decodeScanEntry(result) {
  const data = result.data;
  const raw = data.subarray(4, 4 + data[3]);
  const security = data[37];
  return { generation: data[0] | data[1] << 8, index: data[2], ssid: displaySsid(raw), ssid_hex: bytesToHex(raw),
    rssi: new DataView(data.buffer, data.byteOffset).getInt8(36), secured: Boolean(security),
    security: security & 4 ? security & 2 ? "WPA/RSN" : "RSN (WPA2/WPA3)"
      : security & 2 ? "WPA" : security & 1 ? "WEP" : "Open" };
}
