export const SERVICE_UUID = "7a9c0001-6d8e-4c21-a120-455350464f52";
export const STATUS_UUID = "7a9c0002-6d8e-4c21-a120-455350464f52";

export function validateStatus(value) {
  if (!value || value.protocol !== 1 || value.product !== "ESPForge") {
    throw new Error("Unsupported device or protocol");
  }
  for (const name of ["board", "firmware"]) {
    if (typeof value[name] !== "string") throw new Error(`Invalid ${name}`);
  }
  for (const name of ["uptime_ms", "wifi_error", "ble_error", "sd_error"]) {
    if (!Number.isSafeInteger(value[name])) throw new Error(`Invalid ${name}`);
  }
  if (value.uptime_ms < 0) throw new Error("Invalid uptime");
  for (const name of ["wifi_enabled", "ble_enabled", "wifi_connected", "sd_mounted"]) {
    if (typeof value[name] !== "boolean") throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function requestLine(id, op, fields = {}) {
  let wire = fields;
  if (op === "wifi.connect") {
    validateWifi(fields);
    const hex = (text) => Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
    wire = {ssid_hex: hex(fields.ssid), psk_hex: hex(fields.psk)};
  }
  const line = JSON.stringify({...wire, id, op}) + "\n";
  if (new TextEncoder().encode(line).length > 512) throw new Error("Request exceeds 512 bytes");
  return line;
}

export function validateWifi({ssid, psk}) {
  if (typeof ssid !== "string" || typeof psk !== "string" || ssid.includes("\0") || psk.includes("\0")) {
    throw new Error("Wi-Fi credentials must be strings without NUL");
  }
  const ssidLength = new TextEncoder().encode(ssid).length;
  const pskLength = new TextEncoder().encode(psk).length;
  if (ssidLength < 1 || ssidLength > 32) throw new Error("SSID must be 1-32 UTF-8 bytes");
  if (pskLength !== 0 && (pskLength < 8 || pskLength > 63)) throw new Error("Passphrase must be empty or 8-63 UTF-8 bytes");
}

export const demoStatus = () => ({
  protocol: 1, product: "ESPForge", board: "ESP32-S3-DevKitC",
  firmware: "0.1.0 (simulated)", uptime_ms: 123000,
  wifi_enabled: true, ble_enabled: true, wifi_connected: false,
  wifi_error: 0, ble_error: 0, sd_mounted: false, sd_error: -19,
});
