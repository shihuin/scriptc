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

## 4. Where the time actually goes (the lead that paid off)

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

## 5. `perf/inlinehint-result-entries` — a real win: record-boundaries −23.6%

Acting on the section 4 profile: result-slot producers (`%into.<name>`) are the callee behind
every `makePoint(...)`-shaped call, and the hot ones sit inside counted loops with one or two calls
per iteration. LLVM left two of them out of line, so each call kept a frame and the slot writes
could not be promoted into the caller.

The emitter already carries the fix for the identical situation two lines away, on the shared
indexed-read helper, with the comment "Without the hint LLVM keeps the hot instances out of line
once they have many callers: every read pays a call". The change applies the same `inlinehint` to
`%into.` entries. It lowers the inliner's threshold rather than forcing inlining, so a large entry
still stays out of line.

| workload | baseline ms | candidate ms | change | 95% CI | ratio vs Node |
| --- | ---: | ---: | ---: | --- | --- |
| record-boundaries | 173.9 | 132.8 | **-23.6%** | -23.7% .. -23.0% | 0.84x -> 0.64x |
| the other 19 workloads | — | — | neutral | every CI spans 0 | unchanged |

Every `size` column is `+0.0%`, `http-api` throughput and peak RSS are unchanged, and the run's
geomean is -1.2%. The object for `record-boundaries` grows 11088 -> 11584 bytes; one of the two
producers is inlined and the other (the recursive `widen`) is not.

