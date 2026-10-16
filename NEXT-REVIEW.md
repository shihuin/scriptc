# NEXT.md — review and first implementation

`NEXT.md` proposes a performance/memory programme written as if scriptc were a JavaScript
*interpreter* with a JIT. scriptc is the opposite: TypeScript goes through the tsc frontend into a
typed IR, the IR is emitted as LLVM IR, and the result is a native binary linked against a C
runtime that uses reference counting plus a cycle collector. Much of `NEXT.md` is therefore not
applicable, some of it is already implemented, and a small part is genuinely actionable. This is
the assessment, followed by the first item actually implemented.

## What the pipeline really does

Frontend (tsgo via the `ts7` adapter) → typed IR (`ir/validate.ts`, `ir/serialize.ts`) → LLVM IR
text (`backend/llvm/emitter.ts`) → native object (`backend/native-codegen.ts`) → link against a
precompiled runtime pack (`backend/linker.ts`, `backend/runtime-pack.ts`). There is no interpreter
and no JIT: `diagnostics/diagnostic.ts` states "scriptc has no interpreter fallback", and
`docs/content/docs/how-it-works.mdx` documents the same pipeline.

Memory model, with the files that own it:

- static per-type reference counting, `rc` at offset 0 (`backend/llvm/shapes.ts`, `classes.ts`);
- an 8-byte generational Bacon–Rajan cycle collector, only over types the compiler proves
  cycle-capable (`runtime/src/scr_cycle.c`, `backend/cycle-analysis.ts`, `backend/cycle-mutability.ts`);
  `Acyclic` and `ProgramLifetime` contracts opt types out entirely (`contracts/check.ts`);
- an inlined small-object allocator (`runtime/src/scr_alloc.c`, `backend/llvm/alloc.ts`);
- a counted region allocator, already shipped (`runtime/src/scr_region.c`,
  `backend/llvm/regions.ts`, `@scriptc/experimental` `LifetimeRegion`);
- borrowing through the ABI (`backend/llvm/call-lifetimes.ts`, `virtual-borrows.ts`,
  `borrowed-receivers.ts`).

## Item-by-item

