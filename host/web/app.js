import {SerialTransport, BleTransport, BridgeTransport, DemoTransport} from "./transports.js";
import {validateWifi} from "./protocol.js";

const direct = document.documentElement.dataset.mode === "direct";
const metric = (label, field) => `<div><dt>${label}</dt><dd data-field="${field}">--</dd></div>`;
document.querySelector("#dashboard").innerHTML = `
  <header class="topbar">
    <a class="brand" href="./" aria-label="ESPForge dashboard">
      <span class="brand-mark">EF</span><span><strong>ESPForge</strong>
      <small id="host-name">${direct ? "Direct" : "Local host"} / ESP32-S3 / Zephyr</small></span>
    </a>
    <div id="connection-indicator" data-state="disconnected">
      <span class="connection-light" aria-hidden="true"></span>
      <span id="connection-state" role="status">Disconnected</span>
    </div>
  </header>
  <div class="page">
    <div class="page-heading"><h1>Dashboard</h1><span class="badge">Wi-Fi + BLE on by default</span></div>
    <p id="error" role="alert" hidden></p>
    <p id="preview" class="notice warning" hidden></p>
    <section aria-labelledby="identity-title">
      <div class="section-heading"><h2 id="identity-title">Device information</h2>
        <div class="actions">
          <label class="transport-label">Transport
            <select id="transport">${direct ? '<option value="serial">USB-UART</option><option value="ble">Bluetooth LE</option><option value="demo">Simulated preview</option>' : '<option value="bridge">Local serial host</option>'}</select>
          </label>
          <button id="connect">Select board</button>
          <button id="disconnect" class="secondary" disabled>Disconnect</button>
        </div>
      </div>
      <dl class="metrics identity">
        ${metric("Product", "product")}${metric("Board model", "board")}
        ${metric("Firmware version", "firmware")}${metric("Protocol version", "protocol")}
      </dl>
      <p id="transport-help" class="note"></p>
      <p class="note">Serial/UID, measured clock and RAM usage are not reported by firmware protocol 1.</p>
    </section>
    <section aria-labelledby="settings-title">
      <div class="section-heading"><h2 id="settings-title">Board configuration</h2>
        <button id="configure-wifi" class="secondary" disabled>Configure Wi-Fi</button>
      </div>
      <dl class="metrics">
        <div><dt>Build operating system</dt><dd>Zephyr 4.2.0</dd></div>
        <div><dt>Application core</dt><dd>PROCPU</dd></div>
        <div><dt>Wi-Fi enabled (live)</dt><dd data-field="wifi_enabled">--</dd></div>
        <div><dt>Bluetooth enabled (live)</dt><dd data-field="ble_enabled">--</dd></div>
      </dl>
      <p class="note">Both radios start enabled. Settings are not persistent; radio switches, Save &amp; Reboot and reboot commands are not implemented.</p>
      <details class="pin-map"><summary>Pin configuration</summary><div class="pin-tables">
        <table><caption>Management UART / USB-to-UART bridge</caption><thead><tr><th>Signal</th><th>GPIO / setting</th></tr></thead><tbody>
          <tr><td>TX</td><td>GPIO43</td></tr><tr><td>RX</td><td>GPIO44</td></tr>
          <tr><td>Serial format</td><td>115200 / 8N1</td></tr>
        </tbody></table>
        <table><caption>Storage / SPI2</caption><thead><tr><th>Signal</th><th>GPIO / setting</th></tr></thead><tbody>
          <tr><td>CS / DAT3</td><td>GPIO10</td></tr><tr><td>MOSI / CMD</td><td>GPIO11</td></tr>
          <tr><td>SCLK / CLK</td><td>GPIO12</td></tr><tr><td>MISO / DAT0</td><td>GPIO13</td></tr>
          <tr><td>Supply</td><td>3.3 V + common GND</td></tr>
        </tbody></table>
      </div><p class="note">Reference wiring for the N8 DevKitC build, not detected wiring. Use the USB-to-UART connector, not native USB. Hardware validation is pending.</p></details>
    </section>
    <section aria-labelledby="runtime-title">
      <div class="section-heading"><h2 id="runtime-title">Live diagnostics</h2>
        <button id="refresh" class="secondary" disabled>Refresh status</button>
      </div>
      <dl class="metrics">
        ${metric("Uptime", "uptime_ms")}${metric("Wi-Fi association", "wifi_connected")}
        ${metric("Wi-Fi result code", "wifi_error")}${metric("BLE result code", "ble_error")}
      </dl>
      <p id="freshness" class="note" role="status">Telemetry unavailable</p>
      <p class="note">Polled every second. Wi-Fi association is not proof of a DHCP lease or internet access. Temperature and core load are not reported.</p>
    </section>
    <section aria-labelledby="storage-title">
      <div class="section-heading"><h2 id="storage-title">Storage</h2><span class="badge muted">Hardware testing deferred</span></div>
      <dl class="metrics">
        ${metric("FAT mount state", "sd_mounted")}${metric("Mount result code", "sd_error")}
        <div><dt>Build mount point</dt><dd>/SD:</dd></div>
        <div><dt>Requested SPI ceiling</dt><dd>10 MHz</dd></div>
      </dl>
      <p class="note">The bus ceiling is configuration, not measured speed. A mount error does not prevent board management. Card capacity/identity, file transfer, USB drive handoff and storage benchmarks are not implemented. No automatic formatting or dashboard writes.</p>
    </section>
    <section aria-labelledby="wifi-title">
      <div class="section-heading"><h2 id="wifi-title">Wi-Fi setup</h2><span class="badge muted">RAM only / this boot</span></div>
      <form id="wifi">
        <label>SSID (2.4 GHz, 1-32 UTF-8 bytes)<input id="ssid" required autocomplete="off" disabled></label>
        <label>WPA2 passphrase (empty or 8-63 UTF-8 bytes)<input id="psk" type="password" autocomplete="off" disabled></label>
        <button id="provision" disabled>Connect Wi-Fi for this boot</button>
      </form>
      <p id="wifi-help" class="note">Connect over USB-UART to provision Wi-Fi.</p>
      <p id="wifi-feedback" class="note" role="status"></p>
      <p class="note">Credentials travel in plaintext over UART and stay in board RAM. BLE is read-only. No scan, saved networks or Wi-Fi dashboard transport is available.</p>
    </section>
    <footer>One serial owner at a time. Disconnect before flashing. Errors clear stale telemetry; commands are never automatically retried.</footer>
  </div>`;

