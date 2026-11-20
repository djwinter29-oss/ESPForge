// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("dashboard styles expose wireless selection and focus and wrap dialog actions", () => {
  const css = readFileSync(new URL("../../src/css/dashboard.css", import.meta.url), "utf8");
  assert.match(css, /\.wifi-network\[aria-pressed="true"\]/);
  assert.match(css, /\.wifi-network:focus-visible/);
  assert.match(css, /\.brand:focus-visible/);
  assert.match(css, /\.dialog-actions \{[^}]*flex-wrap: wrap/);
});

test("keyboard focus indicators provide at least 3:1 contrast on dashboard surfaces", () => {
  const css = readFileSync(new URL("../../src/css/dashboard.css", import.meta.url), "utf8");
  const focus = css.match(/--focus:\s*(#[0-9a-f]{6})/i)?.[1];
  const inverseFocus = css.match(/--focus-inverse:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(focus && inverseFocus, "the dashboard defines focus colours for light and dark surfaces");
  const luminance = colour => {
    const channels = colour.match(/[0-9a-f]{2}/gi)?.map(channel => parseInt(channel, 16) / 255);
    assert.ok(channels?.length === 3);
    return channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  };
  for (const surface of ["#ffffff", "#f4f7f6", "#eaf0ee"]) {
    const [light, dark] = [luminance(focus), luminance(surface)].sort((a, b) => b - a);
    assert.ok((light + 0.05) / (dark + 0.05) >= 3, `${focus} must contrast with ${surface}`);
  }
  const focusRules = [...css.matchAll(/([^{}]+:focus-visible[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(focusRules.length > 0);
  for (const [, selector, declarations] of focusRules) {
    const inverse = selector.includes(".brand");
    const colour = inverse ? inverseFocus : focus;
    const token = inverse ? "--focus-inverse" : "--focus";
    assert.match(declarations, new RegExp(`outline:\\s*3px solid var\\(${token}\\)`), selector.trim());
    const surfaces = inverse ? ["#103c3b"] : ["#ffffff", "#f4f7f6", "#eaf0ee"];
    for (const surface of surfaces) {
      const [light, dark] = [luminance(colour), luminance(surface)].sort((a, b) => b - a);
      assert.ok((light + 0.05) / (dark + 0.05) >= 3, `${colour} must contrast with ${surface}`);
    }
  }
});

test("muted and error text colors meet normal-text contrast on dashboard surfaces", () => {
  const css = readFileSync(new URL("../../src/css/dashboard.css", import.meta.url), "utf8");
  const muted = css.match(/--muted:\s*(#[0-9a-f]{6})/i)?.[1];
  const error = css.match(/--coral:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(muted && error);
  const luminance = colour => {
    const channels = colour.match(/[0-9a-f]{2}/gi)?.map(channel => parseInt(channel, 16) / 255);
    assert.ok(channels?.length === 3);
    return channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  };
  for (const [foreground, surface] of [[muted, "#f4f7f6"], [muted, "#eaf0ee"], [error, "#eaf0ee"]]) {
    const [light, dark] = [luminance(foreground), luminance(surface)].sort((a, b) => b - a);
    assert.ok((light + 0.05) / (dark + 0.05) >= 4.5, `${foreground} must contrast with ${surface}`);
  }
});

test("hidden unsaved-change indicator remains visually hidden", () => {
  const css = readFileSync(new URL("../../src/css/dashboard.css", import.meta.url), "utf8");
  assert.match(css, /\.settings-dirty\[hidden\]\s*\{\s*display:\s*none\s*;/);
});