| NEXT.md item | Verdict | Basis |
|---|---|---|
| 1 Hidden classes / maps | INAPPLICABLE | object shape is a compile-time type; access is a constant-index `getelementptr` (`emitter.ts`, `classes.ts`). Only the checked-dynamic `ScrDyn` bag has runtime lookup, and it already has an optional wide-object index. |
| 2 Polymorphic inline caches | INAPPLICABLE | dispatch is resolved statically (`frontend/lowering/devirtualize.ts`); the rest is a monomorphic vtable load. |
| 3 Multi-tier pipeline (Ignition/Sparkplug/TurboFan) | INAPPLICABLE | there is no interpreter to tier from; "tiers" here are build postures (`backend/optimization.ts`). |
| 4 Escape analysis & scalar replacement | ALREADY DONE | `backend/llvm/stack-objects.ts`, `record-results.ts`, `stack-unions.ts`, `stack-captures.ts`, `ir/scalar-records.ts`. |
| 5 String representations (ropes) | PARTIALLY DONE (this work) | `ScrStr` is flat WTF-8 (`scr_runtime.h`) and a rope would change every string consumer — but the item's actual complaint ("concatenation creates new objects") had a **live quadratic** hiding behind it: `s = s + "x" + "y"` copied the whole accumulated string per operand while `s = s + "xy"` appended in place, so scriptc was O(n²) where Node is O(n). Fixed at the self-assignment handoff (`emitter.ts`, `ir/analysis.ts`) by flattening the chain and recognizing the local as its leftmost operand: 320k iterations went 12.13 s → 0.01 s (local) and 2.50 s → 0.01 s (global). See PERF-FINDINGS.md §14. The rope itself is still not done and is a redesign. |
| 6 Elements kinds | ALREADY DONE | `backend/llvm/dense-array-access.ts` dense guard + hole-free prefix, `loop-array-borrows.ts`, `local-array-reads.ts`, 1-byte `boolean[]`. |
| 7 Speculative optimization + deopt | MOSTLY INAPPLICABLE | no feedback vector and nothing to deoptimize to; the useful half exists as static guards with cold fallbacks plus recheck elision (`checked-narrows.ts`, `narrowing-stability.ts`, `immutability.ts`). |
| 8 On-stack replacement | INAPPLICABLE | no interpreter frames. |
| 9 Bounds-check elimination | PARTIAL (corrected) | `backend/llvm/bytes-bounds.ts` proves offsets for fixed typed-array lengths only (entry condition: the function has a `bytes` local), and `frontend/lowering/string-index-bounds.ts` proves `text[i]` present. Ordinary `ScrArr` element access is *not* eliminated: `dense-array-access.ts` keeps the runtime getter as the authority and inlines a **guard** (index < len && index < cap, plus the `filled` hole-free prefix). That is guard elision, not bounds-check elimination, so NEXT.md's `for (i < arr.length) sum += arr[i]` example is not fully realized. |
| 10 Concurrent background compilation | INAPPLICABLE at runtime; already done at build time | `backend/llvm/split.ts`, `native-codegen.ts`, `build-cache.ts`. |
| 11 Register allocation | INAPPLICABLE | delegated to LLVM; the emitter is deliberately alloca/load based (`backend/llvm/blocks.ts`). |
| 12 WebAssembly integration | INAPPLICABLE as written | Wasm is an output target, not a host: `SCRIPTC_TARGET=wasm32-wasi`, `packages/runtime-wasm32-wasi`. |
| A Ownership/path pass | PARTIAL | the AOT-relevant half exists (cycle analysis, immutability, reference effects, contracts). Serializing it into IR JSON is a non-sequitur: shard caches key on emitted LLVM text. |
| B Group borrowing → `noalias` | ACTIONABLE — implemented, see below | there was no `noalias`/`alias.scope` anywhere, though per-field TBAA already existed. |
| C Immutable region borrowing / one precheck | MOSTLY INAPPLICABLE (basis corrected) | typed code *does* carry per-access runtime guards — dense-array slot state (`dense-array-access.ts`), checked-narrow arm tests (`checked-narrows.ts`), `bytes` relational guards, `scr_dyn_check_fail` — so the earlier "no checks to replace" basis was wrong. What has no counterpart here is Vale's *precheck/region-immutability* mechanism; those guards are per-site and cannot be replaced by one entry precheck without a new immutability proof. |
| D Region allocation on the event loop and fibers | PARTIAL (corrected) | the allocator and its lowered surface exist (`runtime/src/scr_region.c`, `backend/llvm/regions.ts`, `@scriptc/experimental` `LifetimeRegion`), but *the item's actual proposal* — automatic regions per microtask drain / timer callback / request handler — does not. `scr_region_enter`/`leave`/`release` have no caller outside the lowered `LifetimeRegion` (`frontend/lowering/lifetime-regions.ts`, `emitter.ts`), and the allocator only ever serves **ProgramLifetime** classes, so for every other program it is a no-op. |
| E Scalar replacement / SoA | PARTIAL | scalar replacement done; SoA for arrays of fixed-shape records is not. |
| F Generational references instead of the collector | ACTIONABLE but redesign-scale; some sub-claims wrong | the collector is already generational and `Acyclic`/`ProgramLifetime` already opt types out. `WeakRef`/`FinalizationRegistry` do not exist in static code, so "makes them deterministic" is moot. |
| G RC only where sharing is irreducible | PARTIAL / mostly done | regions skip counting, `ProgramLifetime` skips RC, published worker graphs are immortal, the borrow ABI removes call-site retain/release. |
| H Linear moves / last-use destruction | PARTIAL | release is scope-driven (`emitter.ts` `releaseScope`); true last-use release needs per-statement liveness. |
| I Boundary technique | first bullet factually wrong; rest largely done | `--dynamic` and the embedded engine were removed in 0.3.0. FFI, WASI and workers exist. |
| J comptime synergy | ALREADY DONE | `frontend/lowering/lower-comptime.ts` (node:vm in the JS host; QuickJS in the native compiler). |

## Factual errors in NEXT.md

1. "Has JIT? No → Interpreter Only", the Ignition/Sparkplug/TurboFan framing and item 8: scriptc
   has no interpreter (`diagnostics/diagnostic.ts`).
2. Item 1's premise ("Current: Slow property lookup / Hash table lookup") is false for typed
   access; it is a constant-index GEP.
