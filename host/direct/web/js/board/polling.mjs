// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/**
 * @file Report polling and freshness: input reports, the status-report poll, the one Feature 12 poll owner and
 * scan/test lifecycle observation. Writes only `report/*` domain events.
 */
import {
  decodeBenchmarkReport, decodeStorageReport, decodeTelemetryReport, decodeWireless,
} from "../protocol/codec.mjs";
import {
  BLE_REPORT_LIFETIME_MS, CAP, OP, REPORT, REPORT_LIFETIME_MS, SCAN_STATE, STAGED_EXPIRED, WIFI_STATE,
} from "../protocol/constants.mjs";
import { OPCODES } from "../protocol/opcodes.mjs";
import { BoardError, errorValue, REASON } from "../state/errors.mjs";
import { withTimeout } from "../timers.mjs";

/** @brief Report IDs whose snapshot expires; Feature 12 lifetime follows its poll interval. */
/** @type {number[]} */
export const TRACKED_REPORTS = [REPORT.TELEMETRY, REPORT.STORAGE, REPORT.BENCHMARK];

/** @brief State cleared when a report expires. */
/** @type {Record<number, Partial<import("../state/reducer.mjs").DashboardState>>} */
const STALE = {
  [REPORT.TELEMETRY]: { runtime: null },
  [REPORT.STORAGE]: { memory: null, filesystem_format: null },
  [REPORT.BENCHMARK]: { self_test: null },
  [REPORT.WIRELESS]: { wireless: null, wireless_error: REASON.WIRELESS_STALE },
};

/** @brief Feature 12 poll interval: fast while a Wi-Fi test or scan runs, otherwise 2 s. */
/** @param {ReturnType<typeof decodeWireless> | null | undefined} wireless */
export const wirelessPollIntervalMs = wireless => wireless?.state === WIFI_STATE.TESTING
  || wireless?.scan_state === SCAN_STATE.SCANNING ? 500 : 2000;

/** @brief Whether a snapshot shows the saved (not staged or under test) SSID. */
/** @param {ReturnType<typeof decodeWireless>} wireless */
const showsSavedSsid = wireless => !wireless.staged_mask
  && wireless.state !== WIFI_STATE.TESTING && wireless.state !== WIFI_STATE.TEST_JOINED
  && wireless.state !== WIFI_STATE.TEST_FAILED;

/** @brief Lifetime of one report snapshot in milliseconds. */
/** @param {number} id
 * @param {ReturnType<typeof decodeWireless> | null | undefined} wireless
 * @param {"usb" | "ble"} [link] */
export const reportLifetimeMs = (id, wireless, link = "usb") => {
  if (id === REPORT.WIRELESS) return 3 * wirelessPollIntervalMs(wireless);
  const lifetimes = link === "ble" ? BLE_REPORT_LIFETIME_MS : REPORT_LIFETIME_MS;
  if (id === REPORT.TELEMETRY) return lifetimes[REPORT.TELEMETRY];
  if (id === REPORT.STORAGE) return lifetimes[REPORT.STORAGE];
  if (id === REPORT.BENCHMARK) return lifetimes[REPORT.BENCHMARK];
  return undefined;
};

/**
 * @typedef {object} PollingSession
 * @property {import("../state/reducer.mjs").DashboardState} state
 * @property {object | null} device
 * @property {AbortSignal} connectionSignal
 * @property {number} timeout
 * @property {ReturnType<typeof import("../timers.mjs").createTimerScope>} timers
 * @property {() => number} now
 * @property {(milliseconds: number, signal?: AbortSignal) => Promise<void>} sleep
 * @property {import("../transport/transport.mjs").Transport} transport
 * @property {boolean} disposed
 * @property {(type: string, changes: Partial<import("../state/reducer.mjs").DashboardState>) => void} emit
 */

/**
 * @brief Interpret one Feature 12 snapshot for an accepted scan/test lifecycle.
 * @param {ReturnType<typeof decodeWireless>} status Decoded Feature 12 snapshot.
 * @param {import("../state/reducer.mjs").WirelessLifecycle} pending Lifecycle record `{operation, generation}`.
 * @return `{kind: "completed", result}`, `{kind: "failed", error: BoardError}`, or null while still running; throws
 *   when the board started a different generation.
 */
