/* The library-mode C ABI, stated once.
 *
 * scriptc's library emission produces a static archive whose exported
 * functions are C-ABI wrappers around the compiled module's exports (see
 * `packages/compiler/src/backend/llvm/emitter.ts`, the `lib.exports` loop:
 * one LLVM `define` per profile export, plus the mode-provided entries).
 * What it never produced is the C DECLARATION of that surface: every embedder
 * has written its header by hand, and `tests/library-mode/scalars/probe.c`
 * is one such hand-written header.
 *
 * This module is the missing half. It maps a resolved `LibraryProfile` to the
 * C types and signatures the emitter actually generates, so a generated
 * header cannot disagree with the archive it declares. That property is the
 * whole point: `test/ir-audit.test.ts` compiles a fixture to LLVM IR and
 * asserts every signature here appears there verbatim, which is what makes a
 * generated header trustworthy rather than merely plausible.
 *
 * Boundaries (marshalling classes) are the profile's; C spellings are ours.
 * The mapping, exhaustively:
 *
 *   f64     double
 *   bool    uint8_t            (0/1; the wrapper compares against zero)
 *   u8      uint8_t
 *   u32     uint32_t
 *   i32     int32_t
 *   i64     int64_t
 *   u64     uint64_t
 *   string  const uint8_t *ptr, size_t len        (UTF-8 bytes, not NUL-terminated)
 *   bytes   const uint8_t *ptr, size_t len
 *
 *   returns f64/bool/u8/...  as above
 *   returns string/bytes     void, with `uint8_t *out, size_t *out_len`
 *                            appended (the wrapper copies into the host's
 *                            buffer and writes the length)
 *   returns void             void
 *
 * Why `uint8_t *` and not `char *` for strings: the ABI's string class is
 * length-carrying UTF-8, the same bytes as the bytes class. A `char *` in a
 * header invites `strlen` on a buffer that is not NUL-terminated, which is
 * exactly the bug a generated header should make impossible.
 *
 * Why `size_t` and not `uintptr_t`: the wrapper's length parameters are the
 * emission's pointer-sized integer, which is `size_t`'s definition on every
 * scriptc target, and it is what an embedder already has in hand.
 */

import type { LibraryProfile, LibraryExportEntry, LibraryCallbackEntry } from "@scriptc/compiler";

/** A parameter or return position's marshalling class. */
export type AbiClass =
  | "f64"
  | "bool"
  | "string"
  | "bytes"
  | "u8"
  | "u32"
  | "i32"
  | "i64"
  | "u64"
  | "void";

/** One C parameter. Split classes (`string`, `bytes`) contribute two. */
export interface CParam {
  /** The class this parameter came from. */
  cls: AbiClass;
  /** Parameter name, e.g. `a0_ptr` or `a1_len`. */
  name: string;
  /** C type spelling. */
  type: string;
}

/** A full C function signature. */
export interface CSignature {
  /** Symbol name exactly as the archive exports it. */
  symbol: string;
  /** Return type spelling, or `void`. */
  returns: string;
  params: CParam[];
  /** One line of embedder-facing documentation. */
  doc: string;
  /** Which part of the ABI this is, for grouping in the header. */
  group: "lifecycle" | "exports" | "callbacks" | "identity";
}

/** The C type for a class in a VALUE position (parameters, scalars). */
export function cTypeOf(cls: AbiClass): string {
  switch (cls) {
    case "f64":
      return "double";
    case "bool":
    case "u8":
      return "uint8_t";
    case "u32":
      return "uint32_t";
    case "i32":
      return "int32_t";
    case "i64":
      return "int64_t";
    case "u64":
      return "uint64_t";
    case "string":
    case "bytes":
      return "const uint8_t *";
    case "void":
      return "void";
  }
}

/** True for the classes that carry a length and therefore occupy two C
 * parameters. */
export function splitsInC(cls: AbiClass): boolean {
  return cls === "string" || cls === "bytes";
}

/** C parameters for one export's inbound class list. `%a<i>` in the emitter
 * becomes `<name>_ptr`/`<name>_len`; the generated names mirror that so a
 * reader can diff the header against the IR by eye. */
export function paramsFor(classes: readonly AbiClass[], names?: readonly string[]): CParam[] {
  const params: CParam[] = [];
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i]!;
    const base = names === undefined ? `a${i}` : names[i]!;
    if (splitsInC(cls)) {
      params.push({ cls: cls, name: `${base}_ptr`, type: cls === "string" ? "const uint8_t *" : "const uint8_t *" });
      params.push({ cls: cls, name: `${base}_len`, type: "size_t" });
      continue;
    }
    params.push({ cls: cls, name: base, type: cTypeOf(cls) });
  }
  return params;
}

/** A parameter as C: `type name`, with the space a pointer type does not
 * need. Shared by the header and the shim so the two cannot spell a parameter
 * differently. */
export function declareParam(p: CParam): string {
  return p.type.endsWith("*") ? `${p.type}${p.name}` : `${p.type} ${p.name}`;
}

/** The `(out, out_len)` pair an outbound string/bytes return appends.
 *
 * `out` is a POINTER TO POINTER, and that is not a stylistic choice: the
 * wrapper calls the runtime's `scr_library_str_out` / `scr_library_bytes_out`
 * (packages/runtime/src/scr_library.c), which hand the host a pointer into
 * the library's arena — `*out = s->data`. The library does not copy into a
 * host buffer, so a header declaring `uint8_t *out` would describe an ABI
 * that does not exist and an embedder following it would read its own
 * uninitialized memory. The value's lifetime is the arena's (see the
 * generated header's MEMORY section). */
