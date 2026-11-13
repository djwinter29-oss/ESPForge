// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/** ESPForge device identity, capabilities and wire constants. */
export const DEVICE_FILTER = Object.freeze({ vendorId: 0xcafe, usagePage: 0xff00, usage: 1 });
/** USB product IDs of the development VID:PID pair. */
export const PRODUCT_IDS = Object.freeze([0x4021]);
/** Report 1 `product_id` of ESPForge. */
export const PRODUCT_ID = 0x0003;
export const CAP = Object.freeze({
  LED: 1, REBOOT: 2, SETTINGS: 4, SPI: 8, SDMMC: 16, SELF_TEST: 32, FORCED_SAVE: 64, WIRELESS: 128,
});
/** Capability bits an ESPForge board may report; the benchmark is optional. */
export const ESPFORGE_CAPABILITIES = CAP.LED | CAP.REBOOT | CAP.SETTINGS | CAP.SDMMC | CAP.SELF_TEST | CAP.WIRELESS;
export const OP = Object.freeze({
  LED: 1, REBOOT: 2, MSC: 3, BENCHMARK: 4, SAVE_SETTINGS: 5, STAGE_SSID: 6, STAGE_PASSWORD: 7, STAGE_KEY: 8, TEST_WIFI: 9, CANCEL_TEST: 10,
  SCAN: 11, SCAN_ENTRY: 12,
});
/** TCP CLI proof (13): ESPForge answers only Unsupported/error 4. */
export const UNSUPPORTED_OPCODES = Object.freeze([13]);
export const CONFIG_FLAGS = Object.freeze({
  CARD_DETECT: 0x01, LED: 0x02, MONITOR_UART: 0x04, WIFI: 0x08, BLE: 0x10, TCP_CLI: 0x20,
  MSC: 0x40, VALID_MASK: 0x5f, RADIO_MASK: 0x18,
});
export const CLOCKS_MHZ = Object.freeze([0, 80, 160, 240]);
/** ESPForge report IDs; Report 11 is conditional on the benchmark capability. */
export const REPORT = Object.freeze({
  IDENTITY: 1, CONFIG: 2, TELEMETRY: 3, STORAGE: 10, BENCHMARK: 11, WIRELESS: 12, CONTROL: 20,
});
/** Published status reports and how long each sample stays authoritative without a newer one. */
export const REPORT_LIFETIME_MS = Object.freeze({
  [REPORT.TELEMETRY]: 750, [REPORT.STORAGE]: 1500, [REPORT.BENCHMARK]: 1500,
});
/** Control result status byte. Values above PENDING are final. */
export const RESULT = Object.freeze({ IDLE: 0, PENDING: 1, COMPLETED: 2 });
/** Feature 12 `wifi_state`. */
export const WIFI_STATE = Object.freeze({ TESTING: 4, TEST_JOINED: 5, TEST_FAILED: 6 });
/** Feature 12 `scan_state`. */
export const SCAN_STATE = Object.freeze({ IDLE: 0, SCANNING: 1, COMPLETE: 2, FAILED: 3 });
/** Feature 12 `staged_state` bit set when staged wireless values expired. */
export const STAGED_EXPIRED = 8;
