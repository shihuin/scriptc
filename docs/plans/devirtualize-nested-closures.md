# Plan: devirtualize non-escaping nested closures (js-bench Area 6)

**Measured gap (this repo, HEAD, Node 24 oracle):** 200K iterations of a 10-deep nested function chain: **10ms vs Node 3.1ms (~3.2x)**. The SAME chain at top level: scriptc **wins 8x** (0.4ms vs 3.2ms — LLVM inlines the whole chain once the calls are direct). The gap is purely the closure-box indirection on nested declarations.

## Root cause (verified)

- `ScrClosure` (`runtime/src/scr_runtime.h:1337-1354`): `{ rc, fn, ncaps, props, caps[] }` — fn pointer at offset 8, trailing capture-cell array.
- Nested `function name(){}` declarations lower as `const name = <lambda>` (`lowerNestedFunctionDecl`, `frontend/lowering/lower-calls.ts:5511-5517`); `lowerLambda` (5700-5865) lifts the body to a module-level IrFunction and returns `{ kind: "closure", fnName, captures }` (5827).
- **Every call through the local goes `callValue`** — load fn from offset 8, `call <ret> %fn(ptr %closure, ...)` (`backend/llvm/expr-calls.ts:398-428`, the indirect call at 417/422; C mirror at `backend/c/exprs.ts:2379-2395`), wrapped in retain/release brackets. Ten of these per benchmark iteration.
- Top-level functions take the direct-call fast path instead (`lower-calls.ts:3947-3971`: `isTopLevelFnSymbol` → `{ kind: "call", callee: sig.name }`), and LLVM inlines the chain at -O2. Direct-call emission (`backend/llvm/expr-calls.ts:15-39`) ICEs on lifted callees today (line 18: `callee.captures === undefined` required) — that check is exactly what a devirt must relax.
- The frontend **already knows the target statically**: the callee is a `varRef` to a local whose sole initializer (one `varDecl` at the lambda's statement position) is a `closure` expr with a known `fnName`. The never-reassigned-binding analysis already exists (`bindingNeverReassigned`, imported at `frontend/lowering/lowerer.ts:98`, used for generic-binding devirt at `lower-calls.ts:3987-3999` — "the binding provably holds its initializer forever").

## Design

A frontend devirt in `lowerCall`'s func-typed-local arm (the catch-all at `lower-calls.ts:4372-4480`):

1. **Eligibility**: the callee expression resolves to a local binding `L` where (a) `L` has exactly one declaration, (b) that declaration's initializer is a `closure` expr with `fnName === F`, (c) `bindingNeverReassigned(L)` — nobody rebinds `L`, (d) the lambda's captures, if any, are still correct to pass (see 2), and (e) the declaration precedes the call in the same function (the nested-decl lowering already guarantees same-scope; hoisting-before-declaration is a compile error per the 5505-5510 comment).
2. **Calling convention problem — this is the real work.** A lifted function `F` expects `(env: ScrClosure*, ...params)` — its captures are read from the closure's `caps[]` cells via `fn->caps[i]`. A direct call must materialize that env. Two options: a. **Closure-form direct call**: keep allocating the closure ONCE at the declaration (so captures stay boxed and the box is the env), but emit `call @F(ptr %closure, ...args)` directly instead of loading fn from it — skips the load, the indirect branch, and the retain/release pair (the closure local already holds the +1). The retain bracket drops because the callee convention owns nothing extra. Cost: still one closure allocation per invocation of the ENCLOSING function, but the call loop reuses the same box → the benchmark's hot loop pays zero indirect-dispatch and zero brackets. b. **Full lift to capture-free**: when the nested function captures NOTHING (the benchmark case — pure f0..f9), emit a plain direct call with the closure's env param passed as the known constant box (or a null-env static), letting LLVM inline the whole chain exactly like the top-level case. This is where the 8x-win mechanism actually fires. Ship (a) first (safe, general), then (b) for capture-free lambdas (the measured case).
3. **Self-reference**: the lambda's self-`varRef` (`selfRef` local, 5505-5510) stays a genuine closure — recursion through the local keeps working; devirt only applies to OTHER call sites' callee locals... simpler: if `L` is the lambda's own self-binding, skip devirt (conservative, correct).
4. **Async lifted functions**: route through the spawn wrapper exactly like `callTarget` does (`backend/llvm/emitter.ts:2754-2761`) — async devirt is the same mechanism with a different target symbol.
5. **Escape rule — crucial**: devirtualizing the CALL does not change the closure's existence. The box still exists if it escapes (returned, stored, passed to non-inlined callees); only the call site changes. That means NO escape analysis is needed for correctness — only for the optional capture-free full-lift (b), which must check the closure value is never used as a VALUE (only called). Use the existing local-use analysis (`lowerer.ts`'s local read tracking; if any use is not a direct call callee, keep the box and use (a)).

## Verification bar

- Full differential corpus plain + SAN (the closures corpus programs: 2400-series closure batteries and the `inlining`-shaped patterns — add a corpus program with the nested-chain shape plus escaping/rebound/self- recursive closures).
- The `clos2` benchmark: expect ~10ms → ~1-3ms with (b); (a) alone should remove the brackets (~10ms → ~7ms).
- `f === f` identity: two `varRef` reads of the same local still produce the SAME box (one allocation per declaration site) — unchanged by this plan.

## Files (all verified)

- `frontend/lowering/lower-calls.ts` — nested decl 5511, lowerLambda 5700-5865, callValue arm 4372-4480, top-level fast path 3947-3971, bindingNeverReassigned use 3987-3999
- `frontend/lowering/lowerer.ts` — bindingNeverReassigned import 98
- `backend/llvm/expr-calls.ts` — closure creation 369-397, callValue 398-428, direct-call ICE guard line 18
- `backend/llvm/emitter.ts` — callTarget 2754-2761, interned fn-value statics 1772-1794
- `runtime/src/scr_runtime.h` — ScrClosure 1337-1354
- `backend/c/exprs.ts` — indirect-call mirror 2379-2395

## Expected outcome

Nested 10-deep chain: ~3.2x → at-parity-or-better with (b) (the top-level twin already beats Node 8x with the same inlining). General nested-closure code: (a) removes 2 brackets + a load + an indirect branch per call.

## Measured baseline vs Bun 1.4.0 (apples to apples: identical self-timing source, warmup, medians of 7, accumulators verified identical; node 24.15, bun 1.4.0)

| family | scriptc today | node | bun | gap vs bun |
|---|---|---|---|---|
| nested-closures (200K 10-deep chain) | 9.5ms | 0.33ms | 3.96ms | 2.4x |

Notably bun does NOT inline this nested chain (3.96ms — JSC boxes nested closures too); node does (0.33ms). The acceptance bar is beating bun (<= 3.96ms) via stage (a); the stretch goal is node's 0.33ms via stage (b) full lift, where the top-level twin already measures 0.4ms — scriptc would then beat BOTH engines on higher-order code.
