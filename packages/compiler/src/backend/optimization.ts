/** Native optimization postures.
 *
 * - `release` (default): -O2 program code against the release runtime flavor,
 *   with retain/release fast paths inlined (see `perf/inline-rc-release`: on
 *   this suite that is -1.5% geomean, with the largest win on the
 *   interpreter-shaped workload).
 * - `dev`: -O0, source line tables, and cached object shards. Retain/release
 *   stay out-of-line calls so unoptimized builds remain readable.
 * - `speed`: -O2 plus optimizations that trade binary size and build time for
 *   run-time speed (a size-for-speed runtime flavor and runtime bitcode
 *   import). Release output never depends on those.
 *
 * Speed is an optimized posture everywhere release is: it shares -O2, release
 * linker flags, and release-only program partitioning. Cache keys spell it
 * out so speed and release artifacts never share an identity; release keys
 * keep their historical shape (release is the absent default). */
export type NativeOptimization = "release" | "dev" | "speed";

export const NATIVE_OPTIMIZATIONS: readonly NativeOptimization[] = ["release", "dev", "speed"];

export function isNativeOptimization(value: unknown): value is NativeOptimization {
  return value === "release" || value === "dev" || value === "speed";
}

/** The -O0/-O2 class of a posture: dev is unoptimized, release and speed are
 * optimized identically at the C/LLVM optimization-level layer. */
export function optimizationClass(optimization: NativeOptimization | undefined): "release" | "dev" {
  return optimization === "dev" ? "dev" : "release";
}

/** Cache-key parts for a posture; empty for release so historical release
 * keys are unchanged. */
export function optimizationKeyParts(optimization: NativeOptimization | undefined): string[] {
  return optimization === undefined || optimization === "release"
    ? []
    : [`optimization-${optimization}`];
}

/** Posture as an optional options field: release stays absent. */
export function optimizationField(optimization: NativeOptimization | undefined): {
  optimization?: "dev" | "speed";
} {
  return optimization === "dev" || optimization === "speed" ? { optimization } : {};
}
