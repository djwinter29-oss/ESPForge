// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/**
 * @typedef {{file: string, linesFound: number, linesHit: number, branchesFound: number, branchesHit: number,
 *   functionsFound: number, functionsHit: number}} CoverageRecord
 */

/**
 * @brief Parse LCOV summary records without depending on Node's human-readable coverage table.
 * @param {string} report
 * @return {CoverageRecord[]}
 */
export function parseLcov(report) {
  /** @type {Map<string, CoverageRecord>} */
  const records = new Map();
  /** @type {Array<Exclude<keyof CoverageRecord, "file">>} */
  const counters = ["linesFound", "linesHit", "branchesFound", "branchesHit", "functionsFound", "functionsHit"];
  /** @param {CoverageRecord} next */
  const merge = next => {
    const current = records.get(next.file);
    if (!current) {
      records.set(next.file, next);
      return;
    }
    for (const counter of counters) current[counter] += next[counter];
  };
  /** @type {CoverageRecord | null} */
  let record = null;
  for (const line of report.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      if (record) merge(record);
      record = { file: line.slice(3).replaceAll("\\", "/"), linesFound: 0, linesHit: 0, branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0, functionsHit: 0 };
      continue;
    }
    if (!record) continue;
    const match = /^(LF|LH|BRF|BRH|FNF|FNH):(\d+)$/.exec(line);
    if (match) {
      const property = /** @type {"linesFound" | "linesHit" | "branchesFound" | "branchesHit"
        | "functionsFound" | "functionsHit"} */ ({
        LF: "linesFound", LH: "linesHit", BRF: "branchesFound", BRH: "branchesHit",
        FNF: "functionsFound", FNH: "functionsHit",
      })[match[1]];
      record[property] = Number(match[2]);
    } else if (line === "end_of_record") {
      merge(record);
      record = null;
    }
  }
  if (record) merge(record);
  return [...records.values()];
}

/**
 * @brief Return runtime modules below any configured coverage floor; modules with no branches/functions score 100%.
 * @param {CoverageRecord[]} records
 * @param {{lines: number, branches: number, functions: number}} floors
 */
export function belowCoverageFloors(records, floors) {
  return records.filter(record => /(?:^|\/)host\/direct\/web\/js\/.+\.mjs$/.test(record.file)).map(record => {
    const percentage = (hit, total) => total ? 100 * hit / total : 100;
    return { file: record.file, lines: percentage(record.linesHit, record.linesFound),
      branches: percentage(record.branchesHit, record.branchesFound),
      functions: percentage(record.functionsHit, record.functionsFound) };
  }).filter(record => record.lines < floors.lines || record.branches < floors.branches
    || record.functions < floors.functions);
}
