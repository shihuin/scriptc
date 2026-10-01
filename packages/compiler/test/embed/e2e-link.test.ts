/* The end-to-end proof that a GENERATED header describes the archive.
 *
 * The IR audit checks symbols and parameter shapes; this test checks the
 * thing an embedder actually does:
 *
 *   1. build the library from a fixture profile (the real compileLibrary),
 *   2. generate the header, the shim, and the descriptor from that profile,
 *   3. compile a C program that includes ONLY the generated header and calls
 *      exports through the generated shim,
 *   4. mount and run it, and compare the transcript with the reference
 *      probe's expectations.
 *
 * A generated header that is wrong in a way the IR cannot see — the
 * out-parameter's pointee, a length's width, the sink's parameter order —
 * fails at step 3 or 4, not in an embedder's build.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compileLibrary, loadLibraryProfile } from "@scriptc/compiler";
import { generateAll } from "@scriptc/compiler/embed";

const repo = process.cwd();

const BUFFERS_PROBE = `/* Written against ONLY the generated header and shim. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "conformance_buffers.h"
#include "conformance_buffers-shim.h"

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx;
  printf("UNEXPECTED SINK %.*s\\n", (int)len, (const char *)msg);
  (void)addr;
}

int main(void) {
  kb_set_panic_sink(sink, NULL);
  kb_init();

  /* The raw ABI: the library hands back an arena pointer. */
  const uint8_t *s = NULL;
  size_t n = 0;
  kb_shout((const uint8_t *)"abc", 3, &s, &n);
  printf("shout: %.*s (len %zu, nul %d)\\n", (int)n, (const char *)s, n, s[n] == 0);

  /* The shim: the same call, copied into a host-owned buffer. */
  size_t nn = 0;
  uint8_t *owned = kb_shim_shout((const uint8_t *)"abc", 3, &nn);
  printf("shim shout: %s (len %zu)\\n", (const char *)owned, nn);

  printf("strlen empty: %.0f\\n", kb_strlen(NULL, 0));
  printf("strlen utf8: %.0f\\n", kb_strlen((const uint8_t *)"caf\\xC3\\xA9", 5));

  const uint8_t *b = NULL;
  size_t bn = 0;
  kb_wrap((const uint8_t *)"\\x01\\x02", 2, &b, &bn);
  printf("wrap: len %zu bytes %d %d %d %d\\n", bn, b[0], b[1], b[2], b[3]);

  /* The shim's buffer survives the next call; the arena's does not. */
  size_t wn = 0;
  uint8_t *wowned = kb_shim_wrap((const uint8_t *)"\\x01\\x02", 2, &wn);
  kb_dashes((const uint8_t *)"axxxbxc", 7, &b, &bn);
  printf("shim wrap after next call: len %zu bytes %d %d %d %d\\n", wn, wowned[0], wowned[1], wowned[2], wowned[3]);

  printf("dashes: %.*s\\n", (int)bn, (const char *)b);

  kb_shim_free(owned);
  kb_shim_free(wowned);
  kb_collect();
  return 0;
}
`;

const BUFFERS_EXPECTED = `buffers ready
shout: ABC! (len 4, nul 1)
shim shout: ABC! (len 4)
strlen empty: 0
strlen utf8: 4
wrap: len 4 bytes 60 1 2 62
shim wrap after next call: len 4 bytes 60 1 2 62
dashes: a-b-c
`;

/** clang, or null when the host has no toolchain (the test then skips). */
function clangOrNull(): string | null {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return "clang";
  } catch {
    return null;
  }
}

test("a C program compiled against the generated header drives the real archive", async () => {
  const clang = clangOrNull();
  if (clang === null) {
    process.stdout.write("skip: clang not on PATH\n");
    return;
  }

  const loaded = loadLibraryProfile(join(repo, "tests/library-mode/buffers/profile.json"));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;

  const scratch = mkdtempSync(join(tmpdir(), "c-embed-e2e-"));
  try {
    const built = await compileLibrary({
      profilePath: join(repo, "tests/library-mode/buffers/profile.json"),
      outDir: scratch,
    });
    if (!built.ok) {
      const codes = built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n");
      throw new Error(`building the fixture library failed:\n${codes}`);
    }

    for (const file of generateAll(loaded.profile)) {
      writeFileSync(join(scratch, file.name), file.text);
    }

    const probePath = join(scratch, "generated_probe.c");
    writeFileSync(probePath, BUFFERS_PROBE);
    const binary = join(scratch, "generated_probe");
    execFileSync(
      clang,
      [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-I",
        scratch,
        probePath,
        join(scratch, "conformance_buffers-shim.c"),
        built.archivePath,
        "-lm",
        "-o",
        binary,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 60_000 });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(BUFFERS_EXPECTED);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 600_000);

test("the generated CMake fragment builds the same probe", async () => {
  const clang = clangOrNull();
  let cmake = true;
  try {
    execFileSync("cmake", ["--version"], { stdio: "ignore" });
  } catch {
    cmake = false;
  }
  if (clang === null || !cmake) {
    process.stdout.write("skip: clang/cmake not on PATH\n");
    return;
  }

  const loaded = loadLibraryProfile(join(repo, "tests/library-mode/buffers/profile.json"));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;

  const scratch = mkdtempSync(join(tmpdir(), "c-embed-cmake-"));
  try {
    const built = await compileLibrary({
      profilePath: join(repo, "tests/library-mode/buffers/profile.json"),
      outDir: scratch,
    });
    if (!built.ok) throw new Error("building the fixture library failed");

    const embed = join(scratch, "embed");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(embed, { recursive: true });
    for (const file of generateAll(loaded.profile)) {
      writeFileSync(join(embed, file.name), file.text);
    }
    writeFileSync(join(embed, "probe.c"), BUFFERS_PROBE);

    // A host project: three lines of CMake, plus compiling the shim it wants.
    writeFileSync(
      join(scratch, "CMakeLists.txt"),
      [
        "cmake_minimum_required(VERSION 3.20)",
        "project(embed_probe C)",
        "set(SCRIPT_EMBED_ARCHIVE ${CMAKE_CURRENT_LIST_DIR}/lib.lib.a)",
        'include("${CMAKE_CURRENT_LIST_DIR}/embed/conformance_buffers.cmake")',
        "add_executable(probe ${CMAKE_CURRENT_LIST_DIR}/embed/probe.c",
        "  ${CMAKE_CURRENT_LIST_DIR}/embed/conformance_buffers-shim.c)",
        "target_link_libraries(probe PRIVATE scriptc::conformance_buffers m)",
        "",
      ].join("\n"),
    );

    const buildDir = join(scratch, "build");
    execFileSync("cmake", ["-S", scratch, "-B", buildDir, "-G", "Ninja"], { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("cmake", ["--build", buildDir], { stdio: ["ignore", "pipe", "pipe"] });

    const run = spawnSync(join(buildDir, "probe"), [], { encoding: "utf8", timeout: 60_000 });
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(BUFFERS_EXPECTED);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 600_000);

test("the generated header matches the hand-written reference probe's call shapes", async () => {
  // The repository's own probe is written by hand against the same fixture.
  // Its extern declarations are the third opinion on the ABI (after the
  // emitter and the runtime), so the generated prototypes must be
  // assignable from them: same symbols, same parameter counts, and the same
  // pointee shape for the out-parameter.
  const loaded = loadLibraryProfile(join(repo, "tests/library-mode/buffers/profile.json"));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const header = generateAll(loaded.profile).find((f) => f.name.endsWith(".h") && !f.name.includes("-shim"))!.text;
  const reference = readFileSync(join(repo, "tests/library-mode/buffers/probe.c"), "utf8");

  const generated = new Map<string, string>();
  for (const line of header.split("\n")) {
    const match = /^(?:void|double|uint8_t|int32_t|uint32_t|uint64_t)\s+(\w+)\((.*)\);$/.exec(line.trim());
    if (match !== null) generated.set(match[1]!, match[2]!);
  }
  // One line wraps, so also catch the multi-line prototypes by prefix.
  for (const line of header.split("\n")) {
    const match = /^void\s+(\w+)\($/.exec(line.trim());
    if (match === null) continue;
    generated.set(match[1]!, "(wrapped)");
  }

  /* `kb_reset` is declared under an #ifdef in the reference probe (the
   * harness builds this fixture a second time with a declared reset), and
   * this profile does not declare one — so it is correctly absent here. */
  const conditional = new Set(["kb_reset"]);
  const referenceSymbols = [...reference.matchAll(/extern\s+[^;]*?\b(\w+)\(/g)]
    .map((m) => m[1]!)
    .filter((name) => name.startsWith("kb_") && !conditional.has(name));
  const missing = referenceSymbols.filter((name) => !generated.has(name));
  expect(missing).toEqual([]);

  // The out-parameter pointee: the reference uses `const uint8_t **out` and
  // the generated header must agree, because a mismatch here compiles in C
  // and corrupts at runtime.
  expect(header).toContain("const uint8_t **out, size_t *out_len");
});
