// `s = s + suffix` and `s += suffix` on a string local that the suffix
// cannot touch move the old value into the concatenation, which appends in
// place when nothing else holds the string. Aliases must keep their value,
// interned literals are never mutated, a throwing suffix leaves the binding
// unchanged, and suffixes that read the local, expression-position updates
// and captured bindings keep the general path. Output must match Node.

function typeListKey(ids: number[]): string {
  let key = "";
  for (let i = 0; i < ids.length; i++) key += (i === 0 ? "" : ",") + ids[i];
  return key;
}

function alias(rounds: number): string[] {
  let s = "start";
  const seen: string[] = [];
  for (let i = 0; i < rounds; i++) {
    const before = s; // shares the string: the append must copy
    s += `-${i}`;
    seen.push(before);
  }
  seen.push(s);
  return seen;
}

function literalHead(): string {
  let s = "lit";
  s += "eral";
  s = s + 1.5;
  s += -0;
  s += 1e21;
  return s;
}

function failing(n: number): string {
  if (n > 2) throw new Error(`too big: ${n}`);
  return `<${n}>`;
}

function guarded(): string {
  let s = "g";
  for (let i = 0; i < 5; i++) {
    try {
      s += failing(i);
    } catch (e) {
      s += `!${(e as Error).message.length}`;
    }
  }
  return s;
}

function selfReading(): string {
  let s = "ab";
  s = s + s;
  s += s.length;
  s += "|" + s;
  return s;
}

function expressionPosition(): string {
  let s = "e";
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) parts.push((s += String(i)));
  return parts.join("/") + ":" + s;
}

function captured(): string {
  let s = "c";
  const add = (x: string): void => {
    s += x;
  };
  for (let i = 0; i < 3; i++) {
    s += String(i);
    add(".");
  }
  return s;
}

function large(): number {
  let s = "";
  for (let i = 0; i < 2000; i++) s += String.fromCharCode(97 + (i % 26)) + i;
  let t = "\u00e9";
  for (let i = 0; i < 100; i++) t += "\u4e2d" + i;
  return s.length * 1000 + t.length;
}

// Chain form: `s = s + a + b` lowers as ((s + a) + b), so the local is the
// LEFTMOST operand of a chain rather than the outer concatenation's left
// operand. The same handoff applies to the whole chain, and the same cases
// keep the general path: an alias must keep its value, and a tail that reads
// the local must not be reordered around it. Surrogate seams across the
// chain's parts must pair exactly as Node does, including across an empty
// part.
function chainKeys(n: number): string {
  let key = "";
  for (let i = 0; i < n; i++) key = key + "[" + i + "]";
  return key;
}

function chainAlias(n: number): string[] {
  let s = "";
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    const before = s;
    s = s + "x" + "y";
    seen.push(before);
  }
  seen.push(s);
  return seen;
}

function chainReadsLocal(n: number): string {
  let s = "a";
  for (let i = 0; i < n; i++) s = s + (s.length > 2 ? "!" : "") + "b";
  return s;
}

function chainSeams(): string {
  let s = "\ud800";
  for (let i = 0; i < 3; i++) s = s + "\ud800" + "\udc00" + "a";
  let e = "\ud800" + "" + "\udc00";
  e = e + "" + "z";
  const codes: number[] = [];
  for (let i = 0; i < s.length; i++) codes.push(s.charCodeAt(i));
  codes.push(-1);
  for (let i = 0; i < e.length; i++) codes.push(e.charCodeAt(i));
  return codes.join(",");
}

console.log(typeListKey([3, 1, 4, 1, 5, 9]), JSON.stringify(typeListKey([])));
console.log(alias(4).join(" "));
console.log(literalHead(), guarded());
console.log(selfReading(), expressionPosition(), captured(), large());
console.log(chainKeys(3), chainReadsLocal(4), chainSeams());
console.log(chainAlias(3).join(" "));
