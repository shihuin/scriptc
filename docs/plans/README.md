# Performance notes and plans

Engineering notes from the performance workstream: what is measured, what is planned, and what was tried and ruled out. These are not published documentation — the site lives in `content/docs/` — they are the working record behind the numbers.

Read in this order:

- [perf-roadmap.md](./perf-roadmap.md) — the gaps to V8/JSC by path, the measured state, and the work items in dependency order.
- [perf-benchmarks.md](./perf-benchmarks.md) — the benchmark tables (static Math surface, regex subject cache, pure-call declares, counted-loop reads) with the method and the negative results on record.

Per-topic plans and findings:

- [numeric-loops.md](./numeric-loops.md) — bounds-check elision, hoisting, `--native-cpu`, vectorization.
- [string-ropes.md](./string-ropes.md) — O(1) rope concat with lazy materialization and shape specialization.
- [string-append.md](./string-append.md) — the `+=` self-assignment handoff is the quadratic-append root cause.
- [array-length.md](./array-length.md) — assigning `.length` is expensive, and the runtime is not at fault.
- [inline-refcounting.md](./inline-refcounting.md) — retain/release inlining and provably-paired elision.
- [devirtualize-nested-closures.md](./devirtualize-nested-closures.md) — direct calls for statically known nested functions.
- [stackless-async.md](./stackless-async.md) — fiber pooling, register-only switches, state-machine async.
- [bump-arena.md](./bump-arena.md) — young-object allocation arena.

The house rule behind every number here: ablation beats timers, medians of 7 over best-of-N, accumulators verified identical across every lane and oracle, and negative results stay on record next to the wins.