3. Item I's "`--dynamic`, ~620KB engine for npm/`any` code": the flag and engine were removed in
   0.3.0 (`CHANGELOG.md`; commit `7e6294ca` deleted `dynamic-support.json`).
4. Item D's "add a region allocator": already shipped.
5. Item D's "no refcount word, no header at all" inside regions: false; `rc` stays at offset 0.
6. Item E's premise that frame/lifetime emission is missing: already implemented.
7. Item F's `WeakRef`/`FinalizationRegistry` claim: static scriptc has neither.
8. Item J's "isolated QuickJS evaluator during the frontend": the JS compiler host uses `node:vm`
   (`frontend/comptime-node.ts`); QuickJS is the natively-built compiler's path
   (`native/comptime.ts` shelling to `packages/compiler/native/comptime.c`). The nearest in-repo
   statement of "no interpreter" is a hint string inside `npmStaticRefusalDiag`
   (`diagnostics/diagnostic.ts`), not a headline claim, so the conclusion rests on the absence of
   any interpreter package rather than on a single citation.
9. The closing benchmark figures (2.2MB RSS, 88MB at a million objects, 2.3ms startup) are not
   supported anywhere in the repository.

## Implemented: `noalias` on provably-disjoint parameters (item B)

**Status: on branch `perf/result-slot-noalias`, not on `main`.** Two commits
(`983fda98`, `5efc586b`) on top of `07e7741c`; `grep noalias packages/compiler/src` on `main`
returns nothing. Nothing in this repository tracks `NEXT.md` or this file, so the branch is the
only record of the change.

**Site 1 — a result-slot entry's `dst`.** A result-slot entry is
`%into.<name>(...params, dst)`: the function writes its fresh result object into a
caller-provided slot instead of returning it. `record-results.ts` builds these entries;
`backend/llvm/stack-objects.ts` is the caller that supplies the slot.

**Site 2 — a scalar class constructor's `this`.** When a class satisfies
`scalarStandaloneClass` (`record-results.ts`) its instance holds only `f64`, `bool` and inline
scalar unions and its constructor never lets `this` escape. `this` is parameter 0, and every
caller passes a fresh object: the stack path a private frame slot, the heap `new` path a fresh
allocation, and the constructor thunk a fresh allocation it then retains.

**Why `noalias` is sound at both sites.** The object holds **no pointers at all**, and it is a
private allocation that no other pointer in the program can name, so nothing in the callee can
alias it. A class whose constructor lets `this` escape (`seen.push(this)`) is excluded by the
same predicate and keeps the conservative spelling.

**Why it should pay.** Without the promise LLVM must assume every call may clobber anything
reachable, so the caller reloads values it already had in registers. With `noalias`, load
elimination and register residency across the call are legal.

**It does not pay — measured.** The reasoning above is right about what the attribute means and
wrong about whether LLVM can use it here: the result-slot entries are fully inlined at `-O2`, so
there is no call boundary left for the promise to apply to. The objects compiled from `value-objects`,
`alloc-trees` and `records-sort` are **byte-identical** with and without the change, a full
20-workload A/B is neutral with a `size` column of `+0.0%` everywhere, and `nm` finds zero `into_`
symbols in the object. See `PERF-FINDINGS.md` for the tables. The change is sound and the corpus
passes (2554/2554), but it is **not a performance improvement** and should not be landed as one.

**Change.** `backend/llvm/emitter.ts`:
- a `resultSlotDst(fn)` predicate (name starts with `RESULT_ENTRY_PREFIX` and the trailing
  parameter is a record/object) and a `noaliasParam(fn)` method that also recognises a scalar
  class constructor and returns parameter 0 for it;
- the definition emits `ptr noalias` for that parameter — in `emitFunction`, in
  `emitInt32AbiWrapper`, and in `emitOwnedCallAdapter`, so the promise survives each ABI
  boundary rather than being dropped at one of them.

**Test.** `backend/llvm/stack-objects.test.ts` asserts that every `%into.*` definition's last
parameter is `noalias` and that no other definition in that module carries the attribute, plus a
case pinning `noalias` on every entry of a scalar class constructor and its absence on a class
whose constructor lets `this` escape. The emitted IR was also checked directly:
`Plain(a, b)` gains `noalias` on `this` in all three entries; `Tracked` (escaping) gains none.

