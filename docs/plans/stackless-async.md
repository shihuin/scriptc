# Plan: stackless async state machines (+ interim fiber wins) (js-bench Area 2)

**Measured gap (this repo, HEAD, Node 24 oracle):** 5000 spawned 3-await chains: **~81ms total (~16.3µs/chain) vs Node ~7.2ms (~1.4µs/chain, ~13x)**. `Promise.resolve` alone is FASTER than Node (19ns vs 32ns) — the promise object is fine; the fiber is the problem. The js-bench doc measured raw `swapcontext` at ~830ns/hop (it performs an `rt_sigprocmask` syscall and saves/restores the entire FPU file), plus ~5µs per spawn-and-complete chain (malloc stack + getcontext/makecontext + 2 switches + destroy).

## Root cause (verified)

- Async is **purely stackful**: every async fn call `scr_async_spawn`s a fiber — `calloc` ScrFiber + `malloc(SCR_FIBER_STACK=256KB)` + `getcontext` + `makecontext` + eager first-switch (`runtime/src/scr_async.c:1209-1274`, stack size 84-88, trampoline 1174-1190) — and **no fiber pooling exists** (destroy at 1267-1271 when the eager prefix finishes; destroy at 2110-2114 on resume completion).
- Every `await` = `scr_await_yield` = one `swapcontext` round trip (`scr_await_park` 1312-1326, `scr_await_yield` 1369-1377, the public `scr_await_hop` 1382 = one-liner; declared `scr_runtime.h:3882`). Even `await Promise.resolve(x)` takes one mandatory microtask hop (`scr_await_settled` 1403-1419) — the benchmark's 3 awaits = 3 hops + spawn.
- Frontend lowers `await <non-promise>` to the `async.hop` libCall (`frontend/lowering/lower-exprs.ts:1240-1289`); LLVM maps it at `backend/llvm/lib-shared.ts:658` and marks the loop live (729); C mirror at `backend/c/exprs.ts:3488,3529`.
- The scheduler lives wholly in `scr_async.c` (`scr_loop_run` 2235-2677, microtask drain 2272-2276, resume via `scr_resume_fiber` 2073-2115); epoll/kqueue files contain no fiber machinery.
- **A stackless lowering already exists for WASI**: LLVM switched coroutines (`llvm.coro.save/suspend/resume/destroy`), emitted at `backend/llvm/emitter.ts:1865-1880, 2764-2797`, with runtime partners `scr_wasi_await_prepare`/`scr_wasi_coro_resume` (`scr_async.c:1328-1362`, 382-388, resume hook in `scr_resume_fiber` 2091-2103). The promise waiter list (`ScrFiber **waiters`, struct at `scr_async.c:96-133`, parked via 1318-1323) and the READY FIFO (392-406) are exactly the interface a stackless native continuation must slot into — the wasm32 lane proves the seam works.

## Stage 0 — interim wins (small, no IR change)

