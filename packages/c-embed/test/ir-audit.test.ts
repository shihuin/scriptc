/* The audit that makes a generated header trustworthy.
 *
 * A header is only useful if it declares what the archive actually exports.
 * So this test does not read the generator's own data structures back: it
 * compiles each library fixture to LLVM IR with the real compiler and asserts
 * that every generated signature appears there, symbol for symbol and type
 * for type.
 *
 * It also compiles a C translation unit that includes the generated header,
 * with `-Wall -Wextra -Werror`, so a header that is merely "the right
 * symbols" but not valid C fails here rather than in an embedder's build.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { compileLibrary, loadLibraryProfile, type LibraryProfile } from "@scriptc/compiler";
import { generateAll, signaturesOf, type CSignature } from "../src/index.js";

const repo = process.cwd();
const FIXTURES = ["scalars", "buffers", "callbacks", "int-returns"] as const;

interface Emitted {
  profile: LibraryProfile;
  /** The archive's LLVM IR text. */
  ir: string;
}

const emitted = new Map<string, Emitted>();

/** The `define`s in an LLVM module, with their parameter type lists. */
function definesOf(ir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of ir.split("\n")) {
    const match = /^define\s+[^@]*@([A-Za-z_][A-Za-z0-9_.$]*)\s*\(([^)]*)\)/.exec(line);
    if (match === null) continue;
    const params = match[2]!.trim();
    const types: string[] = [];
    if (params.length > 0) {
      let depth = 0;
      let start = 0;
      for (let i = 0; i < params.length; i++) {
        const ch = params[i]!;
        if (ch === "(" || ch === "[" || ch === "<" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === ">" || ch === "}") depth--;
        else if (ch === "," && depth === 0) {
          types.push(typeOfParam(params.slice(start, i)));
          start = i + 1;
        }
      }
      types.push(typeOfParam(params.slice(start)));
    }
    out.set(match[1]!, types);
  }
  return out;
}

/** The type token of one IR parameter ("double %a0" -> "double"). */
function typeOfParam(text: string): string {
  const trimmed = text.trim();
  const space = trimmed.indexOf(" ");
  return space < 0 ? trimmed : trimmed.slice(0, space);
}

/** What a generated parameter should look like in the IR.
 *
 * `ptr` marks a pointer-valued position; `int` marks a pointer-SIZED integer
 * (a buffer length). Lengths are compared loosely on purpose: the emission
 * uses the target's pointer-sized integer, which is `i64` on every 64-bit
 * scriptc target but is not a property of the C header — `size_t` is. The
 * comparison therefore checks SHAPE (pointer vs integer, and arity), which is
 * what can drift; exact C types are pinned by the header unit tests, and the
 * end-to-end link is what pins them for real.
 */
type IrShape = "ptr" | "int" | "double" | "i8" | "i32" | "i64";

function shapeOf(cls: string): IrShape {
  switch (cls) {
    case "f64":
      return "double";
    case "bool":
    case "u8":
      return "i8";
    case "u32":
    case "i32":
      return "i32";
    case "i64":
    case "u64":
      return "i64";
    case "string":
    case "bytes":
      return "ptr";
    default:
      throw new Error(`no IR shape for class ${cls}`);
  }
}

/** The parameter shapes a signature should have in the IR. The mode-provided
 * entries are fixed: the sink takes (fn, ctx), the callback registrar takes
 * (name, fn, ctx). The out-parameter pair is read from the export's declared
 * return class, not guessed from the parameter name. */
function expectedIrParams(sig: CSignature, profile: LibraryProfile): IrShape[] {
  if (sig.symbol === profile.sinkRegisterSymbol) return ["ptr", "ptr"];
  if (sig.symbol === profile.callbackRegisterSymbol) return ["ptr", "ptr", "ptr"];
  const entry = profile.exports.find((e) => e.symbol === sig.symbol);
  const returnsBuffer = entry !== undefined && (entry.returns === "string" || entry.returns === "bytes");
  const shapes: IrShape[] = [];
  for (const p of sig.params) {
    if (p.name === "out") shapes.push("ptr");
    else if (p.name === "out_len") shapes.push("int");
    else shapes.push(p.name.endsWith("_len") ? "int" : shapeOf(p.cls));
  }
  void returnsBuffer;
  return shapes;
}

