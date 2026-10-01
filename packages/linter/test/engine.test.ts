/* Engine tests. These drive the real compiler (no mocks): the linter's whole
 * promise is that its verdict comes from compiler decisions, so the test
 * suite pins the verdict against programs whose compiler behavior the corpus
 * and coverage suites already fix. */

import { join } from "node:path";
import { expect, test } from "vitest";
import { FRONTEND_STAGES, lint, lintExitCode, VERIFIED_STAGES } from "../src/engine.js";
import { reportJson, reportText } from "../src/report.js";

const repo = process.cwd();
const corpus = (name: string) => join(repo, "tests/corpus", name);
const fixture = (name: string) => join(repo, "tests/coverage-fixtures", name);

test("a fully static program is supported", async () => {
  const result = await lint(corpus("400-fib.ts"));
  expect(result.guarantee.supported).toBe(true);
  expect(result.guarantee.strictClean).toBe(true);
  expect(result.findings).toEqual([]);
  expect(result.compiled).toBe(true);
  expect(result.stats.staticPercent).toBe(100);
  expect(result.guarantee.summary).toContain("fully supported");
  expect(lintExitCode(result)).toBe(0);
});

test("a fully static JavaScript program is supported", async () => {
  const result = await lint(corpus("1590-js-unannotated.js"));
  expect(result.guarantee.supported).toBe(true);
  expect(result.findings).toEqual([]);
});

test("unsupported constructs are errors attributed to their source", async () => {
  const result = await lint(fixture("mixed.ts"));
  expect(result.guarantee.supported).toBe(false);
  expect(lintExitCode(result)).toBe(1);
  const codes = result.findings.map((f) => f.code);
  expect(codes).toContain("SC1031");
  for (const finding of result.findings) {
    expect(finding.severity).toBe("error");
    expect(finding.origin).toBe("reached");
    expect(finding.ruleId).toMatch(/^scriptc\/SC\d{4}$/);
    expect(finding.loc.start).toBeGreaterThanOrEqual(0);
    expect(finding.loc.file.endsWith("mixed.ts")).toBe(true);
  }
  // Errors are ordered by source position.
  const offsets = result.findings.map((f) => f.loc.start);
  expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
});

test("TypeScript errors are reported as frontend gates", async () => {
  const result = await lint(fixture("type-errors.ts"));
  expect(result.guarantee.supported).toBe(false);
  expect(result.compiled).toBe(false);
  const finding = result.findings.find((f) => f.code === "SC0001");
  expect(finding).toBeDefined();
  expect(finding?.family).toBe("frontend");
  expect(finding?.severity).toBe("error");
  // The guarantee names the frontend-only scope when verification is skipped.
  expect(result.guarantee.checked.some((line) => line.includes("LLVM"))).toBe(false);
});

test("blockers in unreached bodies still fail a strict lint", async () => {
  const strict = await lint(fixture("unreached.ts"));
  expect(strict.guarantee.supported).toBe(false);
  const unreached = strict.findings.filter((f) => f.origin === "unreached");
  expect(unreached.length).toBeGreaterThan(0);
  expect(unreached.every((f) => f.severity === "error")).toBe(true);
  // Nothing on the entry path blocks: the program itself BUILDS.
  expect(strict.stats.blocked).toBe(0);
  expect(strict.stats.unreachedBlocked).toBeGreaterThan(0);

  // --no-strict keeps them visible but non-blocking, which is the exact
  // shape of a build: it succeeds and never lowers those bodies.
  const lenient = await lint(fixture("unreached.ts"), { strict: false });
  expect(lenient.guarantee.supported).toBe(true);
  expect(lenient.guarantee.strictClean).toBe(false);
  expect(lenient.findings.every((f) => f.severity === "warning")).toBe(true);
  expect(lintExitCode(lenient)).toBe(0);

  // Suppressing the group entirely is the fastest lens, and it says so.
  const suppressed = await lint(fixture("unreached.ts"), { reportUnreached: false, strict: false });
  expect(suppressed.findings).toEqual([]);
});

