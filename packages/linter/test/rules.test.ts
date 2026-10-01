/* The rule catalog must track the compiler's diagnostic registry. The
 * registry in packages/compiler/src/diagnostics/diagnostic.ts is the single
 * place "not supported yet" messages live; if it grows a code the linter has
 * no wording for, this test fails instead of the linter silently printing an
 * unexplained SC code. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { allRules, ruleFor, RULE_FAMILIES, type ScCode } from "../src/rules.js";

const registryPath = fileURLToPath(new URL("../../compiler/src/diagnostics/diagnostic.ts", import.meta.url));
const compilerIndexPath = fileURLToPath(new URL("../../compiler/src/index.ts", import.meta.url));

function registryCodes(): string[] {
  const text = readFileSync(registryPath, "utf8");
  return [...new Set(text.match(/SC\d{4}/g) ?? [])].sort();
}

test("every compiler diagnostic code has a linter rule", () => {
  const codes = registryCodes();
  expect(codes.length).toBeGreaterThan(50);
  const missing: string[] = [];
  for (const code of codes) {
    const rule = ruleFor(code as ScCode, "the compiler's own message");
    if (rule.description === "the compiler's own message") missing.push(code);
    if (!RULE_FAMILIES.includes(rule.family)) missing.push(`${code}:${rule.family}`);
  }
  expect(missing).toEqual([]);
});

test("the rules the linter reports all come from the compiler registry", () => {
  const known = new Set(registryCodes());
  const strays = allRules()
    .map((rule) => rule.code)
    .filter((code) => !known.has(code));
  expect(strays).toEqual([]);
});

test("catalogued rules classify into the code band's family", () => {
  // Bands are part of the diagnosed contract: SC1xxx is the static subset,
  // SC2xxx is typed rules, SC3xxx is backend/target, and so on. A rule whose
  // family disagrees with its band would mislead the report's grouping.
  const bandFamily: Record<string, string> = {
    "0": "frontend",
    "1": "unsupported",
    "2": "type",
    "3": "backend",
    "4": "library",
    "5": "ffi",
    "9": "internal",
  };
  for (const rule of allRules()) {
    expect(rule.family, rule.code).toBe(bandFamily[rule.code.slice(2, 3)]);
  }
});

test("SC2010-SC2013 are marked as the dynamic-engine alternative", () => {
  const dynamic = allRules().filter((rule) => rule.dynamicAlternative).map((rule) => rule.code);
  expect(dynamic).toEqual(["SC2010", "SC2011", "SC2012", "SC2013"]);
});

test("the linter depends only on the compiler's public entry point", () => {
  // A linter that reached into compiler internals could report a verdict the
  // installed compiler does not make. Every import is from "@scriptc/compiler".
  const sources = ["../src/engine.ts", "../src/report.ts", "../src/cli.ts"] as const;
  for (const relative of sources) {
    const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    for (const specifier of imports) {
      expect(
        specifier === "@scriptc/compiler" || specifier.startsWith(".") || specifier.startsWith("node:"),
        `${relative} imports ${specifier}`,
      ).toBe(true);
    }
  }
});

test("the compiler exposes analyze and compile as the linter's only entry points", () => {
  const text = readFileSync(compilerIndexPath, "utf8");
  expect(text).toMatch(/export function analyze\(/);
  expect(text).toMatch(/export async function compile\(/);
});
