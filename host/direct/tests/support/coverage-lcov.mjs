// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

/**
 * @typedef {{file: string, linesFound: number, linesHit: number, branchesFound: number, branchesHit: number,
 *   functionsFound: number, functionsHit: number}} CoverageRecord
 * @typedef {{summary: CoverageRecord,
 *   details: {lines: Map<string, boolean>, branches: Map<string, boolean>, functions: Map<string, boolean>},
 *   functions: Array<{identity: string, line: string, name: string, counted: boolean}>}} LcovTrace
 */

/**
 * @brief Parse Node LCOV records, unioning per-item hits across repeated source records.
 * @param {string} report
 * @return {CoverageRecord[]}
 * @throws {Error} If repeated records lack complete per-item details or function counts lack matching definitions.
 */
export function parseLcov(report) {
  /** @type {Map<string, LcovTrace>} */
  const records = new Map();
  /** @type {Array<["lines", "linesFound", "linesHit"] | ["branches", "branchesFound", "branchesHit"]
   *   | ["functions", "functionsFound", "functionsHit"]>} */
  const dimensions = [["lines", "linesFound", "linesHit"], ["branches", "branchesFound", "branchesHit"],
    ["functions", "functionsFound", "functionsHit"]];
  /** @type {Record<string, Exclude<keyof CoverageRecord, "file">>} */
  const summaryFields = {
    LF: "linesFound", LH: "linesHit", BRF: "branchesFound", BRH: "branchesHit",
    FNF: "functionsFound", FNH: "functionsHit",
  };
  /** @param {LcovTrace} next */
  const merge = next => {
    const current = records.get(next.summary.file);
    if (!current) {
      records.set(next.summary.file, next);
      return;
    }
    for (const [dimension, found, hit] of dimensions) {
      if ([current, next].some(trace => trace.details[dimension].size !== trace.summary[found]
          || [...trace.details[dimension].values()].filter(Boolean).length !== trace.summary[hit]
          || dimension === "functions" && trace.functions.some(item => !item.counted))) {
        throw new Error(`Cannot merge LCOV ${dimension} coverage for ${next.summary.file}: `
          + "complete per-item details are required");
      }
      const items = current.details[dimension];
      for (const [identity, covered] of next.details[dimension]) {
        items.set(identity, items.get(identity) === true || covered);
      }
      current.summary[found] = items.size;
      current.summary[hit] = [...items.values()].filter(Boolean).length;
    }
  };
  /** @type {LcovTrace | null} */
  let record = null;
  for (const line of report.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      if (record) merge(record);
      record = {
        summary: { file: line.slice(3).replaceAll("\\", "/"), linesFound: 0, linesHit: 0, branchesFound: 0,
          branchesHit: 0, functionsFound: 0, functionsHit: 0 },
        details: { lines: new Map(), branches: new Map(), functions: new Map() },
        functions: [],
      };
      continue;
    }
    if (!record) continue;
    const match = /^(LF|LH|BRF|BRH|FNF|FNH):(\d+)$/.exec(line);
    const lineHit = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line);
    const branchHit = /^BRDA:(\d+,\d+,\d+),(\d+|-)$/.exec(line);
    const definition = /^FN:(\d+),(.+)$/.exec(line);
    const functionHit = /^FNDA:(\d+),(.+)$/.exec(line);
    if (match) {
      record.summary[summaryFields[match[1]]] = Number(match[2]);
    } else if (lineHit) {
      record.details.lines.set(lineHit[1], Number(lineHit[2]) > 0);
    } else if (branchHit) {
      record.details.branches.set(branchHit[1], branchHit[2] !== "-" && Number(branchHit[2]) > 0);
    } else if (definition) {
      const name = definition[2];
      const occurrence = record.functions.filter(item => item.line === definition[1] && item.name === name).length;
      const identity = `${definition[1]},${name},${occurrence}`;
      record.functions.push({ identity, line: definition[1], name, counted: false });
      record.details.functions.set(identity, false);
    } else if (functionHit) {
      // Node emits counts in definition order, including repeated names at the same source line.
      const item = record.functions.find(item => item.name === functionHit[2] && !item.counted);
      if (!item) throw new Error(`LCOV function count has no matching definition in ${record.summary.file}`);
      item.counted = true;
      record.details.functions.set(item.identity, Number(functionHit[1]) > 0);
    } else if (line === "end_of_record") {
      merge(record);
      record = null;
    }
  }
  if (record) merge(record);
  return [...records.values()].map(record => record.summary);
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