const element = (id) => document.getElementById(id);
let transport;
let timer;
let busy = false;
let active = false;
let lastStatus;
let session = 0;

function connection(state, text) {
  element("connection-indicator").dataset.state = state;
  element("connection-state").textContent = text;
}

function controls() {
  const writable = active && !busy && transport?.writable;
  for (const id of ["provision", "configure-wifi", "ssid", "psk"]) {
    element(id).disabled = !writable;
  }
  element("refresh").disabled = !active || busy;
  element("wifi-help").textContent = !active ? "Connect over USB-UART to provision Wi-Fi."
    : transport.writable ? "Submit once, then watch the live Wi-Fi result. Provision again after reboot."
    : "Read-only connection: Wi-Fi provisioning requires a live USB-UART connection.";
}

function clearStatus() {
  lastStatus = undefined;
  document.querySelectorAll("[data-field]").forEach((node) => { node.textContent = "--"; });
  element("freshness").textContent = "Telemetry unavailable";
  controls();
}

function showError(error) {
  active = false;
  clearTimeout(timer);
  element("error").textContent = error.message;
  element("error").hidden = false;
  element("psk").value = "";
  element("wifi-feedback").textContent = "";
  connection("error", "Error / disconnect to reconnect");
  clearStatus();
}

function render(status) {
  lastStatus = status;
  document.querySelectorAll("[data-field]").forEach((node) => {
    const field = node.dataset.field;
    const value = status[field];
    node.textContent = field === "uptime_ms" ? `${(value / 1000).toFixed(1)} s`
      : field === "sd_mounted" ? (value ? "Mounted" : "Not mounted")
      : field === "wifi_connected" ? (value ? "Associated" : "Not associated")
      : typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : String(value);
  });
  connection("connected", transport.label || "Connected");
  element("freshness").textContent = `Last ${transport.simulated ? "simulated" : "device"} sample: ${new Date().toLocaleTimeString()}`;
  element("error").hidden = true;
}

