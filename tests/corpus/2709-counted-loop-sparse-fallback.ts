// The tracked-loop read fast path's sparse fallback (perf/numeric-loops):
// a proven-present read (`xs[i]!`) whose index is the loop's integer IV
// compiles to a dense GEP load gated on the array's DENSE capacity, with
// everything at or past cap answered by the runtime get. Arrays beyond
// the runtime's dense limit (2^20) keep their tail in sparse overflow
// slots — this program pushes past the limit and pins both regions.
// - indices below cap read through the dense buffers (values exact)
// - indices in [cap, len) read through the sparse slots (values exact,
//   including the first sparse index and a straddling window)
// - the sum covers both regions so neither read path can be dead
function sumAssert(xs: number[]): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s;
}
const limit = 1100000; // 2^20 = 1048576 dense slots; 51424 sparse entries
const xs: number[] = [];
for (let i = 0; i < limit; i++) xs.push(i + 0.25);
console.log(sumAssert(xs));
console.log(xs[1048575], xs[1048576], xs[1099999]);
const ys: number[] = [];
for (let i = 0; i < 40; i++) ys.push(i * 3);
console.log(sumAssert(ys), ys[10], ys[39]);
