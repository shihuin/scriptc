// The reconciler's shape: a void ternary under `&&`, with a DYN property
// comparison as the condition and inner functions taking implicit-any
// parameters as the arms (React's commitLayoutEffectOnFiber work loop).
function work(finishedWork, flags) {
  function safelyAttachRef(current, nearestMountedAncestor) {
    var ref, refCleanup;
    ref = current.ref;
    refCleanup = current.refCleanup;
    if (null !== ref) {
      if ("function" === typeof refCleanup) refCleanup();
    }
  }
  function safelyDetachRef(current, nearestMountedAncestor) {
    var ref;
    ref = current.ref;
    if (null !== ref) ref = null;
  }
  flags & 512 &&
    ("manual" === finishedWork.memoizedProps.mode
      ? safelyAttachRef(finishedWork, finishedWork.return)
      : safelyDetachRef(finishedWork, finishedWork.return));
}
work({ memoizedProps: { mode: "manual" }, ref: null, refCleanup: null, return: null }, 512);
work({ memoizedProps: { mode: "auto" }, ref: null, refCleanup: null, return: null }, 512);
console.log("done");
