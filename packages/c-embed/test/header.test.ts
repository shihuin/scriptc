/* Generated-file structure, against the repository's real library fixtures.
 *
 * These are the fixtures the library-mode harness already builds, so the
 * headers generated here describe artifacts that exist in this repo — not
 * invented profiles.
 */

import { join } from "node:path";
import { expect, test } from "vitest";
import { loadLibraryProfile, type LibraryProfile } from "@scriptc/compiler";
import {
  generateAll,
  generateDescriptor,
  generateHeader,
  generateShim,
  signaturesOf,
  stemOf,
} from "../src/index.js";

const repo = process.cwd();
const fixture = (name: string): LibraryProfile => {
  const loaded = loadLibraryProfile(join(repo, "tests/library-mode", name, "profile.json"));
  if (!loaded.ok) throw new Error(`fixture profile ${name} did not load`);
  return loaded.profile;
};

test("the scalars fixture header declares the lifecycle entries and exports", () => {
  const profile = fixture("scalars");
  const header = generateHeader(profile);
  expect(header).toContain("#include <stddef.h>");
  expect(header).toContain("#include <stdint.h>");
  expect(header).toContain("extern \"C\" {");
  expect(header).toContain("void kt_init(void);");
  expect(header).toContain("void kt_set_panic_sink(kt_sink_fn fn, void *ctx);");
  expect(header).toContain("typedef void (*kt_sink_fn)(void *ctx, const uint8_t *msg, size_t len, uint64_t addr);");
  expect(header).toContain("double kt_add(double a0, double a1);");
  expect(header).toContain("uint8_t kt_invert(uint8_t a0);");
  expect(header).toContain("double kt_plumb(uint8_t a0, uint32_t a1, int32_t a2);");
  // The profile declares no result reset, so the header must say results are
  // per-call.
  expect(header).toContain("resets the result arena on entry");
  expect(header).not.toContain("kt_reset");
});

test("the buffers fixture header carries out-parameters and a shim", () => {
  const profile = fixture("buffers");
  const header = generateHeader(profile);
  expect(header).toContain(
    "void kb_shout(const uint8_t *a0_ptr, size_t a0_len, const uint8_t **out, size_t *out_len);",
  );
  expect(header).toContain("double kb_strlen(const uint8_t *a0_ptr, size_t a0_len);");

  const shim = generateShim(profile);
  expect(shim).not.toBeNull();
  expect(shim).toContain("uint8_t *kb_shim_shout(const uint8_t *a0_ptr, size_t a0_len, size_t *out_len)");
  // The shim copies out of the arena: the library hands back a pointer, and
  // that pointer dies with the next export call.
  expect(shim).toContain("const uint8_t *borrowed = NULL;");
  expect(shim).toContain("kb_shout(a0_ptr, a0_len, &borrowed, out_len);");
  expect(shim).toContain("for (size_t i = 0; i < *out_len; i++) buffer[i] = borrowed[i];");
  // A buffer IN with a scalar return needs no wrapper: the caller already has
  // the pointer and the length.
  expect(shim).not.toContain("kb_shim_strlen");

  const files = generateAll(profile);
  expect(files.map((f) => f.name)).toEqual([
    "conformance_buffers.h",
    "conformance_buffers.c-embed.json",
    "conformance_buffers.cmake",
    "conformance_buffers-shim.h",
    "conformance_buffers-shim.c",
  ]);
});

test("the callbacks fixture declares one typedef per channel and a registration entry", () => {
  const profile = fixture("callbacks");
  const header = generateHeader(profile);
  expect(header).toContain("typedef void (*emitChunk_fn)(const uint8_t *a0_ptr, size_t a0_len, uint32_t a1);");
  expect(header).toContain("typedef int32_t (*progress_fn)(double a0, double a1);");
  expect(header).toContain("typedef uint32_t (*mix_fn)(uint8_t a0, int32_t a1);");
  expect(header).toContain("int32_t cb_set_callback(const uint8_t *name, void *fn, void *ctx);");
  // The declared result-reset entry appears, and the header changes its
  // memory story accordingly.
  expect(header).toContain("void cb_reset_results(void);");
  expect(header).toContain("Results accumulate");

  // Callbacks come before exports: the registration doc points forward to the
  // typedefs, and reading order should follow it.
  expect(header.indexOf("Host-callback channels")).toBeLessThan(header.indexOf("Exports (4)"));
});

test("a scalars-only profile gets no shim", () => {
  const profile = fixture("scalars");
  expect(generateShim(profile)).toBeNull();
  expect(generateAll(profile).map((f) => f.name)).toEqual([
    "conformance_scalars.h",
    "conformance_scalars.c-embed.json",
    "conformance_scalars.cmake",
  ]);
});

test("the descriptor mirrors the header surface for non-C embedders", () => {
  const profile = fixture("buffers");
  const document = JSON.parse(generateDescriptor(profile)) as {
    schema: string;
    prefix: string;
    results: string;
    signatures: { symbol: string; returns: string; params: { name: string; type: string }[] }[];
  };
  expect(document.schema).toBe("scriptc.c-embed.v1");
  expect(document.prefix).toBe("kb_");
  expect(document.results).toBe("reset-per-call");
  const shout = document.signatures.find((s) => s.symbol === "kb_shout");
  expect(shout?.returns).toBe("void");
  expect(shout?.params.map((p) => p.name)).toEqual(["a0_ptr", "a0_len", "out", "out_len"]);

  // The descriptor's signatures are the same list the header renders.
  expect(document.signatures.map((s) => s.symbol)).toEqual(signaturesOf(profile).map((s) => s.symbol));
});

test("the same profile produces byte-identical output (regenerable, diffable)", () => {
  const profile = fixture("callbacks");
  const first = generateAll(profile);
  const second = generateAll(profile);
  for (let i = 0; i < first.length; i++) {
    expect(second[i]!.text, first[i]!.name).toBe(first[i]!.text);
  }
  // No timestamps, no absolute paths.
  for (const file of first) {
    expect(file.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(file.text).not.toContain(repo);
  }
});

test("a stem overrides the file-name base without touching symbol names", () => {
  const profile = fixture("scalars");
  expect(stemOf(profile)).toBe("conformance_scalars");
  expect(stemOf(profile, "my_app")).toBe("my_app");
  const header = generateHeader(profile, { stem: "my_app" });
  expect(header).toContain("#ifndef SCRIPT_EMBED_KT_MY_APP_H");
  expect(header).toContain("void kt_init(void);");
});