test("--dynamic reports island-capable constructions separately", async () => {
  const staticRun = await lint(fixture("dynamic-mix.ts"));
  expect(staticRun.guarantee.supported).toBe(false);
  expect(staticRun.findings.some((f) => f.dynamicAlternative === true)).toBe(true);

  const dynamic = await lint(fixture("dynamic-mix.ts"), { dynamic: true, strict: false });
  // Under --dynamic the island sites lower, so only the flag-independent
  // refusal remains an error.
  expect(dynamic.findings.some((f) => f.dynamicAlternative === true)).toBe(false);
  expect(dynamic.stats.island).toBeGreaterThan(0);
});

test("--no-verify narrows the claim and says so", async () => {
  const result = await lint(corpus("400-fib.ts"), { verify: false });
  expect(result.guarantee.supported).toBe(true);
  expect(result.compiled).toBe(false);
  expect(result.guarantee.checked.some((line) => line.includes("LLVM emission"))).toBe(false);
  expect(result.guarantee.summary).toContain("frontend analysis");
});

test("reachable statements that build but trap are reported and can be silenced", async () => {
  const root = join(repo, "tests/coverage-fixtures/external-types");
  const options = { externalTypes: { "@native-sdk/core": join(root, "native-sdk-core.d.ts") } };
  const strict = await lint(join(root, "side-effect.cjs"), options);
  expect(strict.guarantee.supported).toBe(false);
  const fence = strict.findings.find((f) => f.ruleId === "scriptc/runtime-fence");
  expect(fence).toBeDefined();
  expect(fence?.origin).toBe("runtime");
  expect(fence?.severity).toBe("error");

  const lenient = await lint(join(root, "side-effect.cjs"), { ...options, strict: false });
  expect(lenient.findings.every((f) => f.severity === "warning")).toBe(true);

  const silent = await lint(join(root, "side-effect.cjs"), { ...options, reportRuntimeFences: false, strict: false });
  expect(silent.findings).toEqual([]);
});

test("the guarantee names what it does not check", async () => {
  const result = await lint(corpus("400-fib.ts"));
  expect(result.guarantee.notChecked.length).toBeGreaterThan(0);
  expect(result.guarantee.notChecked.join(" ")).toContain("runtime behavior");
  expect(result.guarantee.checked).toContain("LLVM IR emission");
});

test("the verified stage list extends the frontend one", () => {
  expect(VERIFIED_STAGES.slice(0, FRONTEND_STAGES.length)).toEqual(FRONTEND_STAGES);
  expect(VERIFIED_STAGES).toContain("LLVM IR emission");
  expect(FRONTEND_STAGES).not.toContain("LLVM IR emission");
});

test("statements account for the static percentage", async () => {
  const result = await lint(fixture("mixed.ts"), { strict: false });
  const s = result.stats;
  expect(s.analyzed).toBeGreaterThan(0);
  expect(s.blocked).toBeGreaterThan(0);
  expect(s.static + s.blocked + s.island + s.unreachedBlocked).toBe(s.analyzed);
  expect(s.staticPercent).toBeLessThan(100);
});

test("JSON reports carry the verdict, locations, and stats", async () => {
  const result = await lint(fixture("mixed.ts"));
  const document = reportJson([result]);
  expect(document.tool).toBe("scriptc-lint");
  expect(document.summary.supportedAll).toBe(false);
  expect(document.summary.errors).toBeGreaterThan(0);
  const entry = document.results[0]!;
  expect(entry.supported).toBe(false);
  expect(entry.findings[0]!.line).toBeGreaterThan(0);
  expect(entry.findings[0]!.column).toBeGreaterThan(0);
  expect(entry.checked.length).toBeGreaterThan(0);
  // Strict is the default, so reported severities are errors.
  expect(entry.findings.every((f) => f.severity === "error")).toBe(true);
});

test("text reports name the blocking family and the verdict", async () => {
  const result = await lint(fixture("mixed.ts"));
  const text = reportText([result]);
  expect(text).toContain("not supported");
  expect(text).toContain("scriptc/SC1031");
  expect(text).toContain("statements:");
});
