/* `scriptc build --lib --header`: the flag, the host hook, and the files.
 *
 * The command line is the interface an embedder actually uses, and it has two
 * halves that can drift apart: the flag plumbing in `command.ts` and the
 * generator behind the host hook. This test drives the real `runCli` with the
 * real compileLibrary and a real profile, so both halves are exercised
 * together, then checks the files that landed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runCli } from "../../src/cli/command.js";
import type { CliHost } from "../../src/cli/host.js";
import { generateAll } from "../../src/embed/index.js";
import { compileLibrary, loadLibraryProfile } from "../../src/index.js";

const repo = process.cwd();

/* `runCli` writes to the process streams by design (it is the CLI), so the
 * test captures them rather than restructuring the command layer for
 * testability. Scoped per test: vitest's reporter writes on its own thread of
 * control, and nothing else here writes during these windows. */
let stdout = "";
let stderr = "";
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdout = "";
  stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
});

/** The operations these cases actually reach; anything else fails loudly. */
function host(profilePath: string, outDir: string): CliHost {
  const notUsed = (name: string) => (): never => {
    throw new Error(`host.${name} should not be called by this case`);
  };
  return {
    version: () => "0.0.0-test",
    sourceTargetPlatform: () => process.platform === "darwin" ? "darwin" : "linux",
    analyze: notUsed("analyze"),
    compile: notUsed("compile"),
    resolveProvenanceSources: notUsed("resolveProvenanceSources"),
    warmNativeCaches: notUsed("warmNativeCaches"),
    run: notUsed("run"),
    compileLibrary: (options) =>
      compileLibrary({
        profilePath,
        outDir: options.outDir ?? outDir,
        ...(options.outPath === undefined ? {} : { outPath: options.outPath }),
      }),
    emitLibraryHeader: async (path, dir) => {
      const loaded = loadLibraryProfile(path);
      if (!loaded.ok) return { ok: false, diagnostics: loaded.diagnostics };
      const files = generateAll(loaded.profile);
      for (const file of files) writeFileSync(join(dir, file.name), file.text, "utf8");
      return { ok: true, files };
    },
  };
}

test("--header is rejected outside a library build", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "cli-header-guard-"));
  try {
    const status = await runCli(
      ["build", join(repo, "tests/corpus/400-fib.ts"), "--header", "--out", join(scratch, "out")],
      host(join(repo, "tests/library-mode/scalars/profile.json"), scratch),
    );
    expect(status).toBe(1);
    expect(stderr).toContain("--header is a library-build option");
    // Loud, not silent: the message names the flag and where it belongs.
    expect(stderr).toContain("scriptc build --lib");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 300_000);

test("--lib --header writes the C embedding beside the archive", async () => {
  const profilePath = join(repo, "tests/library-mode/buffers/profile.json");
  const scratch = mkdtempSync(join(tmpdir(), "cli-header-lib-"));
  try {
    const outPath = join(scratch, "libbuf.a");
    const status = await runCli(
      ["build", "--lib", "--profile", profilePath, "--out", outPath, "--header"],
      host(profilePath, scratch),
    );
    expect(status).toBe(0);

    const printed = stdout.trim().split("\n");
    expect(printed[0]).toBe(outPath);
    // The generated file names are printed, so an embedder can read the list
    // from the build log and --check the same set in CI.
    for (const name of [
      "conformance_buffers.h",
      "conformance_buffers.c-embed.json",
      "conformance_buffers.cmake",
      "conformance_buffers-shim.h",
      "conformance_buffers-shim.c",
    ]) {
      expect(printed).toContain(join(scratch, name));
    }

    const header = readFileSync(join(scratch, "conformance_buffers.h"), "utf8");
    expect(header).toContain("void kb_init(void);");
    // The out-parameter shape the runtime actually implements.
    expect(header).toContain("void kb_shout(const uint8_t *a0_ptr, size_t a0_len, const uint8_t **out, size_t *out_len);");
    // And the shim that copies out of the arena.
    expect(readFileSync(join(scratch, "conformance_buffers-shim.c"), "utf8")).toContain(
      "kb_shout(a0_ptr, a0_len, &borrowed, out_len);",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 600_000);

test("without --header the library build prints only the archive", async () => {
  const profilePath = join(repo, "tests/library-mode/scalars/profile.json");
  const scratch = mkdtempSync(join(tmpdir(), "cli-header-off-"));
  try {
    const outPath = join(scratch, "libscalars.a");
    const status = await runCli(
      ["build", "--lib", "--profile", profilePath, "--out", outPath],
      host(profilePath, scratch),
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(outPath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 600_000);
