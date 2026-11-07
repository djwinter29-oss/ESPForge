import {SerialTransport, BleTransport, BridgeTransport, DemoTransport} from "./transports.js";
import {validateWifi} from "./protocol.js";

const direct = document.documentElement.dataset.mode === "direct";
document.querySelector("#dashboard").innerHTML = `
  <header><div><p class="eyebrow">BOARD MANAGEMENT FOUNDATION</p>
    <h1>ESPForge <span>${direct ? "Direct" : "Host"}</span></h1>
    <p>ESP32-S3 / Zephyr OS</p></div><span class="badge">Wi-Fi + BLE enabled by default</span></header>
  <section class="connection"><label>Transport
    <select id="transport">${direct ? '<option value="serial">USB-UART (Web Serial)</option><option value="ble">Bluetooth LE (read-only)</option><option value="demo">Simulated preview</option>' : '<option value="bridge">Local serial host</option>'}</select></label>
    <button id="connect">Connect</button><button id="disconnect" disabled>Disconnect</button>
    <strong id="connection-state">Disconnected</strong></section>
  <p id="error" role="alert" hidden></p><p id="preview" class="warning" hidden></p>
  <div class="grid">
    <section><h2>Device information</h2><dl>
      <dt>Product</dt><dd data-field="product">-</dd>
      <dt>Board / MCU</dt><dd data-field="board">-</dd>
      <dt>Firmware</dt><dd data-field="firmware">-</dd>
      <dt>Protocol</dt><dd data-field="protocol">-</dd></dl></section>
    <section><h2>Board configuration</h2><dl>
      <dt>Operating system</dt><dd>Zephyr 4.2.0</dd>
      <dt>Wi-Fi default</dt><dd>Enabled</dd><dt>BLE default</dt><dd>Enabled</dd>
      <dt>SD transport</dt><dd>SPI / up to 10 MHz requested</dd></dl></section>
    <section><h2>Live diagnostics</h2><dl>
      <dt>Uptime (ms)</dt><dd data-field="uptime_ms">-</dd>
      <dt>Wi-Fi connected</dt><dd data-field="wifi_connected">-</dd>
      <dt>Wi-Fi result code</dt><dd data-field="wifi_error">-</dd>
      <dt>BLE result code</dt><dd data-field="ble_error">-</dd></dl></section>
    <section><h2>Storage</h2><dl>
      <dt>FAT mounted</dt><dd data-field="sd_mounted">-</dd>
      <dt>Mount result code</dt><dd data-field="sd_error">-</dd>
      <dt>Mount point</dt><dd>/SD:</dd></dl>
      <p>No formatting, benchmarks, or dashboard file writes. Hardware validation pending.</p></section>
    <section><h2>Wi-Fi setup</h2><form id="wifi">
      <label>SSID (2.4 GHz)<input id="ssid" maxlength="32" required autocomplete="off"></label>
      <label>WPA2 passphrase (empty for open network)<input id="psk" type="password" maxlength="63" autocomplete="off"></label>
      <button id="provision" disabled>Connect Wi-Fi for this boot</button></form>
      <p>USB-UART only. Credentials stay in RAM; provision again after reboot.</p></section>
    <section><h2>Pin configuration</h2><details><summary>SD-card SPI wiring</summary>
      <dl><dt>CS / DAT3</dt><dd>GPIO10</dd><dt>MOSI / CMD</dt><dd>GPIO11</dd>
      <dt>SCLK / CLK</dt><dd>GPIO12</dd><dt>MISO / DAT0</dt><dd>GPIO13</dd>
      <dt>Power</dt><dd>3.3 V + common GND</dd></dl></details>
      <p>Use the board's USB-to-UART connector, not its native USB connector.</p></section>
  </div><footer>One serial owner at a time. Status is cleared on errors; commands are never automatically retried.</footer>`;

const element = (id) => document.getElementById(id);
let transport;
let timer;
let busy = false;
let active = false;

function clearStatus() {
  document.querySelectorAll("[data-field]").forEach((node) => { node.textContent = "-"; });
  element("provision").disabled = true;
}
function showError(error) {
  element("error").textContent = error.message;
  element("error").hidden = false;
  element("connection-state").textContent = "Error / status unavailable";
  clearStatus();
}
function render(status) {
  document.querySelectorAll("[data-field]").forEach((node) => {
    node.textContent = String(status[node.dataset.field]);
  });
  element("connection-state").textContent = transport.label || "Connected";
  element("provision").disabled = !transport.writable;
  element("error").hidden = true;
}
async function poll() {
  if (!active) return;
  if (busy) {
    timer = setTimeout(poll, 1000);
    return;
  }
  busy = true;
  try {
    const status = await transport.status();
    if (active) render(status);
  }
  catch (error) {
    if (!active) return;
    active = false;
    showError(error);
  } finally {
    busy = false;
    if (active) timer = setTimeout(poll, 1000);
  }
}

element("connect").addEventListener("click", async () => {
  element("connect").disabled = true;
  element("transport").disabled = true;
  element("error").hidden = true;
  const constructors = {serial: SerialTransport, ble: BleTransport, bridge: BridgeTransport, demo: DemoTransport};
  transport = new constructors[element("transport").value]();
  try {
    await transport.connect();
    element("preview").hidden = !(transport.label?.includes("SIMULATED"));
    element("preview").textContent = transport.label || "";
    active = true;
    element("disconnect").disabled = false;
    await poll();
  } catch (error) {
    showError(error);
    try { await transport.close(); } catch (closeError) { showError(closeError); }
    element("connect").disabled = false;
    element("transport").disabled = false;
  }
});
element("disconnect").addEventListener("click", async () => {
  active = false;
  clearTimeout(timer);
  element("disconnect").disabled = true;
  try {
    await transport.close();
    element("connection-state").textContent = "Disconnected";
  } catch (error) { showError(error); }
  clearStatus();
  element("preview").hidden = true;
  element("connect").disabled = false;
  element("transport").disabled = false;
});
element("wifi").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !active || !transport.writable) return;
  busy = true;
  element("provision").disabled = true;
  try {
    const fields = {ssid: element("ssid").value, psk: element("psk").value};
    validateWifi(fields);
    await transport.request("wifi.connect", fields);
    element("psk").value = "";
    element("connection-state").textContent = "Wi-Fi request accepted; waiting for connection result";
  } catch (error) {
    active = false;
    clearTimeout(timer);
    showError(error);
  }
  finally { busy = false; }
});
window.addEventListener("pagehide", () => {
  active = false;
  clearTimeout(timer);
  transport?.close().catch((error) => console.error("Disconnect failed", error));
});
