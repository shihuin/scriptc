import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";

async function moduleFor(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-discarded-logical-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return deserializeModule(await readFile(output, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SOURCE = `
function attach(): void {
  console.log("attach");
}
function detach(): void {
  console.log("detach");
}
export function run(flags: number, mode: string): void {
  flags & 512 && (mode === "manual" ? attach() : detach());
}
export function plain(flags: number, mode: string): void {
  flags & 512 && attach();
  mode === "manual" || detach();
}
console.log("start");
run(512, "manual");
plain(512, "manual");
`;

test("a discarded logical whose arm is a void conditional lowers to control flow", async () => {
  // React's reconciler writes `flags & 512 && (mode === "manual" ? attach() :
  // detach())`. Both arms are void calls, so there is no value-shaped ternary
  // to build — the statement has to become `if (flags & 512) { ... }`. Before
  // the void check this was an internal compiler error: "ternary must not be
  // void".
  const module = await moduleFor(SOURCE);
  const run = module.functions.find((fn) => fn.name === "run");
  expect(run).toBeDefined();
  // The arm is a branch, not a ternary expression.
  const text = JSON.stringify(run!.body);
  expect(text).toContain('"kind":"if"');
  expect(text).not.toContain('"kind":"ternary"');
});

test("the plain void arms keep lowering to control flow too", async () => {
  const module = await moduleFor(SOURCE);
  const plain = module.functions.find((fn) => fn.name === "plain");
  expect(plain).toBeDefined();
  const kinds = JSON.stringify(plain!.body);
  expect(kinds).toContain('"kind":"if"');
});
