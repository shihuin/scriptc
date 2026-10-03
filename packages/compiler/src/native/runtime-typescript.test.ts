import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { ts7Executable } from "../frontend/ts7/rpc-api.js";
import { emitRuntimeTypeScript } from "./runtime-typescript.js";

test("package emission handles enums, parameter properties, assertions and generic functions", () => {
  const emitted = emitRuntimeTypeScript(ts7Executable(), "/package/index.ts", `
    enum Kind { First = 7 }
    class Box { constructor(public value: number) {} }
    function identity<T>(value: T): T { return value; }
    export const result: number = identity(new Box(Kind.First).value as number);
  `, "cjs");
  const exports: Record<string, unknown> = {};
  new Function("exports", emitted)(exports);
  expect(exports["result"]).toBe(7);
});

test("CommonJS emission retains dynamic import conditions and emits import-equals requires", () => {
  const emitted = emitRuntimeTypeScript(ts7Executable(), "/package/index.cts", `
    import value = require("./value.cts");
    export const later = () => import("dual");
    export const result: number = value.result;
  `, "cjs");
  expect(emitted).toContain('require("./value.cts")');
  expect(emitted).toContain('import("dual")');
  expect(emitted).not.toContain('require("dual")');
});

test("ESM emission preserves unused value imports and removes explicitly type-only dependencies", () => {
  const emitted = emitRuntimeTypeScript(ts7Executable(), "/package/index.mts", `
    import type { Missing } from "missing-types";
    import { type Other, unused } from "./value.ts";
    export type { Missing } from "missing-types";
    export const result: number = 42;
  `, "esm");
  expect(emitted).toContain("unused");
  expect(emitted).toContain("./value.ts");
  expect(emitted).not.toContain("missing-types");
  execFileSync(process.execPath, ["--check", "--input-type=module"], { input: emitted });
});

test("syntax diagnostics retain the original module path, including dollar signs", () => {
  expect(() => emitRuntimeTypeScript(ts7Executable(), "/package/$module.mts",
    "export function broken(: number) {}", "esm")).toThrow("/package/$module.mts(");
});
