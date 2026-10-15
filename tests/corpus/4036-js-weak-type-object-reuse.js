// An object with no properties in common flowing into a weak type (every
// property optional): the shape a minified or flow-compiled library
// produces when one unannotated name is reused across scopes for unrelated
// values. tsc flags the assignment TS2559, a strictness family that exists
// to demand annotations a JavaScript author cannot write — relaxed for the
// JS lane like its siblings. The value stays loose: the object keeps its
// own shape and identity, exactly as Node runs it.
/** @type {{ a?: number }} */
let w = {};
const b = { b: 1 };
w = b;
console.log(w, w === b);
