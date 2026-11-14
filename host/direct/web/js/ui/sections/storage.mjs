// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { queryElement, setText } from "../dom.mjs";
import { CAP } from "../../protocol/constants.mjs";

function formatBytes(bytes) {
  const gibibytes = bytes / 1024 ** 3;
  return gibibytes >= 1 ? `${gibibytes.toFixed(2)} GiB`
    : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function formatManufacturer(manufacturer) {
  if (!manufacturer) return "--";
  const id = manufacturer.id;
  if (!Number.isInteger(id) || id < 0 || id > 0xff) return "Unknown manufacturer";
  const names = { 0x03: "SanDisk", 0x41: "Kingston" };
  return `${names[id] ?? "Unknown manufacturer"} (0x${id.toString(16).padStart(2, "0")})`;
}

/** Retained card details are display-only; they never participate in operation eligibility. */
export function deriveStorageViewModel(state, previous = {}) {
  let memory = state.memory;
  let filesystemFormat = state.filesystem_format;
  const detected = state.connected && memory && memory.sample_valid !== false
    ? memory.presence_known === true ? memory.present === true : memory.initialized === true
    : state.connected ? previous.detected ?? false : false;
  const busy = memory?.configured && memory.sample_valid === false;
  const details = memory?.sample_valid && memory.initialized
    ? { memory, filesystemFormat } : busy && state.connected ? previous.details : null;
  const label = busy ? "Busy" : memory?.initialized ? "Ready" : memory?.configured ? "Not initialized" : "Unavailable";
  const note = !memory ? "Waiting for fresh storage status."
    : !memory.sample_valid ? "" : !memory.configured ? "No SD-card transport configured"
      : memory.presence_known && !memory.present
        ? "No card detected. Check card insertion and SD-card wiring."
        : memory.present && !memory.initialized ? "Card detected but not initialized; check UART logs and SD-card wiring."
          : memory.initialized ? "" : "No card mounted; check card insertion and SD-card wiring.";
  if (busy && details) ({ memory, filesystemFormat } = details);
  const manufacturer = memory?.manufacturer;
  const filesystemLabels = { unknown: "Unknown", fat12: "FAT12", fat16: "FAT16", fat32: "FAT32", exfat: "exFAT" };
  return {
    retained: { detected, details },
    hidden: !(detected || state.memory?.msc?.enabled || state.memory?.msc?.transition_pending),
    text: {
      "memory-state": state.memory?.msc?.transition_pending ? "Changing ownership"
        : state.memory?.msc?.enabled ? "USB drive" : label,
      "memory-note": state.memory?.msc?.transition_pending ? "Waiting for storage handoff."
        : state.memory?.msc?.enabled ? "Safely eject in Linux/Windows before returning the card to firmware."
          : state.memory?.msc?.request_rejected ? "Storage handoff failed or the card changed. Check UART logs and retry explicitly."
            : note,
      "memory-speed": memory?.sample_valid !== false && memory?.initialized && memory?.bus_clock_hz
        ? `${(memory.bus_clock_hz / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} MHz` : "--",
      "memory-size": memory?.capacity_bytes ? formatBytes(memory.capacity_bytes) : "--",
      "memory-filesystem": filesystemLabels[filesystemFormat] ?? "Unknown",
      "memory-manufacturer": formatManufacturer(manufacturer),
      "memory-product": manufacturer
        ? `${manufacturer.product_name} rev ${manufacturer.product_revision} · ${manufacturer.manufacture_year}-`
          + String(manufacturer.manufacture_month).padStart(2, "0") : "--",
      "memory-serial": manufacturer ? manufacturer.serial_number.toString(16).padStart(8, "0") : "--",
    },
  };
}

export function createStorageSection() {
  let previous = {};
  return state => {
    const model = deriveStorageViewModel(state, state.connected ? previous : {});
    previous = model.retained;
    setText(model.text);
    queryElement("#memory-note").hidden = !model.text["memory-note"];
    queryElement('[aria-labelledby="memory-title"]').hidden = model.hidden;
    const status = state.freshness?.[11] === "fresh" ? state.self_test : null;
    queryElement("#benchmark-controls").hidden = !((state.hardware?.capabilities ?? 0) & CAP.SELF_TEST);
    const rate = value => value == null ? "--" : `${(value / 1024 ** 2).toFixed(2)} MiB/s`;
    setText({
      "benchmark-state": status ? `${status.state} (${status.progress_percent.toFixed(1)}%)` : "Waiting for fresh status",
      "benchmark-write": rate(status?.write_bytes_per_second),
      "benchmark-read": rate(status?.read_bytes_per_second),
      "benchmark-result": status?.error ? `Error ${status.error}; filesystem ${status.filesystem_result}`
        + (status.file_remains ? "; EFTEST.BIN may remain" : "")
        : status ? `${status.mismatch_count} mismatched bytes` : "--",
    });
  };
}