export function wirelessLifecycleOutcome(status, pending) {
  if (pending.operation === OP.SCAN) {
    if (status.scan_generation !== pending.generation) throw new BoardError(REASON.SCAN_GENERATION_CHANGED);
    if (status.scan_state === SCAN_STATE.FAILED) {
      return { kind: "failed", error: new BoardError(REASON.WIRELESS_SCAN_FAILED) };
    }
    if (status.scan_state === SCAN_STATE.COMPLETE) return { kind: "completed", result: status };
  } else {
    if (status.test_generation !== pending.generation) throw new BoardError(REASON.TEST_GENERATION_CHANGED);
    if (status.state === WIFI_STATE.TEST_FAILED || status.staged_state & STAGED_EXPIRED) {
      return { kind: "failed", error: new BoardError(REASON.TEST_FAILED, status.detail || null) };
    }
    if (status.state === WIFI_STATE.TEST_JOINED && status.pair_tested) {
      // No lifetime is transmitted; the board starts a 600 s window on success. Subtract polling latency.
      return { kind: "completed", result: { ...status, remaining_seconds: 599 } };
    }
  }
  return null;
}

/** @brief Receipt clock for fresh reports; owns its one expiry timer. */
export class ReportReceipts {
  /**
   * @param {ReturnType<typeof import("../timers.mjs").createTimerScope>} timers Timer scope owning the expiry timer.
   * @param {() => number} now Monotonic clock in milliseconds.
   * @param {() => ReturnType<typeof decodeWireless> | null | undefined} wireless Current wireless snapshot.
   * @param {"usb" | "ble"} [link] Link whose delivery cadence sets the status-report deadlines.
   */
  constructor(timers, now, wireless, link = "usb") {
    this.timers = timers;
    this.now = now;
    this.wireless = wireless;
    this.link = link;
    /** @type {Map<number, number>} Report ID to receipt time. */
    this.received = new Map();
    this.timer = null;
  }

  /** @param {number} id */
  get(id) { return this.received.get(id); }
  get size() { return this.received.size; }

  /** @param {number} id */
  record(id) { this.received.set(id, this.now()); }

  /**
   * @brief Drop expired (or, when suspended, all) receipts.
   * @return State changes with `freshness`, or null when nothing expired.
   */
  /** @param {Record<number, "fresh" | "stale" | "unavailable">} freshness @param {boolean} [suspended] */
  expire(freshness, suspended = false) {
    /** @type {Partial<import("../state/reducer.mjs").DashboardState>} */
    const changes = {};
    const next = { ...freshness };
    for (const [id, received] of this.received) {
      if (!suspended && this.now() - received < reportLifetimeMs(id, this.wireless(), this.link)) continue;
      this.received.delete(id);
      next[id] = "stale";
      Object.assign(changes, STALE[id]);
    }
    return Object.keys(changes).length ? { ...changes, freshness: next } : null;
  }

  /** @brief Arm one timer for the earliest expiry; nothing is armed while there are no receipts. */
  /** @param {() => void} onExpire */
  schedule(onExpire) {
    this.cancel();
    if (!this.received.size) return;
    const deadline = Math.min(...[...this.received].map(([id, received]) =>
      received + reportLifetimeMs(id, this.wireless(), this.link)));
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      onExpire();
    }, Math.max(0, deadline - this.now()));
    this.timer.unref?.();
  }

  cancel() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  clear() {
    this.cancel();
    this.received.clear();
  }
}

/** @brief Report reader and freshness owner for one board session. */
export class Polling {
  /**
   * @param {PollingSession} session Report and link services used by polling.
   * @param {boolean} enabled Whether the session polls Feature 12 on its own.
   */
  constructor(session, enabled) {
    this.session = session;
    /** Feature 12 polling switch; tests disable it to drive reads explicitly. */
    this.enabled = enabled;
    this.receipts = new ReportReceipts(session.timers, () => session.now(), () => session.state.wireless,
      session.transport.kind);
    this.pollTimer = null;
    this.wirelessPollTimer = null;
    /** Clock value of the last Feature 12 poll. */
    this.wirelessLastRead = 0;
    this.wirelessReading = false;
    /** SSID hex of the last snapshot showing the saved (not staged) network; used to detect a changed SSID. */
    this.savedSsidHex = null;
  }