async function poll() {
  if (!active || busy) return;
  const currentSession = session;
  clearTimeout(timer);
  busy = true;
  controls();
  try {
    const status = await transport.status();
    if (active && session === currentSession) render(status);
  } catch (error) {
    if (active && session === currentSession) showError(error);
  } finally {
    if (session === currentSession) {
      busy = false;
      controls();
      if (active) timer = setTimeout(poll, 1000);
    }
  }
}

function transportHelp() {
  const mode = element("transport").value;
  element("transport-help").textContent = {
    serial: "USB-UART uses Web Serial in desktop Chrome/Edge on localhost or HTTPS. Select the DevKitC serial bridge; no Python or .NET host is needed.",
    ble: "Bluetooth LE uses Web Bluetooth on supported browsers/OS. Public diagnostics only; no provisioning commands.",
    demo: "Simulated preview works without a board. It does not execute firmware, radio or storage operations.",
    bridge: "This dashboard uses the local Python or .NET server's serial connection, not browser USB permissions.",
  }[mode];
}
element("transport").addEventListener("change", transportHelp);
transportHelp();

element("connect").addEventListener("click", async () => {
  session++;
  element("connect").disabled = true;
  element("transport").disabled = true;
  element("error").hidden = true;
  connection("connecting", "Connecting...");
  const constructors = {serial: SerialTransport, ble: BleTransport, bridge: BridgeTransport, demo: DemoTransport};
  transport = new constructors[element("transport").value]();
  try {
    await transport.connect();
    element("host-name").textContent = direct ? "Direct / ESP32-S3 / Zephyr" : transport.label;
    element("preview").hidden = !transport.simulated;
    element("preview").textContent = "SIMULATED PREVIEW - no hardware connected. Data is synthetic; provisioning is disabled.";
    active = true;
    element("disconnect").disabled = false;
    await poll();
  } catch (error) {
    showError(error);
    try {
      await transport.close();
      element("connect").disabled = false;
      element("transport").disabled = false;
    } catch (closeError) {
      showError(new Error(`${error.message}; cleanup failed: ${closeError.message}`));
      element("disconnect").disabled = false;
    }
  }
});

element("disconnect").addEventListener("click", async () => {
  session++;
  active = false;
  clearTimeout(timer);
  controls();
  element("disconnect").disabled = true;
  try {
    await transport.close();
    busy = false;
    element("error").hidden = true;
    connection("disconnected", "Disconnected");
    element("connect").disabled = false;
    element("transport").disabled = false;
  } catch (error) {
    showError(error);
    element("disconnect").disabled = false;
  }
  clearStatus();
  element("psk").value = "";
  element("wifi-feedback").textContent = "";
  element("preview").hidden = true;
});

element("refresh").addEventListener("click", poll);
element("configure-wifi").addEventListener("click", () => {
  element("wifi").scrollIntoView({behavior: "smooth", block: "center"});
  element("ssid").focus({preventScroll: true});
});
element("wifi").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !active || !transport.writable) return;
  const fields = {ssid: element("ssid").value, psk: element("psk").value};
  try {
    validateWifi(fields);
  } catch (error) {
    element("wifi-feedback").textContent = error.message;
    return;
  }
  if (lastStatus?.wifi_connected) {
    element("wifi-feedback").textContent = "Already associated. Firmware does not support changing networks without a board reboot.";
    return;
  }
  busy = true;
  const currentSession = session;
  clearTimeout(timer);
  controls();
  element("wifi-feedback").textContent = "Submitting Wi-Fi request...";
  try {
    await transport.request("wifi.connect", fields);
    if (active && session === currentSession) element("wifi-feedback").textContent = "Request accepted, not yet connected. Watch live association and result codes.";
  } catch (error) {
    if (active && session === currentSession) showError(error);
  } finally {
    if (session === currentSession) {
      element("psk").value = "";
      busy = false;
      controls();
      if (active) timer = setTimeout(poll, 0);
    }
  }
});
window.addEventListener("pagehide", () => {
  active = false;
  clearTimeout(timer);
  transport?.close().catch((error) => console.error("Disconnect failed", error));
});
