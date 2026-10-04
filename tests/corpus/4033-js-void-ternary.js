// A ternary whose arms are void, in a position whose value is discarded.
//
// A ternary is a VALUE and the validator rejects a void-typed one, so this
// used to reach the validator and stop with an internal error. The value of a
// void call is `undefined`, which the checked-dynamic tree represents.
function left() { console.log("left"); }
function right() { console.log("right"); }
const flag = 1 > 0;
flag ? left() : right();
!flag ? left() : right();
console.log(flag ? "taken" : "not taken");