1. **Fiber pooling**: keep a SCR_TL freelist of ScrFiber structs and stacks (the doc measured malloc+free of 256KB as negligible — glibc caches the mmap — so pool mainly saves the `getcontext`/`makecontext` pair, ~1µs, and the calloc/free traffic). Reuse in `scr_async_spawn` before the eager switch; return to the pool at `scr_fiber_destroy` (1196-1205) instead of free. Pool cleared at loop exit (join it into `scr_loop_run`'s shutdown path) and under `#ifndef SCR_RC_AUDIT` like the string spare cache so ASan sees real lifetimes.
2. **Hand-rolled switch**: replace `swapcontext` with a small assembly routine that saves CalleeSaved regs + SP/PC only (no sigprocmask, no full FPU file — x86-64 SysV needs rbx, rbp, r12-r15, rsp, rip; the FPU/SSE state is caller-saved under SysV and swapcontext over-persists it). Three arches matter for this repo: x86-64, aarch64, arm64-apple. ASan's fiber annotations (`__sanitizer_start_switch_fiber`, already wired at 896-925) stay identical. Expected: ~830ns → ~20-50ns per hop. Combined with pooling: 16µs → ~3-4µs per spawned chain, no semantic risk.
3. **Settled-await fast path**: `scr_await_settled` (1403-1419) currently parks through the READY queue even for ALREADY-settled promises (mandatory one-microtask hop — this is the JS-spec-correct ordering, so keep it; but the doc's benchmark chains `await Promise.resolve(...)` where the promise IS settled at park time — the queue round trip itself can be shortcut to a direct resume in the same loop turn IF microtask ordering is provably preserved. Risky for observable ordering; only do it if the differential async corpus (1020-series, event_loop programs) stays byte-identical.)

## Stage 1 — stackless state machines (the real fix)

Compile each async function to a resumable state machine (V8/JSC/Rust-async style) on native targets, replacing the fiber per call:

1. **Frame**: the arg-pack struct the emitter already builds (`emitAsyncScaffolding`, `backend/llvm/emitter.ts:1863-2012`) gains the state index + a spill slot for every live local at each suspension point. The trampoline (`@sc_tr_...`) becomes a `switch (state)` dispatcher.
2. **Suspension**: at `await` where the promise is PENDING, store state+regs into the frame, register the frame as the promise waiter (extend the waiters list to accept `{resume_fn, ctx}` thunks — same shape the WASI coro already uses via `scr_wasi_await_prepare`), return to the caller. On SETTLED: take the one microtask hop as today (ordering contract).
3. **Resume**: `scr_promise_settle_wake` (992-1008) pushes the frame's resume thunk onto the READY queue; `scr_resume_fiber` (2073-2115) dispatches by tag — a frame-typed waiter calls the dispatcher instead of switching stacks.
4. **Migration surface**: `await` lowering stays the `async.hop` libCall only for the settled case; pending parks lower to a new `async.park(promise, frame)` pair. Generators (`scr_gen_new` 2971-3006) keep fibers initially (suspended-once, different lifecycle), migrate later behind the same dispatch tag.
5. **Destructor discipline**: frames die on completion (explicit state terminal → release captures/arg refs) or on unhandled rejection. The arg-pack malloc (emitter.ts:1807-1839) becomes the only per-call allocation — arena-candidate from the bump-arena plan.

## Verification bar

- The async corpus is the oracle: 1020-series async programs, event_loop programs, `fib-chain`-shaped additions (add a corpus program: parallel chains with awaited-and-rejected interleavings to pin ordering). Full differential corpus plain + SAN. The `async`/`event_loop` js-bench repros as perf pins.
- Stage 0 alone must keep byte-identical behavior everywhere; Stage 1 changes the `await`-pending path's allocation profile, so watch the `library-asyncfree` contract (async_free profiles: the loop-liveness marking at lib-shared.ts:729 must stay truthful).

## Files (all verified)

- `runtime/src/scr_async.c` — spawn 1209, trampoline 1174, destroy 1196, switch 896-925, park/yield/hop 1312-1382, settled 1403-1419, wake 992-1008, loop 2235-2677, resume 2073-2115, fibers struct 302-333, wasi coro seam 1328-1362/382-388, gen 2971-3006
- `backend/llvm/emitter.ts` — async scaffolding 1863-2012, wasm coro 1865-1880/2764-2797, arg packs 1807-1839, callTarget 2754-2761
- `backend/llvm/lib-shared.ts` — async.hop sym 658, loop-live 729
- `frontend/lowering/lower-exprs.ts` — await lowering 1240-1289
- `ir/ir.ts` 3996-3999, `ir/validate.ts` 1109 — async.hop spelling/validation
- `backend/c/exprs.ts` — C mirror 3488/3529, `backend/c/async.ts:117` — C spawn

## Expected outcome

Stage 0: ~16µs → ~3-4µs per spawned chain (13x → ~2.5x). Stage 1: at V8-parity for chains (~1µs; the remaining cost is promise allocation + queue ops, which are already Node-competitive).

## Measured baseline vs Bun 1.4.0 (apples to apples: identical self-timing source, warmup pass, medians of 7 runs, accumulators verified identical across every lane; node 24.15 and bun 1.4.0 run the same .ts)

| family | scriptc today (main + static-math) | node | bun | gap vs bun |
|---|---|---|---|---|
| async-chains (5000 spawned 3-await chains) | 39.8ms | 1.19ms | 1.82ms | 21.9x |

Acceptance bar: async-chains at or below 1.8ms (bun's median), staying byte-identical through the differential corpus and the SAN lane. Note bun itself is 1.5x slower than node here — beating bun is the stated bar; beating node (1.19ms) is the stretch goal.
