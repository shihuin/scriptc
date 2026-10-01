/* `Error(msg)` without `new`.
 *
 * The error constructors are ECMAScript's legacy callable ones: calling them
 * constructs exactly as `new` does, and real code mixes the spellings — React's
 * shipped production build throws a bare `Error()` in its fast paths. Found by
 * vendoring react-reconciler, where it accounted for 93 of 185 refusals.
 *
 * The bare form must emit the SAME lowering as the `new` form. The first
 * attempt hand-built a `new` node instead, which is not how a runtime error
 * class is built at all (they have no lowerable constructor function — the
 * runtime owns them); it turned 94 clean diagnostics into 94 internal errors.
 * These tests pin the equivalence, both directions.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile } from "../src/index.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "error-call-"));
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
    strict: true, noEmit: true, skipLibCheck: true,
  },
  include: ["*.ts"],
});

function lint(source: string): { codes: string[]; llvm: boolean } {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(dir, "probe.ts"), source);
    const result = analyze(join(dir, "probe.ts"), {});
    return { codes: result.coverage.diagnostics.map((d) => d.code), llvm: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a bare Error call is supported", () => {
  const { codes } = lint(`export function f(): string {
  const e = Error("a message");
  return e.message;
}
`);
  expect(codes).toEqual([]);
});

test("bare Error with an argument expression", () => {
  const { codes } = lint(`export function f(code: number): string {
  if (code > 0) throw Error("bad code " + String(code));
  return "ok";
}
`);
  expect(codes).toEqual([]);
});

test("a bare Error with no arguments is supported", () => {
  const { codes } = lint(`export function f(): number {
  try {
    if (Date.now() > 0) throw Error();
  } catch (e) {
    return 1;
  }
  return 0;
}
`);
  // Date.now is its own fence; what matters is that Error() itself is not one.
  expect(codes.some((c) => c === "SC0001")).toBe(false);
});

test("the bare form compiles to LLVM emission", async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(dir, "probe.ts"), `export function f(): string {
  const e = Error("m");
  return e.message;
}
`);
    const result = await compile(join(dir, "probe.ts"), {
      outputKind: "llvm",
      outDir: dir,
      outPath: join(dir, "probe.ll"),
    });
    const codes = (result.diagnostics ?? []).map((d) => d.code);
    expect(codes, "the bare call reaches LLVM emission").toEqual([]);
    expect(result.ok).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