**Verification.** Compiler build clean; `packages/compiler/src/backend` **705 tests passing**
(60 files); the emitted IR carries `noalias` only on the proven parameters (checked directly on a
`Plain` scalar class and its escaping `Tracked` counterpart); and the full differential corpus
passes with both commits — **2554/2554 programs** compiled to native binaries and byte-identical
to Node on stdout, stderr and exit status. The branch is `perf/result-slot-noalias`, commits
`983fda98` and `ba1b9926`.

One environment note, because it cost a wasted run: the published `@scriptc/runtime-linux-x64-gnu@0.3.2`
pack is older than current `main`, so it lacks symbols the current compiler emits
(`scr_dyn_typed_ref_string_view`, added in `packages/runtime/src/scr_json.c`). Linking against it
fails with `undefined reference` for every program that reaches those symbols, which looks like a
codegen regression and is not one. Build the runtime pack from source
(`pnpm --filter @scriptc/runtime-linux-x64-gnu build:native`) before running the corpus locally.

**Soundness of the aliasing claim.** `dst` is always a distinct freshly created result slot.
The case that most invites aliasing — a reassigned binding, `p = add(p, {...})` — is deliberately
lowered as "build the result in its own slot, then copy", so the call becomes
`%into_add(p_ptr, literal_ptr, fresh_dst)` and then a load/store into `p`'s slot:
`dst` never equals an argument. The unit test additionally asserts that no *other* definition in
the module carries `noalias`.

## Implemented (second item): guard-fallback counters

**Status: on branch `perf/guard-fallback-stats`, not on `main`** (commits `bf7ce2a4`,
`ef8bafa6`).

Phase 0 asks for measurement before any of the plan's optimizations, and the audit lane answered
only "did anything leak". This adds the other half for the inlined guards: how often the dense
fast path gives up and calls the runtime, per operation.

- **Emitter** — five cold blocks count themselves with a call to `scr_check_note(i32 kind)`
  before the runtime entry: the four dense element accesses in
  `backend/llvm/dense-array-access.ts` (read, state, write, push) and the local/projected array
  read in `backend/llvm/local-array-reads.ts`. The kinds are the exported `GUARD_FALLBACK` table.
  Two of the local-array slow blocks are also the default path when that path is not inlined, so
  those count only on the inlined branch — otherwise a non-inlining build would report a 100%
  miss rate for a path it never emitted. `LlEmitter` keeps the audit flag as a field
  (`EmitterOptions.objectAudit`) instead of only handing it to the shape/alloc hosts, and emission
  is gated on it exactly like the live-object notes, so production builds emit nothing.
- **Runtime** — `scr_check_note`/`scr_check_count` join the RC-audit notification family in
  `scr_object.c`: real thread-local buckets under `SCR_RC_AUDIT`, an empty function otherwise
  (the symbol must exist in every runtime because directly emitted code may call it — the same
  contract as `scr_obj_alloc_note`, verified with `nm` in both configurations). The summary
  prints from `scr_console.c`'s atexit chain only when `SCRIPTC_CHECK_STATS=1`.

**Verification.**

- End to end: a `--sanitize` build of a program that reads a dense array, misses on a fractional
  index, queries `2.5 in a`, writes a sparse index and reads a projected local array reports
  `scriptc guard fallbacks: read=0 state=1 write=1 push=1 local=2`. With the variable unset the
  same binary prints byte-identical stdout to Node and an **empty** stderr.
- A normal build's IR contains no reference to the symbol at all, so the production IR is
  unchanged and the prebuilt runtime pack needs no new symbol.
- `nm` on `scr_object.c` compiled both ways: the plain form defines an empty `scr_check_note`,
  the `SCR_RC_AUDIT` form defines `scr_check_note` and `scr_check_count` — the same contract as
  `scr_obj_alloc_note`.
- New runtime-lane test (`scr_checks.test.c` + `scr_checks.test.ts`) pins the counter contract
  including out-of-range kinds and both env states.
