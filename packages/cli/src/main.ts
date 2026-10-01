import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, compile, compileLibrary, resolveProvenanceSources, sourceTargetPlatform, warmNativeCaches } from "@scriptc/compiler";
import { generateAll } from "@scriptc/compiler/embed";
import { loadLibraryProfile } from "@scriptc/compiler";
import { runCli } from "./command.js";

/** The version of the installed package. Read from the manifest rather than
 * baked in by the build, so a stamped release and a source checkout answer
 * the same way. */
function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/main.js at install time, src/main.ts under tsx: the manifest is
  // one level up from either.
  const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
  return manifest.version ?? "unknown";
}

process.exitCode = await runCli(process.argv.slice(2), {
  version, analyze: async (entry, options) => analyze(entry, options), compile, compileLibrary, resolveProvenanceSources, sourceTargetPlatform, warmNativeCaches,
  emitLibraryHeader: async (profilePath, outDir) => {
    const loaded = loadLibraryProfile(resolve(profilePath));
    if (!loaded.ok) return { ok: false, diagnostics: loaded.diagnostics };
    const files = generateAll(loaded.profile);
    for (const file of files) writeFileSync(join(outDir, file.name), file.text, "utf8");
    return { ok: true, files };
  },
  run: (binary) => new Promise<number>((resolveExit) => {
    let child;
    if (sourceTargetPlatform() === "wasi") {
      const builtRunner = fileURLToPath(new URL("./wasi-runner.js", import.meta.url));
      const runner = existsSync(builtRunner) ? builtRunner : fileURLToPath(new URL("./wasi-runner.ts", import.meta.url));
      child = spawn(process.execPath, [...process.execArgv, "--no-warnings", runner, binary], { stdio: "inherit" });
    } else child = spawn(binary, [], { stdio: "inherit" });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`scriptc: program killed by ${signal}\n`);
        resolveExit(1);
      } else resolveExit(code ?? 0);
    });
  }),
});
