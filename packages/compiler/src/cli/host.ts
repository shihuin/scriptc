import type { AnalyzeOptions, AnalyzeResult, CompileLibraryOptions, CompileLibraryResult, CompileRequestOptions, CompileRequestResult } from "../compile-types.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { ProvenanceSources } from "../frontend/provenance-registry.js";

/** One generated C-embedding file, named relative to the directory the
 * library artifact landed in. `text` is the artifact's content, not an
 * instruction to anyone else: writing files is the host's job exactly as it
 * is for `compileLibrary`, and the command layer only prints the names it
 * gets back. A host that reported a file it did not write would be lying to
 * the build log, so the two functions have the same obligation. */
export interface LibraryHeaderFile {
  name: string;
  text: string;
}

/** `scriptc build --lib --header`: generate the C surface of the archive
 * just built, INTO `outDir` (the artifact's directory), and return what was
 * written. The generator lives in the compiler's own embed module
 * (`@scriptc/compiler/embed`); the host supplies the call so the command
 * layer stays free of filesystem and module-loading policy. */
export type LibraryHeaderResult =
  | { ok: true; files: LibraryHeaderFile[] }
  | { ok: false; diagnostics: ScrDiagnostic[] };

export type NativeCacheWarmProfile = "runtime" | "tls" | "dynamic";

/** Only host operations vary between the seed and installed compiler. */
export interface CliHost {
  version: () => string;
  sourceTargetPlatform: () => string;
  analyze: (entry: string, options: AnalyzeOptions) => Promise<AnalyzeResult>;
  compile: (entry: string, options: CompileRequestOptions) => Promise<CompileRequestResult>;
  compileLibrary: (options: CompileLibraryOptions) => Promise<CompileLibraryResult>;
  /** Write the C header, shim, descriptor, and CMake fragment for a library
   * profile into `outDir`, and report the file names written. */
  emitLibraryHeader: (profilePath: string, outDir: string) => Promise<LibraryHeaderResult>;
  resolveProvenanceSources: (entry: string) => Promise<ProvenanceSources>;
  warmNativeCaches: (options: {
    optimization?: "release" | "dev";
    sanitize: boolean;
    profiles?: NativeCacheWarmProfile[];
  }) => Promise<{ cacheRoot: string; profiles: { profile: NativeCacheWarmProfile; elapsedMs: number }[] }>;
  run: (binary: string) => Promise<number>;
}
