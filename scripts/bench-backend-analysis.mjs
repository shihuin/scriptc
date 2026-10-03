/* Isolate whole-module propagation from frontend/native toolchain timings.
 * Caller-first and parent-first chains expose depth-dependent rescanning;
 * every measured run verifies the complete analysis result. */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { computeMayThrow } from "../packages/compiler/dist/backend/may-throw.js";
import { computeTraced } from "../packages/compiler/dist/backend/cycle-analysis.js";
import { F64, VOID } from "../packages/compiler/dist/ir/ir.js";

const { values } = parseArgs({ options: {
  iterations: { type: "string", default: "5" },
  sizes: { type: "string", default: "500,2000,4000,8000" },
} });
const iterations = Number(values.iterations);
const sizes = values.sizes.split(",").map(Number);
assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 100, "--iterations must be an integer between 1 and 100");
assert.ok(sizes.length >= 1 && sizes.length <= 16 && sizes.every((n) => Number.isInteger(n) && n >= 1 && n <= 100_000), "--sizes must contain 1–16 integers between 1 and 100000");
const loc = { file: "chain.ts", start: 0, end: 1 };
const value = { kind: "numLit", value: 1, type: F64, loc };
const results = [];
for (const size of sizes) {
  const functions = Array.from({ length: size }, (_, i) => ({
    name: `fn${i}`, params: [], locals: [], returnType: VOID, loc,
    body: [i === size - 1 ? { kind: "throw", value, loc }
      : { kind: "exprStmt", expr: { kind: "call", callee: `fn${i + 1}`, args: [], type: VOID, loc }, loc }],
  }));
  const mod = { irVersion: 13, sourceFile: loc.file, entry: "fn0", functions };
  const records = Array.from({ length: size }, (_, i) => ({
    id: `r${i}`, fields: [{ name: "next", type: i === size - 1 ? F64 : { kind: "record", shapeId: `r${i + 1}` } }],
  }));
  const graph = { ...mod, records };
  const workloads = [
    { name: "may-throw", run: () => computeMayThrow(mod), check: (answer) => {
      assert.equal(answer.indirect, false);
      assert.equal(answer.fns.size, size);
      for (const fn of functions) assert.ok(answer.fns.has(fn.name), fn.name);
    } },
    { name: "cycle-analysis", run: () => computeTraced(graph), check: (answer) => {
      assert.equal(answer.shapes.size, 0);
      assert.equal(answer.unions.size, 0);
    } },
  ];
  for (const { name, run, check } of workloads) {
    const samples = [];
    for (let i = -2; i < iterations; i++) {
      const start = performance.now();
      const answer = run();
      const ms = performance.now() - start;
      check(answer);
      if (i >= 0) samples.push(ms);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    results.push({ analysis: name, nodes: size, median_ms: median, samples_ms: samples });
    process.stderr.write(`${name} ${size}: ${median.toFixed(2)} ms\n`);
  }
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, iterations, results }, null, 2));
