/* The pure-declare table's invariants.
 *
 * Every entry lets LLVM reorder calls: `memory(none)` says the callee reads
 * and writes nothing, `memory(read)` says it only reads. A WRONG entry is a
 * miscompile, not a missed optimization, so this test pins the properties
 * the table's comment claims rather than its exact contents:
 *
 *   - every attribute is one LLVM accepts;
 *   - a helper that READS the array is never `memory(none)`;
 *   - symbols that allocate, write, throw, or do I/O never appear;
 *   - every `scr_*` key names a symbol the runtime actually declares (a
 *     typo is otherwise a silent no-op — `scr_math_sign` and a misspelled
 *     `scr_math_hypot` were both dead here);
 *   - every bare name is a C math function the one-to-one surface emits.
 *
 * The emission cases at the end prove the table is actually applied: a
 * table member's declare carries the attribute and an unmarked call keeps
 * the conservative spelling.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { emitLlvmModule } from "./emitter.js";
import { PURE_DECLARE_MEMORY } from "./lib-shared.js";
import { DYN, F64, STRING, VOID, type IrExpr, type IrLibFn, type IrModule, type IrType } from "../../ir/ir.js";

const runtimeHeader = readFileSync(
  join(import.meta.dirname, "../../../../runtime/src/scr_runtime.h"),
  "utf8",
);

const entries = Object.entries(PURE_DECLARE_MEMORY);
const runtimeKeys = entries.filter(([name]) => name.startsWith("scr_"));

/** The libm names the one-to-one math surface emits directly. */
const LIBM_MATH_NAMES = new Set([
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
  "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  "exp", "expm1", "log", "log1p", "log2", "log10",
  "sqrt", "cbrt", "pow", "fmod", "fabs", "hypot",
]);

/** Symbols that must never be attributed: they allocate, write, throw, or do
 * I/O (or hand back pointers into memory they own). */
const MUST_STAY_UNMARKED = [
  "scr_arr_push_ref", "scr_arr_set_undefined", "scr_arr_new",
  "scr_str_concat", "scr_str_release", "scr_str_new",
  "scr_dyn_new_num", "scr_dyn_new_str", "scr_dyn_release", "scr_dyn_key_set",
  "scr_console_log", "scr_error_new", "scr_throw_error_msg", "scr_trap",
  "malloc", "free", "realloc", "memcpy", "memset",
];

test("every attribute is one LLVM accepts", () => {
  for (const [name, attr] of entries) {
    expect(["memory(none)", "memory(read)"], `${name} -> ${attr}`).toContain(attr);
  }
});

test("array readers are memory(read), never memory(none)", () => {
  // These read the array header/elements. `memory(none)` would let LICM hoist
  // a length or a min/max fold past a push that changes it.
  for (const name of [
    "scr_arr_len", "scr_arr_get_f64",
    "scr_math_min_arr", "scr_math_max_arr", "scr_math_hypot_arr",
  ]) {
    expect(PURE_DECLARE_MEMORY[name], `${name} must be attributed`).toBe("memory(read)");
  }
});

test("effectful symbols stay unmarked", () => {
  for (const name of MUST_STAY_UNMARKED) {
    expect(PURE_DECLARE_MEMORY[name], `${name} must not be attributed`).toBeUndefined();
  }
});

test("every scr_ key is a symbol the runtime declares", () => {
  expect(runtimeKeys.length).toBeGreaterThan(0);
  for (const [name] of runtimeKeys) {
    expect(new RegExp(`\\b${name}\\b`).test(runtimeHeader), `${name} is not declared in scr_runtime.h`).toBe(true);
  }
});

test("every bare key is a C math function the math surface emits", () => {
  for (const [name] of entries) {
    if (name.startsWith("scr_")) continue;
    expect(LIBM_MATH_NAMES.has(name), `${name} is not a one-to-one math name`).toBe(true);
  }
});

const loc = { file: "lib-shared.test.ts", start: 0, end: 0 };

function moduleWithLibCall(fn: IrLibFn, args: IrExpr[], type: IrType): IrModule {
  return {
    irVersion: 13,
    sourceFile: loc.file,
    entry: "__main",
    functions: [{
      name: "__main",
      params: [],
      returnType: VOID,
      locals: [],
      body: [{ kind: "exprStmt", expr: { kind: "libCall", fn, args, type, loc }, loc }],
      loc,
    }],
  };
}

const declareOf = (llvm: string, symbol: string): string => {
  const line = llvm.split("\n").find((l) => l.startsWith("declare") && l.includes(`@${symbol}(`));
  expect(line, `no declare for ${symbol}`).toBeDefined();
  return line!;
};

test("a table member's declare carries its attribute", () => {
  const llvm = emitLlvmModule(moduleWithLibCall("math.sin", [{ kind: "numLit", value: 0.5, type: F64, loc }], F64));
  expect(declareOf(llvm, "sin")).toBe("declare double @sin(double) memory(none)");
});

test("an unmarked call keeps the conservative spelling", () => {
  // dyn.fromEntries allocates: it must stay an unknown-effect barrier.
  const arg: IrExpr = { kind: "dynFrom", value: { kind: "strLit", value: "v", type: STRING, loc }, type: DYN, loc };
  const llvm = emitLlvmModule(moduleWithLibCall("dyn.fromEntries", [arg], DYN));
  const declare = declareOf(llvm, "scr_dyn_from_entries");
  expect(declare).not.toContain("memory(");
});
