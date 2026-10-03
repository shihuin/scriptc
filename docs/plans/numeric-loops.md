# Plan: numeric loops — bounds-check elision + count hoisting + vectorization

The biggest remaining gap-to-bun on the measured suite lives in plain numeric loops: every `xs[i]` is an opaque runtime call (`scr_arr_get_f64`: bounds check + tagged-slot decode inside the call, `backend/llvm/expr-primitives.ts:439`), and `xs.length` re-enters the runtime from the loop condition (`expr-containers.ts:203`). Together they block LLVM's LICM/CSE (partially fixed by the pure-call declares on the pure-call declares) and entirely block auto-vectorization.

## Phase 1: counted-loop shape for f64 arrays

`matchIntegerBytesForLoop` (`backend/llvm/expr-containers.ts`) already recognizes the counted shape for byte arrays and emits a raw GEP + load per element. Extend the same recognition to number[]:

- Loop condition `i < xs.length` with a monotone integer induction variable: hoist `scr_arr_len` out of the loop (the declares from the pure-call declares make it hoistable when the body is pure-read; this phase makes it unconditional by emitting the loop in the bytes shape with a preheader load).
- Element access `xs[i]` inside the recognized loop: inline GEP + slot decode, no bounds check (the loop shape proves `0 <= i < len`).
- Element write `xs[i] = v`: same shape, GEP + store.
- The recognizer must refuse everything else (calls in the body that could push/rename, nested element writes to the same array, non-local arrays) — the differential corpus is the gate.

## Phase 2: opt-in `--native-cpu`

Forward `-mcpu=native` to the LLVM compile line (the emitted .ll is compiled by clang in `native-toolchain.ts`). Opt-in flag: WASI/cross binaries must keep their baseline contract; the flag is for numbers-first local runs.

## Phase 3: vectorization (the payoff)

With the elided loop shape and `-mcpu=native`, LLVM auto-vectorizes the `fadd`/`fmul`/`sqrt`/`fround` families — the one thing AOT does that TurboFan and DFG do not (they never vectorize transcendental loops). math-sqrt and math-pow-hypot (the two families bun still wins at 1.7-2.3x) are the direct targets. Stretch: glibc's libmvec for sin/cos/atan loops (declare `_ZGVbN2v_sin` and emit vectorized calls when the loop shape matches — significant added complexity, do last).

## Target state (measured suite, medians of 7)

math-sqrt 54.4ms → bun-parity (~22ms) via vectorization, math-pow-hypot 119.8 → ~65ms. Full differential corpus (both backends, every oracle) byte-identical is the merge gate.
