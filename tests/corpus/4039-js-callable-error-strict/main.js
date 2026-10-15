// The legacy callable error constructors: `Error(msg)` without `new`
// constructs exactly as `new Error(msg)` does, and real code mixes the
// spellings — React's shipped production build throws a bare `Error()` in
// its fast paths, where this was found.
//
// The tsconfig beside this program is part of the evidence: under
// `strict` + the ES2023 lib + NodeNext resolution the bare form resolves to
// the `Error` constructor VALUE unless the lowering recognises the call, so
// the program compiled but handed back the constructor's fence at runtime
// (the whole vendored react.js hit this 4 times, and the reconciler 98).
function Component(props) {
  this.props = props;
}
Component.prototype.setState = function (partialState, callback) {
  if ("object" !== typeof partialState &&
      "function" !== typeof partialState &&
      null != partialState) {
    throw Error("takes an object of state variables to update or a function which returns an object of state variables.");
  }
  this.props = partialState;
};
const c = new Component(1);
try {
  c.setState({ ok: true });
  console.log("set", c.props.ok);
  c.setState(5);
} catch (e) {
  console.log(e instanceof Error, e.message.slice(0, 20));
}
