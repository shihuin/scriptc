# Roadmap: beating V8 (Node) and JSC (Bun) across the board

**Measured state** (all numbers: apples-to-apples medians of 7 — one self-timing source, warmup pass, results sunk, accumulators verified identical across every lane and oracle; Node 24.15, Bun 1.4.0, same machine):

| workload (per suite run) | scriptc | node | bun | vs bun |
|---|---|---|---|---|
| math-trig (3M ops) | **237.4** | 250.8 | 258.8 | **1.09x — wins** |
| math-hyper (3M ops) | **172.1** | 257.6 | 170.9 | **1.0x — wins** |
| math-mixed (3M ops) | 114.7 | 63.0 | 92.6 | 0.81x |
| math-sqrt (3M ops) | 54.4 | 21.7 | 22.1 | 0.41x |
| math-pow-hypot (3M ops) | 119.8 | 123.6 | 69.6 | 1.72x faster |
| array-sum (1M) | 6.64 | 6.86 | 4.85 | **1.37x faster** |
| regex-loop (400K execs) | 277.5 | 25.2 | 30.2 | 0.09x |
| rc-strchain (1M calls) | 33.5 | 1.99 | 1.91 | 0.06x |
| nested-closures (200K) | 9.73 | 0.33 | 3.92 | 0.40x |
| churn-concat (1M) | 44.1 | 5.58 | 2.69 | 0.06x |
| async-chains (5000) | 39.0 | 1.37 | 1.62 | 0.04x |
| startup (cold) | **0.9ms** | ~25ms | ~15ms | **~20x faster** |

Plus already-won: object literals, escaping allocations, number call chains, Promise.resolve, JSON, TextEncoder, URL, accumulation (`s += x` beats node 3x), top-level function chains (8x).

## What the emitted code still pays for (all verified in the IR)

1. **Every `xs[i]` is an opaque runtime call** — `scr_arr_get_f64` does the bounds check, the f64 index integer check, and a tagged-slot decode *inside* a call (`backend/llvm/expr-primitives.ts:439`; runtime `scr_array.c:206`). No GEP, no compare/branch, no vectorization.
2. **`xs.length` is re-called every iteration** — the loop condition emits `call double @scr_arr_len(ptr)` (`expr-containers.ts:203`), and without memory-effect attributes LLVM can neither hoist it nor reason about any external call. This branch fixes the attribute half (see below).
3. **Refcount brackets are external calls** — retain via `@scr_str_retain_v`, release via `@scr_str_release`, 2-3ns each, on every param pass, assignment, and scope exit. Node/JSC pay zero (deferred GC). No LTO exists to inline them (`native-toolchain.ts:4390-4584`).
4. **Nested/parameter functions are boxed and called indirectly** — `ScrClosure.fn` load + indirect call + brackets per call (`expr-calls.ts:398-428`); the arrow passed into `bench(...)` in this suite allocates per argument evaluation (`:369-397`).
5. **String concat = malloc + 2x memcpy + free** — V8 builds a ConsString, JSC a JSRope: O(1) concat, length is O(1) without flattening. That is why bun does churn at 2.7ns/concat.
6. **Async = 256KB-stack ucontext fibers** — spawn/makecontext/2 switches/ destroy per chain, ~830ns per swapcontext hop (sigprocmask syscall inside), no pooling (`scr_async.c:1209-1274`).
7. **Regex = libregexp's interpreted bytecode** + a malloc'd capture buffer per exec (a per-instance scratch buffer was measured 3-4% SLOWER than the malloc/free pair and reverted — the pair is already pool-fast). V8/JSC compile patterns to native Irregexp. 13x remains after the conversion cache.

## The work items that close each gap (in dependency order)

1. **Regex UTF-16 subject cache** (shipped) — subject conversion cached (-27% on the conversion-bound case; see perf-benchmarks.md).
2. **Pure-call declares** (shipped) — verified-pure symbols stamped with LLVM memory effects at the `host.declare` chokepoint (`PURE_DECLARE_MEMORY` in `lib-shared.ts`): `xs.length` hoists out of counted loops, loop-invariant math collapses to one evaluation, scheduling improves across every numeric loop. Measured: trig -7.3%, mixed -3.9%, pow-hypot -2.4%, array-sum -7.0% vs parent.
3. **Numeric loops** (see numeric-loops.md) — bounds-check elision for counted loops (extend `matchIntegerBytesForLoop`'s shape to f64 arrays: hoist length, inline the element load, elide the check when the induction variable is provably in range) + an opt-in `--native-cpu` flag so the vectorizer sees AVX2. This is the AOT superpower: after elision, plain `fadd`/`fmul`/`sqrt` loops auto-vectorize — TurboFan and DFG do not vectorize transcendental loops at all. Target: math-sqrt/pow-hypot >= bun.
4. **Inline refcounting** (see inline-refcounting.md) — inline the 4-instruction retain body at the emission seams; cold-call the release zero path; then elide provably-paired brackets on the +1-on-frame discipline. Target: rc-strchain from 0.06x to parity/win (the number path already beats node 1.8x — elision is the same story for strings).
5. **Devirtualize nested closures** (see devirtualize-nested-closures.md) — direct-call nested/parameter functions whose target is statically known and whose binding never reassigns; full-lift capture-free lambdas. Target: nested-closures >= bun 2.5x (and this suite's own `bench(fn, ...)` harness overhead — the math families above each carry one of these calls per iteration).
6. **String ropes** (see string-ropes.md) — O(1) rope concat with lazy flattening (the V8/JSC representation), on top of the bump arena for young flat strings. Target: churn-concat >= bun.
7. **Stackless async** (see stackless-async.md) — fiber pooling + register- only context switch (drops sigprocmask), then state-machine async reusing the WASI coroutine seam. Target: async-chains >= bun.

## The end state

Startup is already ~20x faster than both engines. After branches 2-7: numeric loops win via vectorization (AOT-only), strings win via zero-cost abstractions the JITs cannot prove, and the remaining engine-internal gap is regex pattern compilation — the one place where matching V8/JSC means porting an Irregexp-style pattern compiler (est. large; everything else above is bounded engineering).

---

## Measured deltas (pure-call declares)

| workload | parent | declared | delta |
|---|---|---|---|
| math-trig | 256.0 | 237.4 | -7.3% |
| math-mixed | 119.3 | 114.7 | -3.9% |
| math-pow-hypot | 122.7 | 119.8 | -2.4% |
| regex-loop | 352.1 | 277.5 | -21.2% (capture scratch — REVERTED, see perf-benchmarks.md) |
| array-sum | 7.14 | 6.64 | -7.0% |

Accumulators byte-identical across every lane and oracle; full differential corpus (both backends) is the merge gate.
