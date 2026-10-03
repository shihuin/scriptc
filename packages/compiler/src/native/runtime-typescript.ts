import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Both compiler hosts use the pinned native TypeScript emitter. Package
 * configuration, dependency resolution and execution remain outside this
 * isolated emit; the runtime graph resolves the emitted literal imports. */
export function emitRuntimeTypeScript(executable: string, path: string, source: string, format: "esm" | "cjs"): string {
  if (/\.d\.[cm]?ts$/.test(path)) throw new Error("declaration files cannot be embedded as runtime modules");
  if (path.endsWith(".tsx")) throw new Error("TSX runtime modules are not supported");
  const stage = mkdtempSync(join(tmpdir(), "scriptc-typescript-"));
  // Explicit suffixes retain the graph's module format independently of
  // the temporary directory's package scope. NodeNext also preserves
  // dynamic import() in CommonJS instead of changing its export condition.
  const input = format === "esm" ? "module.mts" : "module.cts";
  const output = join(stage, "output");
  try {
    mkdirSync(output);
    writeFileSync(join(stage, input), source);
    const config = join(stage, "tsconfig.json");
    writeFileSync(config, JSON.stringify({
      compilerOptions: {
        target: "esnext", module: "nodenext", moduleDetection: "legacy",
        noCheck: true, noResolve: true, types: [],
        isolatedModules: true, verbatimModuleSyntax: format === "esm",
        noEmitOnError: true, outDir: output,
      },
      files: [input], include: [],
    }));
    // Read the result directly: native subprocess exceptions intentionally
    // do not carry stdout, while spawnSync provides it in both hosts.
    const result = spawnSync(executable, ["--project", config, "--pretty", "false"], {
      encoding: "utf8", stdio: "pipe",
    });
    if (result.error || result.status !== 0 || result.signal !== null) {
      const diagnostic = (result.stdout ?? "").trim();
      // Diagnostic paths may be absolute or relative to the caller's cwd.
      // Replace each source-location prefix without interpreting the path
      // as a replacement template (package names can contain '$').
      const attributed = diagnostic.split(/\r?\n/).map((line) => {
        const at = line.indexOf(input + "(");
        return at < 0 ? line : path + line.slice(at + input.length);
      }).join("\n");
      throw new Error(diagnostic === "" ? "TypeScript emission failed" : attributed
        .replaceAll(stage, "<emit>")
        .replaceAll(stage.replaceAll("\\", "/"), "<emit>"));
    }
    try { return readFileSync(join(output, format === "esm" ? "module.mjs" : "module.cjs"), "utf8"); }
    catch { throw new Error("TypeScript emitter produced no JavaScript"); }
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
