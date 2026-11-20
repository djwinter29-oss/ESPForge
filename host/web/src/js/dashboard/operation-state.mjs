// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/**
 * @typedef {object} OperationSnapshot
 * @property {boolean} [connected]
 * @property {boolean} [outcome_uncertain]
 * @property {boolean} [command_outcome_uncertain]
 * @property {boolean} [command_resync_supported]
 * @property {boolean} [wireless_cleanup_required]
 * @property {boolean} [reboot_pending]
 * @property {boolean} [telemetry_stale]
 * @property {boolean} [storage_stale]
 * @property {{led_available?: boolean, led_colour?: number | null, uptime_milliseconds?: number,
 * uptime_ms?: number} | null} [runtime]
 * @property {boolean} [self_test_stale]
 * @property {{active?: boolean} | null} [self_test]
 * @property {{capabilities?: number} | null} [hardware]
 * @property {{transition_pending?: boolean, enabled?: boolean} | null} [msc]
 * @property {{board_flags?: number} | null} [board_configuration]
 * @property {{sample_valid?: boolean, initialized?: boolean} | null} [memory]
 * @property {(import("./api.mjs").BootSettings & {tcp_cli_enabled?: boolean}) | null} [settings]
 * @property {boolean} [settings_supported]
 * @property {string | null} [settings_message]
 * @property {boolean} [busy]
 * @property {{stale?: boolean} | null} [wireless]
 * @property {string | null} [wireless_error]
 *
 * @typedef {object} Activity
 * @property {boolean} [uncertain]
 * @property {boolean} [rebootPending]
 * @property {boolean} [resyncing]
 * @property {boolean} [saving]
 * @property {boolean} [wirelessBusy]
 * @property {boolean} [wirelessInFlight]
 * @property {boolean} [statusFailed]
 * @property {boolean} [scanning]
 * @property {boolean} [radiosDirty]
 * @property {boolean} [settingsDirty]
 * @property {boolean} [wirelessDirty]
 * @property {boolean} [wirelessDraftDirty]
 * @property {string | null} [wirelessBlockReason]
 *
 * @typedef {{kind: "reconnect" | "resync"}
 *   | {kind: "settings", expected: import("./api.mjs").BootSettings}} Recovery
 * @typedef {Recovery & {message: string}} UncertainCommand
 */

/** Capability bits from Report 1 that the ESPForge dashboard acts on. */
export const CAPABILITY_REBOOT = 2;
export const CAPABILITY_SETTINGS = 4;
export const CAPABILITY_SPI = 8;
export const CAPABILITY_SDMMC = 16;
export const CAPABILITY_BENCHMARK = 32;
export const CAPABILITY_WIRELESS = 128;

/** Fresh report evidence may settle readback-based uncertainty, but never a resync-only obligation.
 * @param {UncertainCommand | null} command
 * @param {OperationSnapshot} snapshot
 */
export function commandSettled(command, snapshot) {
  switch (command?.kind) {
    case "reconnect": return snapshot.connected === false || snapshot.reboot_pending === true;
    case "settings": return snapshot.settings?.system_clock_mhz === command.expected.system_clock_mhz
      && snapshot.settings?.sdcard_profile === command.expected.sdcard_profile
      && snapshot.settings?.radios === command.expected.radios;
    default: return false;
  }
}

/**
 * @typedef {object} BoardCommandState
 * @property {UncertainCommand | null} uncertainCommand
 * @property {"requested" | "observed" | "disconnected" | null} rebootPending
 * @property {number | null} rebootUptimeMs
 * @property {{opcode: number, message: string} | null} commandFailure
 */

/** @returns {BoardCommandState} */
export function createCommandState() {
  return { uncertainCommand: null, rebootPending: null, rebootUptimeMs: null, commandFailure: null };
}

/** Update board-owned lifecycle state from a status poll, returning the settled recovery reason.
 * @param {BoardCommandState} state
 * @param {OperationSnapshot} snapshot
 * @returns {UncertainCommand | null}
 */
export function observeCommandStatus(state, snapshot) {
  const command = state.uncertainCommand;
  if (state.rebootPending !== null) {
    const uptime = reportedUptime(snapshot);
    if (snapshot.connected === false) state.rebootPending = "disconnected";
    else if (snapshot.reboot_pending) state.rebootPending = "observed";
    else if (snapshot.connected === true && state.rebootPending === "requested"
      && state.rebootUptimeMs !== null && uptime !== null && uptime < state.rebootUptimeMs) {
      state.rebootPending = null;
      state.rebootUptimeMs = null;
    } else if (snapshot.connected === true && state.rebootPending !== "requested") state.rebootPending = null;
    if (state.rebootPending === null) state.rebootUptimeMs = null;
  }
  const settled = commandSettled(command, snapshot) ? command : null;
  if (settled) state.uncertainCommand = null;
  return settled;
}

