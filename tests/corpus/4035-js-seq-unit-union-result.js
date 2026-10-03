// A comma expression whose RESULT is a bare unit, coerced into a union
// destination: `return (effect(), null)` inside a function that also returns
// strings, so the inferred return type is `string | null`. The comma has no
// contextual type where it is built, so nothing wrapped its unit result
// there; wrapping the whole sequence would put the unit INSIDE the wrap,
// which the validator rejects (a unionWrap's unit arm is validated as its
// direct value). Before: the compile stopped with an internal error.
function side() {
  console.log("effect");
}
function pick(flag) {
  if (flag) return "yes";
  return (side(), null);
}
console.log(pick(1));
console.log(pick(0));
const saved = pick(1) ?? "fallback";
console.log(saved);
