// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { DashboardError, responseJson, scannedBoards, statusResponse } from "./api.mjs";

/**
 * Owns board discovery, selection, and status-read fencing for one mounted dashboard.
 * @param {{
 *   boardSelect: HTMLSelectElement,
 *   rescanButton: HTMLButtonElement,
 *   fetchWithDeadline: (url: string, options: RequestInit, timeoutMs: number) => Promise<Response>,
 *   normalizeSnapshot: (snapshot: import("./api.mjs").StatusSnapshot) => import("./api.mjs").StatusSnapshot,
 *   getOperationState: () => import("./operation-state.mjs").OperationState,
 *   statusBlocked: () => boolean,
 *   onStatus: (snapshot: import("./api.mjs").StatusSnapshot) => void,
 *   onStatusError: (error: Error) => void,
 *   onScanError: (error: Error) => void,
 *   onSelectionChanged: (boardId: string | null, source: "select" | "scan") => void,
 * }} options
 */
export function createBoardSession({
  boardSelect, rescanButton, fetchWithDeadline, normalizeSnapshot, getOperationState, statusBlocked,
  onStatus, onStatusError, onScanError, onSelectionChanged,
}) {
  /** @type {string | null} */
  let selectedBoard = null;
  let selectedBoardLabel = "";
  /** @type {Array<{id: string, serial_number?: string | null, device_path: string}>} */
  let knownBoards = [];
  let scanning = false;
  /** @type {string | null} */
  let scanWarning = null;
  /** @type {string | null} */
  let statusError = null;
  let statusReading = false;
  let selectionVersion = 0;
  let commandVersion = 0;
  let unknownBoardRescanAt = 0;

  /** @param {string} path @param {string | null} [boardId] */
  function boardUrl(path, boardId = selectedBoard) {
    if (!boardId) return path;
    return `${path}${path.includes("?") ? "&" : "?"}board=${encodeURIComponent(boardId)}`;
  }

  /** @param {{serial_number?: string | null, device_path: string}} board */
  function boardLabel(board) {
    return board.serial_number ? `ESPForge / ${board.serial_number}` : `ESPForge / HID ${board.device_path}`;
  }

  function state() {
    return {
      selectedBoard, scanning, scanWarning, statusError, statusReading, selectionVersion, commandVersion,
    };
  }

  function updateControls() {
    const operations = getOperationState();
    boardSelect.disabled = operations.boardSelectionBusy || knownBoards.length === 0;
    rescanButton.disabled = operations.boardSelectionBusy;
  }

  function commandChanged() {
    commandVersion++;
  }

  /** @param {string} boardId */
  function selectBoard(boardId) {
    if (getOperationState().boardSelectionBusy) {
      boardSelect.value = selectedBoard || "";
      return;
    }
    const nextBoard = boardId || null;
    if (nextBoard === selectedBoard) return;
    selectedBoard = nextBoard;
    const selected = knownBoards.find(board => board.id === selectedBoard);
    selectedBoardLabel = selected ? boardLabel(selected) : selectedBoardLabel;
    selectionVersion++;
    onSelectionChanged(selectedBoard, "select");
    void updateStatus();
  }

  async function updateStatus() {
    if (statusReading || statusBlocked()) return;
    statusReading = true;
    const version = selectionVersion;
    const command = commandVersion;
    try {
      const response = await fetchWithDeadline(boardUrl("/api/status"), { cache: "no-store" }, 5000);
      const snapshot = normalizeSnapshot(statusResponse(
        await responseJson(response, `Status endpoint returned HTTP ${response.status}`)));
      if (version !== selectionVersion || command !== commandVersion || statusBlocked()) return;
      statusError = null;
      onStatus(snapshot);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (version !== selectionVersion || command !== commandVersion) return;
      // Both hosts return 404 for an unknown board; a restart requires discovery to register it again.
      if (error instanceof DashboardError && error.status === 404
        && Date.now() - unknownBoardRescanAt >= 5000) {
        unknownBoardRescanAt = Date.now();
        void rescanBoards();
      }
      statusError = error.message;
      onStatusError(error);
    } finally {
      statusReading = false;
      updateControls();
      if (version !== selectionVersion || command !== commandVersion) void updateStatus();
    }
  }

  async function rescanBoards() {
    if (getOperationState().boardSelectionBusy) return;
    scanning = true;
    updateControls();
    try {
      const response = await fetchWithDeadline("/api/boards", { cache: "no-store" }, 10000);
      const result = await responseJson(response, `Board scan returned HTTP ${response.status}`);
      scanWarning = Array.isArray(result.warnings) ? result.warnings.join(" ") || null : null;
      const previousBoard = selectedBoard;
      knownBoards = scannedBoards(result);
      boardSelect.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = knownBoards.length ? "Select a board" : "No boards found";
      boardSelect.append(placeholder);
      for (const board of knownBoards) {
        const option = document.createElement("option");
        option.value = board.id;
        option.textContent = boardLabel(board);
        boardSelect.append(option);
      }
      if (!selectedBoard && typeof result.default_board_id === "string")
        selectedBoard = result.default_board_id;
      const selected = knownBoards.find(board => board.id === selectedBoard);
      if (selected) {
        selectedBoardLabel = boardLabel(selected);
      } else if (selectedBoard) {
        const missing = document.createElement("option");
        missing.value = selectedBoard;
        missing.textContent = `${selectedBoardLabel || selectedBoard} (not found)`;
        boardSelect.append(missing);
      }
      boardSelect.value = selectedBoard || "";
      if (previousBoard !== selectedBoard) {
        selectionVersion++;
        onSelectionChanged(selectedBoard, "scan");
      }
      await updateStatus();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      onScanError(error);
    } finally {
      scanning = false;
      updateControls();
    }
  }

  return { boardUrl, commandChanged, selectBoard, state, updateControls, updateStatus, rescanBoards };
}
