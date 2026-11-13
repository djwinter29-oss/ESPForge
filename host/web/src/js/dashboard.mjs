// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { renderWirelessStatus } from "./wireless-form.mjs";
import { CAPABILITY_SDMMC, CAPABILITY_WIRELESS, operationState } from "./operation-state.mjs";

/**
 * @typedef {import("./dashboard-api.mjs").StatusSnapshot & {
 * settings_draft?: import("./dashboard-api.mjs").BootSettings,
 * settings_dirty?: boolean, wireless_dirty?: boolean, no_board_selected?: boolean,
 * status_read_error?: boolean, status_reading?: boolean}} DashboardView
 */
/** @param {string} selector */
function element(selector) {
  const node = /** @type {HTMLElement | null} */ (document.querySelector(selector));
  if (!node) throw new Error(`Missing dashboard element: ${selector}`);
  return node;
}
/** @param {string} selector */
const select = selector => /** @type {HTMLSelectElement} */ (element(selector));
/** @param {string} selector */
const button = selector => /** @type {HTMLButtonElement} */ (element(selector));
/** @param {number | undefined} milliseconds */
function uptimeLabel(milliseconds) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "--";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return days ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${seconds}s`;
}

/** @type {{memory: import("./dashboard-api.mjs").Memory, filesystemFormat: string | null | undefined} | null} */
let lastStorageDetails = null;
let cardDetected = false;
/** @type {string | null} */
let boardConfigurationSignature = null;
/** @type {{uartTitle: HTMLElement, storageTitle: HTMLElement, uartTable: HTMLElement,
 * storageTable: HTMLElement, resetCause: HTMLElement} | null} */
let boardConfigurationElements = null;
/** @type {Document | null} */
let boardConfigurationDocument = null;

/**
 * Lift the view's shortcuts out of the shared status shape (tests/status-contract.json): both servers nest USB-drive
 * ownership and filesystem format in `memory` and next-boot settings in `board_configuration`.
 * @param {import("./dashboard-api.mjs").StatusSnapshot} snapshot
 * @returns {import("./dashboard-api.mjs").StatusSnapshot}
 */
export function normalizeStatus(snapshot) {
  const configuration = snapshot.settings_supported ? snapshot.board_configuration : null;
  return {
    ...snapshot,
    msc: snapshot.memory?.msc ?? null,
    filesystem_format: snapshot.memory?.filesystem_format ?? null,
    settings: (configuration ? {
      system_clock_mhz: configuration.system_clock_mhz, sdcard_profile: configuration.sdcard_profile,
      radios: configuration.radios, tcp_cli_enabled: configuration.tcp_cli_enabled,
    } : null),
  };
}

/** @param {DashboardView} snapshot @param {import("./operation-state.mjs").OperationState} [operations] */
export function renderStatus(snapshot, operations = operationState(snapshot, {
  settingsDirty: snapshot.settings_dirty, wirelessDirty: snapshot.wireless_dirty,
})) {
  const connected = Boolean(snapshot.connected);
  if (!connected) {
    lastStorageDetails = null;
    cardDetected = false;
  }
  const hardware = snapshot.hardware;
  const runtime = snapshot.telemetry_stale ? null : snapshot.runtime;
  const connection = element("#connection");
  connection.dataset.state = snapshot.error ? "error" : connected ? "connected" : "disconnected";
  element("#connection-label").textContent = snapshot.error
    ? "Attention" : snapshot.reconnecting ? "Reconnecting" : connected ? "Connected" : "Disconnected";
  element("#product-name").textContent = hardware?.product_name !== undefined
    ? `${hardware.product_name}${(hardware.capabilities ?? 0) & CAPABILITY_SDMMC ? " (SDMMC)" : ""}` : "--";
  const boardModel = typeof hardware?.board_model === "string" ? hardware.board_model
    : ({ 1: "ESP32-S3-DevKitC-1" })[hardware?.board_model ?? 0]
      ?? (hardware?.board_model !== undefined ? `Unknown (${hardware.board_model})` : "--");
  element("#board-model").textContent = hardware?.mcu
    ? `${boardModel} (${hardware.mcu})` : boardModel;
  element("#firmware-version").textContent = hardware?.firmware_version ?? "Unknown";
  const clock = runtime?.system_clock_hz !== undefined
    ? `${(runtime.system_clock_hz / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} MHz`
    : "--";
  element("#identity-clock").textContent = clock;
  renderSettings(snapshot, operations);
  element("#cpu-usage-core0").textContent = [
    runtime?.cpu_usage_core0_basis_points, runtime?.cpu_usage_core1_basis_points,
  ].map(load => load == null ? "--" : `${(load / 100).toFixed(1)}%`).join(" / ");
  const ramUsed = hardware?.ram_reserved_bytes;
  const ramTotal = hardware?.ram_total_bytes;
  element("#ram-usage").textContent = typeof ramTotal === "number" && Number.isSafeInteger(ramTotal) && ramTotal > 0
    && typeof ramUsed === "number" && Number.isSafeInteger(ramUsed) && ramUsed >= 0 && ramUsed <= ramTotal
    ? `${(ramUsed / 1024).toFixed(1)} / ${(ramTotal / 1024).toFixed(0)} KiB`
      + ` (${(ramUsed * 100 / ramTotal).toFixed(1)}%)`
    : "--";
  element("#serial").textContent = hardware?.serial_number || "--";
  element("#uptime").textContent = runtime
    ? uptimeLabel(runtime.uptime_milliseconds ?? runtime.uptime_ms) : "--";
  renderWirelessStatus(snapshot);
  const memory = snapshot.storage_stale ? null : snapshot.memory;
  if (connected && memory && memory.sample_valid !== false)
    cardDetected = memory.presence_known === true ? memory.present === true : memory.initialized === true;
  element('[aria-labelledby="memory-title"]').hidden = !(cardDetected || memory?.msc?.enabled
    || memory?.msc?.transition_pending);
  element("#temperature").textContent = runtime?.temperature_valid && runtime.temperature_centidegrees != null
    ? `${(runtime.temperature_centidegrees / 100).toFixed(2)} °C` : "--";
  renderBoardConfiguration(snapshot);
  renderMemory(memory, snapshot.filesystem_format, Boolean(snapshot.storage_stale),
    snapshot.board_configuration?.card_detect_gpio);
  element("#msc-controls").hidden = !operations.mscSupported;
  button("#msc-enable").disabled = !operations.canEnableMsc;
  button("#msc-return").disabled = !operations.canReturnMsc;
  element("#benchmark-controls").hidden = !operations.benchmarkSupported || !cardDetected;
  button("#benchmark-start").disabled = !operations.canStartBenchmark;
  button("#benchmark-cancel").disabled = !operations.canCancelBenchmark;
  /** @type {HTMLInputElement} */ (element("#benchmark-size")).disabled = !operations.canStartBenchmark;
  const benchmark = snapshot.self_test_stale ? null : snapshot.self_test;
  const rate = (/** @type {number | null | undefined} */ value) =>
    value == null ? "--" : `${(value / 1024 ** 2).toFixed(2)} MiB/s`;
  element("#benchmark-state").textContent = benchmark
    ? `${benchmark.state ?? "--"} (${benchmark.progress_percent?.toFixed(1) ?? "--"}%)` : "Waiting for fresh status";
  element("#benchmark-write").textContent = rate(benchmark?.write_bytes_per_second);
  element("#benchmark-read").textContent = rate(benchmark?.read_bytes_per_second);
  element("#benchmark-result").textContent = !benchmark ? "--" : benchmark.error
    ? `Error ${benchmark.error}; filesystem ${benchmark.filesystem_result ?? "--"}`
      + (benchmark.file_remains ? "; EFTEST.BIN may remain" : "")
    : `${benchmark.mismatch_count ?? "--"} mismatched bytes`;
  if (memory?.msc?.enabled || memory?.msc?.transition_pending) {
    element("#memory-state").textContent = memory.msc.transition_pending ? "Changing ownership" : "USB drive";
    element("#memory-note").textContent = memory.msc.transition_pending ? "Waiting for storage handoff."
      : "Safely eject the drive in Linux/Windows before returning it to firmware.";
    element("#memory-note").hidden = false;
  } else if (memory?.msc?.request_rejected) {
    element("#memory-note").textContent = "Storage handoff failed or the card changed. Check UART logs and retry explicitly.";
    element("#memory-note").hidden = false;
  }

  const message = snapshot.error ?? (snapshot.wireless_cleanup_required
    ? "Temporary Wi-Fi credentials need cleanup. Clear the Wi-Fi test before sending another command."
    : snapshot.reconnecting ? "Reconnecting..."
    : runtime ? "HID telemetry is live"
    : connected && snapshot.telemetry_stale ? "Telemetry report is stale"
    : connected ? "Waiting for first status report"
      : snapshot.no_board_selected ? "Select an ESPForge board" : "Connect an ESPForge board");
  const statusLine = element(".status-line");
  statusLine.dataset.error = String(Boolean(snapshot.error || snapshot.diagnostic_error));
  statusLine.dataset.active = String(Boolean(connected && runtime));
  element("#status-message").textContent = [message, snapshot.diagnostic_error].filter(Boolean).join(" ");
  const commandResync = button("#command-resync");
  if (commandResync) {
    const recovery = operations.recovery;
    commandResync.textContent = recovery === "cleanup" ? "Clear Wi-Fi test" : "Re-sync";
    commandResync.hidden = recovery === null;
    commandResync.disabled = !operations.canRecover;
    const wifiResync = button("#wifi-resync");
    if (wifiResync) {
      wifiResync.hidden = recovery !== "resync";
      wifiResync.disabled = commandResync.disabled;
    }
  }
}

/** Project accepted settings plus owned field drafts into the controls. */
/** @param {DashboardView} snapshot */
export function initializeSettings(snapshot) {
  const settings = snapshot.settings_draft ?? snapshot.settings;
  updateClockOptions(select("#settings-clock"), snapshot.hardware?.mcu,
    settings?.system_clock_mhz);
  if (settings) select("#settings-clock").value = String(settings.system_clock_mhz);
}

/** @param {DashboardView} snapshot @param {import("./operation-state.mjs").OperationState} operations */
function renderSettings(snapshot, operations) {
  const settings = snapshot.settings;
  const supported = Boolean(snapshot.connected && snapshot.settings_supported && settings);
  const ready = supported && !operations.storageCommandPending;
  const wireless = Boolean((snapshot.hardware?.capabilities ?? 0) & CAPABILITY_WIRELESS);
  for (const id of ["wifi-settings", "ble-settings"])
    element(`#${id}`).hidden = !wireless;
  for (const selector of ["#settings-clock", "#settings-wifi", "#settings-ble"]) {
    (/** @type {HTMLSelectElement} */ (element(selector))).disabled = operations.settingsBusy || !ready
      || (selector === "#settings-wifi" || selector === "#settings-ble") && !operations.wirelessStatusReady;
  }
  const canSave = operations.canSaveSettings;
  const saveBlockReason = operations.saveBlockReason;
  button("#settings-save").disabled = !canSave;
  button("#settings-save").title = saveBlockReason ?? "";
  button("#reboot-control").disabled = !operations.canReboot;
  element("#settings-note").textContent = snapshot.settings_message
    || ((snapshot.settings_dirty || snapshot.wireless_dirty) ? saveBlockReason : null)
    || (!snapshot.connected ? "Waiting for an ESPForge connection."
      : !snapshot.settings_supported ? "Boot settings unavailable; update device firmware."
        : operations.storageBlockReason ?? operations.wirelessBlockReason ?? "");
  element("#settings-note").hidden = !element("#settings-note").textContent;
  element("#status-message").hidden = !snapshot.error && !snapshot.diagnostic_error
    && !element("#settings-note").hidden;
}

