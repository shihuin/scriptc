import { expect, test } from "vitest";
import { DYN, F64, VOID, funcOf, type IrExpr, type IrFunction, type IrLocal, type IrModule, type IrStmt } from "../ir/ir.js";
import { computeMayThrow } from "./may-throw.js";

const loc = { file: "tdz.ts", start: 0, end: 1 };
const value: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
const local: IrLocal = { id: "value", name: "value", type: F64, mutable: true, boxed: true, tdz: true };
function fn(name: string, body: IrStmt[], locals: IrLocal[] = [local]): IrFunction {
  return { name, body, locals, params: [], returnType: VOID, loc };
}
function moduleWith(...functions: IrFunction[]): IrModule {
  return { irVersion: 13, sourceFile: loc.file, entry: "caller", functions };
}
const assignment: IrStmt = { kind: "assign", localId: local.id, value, loc };
const expression: IrExpr = { kind: "assignExpr", localId: local.id, value, type: F64, loc };
const increment: IrExpr = { kind: "incDec", localId: local.id, op: "+", prefix: false, type: F64, loc };
const read: IrExpr = { kind: "varRef", localId: local.id, type: F64, loc };
const exprStmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });

test.each([
  ["store", assignment],
  ["assignment expression", exprStmt(expression)],
  ["increment", exprStmt(increment)],
  ["read", exprStmt(read)],
] as const)("TDZ %s propagates through the direct call graph", (_name, operation) => {
  const target = fn("target", [operation]);
  const middle = fn("middle", [exprStmt({ kind: "call", callee: "target", args: [], type: VOID, loc })], []);
  const caller = fn("caller", [exprStmt({ kind: "call", callee: "middle", args: [], type: VOID, loc })], []);
  const answer = computeMayThrow(moduleWith(caller, middle, target));
  expect([...answer.fns].sort()).toEqual(["caller", "middle", "target"]);
  expect(answer.indirect).toBe(false);
});

test("TDZ stores seed indirect-call propagation", () => {
  const closure: IrExpr = { kind: "closure", fnName: "target", captures: [], type: funcOf([], VOID), loc };
  const caller = fn("caller", [exprStmt({ kind: "callValue", callee: closure, args: [], type: VOID, loc })], []);
  const answer = computeMayThrow(moduleWith(caller, fn("target", [assignment])));
  expect(answer.indirect).toBe(true);
  expect([...answer.fns].sort()).toEqual(["caller", "target"]);
});

test.each([true, false])("declaration stores do not throw solely for TDZ (mutable=%s)", (mutable) => {
  const initialize: IrStmt = { ...assignment, initializes: true };
  expect(computeMayThrow(moduleWith(fn("caller", [initialize], [{ ...local, mutable }]))).fns.size).toBe(0);
});

test("legacy const TDZ stores remain initialization", () => {
  const immutable = { ...local, mutable: false };
  expect(computeMayThrow(moduleWith(fn("caller", [assignment], [immutable]))).fns.size).toBe(0);
});

test("ordinary boxed stores do not gain an exception edge", () => {
  const ordinary: IrLocal = { id: local.id, name: local.name, type: F64, mutable: true, boxed: true };
  expect(computeMayThrow(moduleWith(fn("caller", [assignment, exprStmt(expression), exprStmt(increment)], [ordinary]))).fns.size).toBe(0);
});

test("initializers still propagate exceptions from their right-hand side", () => {
  const initialize: IrStmt = {
    ...assignment, initializes: true,
    value: { kind: "call", callee: "failure", args: [], type: F64, loc },
  };
  const failure = fn("failure", [{ kind: "throw", value, loc }], []);
  expect([...computeMayThrow(moduleWith(fn("caller", [initialize]), failure)).fns].sort()).toEqual(["caller", "failure"]);
});

const call = (callee: string): IrStmt => exprStmt({ kind: "call", callee, args: [], type: VOID, loc });
const closureOf = (fnName: string): IrExpr => ({ kind: "closure", fnName, captures: [], type: funcOf([], VOID), loc });
const callClosure = (fnName: string): IrStmt => exprStmt({ kind: "callValue", callee: closureOf(fnName), args: [], type: VOID, loc });
const failure: IrStmt = { kind: "throw", value, loc };

test("propagates through a long caller-first chain without recursive graph traversal", () => {
  const size = 6000;
  const functions = Array.from({ length: size }, (_, i) => fn(`fn${i}`, [i === size - 1 ? failure : call(`fn${i + 1}`)], []));
  for (const order of [functions, [...functions].reverse()]) {
    const answer = computeMayThrow(moduleWith(...order));
    expect(answer.indirect).toBe(false);
    expect(answer.fns).toEqual(new Set(functions.map((f) => f.name)));
  }
});

test("recursive components only throw when they reach a throwing seed", () => {
  const mod = moduleWith(
    fn("caller", [call("left"), call("left")], []),
    fn("left", [call("right")], []),
    fn("right", [call("left")], []),
    fn("pure", [call("pure")], []),
  );
  expect(computeMayThrow(mod).fns.size).toBe(0);
  mod.functions[2]!.body.push(failure);
  expect(computeMayThrow(mod).fns).toEqual(new Set(["caller", "left", "right"]));
});

test("a transitively throwing closure activates indirect callers and their callers", () => {
  const mod = moduleWith(
    fn("outer", [call("indirect")], []),
    fn("indirect", [callClosure("wrapper")], []),
    fn("wrapper", [call("target")], []),
    fn("target", [failure], []),
    fn("otherIndirect", [callClosure("pure")], []),
    fn("pure", [], []),
  );
  const before = structuredClone(mod);
  const answer = computeMayThrow(mod);
  expect(answer.indirect).toBe(true);
  expect(answer.fns).toEqual(new Set(["outer", "indirect", "wrapper", "target", "otherIndirect"]));
  expect(mod).toEqual(before);
  mod.functions[3]!.body = [];
  expect(computeMayThrow(mod)).toEqual({ fns: new Set(), indirect: false });
  expect(answer.fns.size).toBe(5);
});

test.each(["async", "generator", "async generator"])("a throwing %s body does not unwind direct or indirect callers", (kind) => {
  const target = fn("target", [failure], []);
  if (kind.includes("async")) target.async = true;
  if (kind.includes("generator")) target.generator = { yieldT: F64, nextT: VOID, resultType: { kind: "record", shapeId: "result" } };
  const mod = moduleWith(fn("caller", [call("target"), callClosure("target")], []), target);
  expect(computeMayThrow(mod)).toEqual({ fns: new Set(["target"]), indirect: false });
});

test("dynamic function adapters activate indirect calls without an IR closure target", () => {
  const adapter: IrExpr = {
    kind: "dynCheck", value: { kind: "varRef", localId: "unknown", type: DYN, loc },
    type: funcOf([], VOID), loc,
  };
  const callee: IrExpr = { kind: "varRef", localId: "callback", type: funcOf([], VOID), loc };
  const mod = moduleWith(
    fn("caller", [call("indirect")], []),
    fn("indirect", [exprStmt({ kind: "callValue", callee, args: [], type: VOID, loc })], []),
    fn("adapter", [exprStmt(adapter)], []),
  );
  expect(computeMayThrow(mod)).toEqual({ fns: new Set(["caller", "indirect", "adapter"]), indirect: true });
});
