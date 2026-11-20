// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** Bounded plain-text terminal for native shell cursor/edit/erase sequences, not a full VT100 emulator. */
export class ConsoleTerminal {
  lines = [""];
  row = 0;
  column = 0;
  saved = [0, 0];
  escape = "";
  lineOffset = 0;

  /** @param {string} text */
  write(text) {
    for (const character of text) {
      if (this.escape) {
        this.escape += character;
        if (this.escape === "\x1b[") continue;
        if (/^\x1b\[\??[0-9;]*[@-~]$/.test(this.escape)) {
          this.control(this.escape.slice(2));
          this.escape = "";
        } else if (!/^\x1b\[\??[0-9;]*$/.test(this.escape) || this.escape.length > 24) this.escape = "";
        continue;
      }
      if (character === "\x1b") { this.escape = character; continue; }
      if (character === "\r") this.column = 0;
      else if (character === "\n") {
        this.row++;
        this.column = 0;
        if (this.lines[this.row] === undefined) this.lines[this.row] = "";
      } else if (character === "\b") this.column = Math.max(0, this.column - 1);
      else if (character === "\t") this.column = Math.min(511, (Math.floor(this.column / 8) + 1) * 8);
      else if (character >= " " && character !== "\x7f") {
        const line = this.lines[this.row].padEnd(this.column, " ");
        this.lines[this.row] = (line.slice(0, this.column) + character + line.slice(this.column + 1)).slice(0, 512);
        this.column = Math.min(511, this.column + character.length);
      }
      if (this.lines.length > 1000) {
        this.lines.shift();
        this.lineOffset++;
        this.row--;
        this.saved[0] = Math.max(0, this.saved[0] - 1);
      }
    }
  }

  /** @param {string} sequence */
  control(sequence) {
    const command = sequence.at(-1);
    const parameters = sequence.slice(0, -1).split(";").map(Number);
    const count = Math.min(512, parameters[0] || 1);
    const mode = parameters[0] || 0;
    const line = this.lines[this.row];
    if (command === "A") this.row = Math.max(0, this.row - count);
    else if (command === "B") this.row = Math.min(999, this.row + count);
    else if (command === "C") this.column = Math.min(511, this.column + count);
    else if (command === "D") this.column = Math.max(0, this.column - count);
    else if (command === "G") this.column = Math.min(511, count - 1);
    else if (command === "H" || command === "f") {
      this.row = Math.max(0, Math.min(999, (parameters[0] || 1) - 1));
      this.column = Math.max(0, Math.min(511, (parameters[1] || 1) - 1));
    } else if (command === "s") this.saved = [this.row, this.column];
    else if (command === "u") [this.row, this.column] = this.saved;
    else if (command === "@") {
      this.lines[this.row] = (line.slice(0, this.column) + " ".repeat(count) + line.slice(this.column)).slice(0, 512);
    } else if (command === "P") this.lines[this.row] = line.slice(0, this.column) + line.slice(this.column + count);
    else if (command === "K") {
      this.lines[this.row] = mode === 2 ? "" : mode === 1 ? " ".repeat(this.column + 1) + line.slice(this.column + 1)
        : line.slice(0, this.column);
    } else if (command === "J") {
      if (mode === 2) {
        this.lines = [""];
        this.row = this.column = 0;
        this.saved = [0, 0];
      }
      else if (mode === 0) {
        this.lines[this.row] = line.slice(0, this.column);
        this.lines.length = this.row + 1;
      } else if (mode === 1) {
        this.lines.fill("", 0, this.row);
        this.lines[this.row] = " ".repeat(this.column + 1) + line.slice(this.column + 1);
      }
    }
    while (this.lines.length <= this.row) this.lines.push("");
  }

  /** Text segments for safe text-node rendering, never HTML. */
  display() {
    const line = this.lines[this.row].padEnd(this.column + 1, " ");
    const before = [...this.lines.slice(0, this.row), line.slice(0, this.column)].join("\n");
    const after = [line.slice(this.column + 1), ...this.lines.slice(this.row + 1)].join("\n");
    return [before, line[this.column], after];
  }
}

/** @param {Pick<KeyboardEvent, "key"> & Partial<Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey">>} event */
export function consoleKey(event) {
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  /** @type {Record<string, string>} */
  const keys = {
    Enter: "\r", Tab: "\t", Backspace: "\x7f", Delete: "\x1b[3~",
    ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
    Home: "\x1b[H", End: "\x1b[F", Escape: "\x1b",
  };
  return keys[event.key] ?? (event.key.length === 1 ? event.key : null);
}