  /** @brief Record one status report from the transport or the poll. */
  /** @param {{reportId: number, data: DataView | Uint8Array}} event */
  onInputReport(event) {
    const s = this.session;
    const state = s.state;
    if (!state.connected || s.connectionSignal.aborted) return;
    const id = event.reportId;
    if (!TRACKED_REPORTS.includes(id)) return;
    if (id === REPORT.BENCHMARK && !((state.hardware?.capabilities ?? 0) & CAP.SELF_TEST)) {
      s.emit("report/failed", { error: { code: REASON.INVALID_REPORT, detail: "benchmark-capability" } });
      return;
    }
    try {
      /** @type {Partial<import("../state/reducer.mjs").DashboardState>} */
      const changes = id === REPORT.TELEMETRY ? { runtime: decodeTelemetryReport(event.data, state.hardware) }
        : id === REPORT.BENCHMARK ? { self_test: decodeBenchmarkReport(event.data) }
          : decodeStorageReport(event.data, state.hardware);
      this.receipts.record(id);
      this.scheduleExpiry();
      s.emit("report/received", { ...changes, freshness: { ...state.freshness, [id]: "fresh" } });
    } catch (error) { s.emit("report/failed", { error: errorValue(error) }); }
  }

  /** @brief Publish expired (or, when suspended, all) report snapshots as stale and re-arm the expiry timer. */
  /** @param {boolean} [suspended] */
  expireReports(suspended = false) {
    const changes = this.receipts.expire(this.session.state.freshness, suspended);
    if (changes) this.session.emit("report/expired", changes);
    this.scheduleExpiry();
  }

  /**
   * @brief Mark reports stale until a new receipt arrives, so gates wait for the board to reflect a command.
   * @param {number[]} [ids] Tracked report IDs; none is a no-op.
   */
  invalidate(ids = []) {
    if (!ids.length) return;
    /** @type {Partial<import("../state/reducer.mjs").DashboardState>} */
    const changes = { freshness: { ...this.session.state.freshness } };
    for (const id of ids) {
      this.receipts.received.delete(id);
      Object.assign(changes, STALE[id]);
      changes.freshness[id] = "stale";
    }
    this.session.emit("report/expired", changes);
    this.scheduleExpiry();
  }

  /** @brief Arm the expiry timer while a link is open. */
  scheduleExpiry() {
    if (this.session.device) this.receipts.schedule(() => this.expireReports());
    else this.receipts.cancel();
  }

  /** @brief Read one report with a timeout; throws if the connection changed meanwhile. */
  /** @param {number} id @param {AbortSignal} [signal] @param {number} [timeout] */
  async readReport(id, signal = this.session.connectionSignal, timeout = this.session.timeout) {
    const s = this.session;
    const device = s.device;
    const report = await withTimeout(s.transport.readReport(id, signal), timeout, signal, s.timers);
    signal.throwIfAborted();
    if (device !== s.device) throw new BoardError(REASON.CONNECTION_CHANGED);
    return report;
  }

  /** @brief Read status reports on links without Input reports while idle, then reschedule itself. */
  async pollReports() {
    const s = this.session;
    s.timers.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (!s.transport.pollInterval || !s.state.connected || s.disposed) return;
    const signal = s.connectionSignal;
    const idle = () => !s.state.busy && !s.state.pending_request;
    if (idle()) {
      try {
        for (const id of TRACKED_REPORTS) {
          if (id === REPORT.BENCHMARK && !((s.state.hardware?.capabilities ?? 0) & CAP.SELF_TEST)) continue;
          if (!idle()) break;
          const data = await this.readReport(id, signal);
          this.onInputReport({ reportId: id, data });
        }
      } catch (error) {
        if (!signal.aborted) {
          s.emit("report/failed", { error: { code: REASON.STATUS_READ_FAILED, detail: errorValue(error) } });
        }
      }
    }
    if (!signal.aborted && s.state.connected && !s.disposed) {
      this.pollTimer = s.timers.setTimeout(() => { void this.pollReports(); }, s.transport.pollInterval);
      this.pollTimer.unref?.();
    }
  }

