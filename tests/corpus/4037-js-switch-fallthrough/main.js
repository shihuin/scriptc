// Switch fallthrough in a project whose tsconfig sets
// noFallthroughCasesInSwitch — legal, ordinary JavaScript and the shape a
// compiled state machine takes (React's work loops switch on a tag and fall
// through deliberately). TS7029 is a lint-grade style check, not a
// soundness one: nothing about a fallthrough is unrepresentable, so the JS
// lane relaxes it the way it relaxes its sibling families.
function f(x) {
  let out = "";
  switch (x) {
    case 1:
      out += "one";
    case 2:
      out += "two";
      break;
    default:
      out += "other";
  }
  return out;
}
console.log(f(1), f(2), f(3));
