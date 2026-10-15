# Benchmark: static Math surface + regex subject cache + pure-call declares — vs Node 24 and Bun 1.4 (apples to apples)

Method: one self-timing suite (warmup pass, results sunk, medians of 7 runs, accumulators verified identical across every lane and oracle). Lanes: `old-dyn` = main @ 1cec922d built --dynamic (the only way the old compiler could run the transcendentals); `new` = the static-Math build. Node 24.15 and Bun 1.4.0 run the identical .ts source. 3M samples/family.

| family (3M ops) | old-dyn | new | node | bun | new vs old | new vs bun |
|---|---|---|---|---|---|---|
| math-sqrt | 375.8 | 54.6 | 21.5 | 22.3 | 6.9x faster | 0.4x |
| math-trig | 3015.2 | 237.4 | 252.7 | 260.5 | 12.7x faster | **1.10x (wins)** |
| math-pow-hypot | 834.7 | 119.8 | 124.0 | 69.7 | 7.0x faster | 0.58x |
| math-hyper | n/a (no lowering) | 172.1 | 257.6 | 170.9 | new surface | **1.01x (wins)** |
| math-mixed | 1409.3 | 114.7 | 115.1 | 125.7 | 12.3x faster | **1.10x (wins)** |

Isolated 1M chained sqrt (no array loop overhead): scriptc 11.0ms, node 7.0ms, bun 8.5ms. The pure-call declares (memory effects on the verified-pure runtime/libm symbols) contribute a further -7.3% on trig and -3.9% on mixed by letting LLVM hoist loop-invariant calls and CSE repeats. Binary size: 1.41MB (old, embeds the engine) → 225KB static (6.3x smaller). Startup: 4.1ms → 0.9ms.

The static surface removed a 6.9–11.7x gap and lands at or above Bun on the transcendental families (trig and mixed win; hyper par; sqrt and pow-hypot at 0.4–0.6x — their per-element loop cost, see the follow-up perf branches). Accumulators byte-identical across all lanes.

---

# Benchmark: regex UTF-16 subject cache — vs Node 24 and Bun 1.4

Method: one self-timing suite (warmup, medians of 7, accumulators verified identical across every lane and oracle). Same source; `no-cache` = the build before the cache, `cached` = with it.

The suite's regex-loop family (400K execs, two patterns, same 78-byte subject — the cache's exact target):

| lane | 400K execs (ms) | node | bun |
|---|---|---|---|
| no-cache | 365.8 | 24.7 | 26.0 |
| cached | 341.4 | 24.7 | 26.0 |

The cache removed the entire O(n) UTF-8→UTF-16 conversion cost (-24ms, -7% on this workload; -27% on the 200K single-pattern variant measured during development: 144.5 → 113.9ms). The remaining ~13x gap to both oracles is libregexp's interpreted exec itself (bytecode vs V8's and JSC's compiled Irregexp) — engine-level work, not conversion; the follow-up is native/compiled pattern execution, tracked separately.

Negative result on record: a per-instance capture-buffer scratch (reusing the executor's register array across execs) measured 3-4% SLOWER than the malloc/free pair on capture-using patterns and was reverted (99eb3d2a) — the malloc/free pair is already pool-fast and the scratch added per-exec TLS bookkeeping. Hypothesis tested, measurement won, branch carries only the wins.

Accumulators byte-identical across every lane; full regex corpus and the ASan+RC-audit SAN lane green.

---

# Counted number[] loop reads

Status after the arrayGet routing revert (hole reads must answer undefined, so in-loop reads ride the idxOr union read again): the tracked loop itself keeps the machine-integer induction fast path, but the per-element read costs ~41 ns (1M elements, 20 reps: 824 ms vs Node 15 ms / Bun 15 ms — ~55x). Re-landing the read fast path needs a lowering that carries the elem | undefined union (or proves numeric-only use) per read site — tracked as follow-up work.
