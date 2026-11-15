// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

import assert from "node:assert/strict";
import test from "node:test";
import { belowCoverageFloors, parseLcov } from "../support/coverage-lcov.mjs";

test("LCOV records supply stable per-file line, branch and function floors", () => {
  const records = parseLcov(`TN:
SF:host/direct/web/js/board/recovery.mjs
FNF:4
FNH:3
BRF:10
BRH:7
LF:100
LH:90
end_of_record
SF:host/direct/tests/contracts/architecture.test.mjs
FNF:1
FNH:1
BRF:1
BRH:1
LF:1
LH:1
end_of_record
`);
  assert.equal(records.length, 2);
  assert.deepEqual(belowCoverageFloors(records, { lines: 80, branches: 75, functions: 50 }), [
    { file: "host/direct/web/js/board/recovery.mjs", lines: 90, branches: 70, functions: 75 },
  ]);
});

test("LCOV modules without branches or functions are fully covered for those dimensions", () => {
  const [record] = parseLcov(`SF:/home/work/host/direct/web/js/leaf.mjs
LF:2
LH:2
BRF:0
BRH:0
FNF:0
FNH:0
end_of_record
`);
  assert.deepEqual(belowCoverageFloors([record], { lines: 100, branches: 100, functions: 100 }), []);
});

test("repeated LCOV records for one module merge before applying per-file floors", () => {
  const records = parseLcov(`SF:host/direct/web/js/app.mjs
LF:10
LH:5
BRF:4
BRH:2
FNF:2
FNH:1
end_of_record
SF:host/direct/web/js/app.mjs
LF:10
LH:10
BRF:4
BRH:4
FNF:2
FNH:2
end_of_record
`);
  assert.equal(records.length, 1);
  assert.deepEqual(belowCoverageFloors(records, { lines: 80, branches: 75, functions: 50 }), [
    { file: "host/direct/web/js/app.mjs", lines: 75, branches: 75, functions: 75 },
  ]);
});
