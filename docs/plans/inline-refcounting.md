# Plan: inline refcounting + elide provably-paired brackets (js-bench Area 4)

**Measured gap (this repo, HEAD + feat/static-math-surface, Node 24 oracle):** 1M 4-deep string-param calls: **17ms vs Node 2.2ms (~8x)**. Per-op costs from the js-bench study: ~6ns per retain+release pair, ~15ns per call for a string param through a 4-deep chain. Node pays zero at these points (deferred GC).

## Root cause (verified)

1. Every retain/release is a **non-inlined external call** (`call ptr @scr_str_retain_v(...)`) — the runtime `.c` files are separate translation units and **no LTO runs** (`-flto` appears nowhere in `backend/native-toolchain.ts`; runtime objects built at `native-toolchain.ts:4390-4584`).
2. No `alwaysinline`/`inlinehint` attributes exist anywhere (grep-verified).
3. The emitter's own record/class retain/release bodies are ALREADY emitted inline as `internal` functions with exactly the 4-instruction sequence — `retainBody`/`releaseBody` at `backend/llvm/shapes.ts:417-481` — proving the pattern works within a TU. The cycle-header mark-live store is inlined as a raw store at the call site (ABI pinned at `runtime/src/scr_runtime.h:315-336`).

## Phase 1 — emit retain/release inline (small, mechanical)

All emission funnels through two seams: `retainValue`/`releaseValue` (`backend/llvm/emitter.ts:2222-2232`) plus `retainSym`/`releaseSym` (`backend/llvm/shapes.ts:180-205`); scattered direct `@scr_*_retain_v` spellings live in expr-callbacks.ts, expr-stream-callbacks.ts, expr-control.ts, expr-island.ts, dyn.ts, expr-stream-bridges.ts, classes.ts.

Change `retainValue` to emit the inlined body when the kind admits it (the `retainBody` sequence: null check, `load rc` at offset 0, `icmp eq -1` (immortal), `add 1`, `store`; the cycle mark-live store for traced kinds):

- **Inlinable kinds**: str, arr (with the `scr_cyc_mark_live` store when `elem_trace`), union, box, closure — all share `rc` at offset 0 (`RUNTIME_RC_STEMS`, `ir/ir.ts:382-425`).
- **NOT inlinable**: `releaseValue` must stay a call for refcount-reaching-zero kinds — the release path frees children, purges the sidx/rsubject caches, and (strings) hops the spare-block cache (`scr_str_release`, `runtime/src/scr_string.c:260-277`). Split it: the fast path inline (`sub 1`, `icmp ne 0` → done) with a **cold call branch** to the existing `@scr_str_release` only when the count hits zero. LLVM will outline the cold branch on its own; even if not, the common case is 4 instructions.
- Keep `#0`/`sanitize_address` attributes consistent — the inline sequence is ASan-neutral (no memory beyond the header word it already touches).
- The C backend gets the same treatment later or never (its `-fno-strict-aliasing` rationale at `native-toolchain.ts:4406-4417` documents why aggressive C-side inlining of RC fought TBAA before; the LLVM lane has no TBAA metadata).

**Expected**: removes 2-3ns call overhead per bracket; the 4-deep chain has ~5 brackets per call → ~10-15ns of the 17ns total. Roughly 8x → ~4x.

## Phase 2 — elide provably-paired brackets (the remaining gap)

The emitter has a strict +1-on-frame discipline (documented at `backend/llvm/emitter.ts:23-32`: `own()` at 2196, `moveTemp()` at 2208, `releaseFrame` at 2234, scopes/jumps/unwind at 2246-2292). Every varRef read retains, every statement end releases — including values that simply moved.

Add a linearity pass over the emitted statement frames:

1. **Immediate-move elision**: a temp produced at `T` and consumed by the very next `moveTemp` (call argument, varDecl initializer) needs no retain/release at all — the producer already returns +1 (or the literal is immortal and the retain is a no-op anyway; keep the no-op store or drop it — both correct). This is the "freshly-allocated temp passed straight to a call" case the js-bench doc names; Swift/Rust ARC do exactly this.
2. **Param-entry elision**: `expr-calls.ts:20,407,444,472,555` run `moveTemp(a) // callees own their params` — the callee immediately retains its params on entry. One of the two brackets is redundant by construction; make the callee skip the entry retain when the caller already moved an owned +1 (this is a calling-convention flag per call site: "args moved").
3. **Frame-slot load elision** (`ownSlot`, `emitter.ts:2201-2205`): conditional results re-load and re-release — same immediate-move treatment.

**Verification bar (do not merge below this)**: full differential corpus (1090 programs, plain + SAN lanes) byte-identical; the SAN lane's RC audit is the ownership-invariant oracle — any wrong elision shows up as a leak or a double-free there. Add corpus programs specifically stressing moved-args and conditional-slot paths. `tests/corpus/2692-string-accumulation.ts` and `1205-regex-rc-stress.ts` already stress release ordering.

## Files (all verified)

- `packages/compiler/src/backend/llvm/emitter.ts` — retainValue 2222, releaseValue 2230, own/moveTemp/releaseFrame 2196-2244
- `packages/compiler/src/backend/llvm/shapes.ts` — retainSym 180, releaseSym 187, retainBody 417, releaseBody 444
- `packages/compiler/src/backend/llvm/expr-calls.ts` — moveTemp-on-args 20/407/444/472/555
- `packages/compiler/src/ir/ir.ts` — RUNTIME_RC_STEMS 382-425
- `packages/runtime/src/scr_string.c` — release fast/cold split target
- `packages/runtime/src/scr_runtime.h` — ScrCycHdr ABI 315-343, retains 426-429

## Expected outcome

Phase 1 alone: ~8x → ~4x on string-param chains. Phases 1+2: ~1.5-2x, matching the numbers-path case (unboxed doubles are already FASTER than Node — 1.2ms vs 2.2ms — so the target is closing to near-parity where values are monomorphic).

## Measured baseline vs Bun 1.4.0 (apples to apples: identical self-timing source, warmup, medians of 7, accumulators verified identical; node 24.15, bun 1.4.0)

| family | scriptc today | node | bun | gap vs bun |
|---|---|---|---|---|
| rc-strchain (1M 4-deep string-param calls) | 33.2ms | 1.93ms | 1.87ms | 17.8x |

Acceptance bar: rc-strchain at or below 1.87ms (bun's median) with the full differential corpus and SAN RC-audit lane byte-identical.

## The value-model ceiling: releases cost less than liveness

The decisive experiment for this plan's ceiling: no-op EVERY `scr_str_release`/`scr_arr_release` (the zero-cost value model this plan's elision would approach) and re-run the heavy object workloads. It made them SLOWER, not faster:

| workload | with releases | without | |
|---|---|---|---|
| anim 4096 (ms/frame) | 24.4 | 33.1 | +36% |
| churn 8000 (ms/frame) | 50.7 | 67.0 | +32% |
| tree 8000 (ms/frame) | 472 | 468 | flat |

The liveness penalty — values pinned alive, larger heap, worse locality, more cycle-collection scanning — exceeds the refcount work saved. So elision here is bounded engineering with a real but limited win: it cannot close a multi-x gap to a JIT, and the 17.8x rc-strchain gap is dominated by call overhead and string representation, not by the retain/release instructions themselves. The plan below stays valid as optimization; the value-model rewrite it might suggest does not.
