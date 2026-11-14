// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import { mountConsole } from "./console-session.mjs";

const query = new URLSearchParams(location.search);
const board = query.get("board");
mountConsole({ openUrl: `/api/console?${new URLSearchParams(board === null ? {} : { board })}`, openBody: {} });
