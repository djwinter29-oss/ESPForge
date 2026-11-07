import {SERVICE_UUID, STATUS_UUID, requestLine, validateStatus, demoStatus} from "./protocol.js";

export class SerialTransport {
  writable = true;
  id = 0;
  pending = null;
  buffer = "";

  async connect() {
    if (!navigator.serial) throw new Error("Web Serial requires desktop Chrome/Edge and HTTPS or localhost");
    this.port = await navigator.serial.requestPort();
    await this.port.open({baudRate: 115200, bufferSize: 4096});
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readTask = this.readLoop();
  }

  async readLoop() {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const {value, done} = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, {stream: true});
        let end;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end).trim();
          this.buffer = this.buffer.slice(end + 1);
          // ROM boot messages are not protocol responses.
          if (!line.startsWith("{")) continue;
          const reply = JSON.parse(line);
          if (reply.id === 0 && reply.ok === false) throw new Error(`Device rejected frame (${reply.error})`);
          if (this.pending && reply.id === this.pending.id) {
            const pending = this.pending;
            this.pending = null;
            clearTimeout(pending.timer);
            if (reply.ok === true) pending.resolve(reply);
            else pending.reject(new Error(`Device error ${reply.error}`));
          }
        }
        if (this.buffer.length > 4096) throw new Error("Serial receive frame too large");
      }
      this.failure = new Error("Serial disconnected");
    } catch (error) {
      this.failure = error;
    } finally {
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(this.failure || new Error("Serial disconnected"));
        this.pending = null;
      }
      this.reader.releaseLock();
    }
  }

  async request(op, fields = {}) {
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error("Another board request is active");
    this.id = this.id % 2147483647 + 1;
    const id = this.id;
    const bytes = new TextEncoder().encode(requestLine(id, op, fields));
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error("Board timeout; command was not retried"));
      }, 5000);
      this.pending = {id, resolve, reject, timer};
    });
    try {
      await this.writer.write(bytes);
    } catch (error) {
      clearTimeout(this.pending?.timer);
      this.pending?.reject(error);
      this.pending = null;
    }
    return response;
  }

  async status() {
    return validateStatus((await this.request("status")).status);
  }

  async close() {
    if (!this.port) return;
    if (this.reader) {
      await this.reader.cancel();
      await this.readTask;
    }
    this.writer?.releaseLock();
    await this.port.close();
  }
}

export class BleTransport {
  writable = false;
  async connect() {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth is unavailable on this browser/OS");
    this.device = await navigator.bluetooth.requestDevice({filters: [{services: [SERVICE_UUID]}]});
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(STATUS_UUID);
  }
  async status() {
    const data = await this.characteristic.readValue();
    return validateStatus(JSON.parse(new TextDecoder().decode(data)));
  }
  async close() { this.device?.gatt.disconnect(); }
}

export class BridgeTransport {
  writable = true;
  async connect() {
    const response = await fetch("/api/host");
    if (!response.ok) throw new Error("Host server unavailable");
    const host = await response.json();
    this.label = host.name + (host.demo ? " - SIMULATED" : "");
    this.writable = !host.demo;
  }
  async request(op, fields = {}) {
    const response = await fetch("/api/request", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...fields, op}),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.message || `Device error ${result.error}`);
    return result;
  }
  async status() { return validateStatus((await this.request("status")).status); }
  async close() {}
}

export class DemoTransport {
  writable = false;
  label = "SIMULATED - no hardware connected";
  async connect() {}
  async status() { return demoStatus(); }
  async close() {}
}
