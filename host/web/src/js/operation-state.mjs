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
 * @property {{capabilities?: number} | null} [hardware]
 * @property {{transition_pending?: boolean, enabled?: boolean} | null} [msc]
 * @property {(import("./dashboard-api.mjs").BootSettings & {tcp_cli_enabled?: boolean}) | null} [settings]
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
 * @property {string | null} [wirelessBlockReason]
 *
 * @typedef {{kind: "reconnect" | "resync"}
 *   | {kind: "settings", expected: import("./dashboard-api.mjs").BootSettings}} Recovery
 * @typedef {Recovery & {message: string}} UncertainCommand
 */

/** Capability bits from Report 1 that the ESPForge dashboard acts on. */
export const CAPABILITY_REBOOT = 2;
export const CAPABILITY_SETTINGS = 4;
export const CAPABILITY_SPI = 8;
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
 * @property {{opcode: number, message: string} | null} commandFailure
 */

/** @returns {BoardCommandState} */
export function createCommandState() {
  return { uncertainCommand: null, rebootPending: null, commandFailure: null };
}

/** Update board-owned lifecycle state from a status poll, returning the settled recovery reason.
 * @param {BoardCommandState} state
 * @param {OperationSnapshot} snapshot
 * @returns {UncertainCommand | null}
 */
export function observeCommandStatus(state, snapshot) {
  const command = state.uncertainCommand;
  if (state.rebootPending !== null) {
    if (snapshot.connected === false) state.rebootPending = "disconnected";
    else if (snapshot.reboot_pending) state.rebootPending = "observed";
    else if (snapshot.connected === true && state.rebootPending !== "requested") state.rebootPending = null;
  }
  const settled = commandSettled(command, snapshot) ? command : null;
  if (settled) state.uncertainCommand = null;
  return settled;
}

/** Terminal acknowledgement for reboot (2), save (5) and Wi-Fi cancel (10); other opcodes are Unsupported.
 * @param {import("./dashboard-api.mjs").ControlResult} result
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
  // ESPForge has no USB drive, but both hosts still require fresh Report 10 before a reboot or save.
  const storageStatusReady = Boolean(snapshot?.msc && !snapshot.storage_stale);
  const storageCommandPending = !storageStatusReady || Boolean(snapshot?.msc?.enabled || snapshot?.msc?.transition_pending);
  const storageBlockReason = !snapshot?.connected ? null
    : !snapshot.msc || snapshot.storage_stale ? "Waiting for fresh storage status."
      : snapshot.msc.enabled || snapshot.msc.transition_pending ? "Storage reports an unexpected USB-drive state."
        : null;
  const busy = Boolean(activity.resyncing || activity.saving || activity.wirelessBusy || rebootPending
    || outcomeUncertain || cleanupRequired || activity.statusFailed || snapshot?.busy);
  /** @type {"resync" | "cleanup" | null} */
  const recovery = outcomeUncertain ? snapshot?.command_resync_supported ? "resync" : null
    : cleanupRequired ? "cleanup" : null;
  const canProvisionWireless = Boolean(snapshot?.connected && capabilities & CAPABILITY_WIRELESS
    && wirelessStatusReady && !busy && !storageCommandPending && snapshot?.storage_stale === false);
  const saveBlockReason = !snapshot?.connected ? "Waiting for an ESPForge connection."
    : !snapshot.settings_supported || !snapshot.settings
      ? snapshot.settings_message || "Boot settings unavailable; update device firmware."
      : !(capabilities & CAPABILITY_SETTINGS) ? "Firmware does not support saving boot settings."
        : busy ? "Finish the pending operation or recovery before saving settings."
          : storageBlockReason
            ?? (activity.radiosDirty && !wirelessStatusReady ? wirelessBlockReason : null)
            ?? activity.wirelessBlockReason
            ?? (activity.wirelessDirty && !canProvisionWireless ? "Wait for fresh wireless and storage status before saving."
              : !activity.settingsDirty && !activity.wirelessDirty ? "No unsaved settings changes." : null);
  const settingsBusy = Boolean(activity.resyncing || activity.saving || activity.wirelessInFlight || rebootPending
    || outcomeUncertain || cleanupRequired || activity.statusFailed);
  return {
    outcomeUncertain, rebootPending, storageCommandPending, storageStatusReady,
    storageBlockReason, wirelessStatusReady, wirelessBlockReason, busy,
    canProvisionWireless, canSaveSettings: saveBlockReason === null, saveBlockReason,
    canReboot: Boolean(snapshot?.connected && capabilities & CAPABILITY_REBOOT && !settingsBusy && !storageCommandPending),
    recovery,
    canRecover: Boolean(recovery && snapshot?.connected && !activity.resyncing && !activity.statusFailed
      && !activity.saving && !activity.wirelessInFlight),
    settingsBusy,
    boardSelectionBusy: Boolean(activity.resyncing || activity.scanning || activity.saving || activity.wirelessBusy),
  };
}

/** @typedef {ReturnType<typeof operationState>} OperationState */
