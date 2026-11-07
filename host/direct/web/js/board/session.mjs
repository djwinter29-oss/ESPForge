// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/**
 * @file Board session: owns the active transport, serializes link I/O and fences late results by generation so a
 * previous connection can never update the dashboard.
 */

import { POLL_INTERVAL_MS } from "../protocol/constants.mjs";
import { DeviceError, errorMessage, isChooserCancelled } from "../state/errors.mjs";
import { selectControls } from "../state/selectors.mjs";
import { CommandRejected, prepareWifiCommand } from "./commands.mjs";
import { createPoller } from "./polling.mjs";

/**
 * @typedef {import("../transport/transport.mjs").Transport} Transport
 * @typedef {import("../transport/transport.mjs").TransportKind} TransportKind
 * @typedef {{ ok: boolean, message: string }} CommandResult
 */

export class BoardSession {
  /** @type {Transport | null} */ transport = null;
  /** @type {Promise<void> | null} */ active = null;
  generation = 0;

  /**
   * @param {{
   *   createTransport: (kind: TransportKind) => Transport,
   *   store: import("../state/store.mjs").DashboardStore,
   *   timers: import("../timers.mjs").TimerScope,
   *   now?: () => number,
   *   pollInterval?: number,
   * }} options
   */
  constructor({ createTransport, store, timers, now = Date.now, pollInterval = POLL_INTERVAL_MS }) {
    this.createTransport = createTransport;
    this.store = store;
    this.now = now;
    this.poller = createPoller({ timers, interval: pollInterval, task: () => this.sample() });
  }

  /**
   * @brief Open a link chosen by the user. Must be called from a click so the browser shows its picker.
   * @param {TransportKind} kind
   */
  async connect(kind) {
    if (!selectControls(this.store.getState()).connect) return;
    const generation = ++this.generation;
    const transport = this.createTransport(kind);
    this.transport = transport;
    this.store.dispatch({ type: "connecting", kind });
    try {
      await transport.connect();
    } catch (error) {
      if (generation === this.generation) await this.abandon(transport, error);
      return;
    }
    if (generation !== this.generation) {
      await transport.close().catch(() => {});
      return;
    }
    transport.addEventListener("disconnect", () => {
      const failure = /** @type {{ failure?: Error | null }} */ (transport).failure;
      void this.fail(failure ?? new Error("Board link lost"), generation);
    });
    this.store.dispatch({
      type: "connected",
      transport: { kind, label: transport.label, writable: transport.writable, simulated: transport.simulated },
    });
    await this.poller.start();
  }

  /**
   * @param {Transport} transport
   * @param {unknown} error
   */
  async abandon(transport, error) {
    const cancelled = isChooserCancelled(error);
    try {
      await transport.close();
      if (this.transport === transport) this.transport = null;
      if (cancelled) this.store.dispatch({ type: "disconnected", notice: "No board was selected." });
      else this.store.dispatch({ type: "failed", error: errorMessage(error) });
    } catch (closeError) {
      this.store.dispatch({
        type: "failed", error: `${errorMessage(error)}; cleanup failed: ${errorMessage(closeError)}`,
        cleanup_pending: true,
      });
    }
  }

  /** @brief Close the link on request; a failed close keeps Disconnect available for a retry. */
  async disconnect() {
    ++this.generation;
    this.poller.stop();
    const transport = this.transport;
    try {
      await transport?.close();
      if (this.transport === transport) this.transport = null;
      this.store.dispatch({ type: "disconnected" });
    } catch (error) {
      this.store.dispatch({ type: "failed", error: `Disconnect failed: ${errorMessage(error)}`, cleanup_pending: true });
    }
  }

  /**
   * @brief Any link failure clears device facts and releases the link; commands are never retried.
   * @param {unknown} error
   * @param {number} generation
   */
  async fail(error, generation) {
    if (generation !== this.generation) return;
    ++this.generation;
    this.poller.stop();
    const transport = this.transport;
    this.store.dispatch({ type: "failed", error: errorMessage(error) });
    try {
      await transport?.close();
      if (this.transport === transport) this.transport = null;
    } catch (closeError) {
      if (this.transport === transport) {
        this.store.dispatch({
          type: "failed", error: `${errorMessage(error)}; cleanup failed: ${errorMessage(closeError)}`,
          cleanup_pending: true,
        });
      }
    }
  }

  /**
   * @brief Run one link operation at a time for the current generation.
   * @param {number} generation
   * @param {(transport: Transport) => Promise<void>} operation
   */
  async exclusive(generation, operation) {
    while (this.active) await this.active;
    const transport = this.transport;
    if (generation !== this.generation || !transport) return;
    const run = (async () => {
      this.store.dispatch({ type: "busy", busy: true });
      try {
        await operation(transport);
      } catch (error) {
        await this.fail(error, generation);
      } finally {
        if (generation === this.generation) this.store.dispatch({ type: "busy", busy: false });
      }
    })();
    this.active = run;
    try {
      await run;
    } finally {
      if (this.active === run) this.active = null;
    }
  }

  async sample() {
    if (this.active) return;
    const generation = this.generation;
    await this.exclusive(generation, async transport => {
      const status = await transport.status();
      if (generation === this.generation) this.store.dispatch({ type: "sample", status, at: this.now() });
    });
  }

  refresh() {
    return this.poller.trigger();
  }

  /**
   * @brief Submit Wi-Fi credentials once for this boot. Local rejections and board error replies keep the link.
   * @param {unknown} input
   * @return {Promise<CommandResult>}
   */
  async connectWifi(input) {
    let credentials;
    try {
      credentials = prepareWifiCommand(this.store.getState(), input);
    } catch (error) {
      if (error instanceof CommandRejected) return { ok: false, message: error.message };
      throw error;
    }
    const generation = this.generation;
    /** @type {CommandResult | null} */
    let result = null;
    await this.exclusive(generation, async transport => {
      this.store.dispatch({ type: "busy", busy: true, command: "wifi" });
      try {
        await transport.wifiConnect(credentials);
        result = { ok: true, message: "Request accepted, not yet connected. Watch Wi-Fi association and result." };
        this.store.dispatch({ type: "notice", message: result.message });
      } catch (error) {
        if (!(error instanceof DeviceError)) throw error;
        result = { ok: false, message: error.message };
      }
    });
    if (generation === this.generation) void this.refresh();
    return result ?? { ok: false, message: this.store.getState().error ?? "Board disconnected" };
  }

  dispose() {
    ++this.generation;
    this.poller.stop();
    const transport = this.transport;
    this.transport = null;
    transport?.close().catch(() => {});
  }
}