  /** @brief The one Feature 12 poll owner: shared by both transports, self-rescheduling, independent of the UI. */
  pollWireless() {
    const s = this.session;
    s.timers.clearTimeout(this.wirelessPollTimer);
    this.wirelessPollTimer = null;
    if (!this.enabled || s.disposed || !s.state.connected || !(s.state.hardware?.capabilities & CAP.WIRELESS)) return;
    if (this.wirelessReading) return;
    const delay = this.wirelessLastRead + wirelessPollIntervalMs(s.state.wireless) - s.now();
    if (delay <= 0 && !s.state.busy && !s.state.reboot_pending && !s.state.pending_request
      && !s.state.wireless_busy) {
      void this.readWirelessNow();
      return;
    }
    this.wirelessPollTimer = s.timers.setTimeout(() => this.pollWireless(), Math.max(delay, 250));
    this.wirelessPollTimer.unref?.();
  }

  /** @brief Read Feature 12 once for the poll owner; failures expire reports and record a poll error. */
  async readWirelessNow() {
    const s = this.session;
    const signal = s.connectionSignal;
    this.wirelessReading = true;
    this.wirelessLastRead = s.now();
    try { await this.readWireless(); }
    catch (error) {
      if (!signal.aborted) {
        this.expireReports();
        s.emit("report/failed", { wireless_poll_error: errorValue(error) });
      }
    } finally {
      this.wirelessReading = false;
      if (!s.disposed) this.pollWireless();
    }
  }

  /** @brief Read and record one Feature 12 snapshot; throws if the connection changed meanwhile. */
  /** @param {AbortSignal} [operationSignal] @param {object | null} [device] */
  async readWireless(operationSignal, device = this.session.device) {
    const s = this.session;
    const signal = operationSignal ? AbortSignal.any([s.connectionSignal, operationSignal]) : s.connectionSignal;
    const wireless = decodeWireless(await this.readReport(REPORT.WIRELESS, signal, 1500), s.state.settings);
    if (signal.aborted || device !== s.device) throw new BoardError(REASON.WIRELESS_CONNECTION_CHANGED);
    if (showsSavedSsid(wireless)) this.savedSsidHex = wireless.ssid_hex;
    this.receipts.record(REPORT.WIRELESS);
    s.emit("report/received", { wireless, wireless_error: null, wireless_poll_error: null,
      freshness: { ...s.state.freshness, [REPORT.WIRELESS]: "fresh" } });
    this.scheduleExpiry();
    return wireless;
  }

  /** @brief Poll Feature 12 until the pending scan/test lifecycle completes or fails; never replays it. */
  /** @param {import("../state/reducer.mjs").WirelessLifecycle} pending
   * @param {(progress: import("../state/reducer.mjs").ReasonValue) => void} [onProgress]
   * @param {AbortSignal} [operationSignal] */
  async waitLifecycle(pending, onProgress, operationSignal) {
    const s = this.session;
    const device = s.device;
    const signal = operationSignal ? AbortSignal.any([s.connectionSignal, operationSignal]) : s.connectionSignal;
    const deadline = s.now() + OPCODES[pending.operation].lifecycle.timeoutMs;
    while (s.now() < deadline) {
      if (signal.aborted) throw new BoardError(REASON.WIRELESS_UNCERTAIN);
      const status = await this.readWireless(signal, device);
      const outcome = wirelessLifecycleOutcome(status, pending);
      if (outcome) return outcome;
      onProgress?.(status.detail ? { code: REASON.WIFI_DETAIL, detail: status.detail } : REASON.WIRELESS_CONNECTING);
      await s.sleep(500, signal);
    }
    throw new BoardError(REASON.WIRELESS_TIMEOUT);
  }

  /** @brief Stop every poll and forget per-connection receipts. */
  reset() {
    const timers = this.session.timers;
    timers.clearTimeout(this.pollTimer);
    timers.clearTimeout(this.wirelessPollTimer);
    this.pollTimer = null;
    this.wirelessPollTimer = null;
    this.wirelessLastRead = 0;
    this.savedSsidHex = null;
    this.receipts.clear();
  }
}
