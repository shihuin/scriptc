import { expect, test, vi } from "vitest";
import { F64, JSVAL, funcOf, type IrGlobal, type IrLocal } from "../../ir/ir.js";
import { SyntaxKind, type Expression, type Identifier, type Program, type SourceFile, type Type } from "../ts7/adapter.js";
import { isIslandExpr } from "./lower-island.js";
import { Lowerer } from "./lowerer.js";

const identifier = { kind: SyntaxKind.Identifier, text: "value" } as Identifier;
const context = (dynamic: boolean) => new Lowerer({ getTypeChecker: () => ({}) } as Program, { fileName: "island.ts" } as SourceFile, [], dynamic);

test("static island probes do not query the checker or map receiver and callee types", () => {
  const lowerer = context(false);
  const typeOf = vi.spyOn(lowerer, "typeOf");
  const mapTypeOf = vi.spyOn(lowerer, "mapTypeOf");
  const peekLocal = vi.spyOn(lowerer, "peekLocal");
  const globalOf = vi.spyOn(lowerer, "globalOf");
  for (const kind of [SyntaxKind.Identifier, SyntaxKind.PropertyAccessExpression, SyntaxKind.ElementAccessExpression, SyntaxKind.CallExpression]) {
    expect(isIslandExpr(lowerer, { kind } as Expression)).toBe(false);
  }
  expect(typeOf).not.toHaveBeenCalled();
  expect(mapTypeOf).not.toHaveBeenCalled();
  expect(peekLocal).not.toHaveBeenCalled();
  expect(globalOf).not.toHaveBeenCalled();
});

test("dynamic island probes preserve checker mapping and the current binding's representation", () => {
  const lowerer = context(true);
  vi.spyOn(lowerer, "typeOf").mockReturnValue({} as Type);
  const mapTypeOf = vi.spyOn(lowerer, "mapTypeOf").mockReturnValue(JSVAL);
  const peekLocal = vi.spyOn(lowerer, "peekLocal").mockReturnValue(null);
  const globalOf = vi.spyOn(lowerer, "globalOf").mockReturnValue(null);
  expect(isIslandExpr(lowerer, identifier)).toBe(true);

  mapTypeOf.mockReturnValue(funcOf([], F64));
  expect(isIslandExpr(lowerer, identifier)).toBe(false);
  globalOf.mockReturnValue({ type: JSVAL } as IrGlobal);
  expect(isIslandExpr(lowerer, identifier)).toBe(true);
  // A native local shadows the island global; probes must see scope changes.
  peekLocal.mockReturnValue({ type: F64 } as IrLocal);
  expect(isIslandExpr(lowerer, identifier)).toBe(false);
  peekLocal.mockReturnValue({ type: JSVAL } as IrLocal);
  expect(isIslandExpr(lowerer, identifier)).toBe(true);
  mapTypeOf.mockReturnValue(null);
  expect(isIslandExpr(lowerer, identifier)).toBe(true);
});

test("dynamic promise bindings retain checker dispatch even when stored as island handles", () => {
  const lowerer = context(true);
  vi.spyOn(lowerer, "typeOf").mockReturnValue({} as Type);
  vi.spyOn(lowerer, "mapTypeOf").mockReturnValue({ kind: "promise", inner: F64 });
  const peekLocal = vi.spyOn(lowerer, "peekLocal").mockReturnValue({ type: JSVAL } as IrLocal);
  vi.spyOn(lowerer, "globalOf").mockReturnValue({ type: JSVAL } as IrGlobal);
  expect(isIslandExpr(lowerer, identifier)).toBe(false);
  peekLocal.mockReturnValue(null);
  expect(isIslandExpr(lowerer, identifier)).toBe(false);
});
