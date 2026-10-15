# Plan: string ropes — O(1) append, built materialization, shape specialization

Measured gap: a 1M-iteration `s += "*" + i` chain builds 2M intermediate strings and pays O(len) copy at every step — 6041ms in scriptc vs 631ms in bun (1M-part chain: 6041 → 631ms, see `bench-string-chain`). JavaScriptCore and V8 both win via rope strings: O(1) append builds a rope; materialization (the first op that needs contiguous bytes — `charAt`, `slice`, FFI, print) flattens once, O(n). HBC's `backend/native/ffi.ts` FFI handoff and the `scr_print_*` sinks are the materialization points; `scr_str_concat` (`packages/runtime/src/scr_string.c`) is the append site.

## Phase 1: rope representation in the runtime

- Add a `ScrRope` variant to the string type: left/right + length, lazily flat. `scr_str_concat` returns a rope when either side is a rope or both exceed the inline threshold (small strings stay inline — the common case must not regress).
- `scr_str_len` decodes rope length O(1) (no flattening).
- Element access (`scr_str_at`, `scr_str_slice`), FFI handoff (`backend/native/ffi.ts` FFI handoff), and the `scr_print_*` sinks flatten once: O(n) build into contiguous bytes, then free the rope.
- Interned/short strings keep their fast paths — the differential corpus (both backends, string oracles incl. 2702/2745) is the gate.

## Phase 2: append specialization for `s += e`

`backend/llvm/expr-primitives.ts` element-write shape for strings: the `+=` statement compiles to `scr_str_concat` + rebind. With ropes this is O(1) per append; the 1M-part chain target is bun-parity (~631ms), the 2M-part chain target is ~2x bun (bun builds the same intermediates — the rope wins because append is O(1) and flattening is O(n) once).

## Phase 3: shape specialization (stretch)

`backend/native/ffi.ts` FFI handoff + `scr_print_*` sinks (`packages/runtime/src/scr_console.c`): materialization sites learn the hot shapes — measure first (both oracles, medians of 7), specialize only what the corpus proves hot. Full differential byte-identical is the merge gate.

## Measurement addendum (from perf/string-append)

A finer split of the same problem, compiled probes, three loops each building the same two characters per iteration:

| loop | 16k | 64k | 256k | |
| --- | --- | --- | --- | --- |
| `s = s + "x"` | 0 ms | 1 ms | 5 ms | linear |
| `s = s + "x" + "y"` | 3 ms | 69 ms | 1285 ms | **quadratic** |
| `p = "x" + "y"; s = s + p` | 2 ms | 2 ms | 24 ms | ~linear |

**A single concat is already linear.** The phase-1 target ("`scr_str_concat` is the append site") is right, but the sharp edge is narrower: it is the *chain*, and the reason is the self-assignment handoff, not `scr_str_concat` itself.

The `+=` / self-assignment path in the emitter nulls the binding and releases the loaded value *before* concatenating, which is what brings the accumulator's `rc` to 1 — the condition `scr_str_concat`'s in-place branch requires. `s = s + "x"` is recognised as a self-assignment and the handoff fires. `s = s + "x" + "y"` is not recognised (the right-hand side is a chain, not a plain `s + expr`), so the accumulator is read into an owned temporary, `rc` stays 2, and the copy path runs every iteration.

### Two fixes ruled out, with evidence

**"Allow `rc <= 2` to append in place."** Tried and reverted: it did not merely get slower, it **died with `scriptc: out of memory`**. The second reference is a genuine alias; the runtime cannot distinguish it from an independent owner.

**"Give the copy path geometric slack."** Structurally cannot help. Slack lets a *later* append reuse the block, and the later append is exactly the one that must copy.

Both matter for phase 1: a rope representation makes these moot for the append site, which is an argument for ropes over further tuning of the flat representation.

### One attempt made and reverted

Flattening the chain in the emitter onto a multi-operand `scr_str_concat_n(a, rest[], n)`. The flattening was verified to *fire* (a diagnostic confirmed chains of 3 and 6 operands reach the branch) and the chain **stayed quadratic** — flattening removes the intermediate but not the reason the in-place branch was skipped. **Fewer calls is not the same as lower refcount.** `scr_str_concat_n` is implemented and committed on `perf/string-append` as a building block; it is not a fix on its own.

The independent route worth trying before ropes, if ropes are deferred: extend the self-assignment handoff to chains — when the RHS of `s = ...` is a string `+` chain whose leftmost operand is `s`, lower it in the handoff form with the remaining operands as suffix, dropping the binding first exactly as `+=` does today. That reaches the existing in-place append with no new representation.