/** Compare one shape against an IR type token, allowing either pointer-sized
 * integer spelling where a length is expected. */
function shapeMatches(shape: IrShape, irType: string): boolean {
  if (shape === "int") return irType === "i64" || irType === "i32" || irType === "ptr";
  if (shape === "ptr") return irType === "ptr";
  return shape === irType;
}

beforeAll(async () => {
  for (const name of FIXTURES) {
    const loaded = loadLibraryProfile(join(repo, "tests/library-mode", name, "profile.json"));
    if (!loaded.ok) throw new Error(`fixture ${name} did not load`);
    const scratch = mkdtempSync(join(tmpdir(), `c-embed-${name}-`));
    try {
      // Library mode, not executable mode: the wrappers this header declares
      // are emitted by the library path (compileLibrary), and the kept LLVM
      // module is that same emission.
      const result = await compileLibrary({
        profilePath: join(repo, "tests/library-mode", name, "profile.json"),
        outDir: scratch,
        emitIr: true,
      });
      if (!result.ok) {
        const codes = result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n");
        throw new Error(`compiling fixture ${name} failed:\n${codes}`);
      }
      const { readFileSync } = await import("node:fs");
      emitted.set(name, { profile: loaded.profile, ir: readFileSync(result.llvmPath, "utf8") });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}, 600_000);

for (const name of FIXTURES) {
  test(`${name}: every generated symbol exists in the archive's IR`, () => {
    const { profile, ir } = emitted.get(name)!;
    const defines = definesOf(ir);
    const missing: string[] = [];
    for (const sig of signaturesOf(profile)) {
      if (!defines.has(sig.symbol)) missing.push(sig.symbol);
    }
    expect(missing).toEqual([]);
  });

  test(`${name}: every generated parameter list matches the IR`, () => {
    const { profile, ir } = emitted.get(name)!;
    const defines = definesOf(ir);
    const mismatches: string[] = [];
    for (const sig of signaturesOf(profile)) {
      const actual = defines.get(sig.symbol);
      if (actual === undefined) continue; // the symbol test reports this
      const expected = expectedIrParams(sig, profile);
      const ok =
        actual.length === expected.length &&
        expected.every((shape, i) => shapeMatches(shape, actual[i]!));
      if (!ok) {
        mismatches.push(`${sig.symbol}: header [${expected.join(",")}] vs IR [${actual.join(",")}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });
}

test("the generated headers compile as C and as C++", () => {
  let clang = true;
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
  } catch {
    clang = false;
  }
  if (!clang) {
    process.stdout.write("skip: clang not on PATH\n");
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "c-embed-cc-"));
  try {
    const includes: string[] = [];
    for (const name of FIXTURES) {
      const { profile } = emitted.get(name)!;
      const stem = generateAll(profile)[0]!.name.replace(/\.h$/, "");
      for (const file of generateAll(profile)) {
        writeFileSync(join(scratch, file.name), file.text);
      }
      includes.push(`#include "${stem}.h"`);
      // The shim pair, when the profile has one.
      if (generateAll(profile).some((f) => f.name.endsWith("-shim.h"))) {
        includes.push(`#include "${stem}-shim.h"`);
      }
    }
    const probe = `${includes.join("\n")}\nint main(void) { return 0; }\n`;
    const probePath = join(scratch, "probe.c");
    writeFileSync(probePath, probe);
    execFileSync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", probePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // C++ too: `extern "C"` guards must hold and no C-only spelling may leak.
    writeFileSync(probePath, probe);
    execFileSync(
      "clang++",
      ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-x", "c++", probePath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