- `packages/compiler/src/backend`: 60 files, all passing. Full differential corpus in the normal
  lane: **2554/2554** byte-identical to Node. The sanitized lane, which is where the counter calls
  are actually emitted, passes on the programs the change touches: the seven `array-sparse`
  programs, `3140-array-dense-access` plus the three other `dense` matches, and the seventeen
  `tuple`-matching programs that exercise projected array reads.
- `oxlint --deny-warnings` and `oxfmt --check` clean on the new and changed files.

## Where the rest of the plan would go

Ranked by value × feasibility. The earlier ranking was too optimistic about the first two items;
the corrected scoping is below.

1. **`llvm.lifetime.start/end` on stack objects** — genuinely absent (`grep -rn llvm.lifetime
   packages/compiler/src` returns nothing) and explicitly requested by NEXT.md item E, whose
   `alloca` half already exists (`stack-objects.ts`, `stack-unions.ts`, `stack-captures.ts`).
   It looks like the cheapest remaining item, and it is the one to be most careful about. Two
   reasons: (a) a marker with a wrong range is a miscompile, not a missed optimization, so the
   range has to be proven, which means per-statement liveness — i.e. it is a piece of item H, not
   a standalone win; and (b) the slots in question have their address passed to a call
   (`emitStackObject` hands the slot to the `%into.` entry), so LLVM's mem2reg cannot promote
   them and lifetime markers would not change that. Emitting them naively would be churn.
2. **Phase 0 measurement, scoped honestly.** The earlier claim that "only the counters are
   missing" was wrong: retain/release is not centralised. There are 9 inline `*_retain` bodies in
   `scr_runtime.h`, RC manipulation emitted directly into class/record retain/release bodies by
   `backend/llvm/shapes.ts` (which an emitter-side counter *can* hook through the existing
   `objectAudit` flag), and dozens of out-of-line `*_retain`/`*_release` definitions across ~20
   runtime files (`scr_child.c` alone has 16). A complete count therefore spans the emitter, the
   header, and most container units. Any such summary must be gated on a **new env variable**
   (`SCRIPTC_RC_STATS=1`), not on `SCR_RC_AUDIT`, or the sanitized lane's byte-exact stderr
   comparisons break — the same mistake the region stats avoided.
3. ~~**Guard-fallback counters**~~ — **done**, see above. Two guard families are counted (the
   dense element accesses and the local/projected array reads). The remaining families have the
   same cold-block shape and take a new bucket by appending to `GUARD_FALLBACK` and bumping
   `SCR_CHECK_KINDS` (the report's static assert then demands a name): `checked-narrows.ts`,
   `bytes-bounds.ts` and `scr_dyn_check_fail`. Note the wrinkle the local-array family already
   had — a slow block that is *also* the default path when the guard is not inlined must count
   only on the inlined branch, or a non-inlining build reports a 100% miss rate for a path it
   never emitted. True "checks executed" counters are a different thing — hot-path increments at
   every guard site — and change the code being measured; do not start there.
4. **Automatic region boundaries** — the API is sufficient (`scr_region_enter/leave/release` are
   balanced, stack-based and thread-local; `scr_region_create` already keeps a process-global
   type table), and the event loop's microtask/timer/immediate stations are the natural
   boundaries. Two costs keep it below the others: it can only ever hold **ProgramLifetime**
   instances, so it is a no-op for every other program, and it changes observable behaviour —
   `tests/corpus/5013-lifetime-region-async.ts` pins that work resuming after `await` lands in
   the never-freed default region, and the sanitized lane's "RC audit skipped: N program-lifetime
   object(s)" line is stderr-compared.
5. **SoA for arrays of fixed-shape records** — highest value on struct-array workloads, but arrays
   of records are `SCR_ELEM_REF` (each element an owned pointer), so it is a new element kind plus
   every access path plus the region/release walkers.
6. **`noalias` beyond these two sites** — **not** a small extension: the lifetime analysis
   (`call-lifetimes.ts`, `virtual-borrows.ts`) proves that a callee neither retains nor releases a
   parameter, which is *non-ownership*, not *disjointness*. Nothing there rules out `f(a, a)`, so
   `noalias` on a borrowed parameter needs a new group/path disjointness analysis first.
7. **Last-use destruction** — lower peak RSS, but it needs the same per-statement liveness.

Item F (generational references replacing the collector) is a redesign, not a patch, and the
collector it would replace is already generational and already skippable per type.
