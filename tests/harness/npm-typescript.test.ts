import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { compile } from "@scriptc/compiler";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dirname, "../..");
const fixtures = join(root, "tests/fixtures/npm");
const entry = join(fixtures, "typescript/main.ts");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("embedded TypeScript packages match Node type stripping outside node_modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-typescript-runtime-"));
  try {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    // Node refuses TypeScript under node_modules. Copy the identical source
    // bytes into a regular module scope for its built-in stripping oracle.
    cpSync(join(fixtures, "node_modules/tsruntime"), join(dir, "runtime"), { recursive: true });
    const reference = join(dir, "reference.ts");
    writeFileSync(reference, readFileSync(entry, "utf8")
      .replace('"tsruntime"', '"./runtime/index.ts"')
      .replace('"tsruntime/common"', '"./runtime/common.cts"'));
    const built = await compile(entry, { outDir: dir, outPath: join(dir, "program"), dynamic: true, sanitize });
    if (!built.ok) throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const [node, native] = await Promise.all([
      execFileAsync(process.execPath, [reference], { encoding: "utf8" }),
      execFileAsync(built.binaryPath, [], { encoding: "utf8" }),
    ]);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stdout).toBe("type-specifier-side-effect\nunused-import-side-effect\ntype-export-side-effect\n42:42:7\n");
    expect(node.stderr).toBe("");
    expect(sanitize ? native.stderr.replace(
      /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm, "",
    ) : native.stderr).toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
