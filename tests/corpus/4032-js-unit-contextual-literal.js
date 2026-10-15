// An object literal whose contextual type is a UNIT.
//
// `head.next` is typed `null` — inferred from the literal that introduced it —
// so the chained assignment's right-hand side has a contextual type of `null`,
// which a static object literal cannot construct. It builds as a checked-
// dynamic object instead. Before: "values of type 'null' have no static
// representation".
let head = { value: 1, next: null };
let current = head;
current = current.next = { value: 7, next: null };
console.log(head.next.value, current.value, head.value);
