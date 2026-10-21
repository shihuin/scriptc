/* View-shape elision (ir/shape-elision.ts): a never-constructed narrowing
 * shape borrows the wider shape's layout and its conversion becomes a share.
 * These tests pin the decision and its two observable contracts: the layout
 * follows the source (so a physical source value reads and frees correctly
 * through the view) and the declared keys do not (JSON of a view-shaped
 * value keeps the view's own keys). */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../index.js";
import type { IrModule, IrRecordShape } from "./ir.js";

/** Compile a source program and hand back its module. */
async function moduleFor(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-shape-elision-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return deserializeModule(await readFile(output, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function shapeOf(mod: IrModule, predicate: (shape: IrRecordShape) => boolean): IrRecordShape {
  const found = (mod.records ?? []).find(predicate);
  if (!found) throw new Error("shape not found");
  return found;
}

/** A view: `Narrow` reads through `Wide` and nothing ever builds a Narrow. */
const VIEW = `
interface Wide { a: string; b: string; c: string; d: string }
interface Narrow { a: string; c: string }
function use(n: Narrow): number { return n.a.length + n.c.length; }
function make(): Wide { return { a: "x", b: "B", c: "y", d: "D" }; }
console.log(use(make()));
`;

test("a never-constructed narrowing shape borrows the source layout", async () => {
  const mod = await moduleFor(VIEW);
  const view = shapeOf(mod, (s) => s.aliasedTo !== undefined);
  const source = shapeOf(mod, (s) => s.id === view.aliasedTo);
  // The layout is the source's: every GEP, entry point and release walk
  // follows these slots.
  expect(view.fields.map((f) => f.name)).toEqual(source.fields.map((f) => f.name));
  // The observable surfaces follow the source too: a narrowed value IS the
  // source object in the language (the narrowing never made a new one), so
  // reflection over it sees the source's keys in the source's order.
  expect(view.declaredOrder ?? []).toEqual(source.declaredOrder ?? []);
  // The source is wide enough to hold the view's fields at its own slots.
  expect(source.fields.map((f) => f.name).sort()).toEqual(["a", "b", "c", "d"]);
});

test("the width conversion becomes a share of the same reference", async () => {
  const mod = await moduleFor(VIEW);
  const view = shapeOf(mod, (s) => s.aliasedTo !== undefined);
  const helper = (mod.functions ?? []).find((f) => f.name.startsWith("%rec.width."));
  expect(helper).toBeDefined();
  // One statement: `return upcast(r)` — no allocation, no field copies.
  expect(helper!.body).toHaveLength(1);
  const ret = helper!.body[0]!;
  expect(ret.kind).toBe("return");
  const value = (ret as { value: { kind: string; value?: { kind: string } } }).value;
  expect(value.kind).toBe("upcast");
  expect(value.value?.kind).toBe("varRef");
  expect((ret as { value: { type: { shapeId?: string } } }).value.type.shapeId).toBe(view.id);
});

test("a constructed narrow shape keeps its own layout", async () => {
  const mod = await moduleFor(`
interface Wide { a: string; b: string; c: string; d: string }
interface Narrow { a: string; c: string }
function use(n: Narrow): number { return n.a.length + n.c.length; }
const n: Narrow = { a: "x", c: "y" };
console.log(use(n));
`);
  // The literal builds a Narrow, so its shape is not a view: no alias, and
  // its own compact layout is what the struct uses.
  const narrow = shapeOf(mod, (s) => s.fields.length === 2);
  expect(narrow.aliasedTo).toBeUndefined();
  expect(narrow.declaredOrder ?? []).toEqual(["a", "c"]);
});

test("the view's release walks the source's fields, not just its own", async () => {
  const mod = await moduleFor(VIEW);
  const view = shapeOf(mod, (s) => s.aliasedTo !== undefined);
  // A physical Wide destroyed through the Narrow release must free every
  // refcounted field — which is what the layout-ordered walk does.
  expect(view.fields.filter((f) => f.type.kind === "string").map((f) => f.name)).toEqual([
    "a",
    "b",
    "c",
    "d",
  ]);
});
