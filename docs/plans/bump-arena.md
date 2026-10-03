# Plan: bump arena for young values (js-bench Areas 3+5)

**Measured gap (this repo, HEAD, Node 24 oracle):**
- 1M fixed-size 32+32-byte concats: **45ms vs Node 1.6ms (~28x)** — each iteration is malloc + 2×memcpy + free (plus the RC audit shows this is purely alloc/teardown: an array of IMMORTAL literals is still ~10x slower, so allocation dominates, not refcounting).
- Note: the doc's `huge_strings` 422x accumulation gap is **already fixed on main** (measured 2.3ms vs Node 7.2ms — the `s += x` ownership-handoff lowering hits `scr_str_concat`'s rc==1 in-place path via `matchStringSelfConcat`, `ir/analysis.ts:23` + `emitStringSelfConcatAssign`, `backend/llvm/emitter.ts:3965`). What remains of Area 3 is exactly the fresh-value churn in this Area 5.

## Root cause (verified)

Every fresh string/array/record/closure is an individual `malloc`/`calloc` and every death an individual `free` (or spare-cache hop). V8's young generation is a bump pointer with a copying scavenger. The allocation chokepoints are concentrated:

| Kind | Allocator | Site |
|---|---|---|
| strings | `scr_str_alloc` (+ one-slot spare cache, + `realloc` regrow) | `runtime/src/scr_string.c:196-258` |
| arrays (plain) | `scr_arr_new` / `scr_arr_grow` (data `realloc`) | `runtime/src/scr_array.c:83-112` |
| unions, boxes, closures, traced arrays/maps | `scr_cyc_alloc` (one `calloc`) | `runtime/src/scr_cycle.c:100-110` |
| plain maps | `scr_map_new`'s `calloc` | `runtime/src/scr_map.c:204-223` |
| records / classes | emitted-LLVM `@scr_cyc_alloc` / `@calloc` | `backend/llvm/shapes.ts:543-584`, `backend/llvm/classes.ts:417-443` |
| arg packs / coro frames | emitted-LLVM raw `@malloc` | `backend/llvm/emitter.ts:1807,1833,2879` |

## Design: thread-local bump arena for young values (the classic nursery)

RC still traces lifetimes (correctness unchanged); the arena only makes death cheap and allocation a pointer bump.

1. **Arena structure** (new `runtime/src/scr_arena.c` or fold into `scr_cycle.c`): `SCR_TL` chunk list (64KB chunks, `SCR_TL` follows the existing per-instance pattern — `scr_runtime.h:44-48`, used by the sidx tables and spare cache). Chunk = `{ next, used, size, bytes[] }`. Bump pointer; on exhaustion, keep the current chunk (values may survive in it) and allocate a new one. Reclaim at explicit safe points (see 4).
2. **Range test, not free**: on release-reaching-zero, test whether the block is inside any live arena chunk (pointer compare against [base, base+size) — keep a small array of live chunk ranges, ≤ a handful). If yes: run the semantic teardown (element releases for arrays, field releases for records/unions, `scr_sidx_purge`/rsubject purge for strings) but SKIP the `free`. If no (promoted/old value): the existing free path.
3. **Alloc-side integration, one kind at a time** (each step independently shippable): a. Strings first (the measured churn case): `scr_str_alloc` bumps. The `realloc` regrow path (`scr_str_regrow`) only fires for rc==1 values — bump-allocated blocks get a fresh arena block instead of realloc (copy, like the copy-path concat today; regrow is rare). b. Closures/boxes (fiber arg packs churn these) via `scr_cyc_alloc` — note the cycle header must be zeroed (bump gives dirty memory; zero the 32-byte `ScrCycHdr` explicitly, `scr_runtime.h:315-343`). c. Arrays/maps headers; array DATA stays `realloc` (it grows). d. Records/classes: swap the two emitted `@calloc`/`@scr_cyc_alloc` sites (shapes.ts/classes.ts) to an arena-aware `@scr_rec_new` symbol OR leave records on calloc initially (they're not in the top gap).
4. **Reclamation**: arena chunks are reclaimed at loop checkpoints (`scr_loop_run` already has defined quiescent points — the microtask drain, `scr_async.c:2272-2276`) and at program exit, by compacting: walk the chunk, keep blocks whose `rc > 0` (they survived), free empty chunks. Cheap variant to start: **epoch arena** — chunks allocated before checkpoint N where no block in them died... no, simplest correct version: only reclaim a chunk when ALL its blocks are dead (checked at checkpoints). Young churn loops (the 28x benchmark) recycle the same chunk forever — that alone wins.
5. **RC audit lane**: `#ifndef SCR_RC_AUDIT` compile-out, exactly like the spare-block cache (`scr_string.c:221-240`) so ASan sees real frees.
6. **sidx/rsubject interaction**: those caches are pointer-keyed with purge-on-free (`scr_string.c:263`, and the new rsubject purge) — arena blocks die through the same release path, so the purges fire unchanged. Address reuse WITHIN a chunk is handled by the purge (the dead block's address is purged before any reuse could alias it).

## Verification bar

- Full differential corpus (1090 programs) plain + SAN lanes. The SAN lane needs the audit compile-out to keep auditing real lifetimes (leaks are the risk here; the differential corpus's RC-stress programs are the oracle).
- New corpus program: churn benchmark shape (fresh concats in a loop, array literals of literals, record literals dropped immediately) with sink.
- Memory ceiling check: a long-running loop must not grow RSS unboundedly — add a corpus-style program doing 10M fresh strings and assert len of the final output only (RSS is not observable; instead assert via `/usr/bin/time -v` in the harness or keep the reclaim-on-checkpoint tested by a program that interleaves churn with timer checkpoints).

## Files (all verified)

- `runtime/src/scr_string.c` — alloc 196, spare 222-240, regrow 252, release 260
- `runtime/src/scr_array.c` — grow 83, new 96, release 157
- `runtime/src/scr_cycle.c` — scr_cyc_alloc 100, free 112
- `runtime/src/scr_map.c` — new 204-223
- `runtime/src/scr_closure.c` — box_new 72, closure_new 183
- `backend/llvm/shapes.ts` 543-584, `backend/llvm/classes.ts` 417-443 (record/class new)
- `backend/llvm/emitter.ts` 1807/1833/2879 (arg packs, coro frames)
- `runtime/src/scr_async.c` 2272-2276 (checkpoint reclaim point)

## Expected outcome

~20x on the fixed-concat churn case (45ms → ~2-4ms: the remaining cost is the 2×memcpy, which V8 also pays), similar on array-literal and closure-churn paths. The accumulation case is already won.

## Measured baseline vs Bun 1.4.0 (apples to apples: identical self-timing source, warmup, medians of 7, accumulators verified identical; node 24.15, bun 1.4.0)

| family | scriptc today | node | bun | gap vs bun |
|---|---|---|---|---|
| churn-concat (1M fixed 32+32B concats) | 43.8ms | 4.74ms | 2.59ms | 16.9x |

Acceptance bar: churn-concat at or below 2.59ms (bun's median). The work is alloc+teardown (2xmemcpy remains for every engine — that floor is shared with node/bun).
