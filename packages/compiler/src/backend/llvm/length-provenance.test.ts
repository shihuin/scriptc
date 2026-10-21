import { expect, test } from "vitest";
import { compile } from "../../index.js";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function llvmFor(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-length-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "llvm" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return await readFile(output, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an index derived from a length never round-trips through a double", async () => {
  // A length is a proven u32, so `values.length - 1` is computed in integers.
  // Before this, the length became a double and the index conversion turned it
  // straight back, costing a sitofp/fptosi pair on every element access.
  const llvm = await llvmFor(`
export function last(values: number[]): number {
  return values[values.length - 1]!;
}
console.log(last([1, 2, 3]));
`);
  // The subtraction consumes the loaded word directly, with no fptosi
  // between the zext and the sub.
  const zext = /(%\w+) = zext i32 %\w+ to i64/.exec(llvm);
  expect(zext).not.toBeNull();
  const after = llvm.slice(zext!.index);
  const sub = /sub nsw i64 (%\w+), 1/.exec(after);
  expect(sub).not.toBeNull();
  expect(sub![1]).toBe(zext![1]);
  expect(after.slice(0, sub!.index)).not.toContain("fptosi");
});