Correctness, both lanes: the full differential corpus passes **2554/2554** in the plain lane and
**2554/2554 in the sanitized lane** (ASan plus the runtime RC audit, which aborts unless every
object family's live count is zero at exit — so the extra inlining leaks nothing). The harness
exits 0, meaning no workload failed to build or diverged, and `emitter.test.ts` pins the attribute
on a result-slot entry and its absence on an ordinary function.

## 6. What is left in record-boundaries (next candidate, not implemented)

Re-profiling after the inline hint (`perf record -F 2000 -g`, 8 scale): `main` 71.6%,
`sc_bf__x25_into_widen.i32` **28.0%**, everything else noise. The remaining hot producer is the
recursive `widen`, which cannot be fully inlined.

Its recursion is in tail position — `return widen(newSpan, values, from + 1, to)` — and the
result-slot transform already passes the caller's `dst` straight down instead of copying, so the
lowered body ends in a call followed only by `ret void`. Disassembly shows the compiler did **not**
turn that into a loop: the function contains exactly one self-`call` and no self-`jmp`.

**Update: this hypothesis was tested in section 9 and partly refuted — the dead check is free
(LLVM already deletes it), and the marker alone is what pays (-7.0%). Read section 9 before acting
on this one.**

The candidate is to mark that call (a plain `tail`, or a hard `musttail`) when the emitter can
see that a result-slot entry's body ends in a call to itself followed by `return`. That is a
statement-level pattern the IR makes visible: `record-results.fill` rewrites `return f(...)` into
`[exprStmt(call %into.f), return null]`, so a result-slot entry whose last two body statements are
`exprStmt(call to itself)` and `return null` is exactly the shape. The measured depth here is 15
levels per span, and there are ~1.15M such calls in the workload.

Two things to settle before writing it. `musttail` is a hard requirement: if the signatures do not
match exactly — notably the i32-ABI variant calling the same variant — LLVM rejects the module, so
it would fail loudly rather than miscompile, but it must be gated on an exact signature match. And
turning recursion into iteration changes what happens when a program would exhaust the stack: Node
raises a `RangeError`, a loop would keep going. No corpus program pins call-stack exhaustion
today (the one file matching "Maximum call stack" is about an array used as a work stack), but that
is a real behavioural difference and the reason this is written up rather than landed in the same
round as the inline hint.

## 7. A profile sweep for the next win (negative results)

After the inline hint, `perf record` on eleven self-contained workloads, top non-`main` symbols.
The point was to look for more direct calls LLVM left out of line, since that is what the hint
fixed. There are none:

| workload | hot emitted function | share | why a hint cannot help |
| --- | --- | ---: | --- |
| records-sort | `sc_bf__x25_fn5` | 49.2% | a comparator reached through `sort` — an indirect call |
| alloc-trees | `sc_f_build.i32` | 39.7% | `build` is recursive |
| template-render | `sc_bf_renderProduct` | 29.8% | reached through `map` |
| ast-interp | `sc_bf__x25_Binary_evaluate` | 25.1% | a method reached through its object |
| optional-fields | `sc_bf__x25_fn4` | 21.4% | a callback reached through the runtime |
| functional-pipeline | `sc_bf__x25_fn22` | 19.1% | a callback reached through the runtime |
| alloc-trees | `sc_bf__x25_TreeNode_check` | 19.7% | a recursive tree walk |

Every remaining hot emitted function is either a callback/virtual target (no static call site to
hint) or recursive (the inliner cannot remove the call). `value-objects` and `numeric-kernels` are
99% and 89% `main` — fully inlined, nothing left. The `inlinehint` lever was specific to `%into.`
entries precisely because those are direct calls with one static call site each.

One experiment from this sweep failed and is recorded so it is not repeated: `scr_map_entry_str_bytes`
is `__attribute__((noinline))` yet takes 9.8% of `word-graph`, so removing the attribute looked
promising. Measured: `word-graph +0.5%` (CI -1.0% .. +1.4%), `json-records +0.7%` — neutral. LLVM
either does not inline it or the inlining does not pay.

## 8. Memory: scriptc is already 10-40x under Node, and the harness cannot measure it here

Peak RSS of the compiled binary vs Node, sampled from `/proc/<pid>/status` `VmHWM`:

| workload | scriptc | node |
| --- | ---: | ---: |
| value-objects | 2.6 MiB | 112.8 MiB |
| alloc-trees | 3.4 MiB | 88.5 MiB |
| optional-fields | 4.5 MiB | 146.6 MiB |
| json-records | 32.4 MiB | 184.3 MiB |
| csv-numbers | 41.0 MiB | 260.9 MiB |
| word-graph | 46.9 MiB | 168.7 MiB |

The largest figures are data-driven (a 300k-element text array, a large string-keyed map), the leak
oracle (`--sanitize`, which aborts unless every family's live count is zero at exit) passes across
the corpus, and there is no workload where memory is disproportionate to what the program holds.
Memory is therefore not where this suite has headroom.

Worth knowing when reading the harness's output: its RSS columns come from `/usr/bin/time`, which
is **not installed on this host**, so every `peak RSS MiB` cell prints `-` and every
`peak_rss_bytes` field in the JSON is null — including the server table, which is the only place
the harness prints RSS at all. Process workloads are never asked for it. The numbers above came
from a `/proc` poll instead. Installing GNU `time` (or teaching the runner to read
`/proc/<pid>/status` itself) would make memory regressions visible in the normal flow; until then
a memory claim needs its own measurement.

## 9. Tail calls: what the recursion is worth, and why it is not landed

Section 6 left a candidate: mark the recursive producer's tail call so LLVM turns the recursion
into a loop. This measures what that is worth and what it costs.

**The dead pending check is not the blocker.** Round 3's hypothesis was that the exception check
after the call prevents tail-call elimination. It does not. Taking the compiler's real IR for
`record-boundaries`, removing the check after the self-call leaves the generated code
**byte-identical**: at machine level LLVM had already deleted the check (both unwind paths were
bare `ret void`, so the flag read was dead). An emitter change to elide it would buy exactly
nothing.

**The marker is the lever, and the payoff is real.** Replacing that same call with
`musttail call` (everything else unchanged, compiled by `clang -O2` from the same IR and linked
against the same runtime objects using the compiler's own `--print=native-link-info`) changes the
object dramatically: `nm` finds **no `widen` symbols at all** — the recursion becomes a loop and
the whole function is then inlined into `main`.

| variant | median | vs plain |
| --- | ---: | ---: |
| plain (`call`) | 132.3 ms | — |
| `musttail` | 123.0 ms | **-7.0%** |

Both are byte-identical to Node on stdout. Measured as medians of 40 interleaved runs, alternating
which variant goes first. For scale: main is 173.9 ms on this workload, the inline hint brought it
to 132.8 ms, and this would take it to ~123 ms — about 29% below where this work started.
Recursion-heavy workloads elsewhere in the suite are bigger still (`alloc-trees` spends 39.7% in
the recursive `build` and 19.7% in the recursive `TreeNode_check`), so the aggregate could be
larger than this one row.

**Why it is not landed.** It is a semantic change, not just a codegen change: **Node does not
implement tail calls**, so a scriptc binary that loops where Node grows the stack diverges on
stack exhaustion — an unbounded tail-recursive program would hang instead of raising `RangeError`.
The project's promise is byte-for-byte differential parity with Node, so that is a maintainer
decision rather than something to slip in as an optimization, however favourable the number is.
The corpus pins no stack-exhaustion behaviour today (the one file matching "Maximum call stack" is
about an array used as a work stack), so landing it would be silent by construction.

If it is ever taken, the emitter can only emit the marker when all of these hold, and must
otherwise emit the ordinary call: the call is the last action before `ret` of the same value
(tail position); the unwind cleanup for that call is empty, or a tail call would skip the releases
and leak; no `try` is active; and the callee's signature, including the i32-ABI variant, matches
the caller's exactly — `musttail` is a hard requirement, so a mismatch is an LLVM verifier error
(fail loud, not miscompile). The empty-cleanup condition is the one to get right; it is also what
makes the sanitized RC-audit lane the right gate, since a skipped release shows up there as a
nonzero live count at exit.

## 10. The `speed` posture: measured, and not a free win

`--optimization=speed` bundles a size-for-speed runtime flavor, runtime bitcode import and inline
reference counting. Measured against the default `release` on the same checkout (the
`perf/inlinehint-result-entries` one, so it stacks on the landed win), 11 runs each:

| workload | change | verdict |
| --- | ---: | --- |
| ast-interp | **-12.1%** | faster |
| async-pipeline | **-9.6%** | faster |
| alloc-trees | -3.5% | faster |
| template-render | -3.2% | faster |
| word-graph | -3.1% | faster |
| log-summary | -2.9% | faster |
| inventory-report | -2.9% | faster |
| records-sort | -1.9% | neutral |
| validate-errors | -1.1% | faster |
| **record-boundaries** | **+6.0%** | **slower** (CI +5.2% .. +6.6%) |
| numeric-kernels | +2.9% | slower |
| optional-fields | +2.9% | slower |
| log-lines | +1.9% | slower |
| functional-pipeline | +2.1% | neutral (CI spans 0) |
| the rest | — | neutral |

Geomean **-1.5%**, binary sizes **+4% .. +9%**. So the posture is a real lever with real wins, but
it is not a uniform improvement: the workload this work just optimized is the one that loses most.
Making it the default is a policy decision, and on this evidence it would trade a small geomean
gain for a 6% regression on record-boundaries and a size increase everywhere. Worth revisiting only
after understanding *which* of the three bundled features causes the regressions — the wins
concentrate in interpreter/async-shaped code, which points at runtime bitcode import, while the
losses concentrate in record/array code, which points at inline reference counting or the runtime
flavor's size-for-speed layout.

(The local runtime pack does contain the `speed` flavor and its 152 `.bc` files, so bitcode import
was available for this measurement rather than silently disabled.)

## 11. Splitting the `speed` posture: the flavor causes the regressions

The posture bundles three things: a size-for-speed runtime flavor, runtime bitcode import
(`--import-bitcode`, inlining runtime helpers into program code) and inline reference counting.
Since the regressions are what make the posture unusable as a default, the question is which
feature causes them. Measured with inline RC disabled, everything else unchanged (a throwaway
checkout, both contenders built from it, 11 runs):

| workload | `speed` (all three) | `speed` without inline RC |
| --- | ---: | ---: |
| ast-interp | -12.1% | **-5.8%** |
| async-pipeline | -9.6% | -7.4% |
| csv-numbers | -3.0% | **-4.4%** |
| alloc-trees | -3.5% | -3.0% |
| template-render | -3.2% | -2.3% |
| log-summary | -2.9% | -2.5% |
| word-graph | -3.1% | -1.0% (neutral) |
| inventory-report | -2.9% | -0.7% (neutral) |
| **record-boundaries** | **+6.0%** | **+5.2%** |
| numeric-kernels | +2.9% | +3.3% |
| optional-fields | +2.9% | +3.0% |
| geomean | -1.5% | -1.3% |

Two conclusions, and the second is the useful one:

1. **The regressions are not inline RC.** They persist with it disabled — record-boundaries is
   +5.2% instead of +6.0%, numeric-kernels and optional-fields unchanged. Whatever the
   size-for-speed runtime flavor changes (layout, aligned runtime code, per-object size classes)
   is what costs the record/array workloads.
2. **Inline RC is where a large part of the interpreter win lives.** Disabling it halves
   ast-interp (-12.1% -> -5.8%) and removes the word-graph and inventory-report gains entirely,
   while bitcode import and the flavor keep the async/csv/template wins.

That points at a narrower lever than "switch the posture": inline RC on the *release* flavor.
Whether it pays on its own is measured in section 12.

## 12. Inline RC on the release flavor: the narrower lever, and it wins

Section 11 showed the posture's regressions come from the runtime flavor while a large part of its
interpreter win comes from inline reference counting. So: keep the release flavor and the release
runtime, and enable inline RC alone. Both contenders are the same checkout with the inline hint
landed, 11 runs:

| workload | change | verdict |
| --- | ---: | --- |
| ast-interp | **-9.6%** | faster (CI -10.4% .. -8.9%) |
| alloc-trees | **-4.9%** | faster |
| records-sort | **-3.9%** | faster |
| log-summary | -2.4% | faster |
| record-boundaries | **-2.3%** | faster |
| word-graph | -2.2% | faster |
| **optional-fields** | **+2.3%** | **slower** (CI +1.6% .. +3.5%) |
| csv-numbers | +1.0% | slower (CI +0.1% .. +1.5%) |
| the other 12 workloads | — | neutral |
| geomean | **-1.5%** | |

Binary sizes are `+0.0%` on every row except csv-numbers (+2.3%) and http-api (+0.8%) —
inline RC duplicates a few instructions per retain/release rather than importing runtime code.

Compare with the whole `speed` posture (section 10), which reaches the same -1.5% geomean but takes
record-boundaries **+6.0%**, numeric-kernels +2.9%, optional-fields +2.9% and grows every binary
4-9%. Inline RC alone is better on the workloads that matter here: it *improves* the two record
workloads the posture hurt, and it costs only optional-fields (+2.3%) and csv-numbers (+1.0%).

That makes it a real candidate to enable for the default posture — which is what
`perf/inline-rc-release` does, gated to the optimized postures so `dev` keeps its readable
un-inlined code. It is not a uniform win (two workloads regress), so it is a judgement call rather
than a free change; but it is the first lever in this work that improves the suite's aggregate
without a large regression anywhere.

Measured again **standalone against `main`** (the branch is based on `main`, so this is the number
a reviewer would reproduce):

| workload | vs main | vs the inline-hint base |
| --- | ---: | ---: |
| ast-interp | **-10.9%** (CI -14.1% .. -6.4%) | -9.6% |
| alloc-trees | **-3.8%** (CI -6.5% .. -1.2%) | -4.9% |
| http-api (server) | **-2.2%** (CI -3.1% .. -1.4%) | +0.1% |
| records-sort | -3.8% (neutral interval) | -3.9% |
| word-graph | -2.5% (neutral interval) | -2.2% |
| log-summary | -1.5% (neutral interval) | -2.4% |
| record-boundaries | -1.2% (neutral interval) | -2.3% |
| optional-fields | **+1.8%** (CI +1.1% .. +3.4%) | +2.3% |
| csv-numbers | +0.6% (neutral interval) | +1.0% |
| geomean | **-1.2%** | -1.5% |

Verification for the branch: plain corpus 2554/2554, sanitized corpus 2554/2554 (the RC-audit lane
is the gate that matters here), backend suite 60 files. One test needed updating rather than the
code: `serialized-ir-emission.test.ts` mirrors the backend options `compile` derives, and did not
know about the new one, so it compared an inlined emission against a non-inlined one. With
`inlineRc` mirrored, the two paths produce identical text — which is also the check that the
inlined declarations are ordered deterministically enough for cache identity.

**The one regression is layout, not work.** optional-fields was re-measured at 31 runs (+1.7%,
CI +1.5% .. +2.3%) and profiled with `perf stat`: the two binaries execute the *same* dynamic
instruction count (4,578,846,902 against 4,578,849,207 — a 0.00005% difference) and the same
branch count. The inline fast path mirrors the runtime's own fast path, so replacing a call with
it moves the same work into the caller; what changes is code placement and i-cache behaviour.
Narrowing the feature for that workload would therefore be chasing layout luck, and would likely
move the cost somewhere else — so it is left as a known, small, workload-specific layout cost.

**Build time cost: +1.5%.** Fresh-cache `release` builds of `optional-fields` on the same host:
1065 ms median on `main`, 1081 ms on the branch (three runs each). Inline RC emits a few small
internal helpers per module, so the optimizer has slightly more to do; that is the whole cost.

**What was ruled out as a further lever.** Array growth is already geometric (doubling below
`SCR_ARR_DENSE_LIMIT`, then +50%), and capacity hints have little to buy: the guard counters report
16 push fallbacks in functional-pipeline and 6323 in word-graph — the latter being roughly 1% of a
130 ms run even though those pushes are exactly the ones that reallocate. The runtime pack's
`speed` flavor really is a different compilation (its `scr_string.o` is 135,832 bytes against
release's 137,184), so the section 10/11 splits stand; isolating bitcode import on the *release*
flavor would need the runtime build to emit release bitcode, which is a packaging change and a
policy decision rather than a measurement.

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