export function outParamsFor(): CParam[] {
  return [
    { cls: "bytes", name: "out", type: "const uint8_t **" },
    { cls: "bytes", name: "out_len", type: "size_t *" },
  ];
}

/** The return type and trailing parameters for an export's return class. */
export function returnsFor(cls: AbiClass): { returns: string; params: CParam[] } {
  if (cls === "string" || cls === "bytes") return { returns: "void", params: outParamsFor() };
  return { returns: cTypeOf(cls), params: [] };
}

/** Every signature the archive exports, in header order. */
export function signaturesOf(profile: LibraryProfile): CSignature[] {
  const out: CSignature[] = [];

  out.push({
    symbol: profile.initSymbol,
    returns: "void",
    params: [],
    doc:
      "Initialize (or fully re-initialize) the instance: releases program globals, " +
      "resets the runtime and result arena, runs the module's top level, and delivers " +
      "any escaped exception to the panic sink. Call it once before any export.",
    group: "lifecycle",
  });

  out.push({
    symbol: profile.sinkRegisterSymbol,
    returns: "void",
    params: [
      { cls: "bytes", name: "fn", type: sinkTypedefName(profile) },
      { cls: "bytes", name: "ctx", type: "void *" },
    ],
    doc:
      "Register the panic sink (see the typedef above). `msg`/`len` are the structured " +
      "trap-teaching bytes and `addr` is the source address slot (0 when absent). Without a " +
      "sink, a trap is fatal to the process.",
    group: "lifecycle",
  });

  if (profile.collectSymbol !== null) {
    out.push({
      symbol: profile.collectSymbol,
      returns: "void",
      params: [],
      doc: "Run a full cycle collection (arena reset included). Safe to call between exports.",
      group: "lifecycle",
    });
  }

  if (profile.resultResetSymbol !== null) {
    out.push({
      symbol: profile.resultResetSymbol,
      returns: "void",
      params: [],
      doc:
        "Reset the result arena. The profile declares this, so results accumulate across " +
        "exports until the host resets them.",
      group: "lifecycle",
    });
  }

  if (profile.callbackRegisterSymbol !== null) {
    out.push({
      symbol: profile.callbackRegisterSymbol,
      returns: "int32_t",
      params: [
        { cls: "bytes", name: "name", type: "const uint8_t *" },
        { cls: "bytes", name: "fn", type: "void *" },
        { cls: "bytes", name: "ctx", type: "void *" },
      ],
      doc:
        "Register a host-callback channel by name (NUL-terminated UTF-8). Returns 0 on success, " +
        "-1 for an unknown name or a NULL name. See the per-channel typedefs below.",
      group: "callbacks",
    });
  }

  const sidecar = profile.sidecar;
  if (sidecar !== null) {
    out.push({
      symbol: sidecar.buildIdSymbol,
      returns: "uint64_t",
      params: [],
      doc:
        "The build id (u64). Reads with no runtime touch, so it is callable before init and " +
        "after a trap — that is its purpose: a host fences a stale archive before it calls in.",
      group: "identity",
    });
    out.push({
      symbol: sidecar.abiVersionSymbol,
      returns: "uint32_t",
      params: [],
      doc: "The profile's declared contract ABI version. Same no-touch guarantee as the build id.",
      group: "identity",
    });
  }

  for (const entry of profile.exports) {
    out.push(exportSignature(entry));
  }

  return out;
}

/** One export's C signature, mirroring the emitter's per-class lowering. */
export function exportSignature(entry: LibraryExportEntry): CSignature {
  const params = paramsFor(entry.params as AbiClass[]);
  const ret = returnsFor(entry.returns as AbiClass);
  return {
    symbol: entry.symbol,
    returns: ret.returns,
    params: [...params, ...ret.params],
    doc: `Export \`${entry.export}\` from the entry module.`,
    group: "exports",
  };
}

/** The inline C typedef a host writes its callback against: parameters are the
 * channel's declared classes converted for C, and every callback return rides
 * a double (the runtime hands the compiler a checked conversion). */
export function callbackTypedef(cb: LibraryCallbackEntry): { name: string; text: string } {
  const params = paramsFor(cb.params as AbiClass[]);
  const args = params
    .map((p) => (p.type.endsWith("*") ? `${p.type}${p.name}` : `${p.type} ${p.name}`))
    .join(", ");
  const ret = cTypeOf(cb.returns as AbiClass);
  const name = `${cb.name}_fn`;
  return {
    name: name,
    text: `typedef ${ret} (*${name})(${args === "" ? "void" : args});`,
  };
}

/** A C identifier check: the profile loader already enforces this for the
 * declared symbol names, and the generator refuses anything else so a header
 * cannot be emitted with an identifier the compiler would not accept. */
export function isCIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** The panic-sink handler type the sink registration takes. A typedef rather
 * than an inline `void (*)(...)` parameter: the header reads better, a host
 * can name the type, and the generator never has to wrap a prototype inside a
 * parameter list. */
export function sinkTypedefName(profile: LibraryProfile): string {
  return `${profile.prefix}sink_fn`;
}

/** The include guard for a profile, e.g. `SCRIPT_EMBED_KT_H`. */
export function includeGuard(profile: LibraryProfile, stem: string): string {
  const base = `${profile.prefix}${stem}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `SCRIPT_EMBED_${base}_H`;
}

/** The C symbol prefix a profile exposes, for the shim's own helpers. */
export function prefixOf(profile: LibraryProfile): string {
  return profile.prefix;
}