/** @param {HTMLSelectElement} select @param {string | undefined} mcu @param {number | undefined} savedClock */
function updateClockOptions(select, mcu, savedClock) {
  /** @type {Array<[number, string, boolean?]>} */
  const choices = mcu === "ESP32-S3"
    ? [[0, "Default (240 MHz)"], [80, "80 MHz"], [160, "160 MHz"], [240, "240 MHz"]]
    : [[0, "Default"]];
  const unsupportedClock = Number.isInteger(savedClock) && savedClock !== 0
    && !choices.some(([value]) => value === savedClock) ? savedClock : null;
  const signature = `${mcu ?? "unknown"}:${unsupportedClock ?? ""}`;
  if (select.dataset.clockOptions === signature
    || typeof document.createElement !== "function" || typeof select.replaceChildren !== "function") return;

  const previous = select.value;
  /** @type {Array<[number, string, boolean?]>} */
  const allChoices = [...choices];
  if (unsupportedClock !== null && unsupportedClock !== undefined)
    allChoices.push([unsupportedClock, `${unsupportedClock} MHz (saved; unsupported)`, true]);
  const options = allChoices.map(([value, label, disabled = false]) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = label;
      option.disabled = disabled;
      return option;
    });
  select.replaceChildren(...options);
  select.dataset.clockOptions = signature;
  select.value = options.some(option => option.value === previous) ? previous : "0";
}

