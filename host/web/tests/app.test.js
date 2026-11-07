import test from "node:test";
import assert from "node:assert/strict";
import {SerialTransport, DemoTransport} from "../transports.js";
import {demoStatus} from "../protocol.js";

let fixtureId = 0;

async function dashboard(t) {
  const ids = new Map();
  let fields = [];
  const node = (attributes = "") => ({
    disabled: /\bdisabled\b/.test(attributes),
    hidden: /\bhidden\b/.test(attributes),
    value: "",
    textContent: "",
    dataset: {},
    listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; },
    scrollIntoView() {},
    focus() {},
    fire(event) { return this.listeners[event]({preventDefault() {}}); },
  });
  const root = {
    set innerHTML(html) {
      for (const tag of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
        ids.set(tag[1], node(tag[0]));
      }
      fields = Array.from(html.matchAll(/data-field="([^"]+)"/g), ([, field]) => {
        const item = node();
        item.dataset.field = field;
        return item;
      });
      ids.get("transport").value = "serial";
    },
  };
  const previous = Object.fromEntries(["document", "window", "setTimeout", "clearTimeout"]
    .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const timers = new Map();
  let timerId = 0;
  globalThis.document = {
    documentElement: {dataset: {mode: "direct"}},
    querySelector: () => root,
    querySelectorAll: () => fields,
    getElementById: (id) => ids.get(id),
  };
  globalThis.window = {addEventListener() {}};
  globalThis.setTimeout = (callback) => { timers.set(++timerId, callback); return timerId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await import(`../app.js?fixture=${++fixtureId}`);
  return {
    get: (id) => ids.get(id),
    field: (name) => fields.find((item) => item.dataset.field === name).textContent,
  };
}

function patch(t, prototype, methods) {
  const originals = Object.fromEntries(Object.keys(methods).map((name) => [name, prototype[name]]));
  Object.assign(prototype, methods);
  t.after(() => Object.assign(prototype, originals));
}

test("preview renders live flags, disables commands and clears on disconnect", async (t) => {
  const ui = await dashboard(t);
  ui.get("transport").value = "demo";
  await ui.get("connect").fire("click");
  assert.equal(ui.field("product"), "ESPForge");
  assert.equal(ui.field("wifi_enabled"), "Enabled");
  assert.equal(ui.field("uptime_ms"), "123.0 s");
  assert.equal(ui.get("preview").hidden, false);
  assert.equal(ui.get("provision").disabled, true);
  assert.equal(ui.get("ssid").disabled, true);
  await ui.get("disconnect").fire("click");
  assert.equal(ui.field("product"), "--");
  assert.equal(ui.get("preview").hidden, true);
  assert.equal(ui.get("connect").disabled, false);
});

test("local invalid credentials do not stop telemetry or send commands", async (t) => {
  let requests = 0;
  patch(t, SerialTransport.prototype, {
    async connect() {},
    async close() {},
    async status() { return {...demoStatus(), wifi_enabled: false}; },
    async request() { requests++; return {ok: true}; },
  });
  const ui = await dashboard(t);
  await ui.get("connect").fire("click");
  assert.equal(ui.field("wifi_enabled"), "Disabled");
  ui.get("ssid").value = "\u00e9".repeat(17);
  ui.get("psk").value = "12345678";
  await ui.get("wifi").fire("submit");
  assert.match(ui.get("wifi-feedback").textContent, /UTF-8 bytes/);
  assert.equal(requests, 0);
  assert.equal(ui.get("refresh").disabled, false);
  assert.equal(ui.field("product"), "ESPForge");
  ui.get("ssid").value = "lab";
  await ui.get("wifi").fire("submit");
  assert.equal(requests, 1);
  assert.equal(ui.get("psk").value, "");
  assert.match(ui.get("wifi-feedback").textContent, /Request accepted, not yet connected/);
});

test("status failure clears telemetry and permits explicit disconnect/reconnect", async (t) => {
  let fail = false;
  patch(t, SerialTransport.prototype, {
    async connect() {},
    async close() {},
    async status() {
      if (fail) throw new Error("Unplugged");
      return demoStatus();
    },
  });
  const ui = await dashboard(t);
  await ui.get("connect").fire("click");
  fail = true;
  await ui.get("refresh").fire("click");
  assert.equal(ui.field("product"), "--");
  assert.equal(ui.get("provision").disabled, true);
  assert.equal(ui.get("error").textContent, "Unplugged");
  await ui.get("disconnect").fire("click");
  fail = false;
  await ui.get("connect").fire("click");
  assert.equal(ui.field("product"), "ESPForge");
});

test("late status from a disconnected session cannot overwrite a new session", async (t) => {
  let resolveOld;
  let count = 0;
  patch(t, DemoTransport.prototype, {
    async status() {
      if (++count === 1) return new Promise((resolve) => { resolveOld = resolve; });
      return {...demoStatus(), firmware: "new session"};
    },
  });
  const ui = await dashboard(t);
  ui.get("transport").value = "demo";
  const oldConnect = ui.get("connect").fire("click");
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(resolveOld);
  await ui.get("disconnect").fire("click");
  await ui.get("connect").fire("click");
  assert.equal(ui.field("firmware"), "new session");
  resolveOld({...demoStatus(), firmware: "stale session"});
  await oldConnect;
  assert.equal(ui.field("firmware"), "new session");
  assert.equal(ui.get("refresh").disabled, false);
});

test("cleanup failure keeps a disconnect retry available", async (t) => {
  let fail = true;
  patch(t, SerialTransport.prototype, {
    async connect() { throw new Error("Open failed"); },
    async close() { if (fail) throw new Error("Close failed"); },
  });
  const ui = await dashboard(t);
  await ui.get("connect").fire("click");
  assert.match(ui.get("error").textContent, /Open failed; cleanup failed: Close failed/);
  assert.equal(ui.get("disconnect").disabled, false);
  assert.equal(ui.get("connect").disabled, true);
  fail = false;
  await ui.get("disconnect").fire("click");
  assert.equal(ui.get("connect").disabled, false);
});
