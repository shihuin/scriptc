/* The ABI mapping's rules, pinned.
 *
 * Every case here is a spelling the emitter actually produces
 * (`packages/compiler/src/backend/llvm/emitter.ts`, the `lib.exports` loop).
 * The mapping is small enough to state exhaustively, and stating it
 * exhaustively is what keeps a generated header from inventing a convention.
 */

import { expect, test } from "vitest";
import {
  cTypeOf,
  declareParam,
  exportSignature,
  isCIdentifier,
  outParamsFor,
  paramsFor,
  returnsFor,
  sinkTypedefName,
  splitsInC,
  type AbiClass,
} from "@scriptc/compiler/embed";

test("every value class has exactly one C spelling", () => {
  const expected: Record<AbiClass, string> = {
    f64: "double",
    bool: "uint8_t",
    u8: "uint8_t",
    u32: "uint32_t",
    i32: "int32_t",
    i64: "int64_t",
    u64: "uint64_t",
    string: "const uint8_t *",
    bytes: "const uint8_t *",
    void: "void",
  };
  for (const cls of Object.keys(expected) as AbiClass[]) {
    expect(cTypeOf(cls), cls).toBe(expected[cls]);
  }
});

test("strings and bytes split into a pointer and a length", () => {
  expect(splitsInC("string")).toBe(true);
  expect(splitsInC("bytes")).toBe(true);
  for (const cls of ["f64", "bool", "u8", "u32", "i32", "i64", "u64", "void"] as AbiClass[]) {
    expect(splitsInC(cls), cls).toBe(false);
  }

  const params = paramsFor(["string", "bytes", "f64"]);
  expect(params.map((p) => p.name)).toEqual(["a0_ptr", "a0_len", "a1_ptr", "a1_len", "a2"]);
  expect(params.map((p) => p.type)).toEqual([
    "const uint8_t *",
    "size_t",
    "const uint8_t *",
    "size_t",
    "double",
  ]);
});

test("buffer returns become out-parameters, not return values", () => {
  for (const cls of ["string", "bytes"] as AbiClass[]) {
    const ret = returnsFor(cls);
    expect(ret.returns, cls).toBe("void");
    expect(ret.params.map((p) => p.name)).toEqual(["out", "out_len"]);
  }
  expect(returnsFor("f64")).toEqual({ returns: "double", params: [] });
  expect(returnsFor("void")).toEqual({ returns: "void", params: [] });
  // `out` is a pointer to pointer: the runtime hands back an arena pointer
  // (scr_library_str_out), it does not fill a host buffer.
  expect(outParamsFor().map((p) => p.type)).toEqual(["const uint8_t **", "size_t *"]);
});

test("a parameter is spelled `type name`, with no space after a pointer", () => {
  expect(declareParam({ cls: "f64", name: "a0", type: "double" })).toBe("double a0");
  expect(declareParam({ cls: "string", name: "a0_ptr", type: "const uint8_t *" })).toBe("const uint8_t *a0_ptr");
  expect(declareParam({ cls: "bytes", name: "out", type: "const uint8_t **" })).toBe("const uint8_t **out");
  expect(declareParam({ cls: "bytes", name: "out_len", type: "size_t *" })).toBe("size_t *out_len");
});

test("an export signature mirrors profile order and its return class", () => {
  const sig = exportSignature({
    export: "shout",
    symbol: "kb_shout",
    params: ["string", "u32"],
    returns: "string",
  });
  expect(sig.symbol).toBe("kb_shout");
  expect(sig.returns).toBe("void");
  expect(sig.params.map((p) => `${p.type}${p.type.endsWith("*") ? "" : " "}${p.name}`)).toEqual([
    "const uint8_t *a0_ptr",
    "size_t a0_len",
    "uint32_t a1",
    "const uint8_t **out",
    "size_t *out_len",
  ]);
});

test("the sink typedef is derived from the prefix", () => {
  // Only the naming rule is checkable without a profile; the header test
  // exercises the real thing.
  expect(sinkTypedefName({ prefix: "kt_" } as never)).toBe("kt_sink_fn");
});

test("C identifiers are enforced, not assumed", () => {
  expect(isCIdentifier("kt_add")).toBe(true);
  expect(isCIdentifier("_x9")).toBe(true);
  expect(isCIdentifier("9x")).toBe(false);
  expect(isCIdentifier("kt-add")).toBe(false);
  expect(isCIdentifier("")).toBe(false);
});