/** @param {DashboardView} snapshot */
function renderBoardConfiguration(snapshot) {
  if (boardConfigurationDocument !== document || !boardConfigurationElements) {
    boardConfigurationDocument = document;
    boardConfigurationSignature = null;
    boardConfigurationElements = {
      uartTitle: element("#board-uart-title"),
      storageTitle: element("#board-storage-title"),
      uartTable: element("#board-uart"),
      storageTable: element("#board-storage-pins"),
      resetCause: element("#board-reset-cause"),
    };
  }
  const { uartTitle, storageTitle, uartTable, storageTable, resetCause } = boardConfigurationElements;
  const configuration = snapshot.board_configuration;
  /** @param {HTMLElement} element @param {string} value */
  const setText = (element, value) => {
    if (element.textContent !== value) element.textContent = value;
  };
  /** @param {number | undefined} pin */
  const formatPin = pin => pin === undefined ? "--" : pin === 255 ? "Unassigned" : `GPIO${pin}`;
  /** @param {HTMLElement} table @param {string[]} signals @param {(number | undefined)[]} pins */
  const renderPins = (table, signals, pins) => {
    const headings = document.createElement("tr");
    const values = document.createElement("tr");
    signals.forEach((signal, index) => {
      const heading = document.createElement("th");
      heading.scope = "col";
      heading.textContent = signal;
      const cell = document.createElement("td");
      cell.textContent = configuration ? formatPin(pins[index]) : "--";
      headings.append(heading);
      values.append(cell);
    });
    table.replaceChildren(headings, values);
  };
  const sdmmc = Boolean((snapshot.hardware?.capabilities ?? 0) & CAPABILITY_SDMMC);
  const labels = ["CLK", "CMD", "DAT0", "DAT1", "DAT2", "DAT3"];
  const signature = JSON.stringify([sdmmc, configuration]);
  if (signature !== boardConfigurationSignature) {
    boardConfigurationSignature = signature;
    setText(uartTitle, configuration?.monitor_uart_index !== undefined && configuration.monitor_uart_index !== 255
      ? `Monitor UART${configuration.monitor_uart_index}` : "Monitor UART");
    setText(storageTitle, configuration ? `Storage (${sdmmc ? "SDMMC" : "unknown transport"})` : "Storage");
    renderPins(uartTable, ["TX", "RX"],
      [configuration?.monitor_uart_tx_gpio, configuration?.monitor_uart_rx_gpio]);
    renderPins(storageTable, [...labels, "Card detect"],
      [...labels.map((_, index) => configuration?.storage_gpios?.[index]), configuration?.card_detect_gpio]);
  }
  if (configuration?.reset_cause === undefined) {
    setText(resetCause, "--");
    return;
  }
  /** @type {Record<number, string>} */
  const resetCauses = { 0: "Unknown", 1: "Power-on", 2: "Watchdog", 3: "Software request" };
  const resetCauseLabel = resetCauses[configuration.reset_cause]
    ?? `Unassigned (${configuration.reset_cause})`;
  setText(resetCause, resetCauseLabel);
}

