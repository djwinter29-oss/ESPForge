// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
import { ConsoleTerminal, consoleKey } from "./console-terminal.mjs";

/**
 * @param {{openUrl: string, openBody: object, check?: () => Promise<void>}} options
 */
export function mountConsole({ openUrl, openBody, check = async () => {} }) {
  const toggle = /** @type {HTMLButtonElement} */ (document.querySelector("#console-toggle"));
  const status = /** @type {HTMLElement} */ (document.querySelector("#console-status"));
  const output = /** @type {HTMLElement} */ (document.querySelector("#terminal"));
  const before = document.createTextNode("");
  const cursor = document.createElement("span");
  cursor.className = "terminal-cursor";
  cursor.setAttribute("aria-hidden", "true");
  const after = document.createTextNode("");
  output.replaceChildren(before, cursor, after);
  let terminal = new ConsoleTerminal();
  let renderQueued = false;
  /** @typedef {{token: string | null, abort: AbortController, pending: string, sending: boolean}} Lifetime */
  /** @type {Lifetime | null} */
  let active = null;

  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
      const [prefix, caret, suffix] = terminal.display();
      before.textContent = prefix;
      cursor.textContent = caret;
      after.textContent = suffix;
      if (follow) output.scrollTop = output.scrollHeight;
    });
  }

  /** @param {string} url @param {string} method @param {string | null} token
   * @param {object | undefined} body @param {AbortSignal} signal @param {boolean} [keepalive] */
  async function request(url, method, token, body, signal, keepalive = false) {
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json" };
    if (token !== null) headers["X-Console-Session"] = token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), keepalive,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (method === "DELETE" && response.status === 409) return {};
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : `HTTP ${response.status}`);
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Malformed console relay response");
    }
    return result;
  }

  /** @param {string} message @param {Lifetime} life */
  async function disconnect(message, life) {
    if (active !== life) return;
    active = null;
    life.pending = "";
    life.abort.abort();
    toggle.disabled = true;
    toggle.textContent = "Connect";
    const notice = life.sending ? `${message} In-flight input may have reached the board; it is not retried.` : message;
    status.textContent = notice;
    try {
      if (life.token !== null) {
        await request("/api/console", "DELETE", life.token, undefined, new AbortController().signal, true);
      }
    } catch (error) {
      status.textContent = `${notice} Relay cleanup failed: ${String(error)}. It expires after 15 idle seconds.`;
    } finally {
      toggle.disabled = false;
    }
  }

  /** @param {Lifetime} life */
  async function read(life) {
    const decoder = new TextDecoder();
    try {
      while (active === life) {
        await check();
        const packet = await request("/api/console", "GET", life.token, undefined, life.abort.signal);
        if (active !== life) return;
        if (typeof packet.data !== "string" || packet.data.length > 5464 || typeof packet.closed !== "boolean") {
          throw new Error("Malformed console output");
        }
        const bytes = Uint8Array.from(atob(packet.data), character => character.charCodeAt(0));
        if (bytes.length > 4096) throw new Error("Console output exceeds the packet limit");
        terminal.write(decoder.decode(bytes, { stream: !packet.closed }));
        render();
        if (packet.closed) {
          await disconnect("The board closed the console. Connect explicitly to reopen.", life);
          return;
        }
      }
    } catch (error) {
      await disconnect(`Console disconnected: ${String(error)}`, life);
    }
  }

  /** @param {Lifetime} life */
  async function send(life) {
    if (life.sending) return;
    life.sending = true;
    try {
      while (active === life && life.pending) {
        const bytes = new TextEncoder().encode(life.pending);
        life.pending = "";
        await check();
        if (active !== life) return;
        const packet = await request("/api/console/input", "POST", life.token,
          { data: btoa(String.fromCharCode(...bytes)) }, life.abort.signal);
        if (active !== life) return;
        if (!Number.isInteger(packet.written) || packet.written !== bytes.length) {
          throw new Error("The relay did not confirm the complete input");
        }
      }
    } catch (error) {
      await disconnect(`Input may have reached the board; it was not retried. ${String(error)}`, life);
    } finally {
      life.sending = false;
    }
  }

  /** @param {string} text */
  function enqueue(text) {
    const life = active;
    if (life === null || life.token === null || !text) return;
    if (new TextEncoder().encode(life.pending + text).length > 1024) {
      status.textContent = "Input exceeds the 1024-byte queue limit; this input was not sent.";
      return;
    }
    life.pending += text;
    void send(life);
  }

  async function connect() {
    /** @type {Lifetime} */
    const life = { token: null, abort: new AbortController(), pending: "", sending: false };
    active = life;
    toggle.textContent = "Disconnect";
    status.textContent = "Connecting to the board's raw TCP shell...";
    terminal = new ConsoleTerminal();
    render();
    try {
      await check();
      if (active !== life) return;
      const packet = await request(openUrl, "POST", null, openBody, life.abort.signal);
      if (typeof packet.session !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(packet.session)
          || typeof packet.ipv4 !== "string") throw new Error("Malformed console connection");
      life.token = packet.session;
      if (active !== life) {
        await request("/api/console", "DELETE", life.token, undefined, new AbortController().signal, true);
        return;
      }
      status.textContent = `Connected to ${packet.ipv4}:2323 - unauthenticated, plaintext shell.`;
      output.focus();
      void read(life);
    } catch (error) {
      await disconnect(`Cannot connect: ${String(error)}. An unconfirmed connection expires after 15 idle seconds.`, life);
    }
  }

  toggle.addEventListener("click", () => {
    if (active !== null) void disconnect("Disconnected. Input is never replayed.", active);
    else void connect();
  });
  output.addEventListener("keydown", event => {
    if (event.shiftKey && event.key === "Tab" || event.isComposing || active?.token == null) return;
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "v"
        || event.key.toLowerCase() === "c" && window.getSelection()?.toString())) return;
    const text = consoleKey(event);
    if (text === null) return;
    event.preventDefault();
    enqueue(text);
  });
  output.addEventListener("paste", event => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (/[\r\n]/.test(text) && !window.confirm("Pasted newlines execute shell commands. Send this paste?")) return;
    enqueue(text.replace(/\r\n|\r|\n/g, "\r"));
  });
  window.addEventListener("pagehide", () => {
    if (active !== null) void disconnect("Disconnected.", active);
  });
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  void connect();
}
