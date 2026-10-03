// Increment of a dynamic local whose READ a loop condition narrowed.
//
// `index < xs.length` narrows `index` to a number inside the body while its
// storage stays checked-dynamic, so `index++` hands a narrowed read to
// `dyn.toNumeric`, which takes a dynamic argument. Found vendoring
// react-reconciler, whose work loops are exactly this shape
// (`fiber = hostRoot[index++]`) — five internal compiler errors there, and
// the same shape reached as a fence in other programs.
let xs;
xs = [10, 20, 30, 40];
let index;
index = 0;
let fiber;
let seen = 0;
for (; index < xs.length; ) {
  fiber = xs[index++];
  seen++;
}
console.log("fiber", fiber, "index", index, "seen", seen);
// The decrement spelling and a comparison guard, so both arms of the
// increment path are pinned.
let down;
down = 3;
for (; down > 0; ) {
  down--;
}
console.log("down", down);
