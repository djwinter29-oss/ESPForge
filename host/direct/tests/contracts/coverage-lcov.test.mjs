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

test("complementary LCOV runs union identities without collapsing same-name functions or branches", () => {
  const first = `SF:host/direct/web/js/app.mjs
FN:10,handler
FN:10,handler
FNDA:3,handler
FNDA:0,handler
FNF:2
FNH:1
BRDA:10,0,0,3
BRDA:10,0,1,-
BRF:2
BRH:1
DA:10,3,checksum
DA:11,0
LF:2
LH:1
end_of_record
`;
  const second = `SF:host\\direct\\web\\js\\app.mjs
FN:10,handler
FN:10,handler
FNDA:0,handler
FNDA:4,handler
FNF:2
FNH:1
BRDA:10,0,0,0
BRDA:10,0,1,4
BRF:2
BRH:1
DA:10,0,checksum
DA:11,4
LF:2
LH:1
end_of_record
`;
  const records = parseLcov((first + second + first).replaceAll("\n", "\r\n"));
  assert.deepEqual(records, [
    { file: "host/direct/web/js/app.mjs", linesFound: 2, linesHit: 2, branchesFound: 2, branchesHit: 2,
      functionsFound: 2, functionsHit: 2 },
  ]);
  assert.deepEqual(belowCoverageFloors(records, { lines: 100, branches: 100, functions: 100 }), []);
});

test("repeated LCOV runs retain unhit identities and accept a final record without a terminator", () => {
  const report = `SF:host/direct/web/js/app.mjs
DA:10,1
DA:11,0
LF:2
LH:1
BRF:0
BRH:0
FNF:0
FNH:0
`;
  const records = parseLcov(`${report}end_of_record\n${report}`);
  assert.deepEqual(records, [
    { file: "host/direct/web/js/app.mjs", linesFound: 2, linesHit: 1, branchesFound: 0, branchesHit: 0,
      functionsFound: 0, functionsHit: 0 },
  ]);
  assert.deepEqual(belowCoverageFloors(records, { lines: 50, branches: 100, functions: 100 }), []);
  assert.deepEqual(belowCoverageFloors(records, { lines: 51, branches: 100, functions: 100 }), [
    { file: "host/direct/web/js/app.mjs", lines: 50, branches: 100, functions: 100 },
  ]);
});

test("partial function records union the same source location despite different same-name definitions", () => {
  const records = parseLcov(`SF:host/direct/web/js/app.mjs
FN:10,handler
FN:20,handler
FNDA:1,handler
FNDA:0,handler
FNF:2
FNH:1
end_of_record
SF:host/direct/web/js/app.mjs
FN:20,handler
FNDA:1,handler
FNF:1
FNH:1
end_of_record
`);
  assert.deepEqual(records, [
    { file: "host/direct/web/js/app.mjs", linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0,
      functionsFound: 2, functionsHit: 2 },
  ]);
});

test("repeated summary-only LCOV records fail explicitly when identity details are unavailable", () => {
  for (const dimension of ["LF:1\nLH:1", "BRF:1\nBRH:1", "FNF:1\nFNH:1"]) {
    const record = `SF:host/direct/web/js/app.mjs\n${dimension}\nend_of_record\n`;
    assert.throws(() => parseLcov(record + record), /per-item details/, dimension);
  }
});

test("LCOV function counts must match definitions rather than defaulting missing counts to zero", () => {
  assert.throws(() => parseLcov("SF:host/direct/web/js/app.mjs\nFNDA:1,handler\nend_of_record\n"),
    /no matching definition/);
  const record = "SF:host/direct/web/js/app.mjs\nFN:10,handler\nFNF:1\nFNH:0\nend_of_record\n";
  assert.throws(() => parseLcov(record + record), /per-item details/);
});
