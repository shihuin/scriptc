# Performance findings

Measurements taken 2026-10-15 on this host with `scripts/bench-runtime.mjs`, `release` posture,
against `main` at `07e7741c`. Every timed executable had already matched Node byte-for-byte on
stdout, stderr and exit status — the runner refuses to time anything that diverges — so these are
correctness-safe comparisons.

Two prepared performance branches were measured. **Neither improves performance.** Both are
correct; neither is worth landing as an optimization. The measurement trap that initially made one
of them look like a 37% win is documented in `benchmarks/runtime/README.md` under "Measuring
safely".

## 1. `perf/result-slot-noalias` is a codegen no-op

The change marks two parameters `noalias` where disjointness is provable by construction: a
result-slot entry's trailing `dst`, and a scalar class constructor's `this`.

**The emitted IR does change.** `value-objects` compiled with and without the branch differs by
112 diff lines and carries 28 `noalias` attributes (the baseline carries none).

**The object code does not.** `value-objects`, `alloc-trees` and `records-sort` each compile to
byte-identical `.o` files (`cmp` on `--emit=obj` output, same `md5sum`):

| workload | object bytes | identical? |
| --- | ---: | --- |
| value-objects | 22040 | yes |
| alloc-trees | 12064 | yes |
| records-sort | 28880 | yes |

**Why.** The result-slot entries are fully inlined: `nm` on the object finds **zero** `into_`
symbols, and only 10 local/global functions survive at all. A parameter attribute only matters at a
call boundary; LLVM inlines every `%into.` entry and every scalar constructor at `-O2`, so the
attributes disappear with the call sites. The objects the slots point at are fresh scalar records
whose addresses basic alias analysis already proves disjoint from the caller's other allocas.

**The suite agrees.** All 20 workloads measured neutral, worst case +2.2% with a confidence
interval spanning zero, and every row's `size` column `+0.0%` — the executables are the same size.

The attribute is not merely ignored because of inlining. `record-boundaries` keeps two `%into.`
entries as real functions (`nm` finds 2 `into_` symbols) and they take **40% of the workload's
samples** — the ideal case for the promise — and its object is *also* byte-identical with and
without the change. LLVM's basic alias analysis already knows what the attribute would assert: the
destination is a fresh `alloca` in the caller, so the callee's stores through it cannot alias the
caller's other slots. There is nothing left for `noalias` to add.

**Recommendation:** do not land this as a performance change. It is sound and the corpus passes
(2554/2554), but it buys nothing measurable, so it is IR noise. Close `perf/result-slot-noalias`
on the fork, or land it only if a future change removes the inlining that makes it moot.

## 2. `pr/pure-call-declares-rebased` is neutral on this suite

The change stamps a small verified-pure table of external declares with `memory(none)` /
`memory(read)` so LLVM can hoist and CSE calls that touch nothing.

It does change code for some programs — `numeric-kernels` shrinks by 88 bytes (18608 -> 18520) —
and not for others (`optional-fields` is byte-identical).

It does not make them faster. A 31-run measurement of the workloads whose code changed:

| workload | baseline ms | candidate ms | change | 95% CI | verdict |
| --- | ---: | ---: | ---: | --- | --- |
| numeric-kernels | 24.4 | 24.7 | +1.0% | +0.3% .. +2.1% | slower |
| csv-numbers | 124.3 | 123.5 | -0.6% | -1.8% .. +0.7% | neutral |
| log-lines | 226.2 | 225.0 | -0.5% | -0.9% .. +0.1% | neutral |

The full 20-workload run was neutral apart from one marginal `slower` row (`template-render`,
+1.4%, CI +0.2% .. +2.6%), which also reports `size +0.0%` and so is layout luck rather than
codegen.

The commit's own claim of a 7.3% trig win is not reproduced by this suite; the workloads here may
simply not contain the hoistable shape it targets (a counted loop reading an array length across
calls). **Recommendation:** keep the branch if the target shape can be demonstrated on a workload
in `benchmarks/runtime/workloads/`; otherwise it is unproven.

## 3. Where the guards actually miss

The first real use of the guard-fallback counters (`perf/guard-fallback-stats`) is to check an
assumption rather than make one: that the inlined array fast paths are doing their job. Sanitized
builds of three workloads, run with `SCRIPTC_CHECK_STATS=1`:

| workload | read | state | write | push | local |
| --- | ---: | ---: | ---: | ---: | ---: |
| record-boundaries | 0 | 0 | 0 | 30 | 1 |
| value-objects | 0 | 0 | 0 | 19 | 1 |
| optional-fields | 0 | 0 | 241 | 271 | 801 |

`read` and `state` never miss in any of them: every dense element read and every `in`-style query
is answered inline across the whole run. The misses are `push` (capacity growth — the array has to
reallocate, which is inherent to growing an empty array), and, in `optional-fields`, `write` and
`local`, which is exactly the workload built from `number | undefined` fields and holes — shapes
that are *supposed* to take the runtime path.

That is a negative result worth having: on these workloads the array element fast paths are not
where time is, so optimizing them further would buy little. It is also the check that keeps the
claim honest per program instead of by assumption. The report stays off unless the environment
variable is set, so a measured binary's stdout/stderr still match Node byte-for-byte.

## 4. Where the time actually goes (next lead)

`record-boundaries` has the worst ratio against Node of the suite (0.84x, 174ms vs 208ms), so it
is the workload with the most headroom. `perf record -F 2000 -g -- ./record-boundaries 8`, 355
samples:

| symbol | share |
| --- | ---: |
| `main` | 60.3% |
| `sc_bf__x25_into_widen.i32` | 20.3% |
| `sc_bf__x25_into_pointAt` | 19.4% |

Two result-slot producers that LLVM did **not** inline are 40% of the run. That is where to look
next; it is not where the `noalias` change looks, as section 1 shows. Worth checking before
optimizing: whether the i32-ABI entry of `widen` is being called per element (the `.i32` suffix
means the integer-specialized borrowing body) and whether the two producers are worth forcing
inline at their call sites, since they are small enough to be candidates and are called from one
place each.

The suite's other near-Node row, `log-lines` (0.44x), is I/O-bound: it writes 200k lines into the
runner's pipe, so its ratio says more about the pipe than about codegen.

## The trap that produced the first (wrong) table

The first full run compared a candidate whose runtime pack had been rebuilt from source against a
baseline still linking the **published** `@scriptc/runtime-linux-x64-gnu@0.3.2` pack, which lags
this repository. It reported `alloc-trees -37.6%`, `value-objects -13.4%`, `ast-interp -5.0%`,
`inventory-report +11.6%`, `functional-pipeline +8.2%` and more — with three workloads failing to
link (`undefined reference to scr_arr_dense_slots`, `scr_map_iter_start`,
`scr_dyn_typed_ref_string_view`).

Those numbers were the runtime difference, not the program difference. After rebuilding the
baseline pack from source, the same comparison returned neutral everywhere and the object files
were byte-identical. The runner had been exiting non-zero on the link failures all along; piping
it through `tail` replaced that status with the pipe's own, which is how the invalid table was
mistaken for a result.

The rules that follow from it are in `benchmarks/runtime/README.md#measuring-safely`: rebuild the
runtime pack from source in every contender, never mask the runner's exit status, and confirm
neutral results at the object level before believing them.