/** @param {import("./dashboard-api.mjs").Memory | null | undefined} memory
 * @param {string | null | undefined} filesystemFormat @param {boolean} stale @param {number | undefined} cardDetectGpio
 */
function renderMemory(memory, filesystemFormat, stale, cardDetectGpio) {
  /** @param {string} id @param {string} value */
  const set = (id, value) => { element(id).textContent = value; };
  const busy = !stale && memory?.configured && memory.sample_valid === false;
  if (!stale && memory?.sample_valid && memory.initialized) {
    lastStorageDetails = { memory, filesystemFormat };
  } else if (!busy) {
    lastStorageDetails = null;
  }
  if (stale) {
    set("#memory-note", "Storage status is stale; waiting for a fresh report.");
    for (const id of ["#memory-state", "#memory-speed", "#memory-size",
      "#memory-filesystem", "#memory-manufacturer", "#memory-product", "#memory-serial"]) set(id, "--");
    return;
  }
  set("#memory-state", memory?.configured && memory.sample_valid === false ? "Busy"
    : memory?.initialized ? "Ready" : memory?.configured ? "Not initialized" : "Unavailable");
  set("#memory-note", !memory?.configured ? "No SD-card transport configured"
    : memory && !memory.sample_valid ? ""
    : memory.presence_known && !memory.present
      ? `No card detected. Check card insertion${
        cardDetectGpio !== undefined && Number.isInteger(cardDetectGpio) && cardDetectGpio >= 0 && cardDetectGpio < 255
          ? ` and the card-detect connection on GPIO${cardDetectGpio}` : ""}.`
      : memory.present && !memory.initialized
        ? "Card detected but not initialized; check UART logs and SD wiring."
        : memory.initialized ? "" : "Card not mounted; check card insertion, UART logs and SD wiring.");
  if (busy && lastStorageDetails) {
    ({ memory, filesystemFormat } = lastStorageDetails);
  }
  const manufacturer = memory?.manufacturer;
  set("#memory-speed", memory?.sample_valid !== false && memory?.initialized && memory?.bus_clock_hz
    ? `${(memory.bus_clock_hz / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} MHz`
    : "--");
  set("#memory-size", memory?.capacity_bytes ? formatBytes(memory.capacity_bytes) : "--");
  /** @type {Record<string, string>} */
  const filesystemLabels = { unknown: "Unknown", fat12: "FAT12", fat16: "FAT16", fat32: "FAT32", exfat: "exFAT" };
  set("#memory-filesystem", filesystemLabels[filesystemFormat ?? "unknown"] ?? "Unknown");
  set("#memory-manufacturer", formatManufacturer(manufacturer));
  set("#memory-product", manufacturer?.product_name !== undefined && manufacturer.product_revision !== undefined
    && manufacturer.manufacture_year !== undefined && manufacturer.manufacture_month !== undefined
    ? `${manufacturer.product_name} rev ${manufacturer.product_revision} · ${manufacturer.manufacture_year}-${String(manufacturer.manufacture_month).padStart(2, "0")}`
    : "--");
  set("#memory-serial", manufacturer?.serial_number !== undefined
    ? manufacturer.serial_number.toString(16).padStart(8, "0") : "--");
}

/** @param {import("./dashboard-api.mjs").Manufacturer | null | undefined} manufacturer */
function formatManufacturer(manufacturer) {
  if (!manufacturer) return "--";
  const id = manufacturer.id ?? manufacturer.manufacturer_id;
  if (id === undefined || !Number.isInteger(id) || id < 0 || id > 0xff) return "Unknown manufacturer";
  /** @type {Record<number, string>} */
  const names = { 0x03: "SanDisk", 0x41: "Kingston" };
  return `${names[id] ?? "Unknown manufacturer"} (0x${id.toString(16).padStart(2, "0")})`;
}

/** @param {number} bytes */
function formatBytes(bytes) {
  const gibibytes = bytes / (1024 ** 3);
  return gibibytes >= 1 ? `${gibibytes.toFixed(2)} GiB`
    : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 ** 2)).toFixed(2)} MiB`;
}
