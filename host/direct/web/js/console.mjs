// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { mountConsole } from "./ui/console-session.mjs";
import { checkConsoleTarget } from "./ui/console-target.mjs";

const query = new URLSearchParams(location.search);
const source = query.get("source");
const target = { ipv4: query.get("ipv4") ?? "", serial: query.get("serial") ?? "" };
const channel = new BroadcastChannel(`espforge-console-${source}`);
mountConsole({
  openUrl: "/api/console", openBody: { ipv4: target.ipv4 },
  check: () => checkConsoleTarget(channel, target),
});
window.addEventListener("pagehide", () => channel.close());
