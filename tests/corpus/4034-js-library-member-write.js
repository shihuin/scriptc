// A dot write to a member with no static slot, on a LIBRARY receiver.
//
// `Error.stack` has no static representation and no program class to place it
// on, so every existing path declines and the statement used to reach the
// generic "assignment to non-variables" fence — which named neither the
// receiver nor the member. The keyed dynamic write is used instead.
const err = new Error("boom");
err.stack = "cleared";
console.log(err.message, err.stack === "cleared");
