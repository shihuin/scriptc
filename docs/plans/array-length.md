# perf/array-length — assigning `.length` costs far more than `pop()`

Branch: `perf/array-length`. Status: **measured and located; no fix committed** — the runtime work is already minimal for what the API promises, so the actionable change is elsewhere. Recording that precisely, because "make `set_len` faster" is the obvious move and the evidence does not support it.

## The measurement

In the gpuix-scriptc port, `bindSpec` popped its work stack with the idiomatic form:

```ts
while (stack.length > 0) {
  const current = stack[stack.length - 1]!;
  stack.length = stack.length - 1;   // <- replaced
```

Replacing it with `stack.pop()` was worth **12–16% of a whole frame** (tree 8000: 1630 → 1432 ms; churn 8000: 3620 → 3058 ms; anim 4096: 1725 → 1494 ms), and it *tightened* the run-to-run spread from 1616–1692 to 1426–1438.

Two conclusions were drawn from that in the port's notes: assigning `.length` is expensive, and reading it is cheap (hoisting `.length` out of hot `for` loops bought ~2% on one workload and nothing on the other two).

## Why, from the runtime

`scr_arr_set_len` (packages/runtime/src/scr_array.c) is not doing anything wasteful. For a shrink it must:

```c
size_t next = (size_t)length;                      // after a full validation:
                                                   // isfinite && trunc==length && 0..MAX
if (next < a->len) {
  size_t dense_end  = a->len < a->cap ? a->len : a->cap;
  size_t dense_stop = next < dense_end ? next : dense_end;
  if (scr_elem_is_ref(a->elem)) { ...release the removed range, clear present[]... }
  size_t keep = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, next);
  ...
```

`scr_arr_pop_state` does something deliberately narrower:

```c
size_t idx = a->len - 1;
scr_arr_take_state(a, idx, &slot, &state);
a->len = idx;
```

So the difference is exactly what the API promises: `length = n` must validate its argument, release *a whole range*, and maintain the sparse index so a later `length = m` (m > n) still sees holes correctly. `pop()` removes one dense element and shrinks by one.

**In the port's call pattern the extra work is per-iteration:** one `.length` **read** (through the generated array helper) plus one `set_len` call, against one `pop` call. The saving is the read plus the range/sparse bookkeeping — not a bug in `set_len`.

## What this means for a fix

**Not** "optimise `set_len`". For a dense array with `sparse_len == 0` the range loop already runs once and `sparse_lower_bound` is trivial; there is no fat to trim without weakening the holes contract that `length = m > n` depends on.

The two routes that are actually supported by the evidence:

1. **Codegen peephole.** `arr.length = arr.length - K` is exactly `K` pops, and the cheaper path already exists. Lowering that shape to `pop()` (K times, or a small `scr_arr_truncate_fast`) removes the read and the range bookkeeping with no semantic change — both forms truncate to the same length and drop the same elements. This is the change the port's 12–16% points at.

2. **A documented rule for writers.** Prefer `pop()` to `arr.length = n`, and do not expect a runtime fix. Worth putting in the runtime docs because the idiomatic form (`length = length - 1`) is the slow one, and the fast one is shorter.

## Not established

Whether `.length = n` for n **well below** `len` (a bulk clear) is expensive for the same reason. The port only ever shrank by one. A bulk clear is exactly the case `set_len` is designed for — `Repeatedly clearing a reused work array must cost only the elements removed, not its historical peak` — and it should be measured before anyone assumes it is slow.
