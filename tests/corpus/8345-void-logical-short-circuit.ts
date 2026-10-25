// A discarded `&&`/`||` is statement control flow, not a value: its right
// operand runs only when the left says so. When the right operand is a
// conditional whose arms are void calls — `flags & 512 && (mode === "manual"
// ? attach() : detach())`, the shape React's reconciler uses — there is no
// value-shaped ternary to build, and the frontend used to reach SC9001.
function note(text: string): void {
  console.log(text);
}
function attach(): void {
  note("attach");
}
function detach(): void {
  note("detach");
}
function flags(on: boolean): number {
  return on ? 512 : 0;
}

for (const on of [true, false]) {
  // The conditional arm: both branches are void calls.
  flags(on) && (on ? attach() : detach());
  flags(on) || (on ? detach() : attach());
  // The plain arm, for the same short-circuit.
  flags(on) && note("and");
  flags(on) || note("or");
}

// A discarded logical whose left is a string, and one that nests.
const name: string = "x";
name === "x" && (name.length > 0 ? note("str-and") : note("str-else"));
name === "y" || (name.length > 0 ? note("str-or") : note("str-or-else"));
name === "y" && (name.length > 0 ? note("no") : note("no"));