/** @param {OperationSnapshot} snapshot */
function reportedUptime(snapshot) {
  const uptime = snapshot.runtime?.uptime_milliseconds ?? snapshot.runtime?.uptime_ms;
  return typeof uptime === "number" && Number.isFinite(uptime) && uptime >= 0 ? uptime : null;
}

/** Terminal acknowledgement and lifecycle effects; MSC completion acknowledges admission, not settled ownership.
 * @param {import("./api.mjs").ControlResult} result
 */
export function commandEffects(result) {
  const completed = result.status === "completed";
  const reason = result.error && result.error !== "none" ? `: ${result.error}` : "";
  const detail = result.detail ? ` (detail ${result.detail})` : "";
  return {
    reboot: completed && (result.opcode === 2 || result.opcode === 5),
    wifiCancel: result.opcode === 10,
    completed,
    failure: completed ? null
      : `Command ${result.opcode} ${result.status}${reason}${detail}. Retry explicitly when the board is ready.`,
  };
}

/**
 * One admission policy for renderers and command handlers; local activity never changes reported board facts.
 * @param {OperationSnapshot | null} snapshot
 * @param {Activity} [activity]
 */
export function operationState(snapshot, activity = {}) {
  const capabilities = snapshot?.hardware?.capabilities ?? 0;
  const outcomeUncertain = Boolean(activity.uncertain || snapshot?.outcome_uncertain || snapshot?.command_outcome_uncertain);
  const rebootPending = Boolean(activity.rebootPending || snapshot?.reboot_pending);
  const cleanupRequired = Boolean(snapshot?.wireless_cleanup_required);
  const wirelessStatusReady = Boolean(snapshot?.wireless && !snapshot.wireless.stale && !snapshot.wireless_error);
  const wirelessBlockReason = snapshot?.connected && capabilities & CAPABILITY_WIRELESS
    && !wirelessStatusReady ? "Waiting for fresh wireless configuration before editing radios." : null;
  const storageStatusReady = Boolean(snapshot?.msc && !snapshot.storage_stale
    && (snapshot.memory?.sample_valid !== false || snapshot.msc.enabled));
  const benchmarkSupported = Boolean(capabilities & CAPABILITY_BENCHMARK);
  const benchmarkFresh = Boolean(snapshot?.self_test && snapshot.self_test_stale === false);
  const benchmarkPending = benchmarkSupported && (!benchmarkFresh || snapshot?.self_test?.active);
  const storageCommandPending = !storageStatusReady || Boolean(snapshot?.msc?.enabled
    || snapshot?.msc?.transition_pending || benchmarkPending);
  const storageBlockReason = !snapshot?.connected ? null
    : !snapshot.msc || snapshot.storage_stale ? "Waiting for fresh storage status."
      : snapshot.msc.enabled ? "Safely eject the USB drive, then return the card to firmware."
        : snapshot.msc.transition_pending || !storageStatusReady ? "Waiting for storage to become idle."
          : benchmarkPending ? benchmarkFresh ? "Waiting for the storage benchmark to finish."
            : "Waiting for fresh benchmark status."
        : null;
  const mscSupported = Boolean((snapshot?.board_configuration?.board_flags ?? 0) & 64);
  const busy = Boolean(activity.resyncing || activity.saving || activity.wirelessBusy || rebootPending
    || outcomeUncertain || cleanupRequired || activity.statusFailed || snapshot?.busy);
  /** @type {"resync" | "cleanup" | null} */
  const recovery = outcomeUncertain ? snapshot?.command_resync_supported ? "resync" : null
    : cleanupRequired ? "cleanup" : null;
  const canProvisionWireless = Boolean(snapshot?.connected && capabilities & CAPABILITY_WIRELESS
    && wirelessStatusReady && !busy && !storageCommandPending && snapshot?.storage_stale === false);
  const settingsBusy = Boolean(activity.resyncing || activity.saving || activity.wirelessInFlight || rebootPending
    || outcomeUncertain || cleanupRequired || activity.statusFailed);
  const saveBlockReason = !snapshot?.connected ? "Waiting for an ESPForge connection."
    : !snapshot.settings_supported || !snapshot.settings
      ? snapshot.settings_message || "Boot settings unavailable; update device firmware."
      : !(capabilities & CAPABILITY_SETTINGS) ? "Firmware does not support saving boot settings."
        : busy ? "Finish the pending operation or recovery before saving settings."
          : storageBlockReason
            ?? (activity.radiosDirty && !wirelessStatusReady ? wirelessBlockReason : null)
            ?? activity.wirelessBlockReason
            ?? (activity.wirelessDirty && !canProvisionWireless ? "Wait for fresh wireless and storage status before saving."
              : !activity.settingsDirty && !activity.wirelessDirty && activity.wirelessDraftDirty
                ? "Test Wi-Fi details before saving; untested credentials are not sent."
                : !activity.settingsDirty && !activity.wirelessDirty ? "No unsaved settings changes." : null);
  const canManageMsc = Boolean(snapshot?.connected && mscSupported && storageStatusReady
    && !snapshot.msc?.transition_pending && !benchmarkPending && !busy && !settingsBusy);
  const canSetLed = Boolean(snapshot?.connected && capabilities & 1 && snapshot.telemetry_stale === false
    && snapshot.runtime?.led_available && Number.isInteger(snapshot.runtime.led_colour) && !busy && !settingsBusy);
  const canReboot = Boolean(snapshot?.connected && capabilities & CAPABILITY_REBOOT && !settingsBusy
    && !storageCommandPending);
  const canStartBenchmark = Boolean(snapshot?.connected && benchmarkSupported && benchmarkFresh && !settingsBusy
    && !busy && !storageCommandPending && snapshot?.memory?.initialized);
  const canCancelBenchmark = Boolean(snapshot?.connected && benchmarkSupported && benchmarkFresh && !settingsBusy
    && !busy && snapshot?.self_test?.active);
  const canEnableMsc = canManageMsc && !snapshot?.msc?.enabled && snapshot?.memory?.initialized === true;
  const canReturnMsc = canManageMsc && snapshot?.msc?.enabled === true;
  const rebootBlockReason = canReboot ? null : !snapshot?.connected
    ? "Connect to an ESPForge board before rebooting."
    : !(capabilities & CAPABILITY_REBOOT) ? "Firmware does not support rebooting."
      : settingsBusy ? "Finish the pending operation or recovery before rebooting."
        : storageBlockReason ?? "Wait for storage to become idle before rebooting.";
  const ledBlockReason = canSetLed ? null : !snapshot?.connected
    ? "Connect to an ESPForge board to control its LED."
    : !(capabilities & 1) ? "Firmware does not support board LED control."
      : snapshot.telemetry_stale !== false ? "Waiting for fresh status before controlling the LED."
        : !snapshot.runtime?.led_available || !Number.isInteger(snapshot.runtime.led_colour)
          ? "Firmware does not report an available board LED."
          : busy || settingsBusy ? "Finish the pending operation or recovery before controlling the LED."
            : null;
  const mscEnableBlockReason = canEnableMsc ? null : !snapshot?.connected
    ? "Connect to a board before enabling USB storage."
    : !mscSupported ? "Firmware does not support USB storage handoff."
      : storageBlockReason ?? (busy || settingsBusy ? "Finish the pending operation before changing storage."
        : snapshot?.msc?.enabled ? "USB storage is already active; safely eject it before returning the card."
          : "Initialize a detected card before enabling USB storage.");
  const mscReturnBlockReason = canReturnMsc ? null : !snapshot?.connected
    ? "Connect to a board before returning USB storage."
    : !mscSupported ? "Firmware does not support USB storage handoff."
      : storageBlockReason ?? (busy || settingsBusy ? "Finish the pending operation before changing storage."
        : "USB storage is not active.");
  const benchmarkStartBlockReason = canStartBenchmark ? null : !snapshot?.connected
    ? "Connect to a board before starting a benchmark."
    : !benchmarkSupported ? "Firmware does not support storage benchmarks."
      : !benchmarkFresh ? "Waiting for fresh benchmark status."
        : snapshot?.self_test?.active ? "A benchmark is already running; cancel it before starting another."
          : storageBlockReason ?? (busy || settingsBusy ? "Finish the pending operation before starting a benchmark."
            : !snapshot?.memory?.initialized ? "Initialize a detected card before starting a benchmark."
              : "Storage is not ready for a benchmark.");
  const benchmarkCancelBlockReason = canCancelBenchmark ? null : !snapshot?.connected
    ? "Connect to a board before canceling a benchmark."
    : !benchmarkSupported ? "Firmware does not support storage benchmarks."
      : !benchmarkFresh ? "Waiting for fresh benchmark status."
        : !snapshot?.self_test?.active ? "No storage benchmark is currently running."
          : busy || settingsBusy ? "Finish the pending operation before canceling the benchmark."
            : null;
  return {
    canSetLed, ledBlockReason,
    outcomeUncertain, rebootPending, storageCommandPending, storageStatusReady,
    storageBlockReason, wirelessStatusReady, wirelessBlockReason, busy,
    canProvisionWireless, canSaveSettings: saveBlockReason === null, saveBlockReason,
    canReboot, rebootBlockReason,
    recovery,
    canRecover: Boolean(recovery && snapshot?.connected && !activity.resyncing && !activity.statusFailed
      && !activity.saving && !activity.wirelessInFlight),
    settingsBusy,
    mscSupported, canEnableMsc, canReturnMsc, mscEnableBlockReason, mscReturnBlockReason,
    benchmarkSupported, canStartBenchmark, canCancelBenchmark,
    benchmarkStartBlockReason, benchmarkCancelBlockReason,
    boardSelectionBusy: Boolean(activity.resyncing || activity.scanning || activity.saving || activity.wirelessBusy),
  };
}

/** @typedef {ReturnType<typeof operationState>} OperationState */
