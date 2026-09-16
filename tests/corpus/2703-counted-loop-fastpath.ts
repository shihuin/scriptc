// The number[] counted loop (perf/numeric-loops): the backend keeps the
// induction variable in machine-integer storage (nuw increment, ult
// compare, per-iteration length load) whenever the loop shape permits.
// This program pins the behaviors that representation must preserve:
// - a push INSIDE the loop body extends the loop exactly like re-evaluating
//   xs.length would (the length load is per-iteration, never pre-hoisted)
// - a value expression that grows the receiver between the guard and the
//   store picks up the moved data buffer (data loads fresh per access)
// - element writes land and stay (verified by re-reading)
// - hole reads in the loop answer undefined → NaN in numeric context, the
//   same values the union read produces.
function sum(xs: number[]): number {
  let acc = 0;
  for (let i = 0; i < xs.length; i++) acc = acc + xs[i];
  return acc;
}
function doubles(xs: number[]): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    xs[i] = xs[i] * 2 + 1;
    s = s + xs[i];
  }
  return s;
}
// push during iteration extends the loop — the fresh length load is
// load-bearing for this to terminate at the right count.
function grow(n: number): number {
  const xs: number[] = [1];
  let count = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs.length < n) xs.push(xs[xs.length - 1] * 2);
    count++;
  }
  return count * 1000 + xs.length;
}
// value expression grows the receiver mid-statement: data must be
// re-loaded after the value, before the store.
function growInValue(xs: number[]): number {
  for (let i = 0; i < xs.length; i++) {
    xs[i] = xs.length * 10 + i;
  }
  return xs[0] + xs[xs.length - 1];
}
const xs: number[] = [];
for (let i = 0; i < 50; i++) xs.push(i);
console.log(sum(xs));
console.log(doubles(xs));
console.log(sum(xs));
console.log(grow(5));
const ys: number[] = [3, 1];
console.log(growInValue(ys), ys[0], ys[1]);
// element writes survive; re-reads through the same loop shape agree.
let twice = 0;
for (let i = 0; i < xs.length; i++) twice = twice + xs[i] - xs[i];
console.log(twice, xs[7]);
