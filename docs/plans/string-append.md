# perf/string-append — a `+` chain is quadratic; a single concat is not

Branch: `perf/string-append`. Status: **diagnosed, root cause identified, two fixes ruled out.** No behaviour change committed.

## What is actually slow

`docs`-level folklore in the port said "string append is quadratic (227 ms for 64k pieces) vs `join` (6 ms)". That is true but imprecise, and the imprecision matters: a single-concat accumulator is **already linear**. It is the *chain* that is quadratic.

Compiled probe (`/tmp/np/concatprobe.ts`), three loops building the same 2 chars per iteration:

| loop | 16 000 | 64 000 | 256 000 | scaling |
| --- | --- | --- | --- | --- |
| `s = s + "x"` | 0 ms | 1 ms | **5 ms** | linear ✓ |
| `s = s + "x" + "y"` | 3 ms | 69 ms | **1285 ms** | **quadratic** ✗ |
| `p = "x" + "y"; s = s + p` | 2 ms | 2 ms | 24 ms | ~linear ✓ |

4× the input is 4–5× the time for a single concat, and **23× for a chain** (quadratic predicts 16×).

So the workaround is precise and testable: **hoist sub-concatenations out of the accumulator, or accumulate in a `string[]` and `join`.** The port's encoder already does the latter. Any hot loop in any scriptc program should do the same today.

## Root cause

**It is the self-assignment handoff, and a chain escapes it.**

The `+=` / self-assignment path in the emitter (`emitter.ts`, the `store ptr null` block before the concat) deliberately drops the accumulator's reference *before* concatenating:

```ts
B.line(`${old} = load ptr, ptr ${b.slot}`);
B.line(`store ptr null, ptr ${b.slot}`);
this.releaseValue(old, b.type);
...
B.line(`${raw} = call ptr @scr_str_concat(ptr ${snapshot.name}, ptr ${right.name})`);
```

Nulling the binding and releasing the loaded value is what brings the accumulator's `rc` down to 1, which is exactly what the runtime's in-place branch requires:

```c
if (a->rc == 1 && a != b && a->cap >= newlen) {
  ...
  a->rc = 2; /* +1 for the returned reference, beside the caller's borrow */
  return a;
}
```

So `s = s + "x"` is recognised as a self-assignment, the handoff fires, and the append is in place — linear, as measured.

`s = s + "x" + "y"` is **not** recognised: the right-hand side is a chain, not a plain `s + expr`, so the ordinary path is taken. There the accumulator is read into an owned temporary, `rc` stays at 2, the in-place branch is skipped, and the copy path runs — once per iteration, O(n) each, quadratic.

Geometric growth is already implemented for the `rc == 1` path (`a->cap + (a->cap >> 1) + 16`), so a *single* accumulator is amortised linear — which is why the first row above is fast.

A chain evaluates left to right:

1. `s + "x"` — `s` is solely owned (rc 1), so this appends **in place** and returns the same pointer with **`rc = 2`**: the caller's borrow of `s`, plus the returned reference.
2. `(that) + "y"` — the left operand now has `rc == 2`, so the in-place branch is skipped and the copy path runs. For `newlen < 512` the copy path allocates **exactly** `newlen`, so the next iteration cannot append in place either.

One full copy of the growing accumulator per iteration is O(n²).

## Fixes ruled out, with the evidence

**“Allow `rc <= 2` to append in place.”** Tried, measured, reverted. The probe did not merely get slower — it **died with `scriptc: out of memory`** (SIGABRT). The second reference is a *genuine alias*, not bookkeeping: appending through it mutates a string another holder still sees. The runtime cannot distinguish "the caller's borrow of the same expression" from "an independent owner", and guessing corrupts the heap.

This is worth keeping: the obvious one-line fix is not merely risky, it is **wrong**, and it fails loudly rather than silently — which is the good case.

**“Give the copy path geometric slack too.”** Does not help, and the reason is structural rather than numeric: slack only lets a *later* append reuse the block, and the later append is exactly the one that must copy. One full copy per iteration remains.

## Attempted: a multi-operand concat, and why it is not sufficient

`scr_str_concat_n(a, rest[], n)` **is implemented and committed** (runtime only, additive, builds clean). The emitter-side flattening was written, verified to fire (a diagnostic confirmed the branch runs, and that chains of 3 and 6 operands reach it), and then **reverted, because the chain stayed quadratic**:

```
chain n=16000 len=32000 ms=4
chain n=64000 len=128000 ms=67
chain n=256000 len=512000 ms=1308
```

Flattening removes the *intermediate*, but it does not touch the reason the in-place branch was skipped: the accumulator is still read into an **owned temporary**, so its `rc` is still 2 when the call is made. `scr_str_concat_n` requires `rc == 1` and takes the copy path for exactly the same reason the nested form did.

That is worth knowing before anyone writes this again: **fewer calls is not the same as lower refcount.**

## What the fix has to do

The chain has to be recognised as a **self-assignment** and get the same handoff as `s = s + "x"` — the accumulator's reference dropped (binding nulled, value released) before the concatenation, bringing `rc` to 1. That is a frontend/emitter recognition problem, not a runtime one, and it is the only shape that reaches the existing in-place append.

Two ways to get there:

1. **Extend the handoff to chains.** When the right-hand side of `s = ...` is a string `+` chain whose leftmost operand is `s` itself, lower it as the handoff form with the remaining operands as the suffix — dropping the binding first, exactly as `+=` does today. Smallest change; reuses the machinery that already works.
2. **A compiler-owned append.** `scr_str_append_owned(a, b)`, requiring `rc == 1` and returning `rc == 1` with no bump, called only where the emitter *knows* it holds the only reference and has already dropped the binding's.

Option 1 is the one to try first: `s = s + a + b` is the common shape and the handoff already solves it for the one-operand case.

## Suggested acceptance test

The probe above is the test. A fix is done when `s = s + "x" + "y"` scales linearly at 16k/64k/256k, and the differential corpus (which compares compiled output against Node byte-for-byte) still passes — that corpus is the oracle for whether an in-place append is observably wrong.
