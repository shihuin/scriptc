/* View-shape elision: when a record shape is never constructed and its
 * fields are a subset of exactly one other shape's, its values ARE that
 * shape's values at runtime — so it borrows the wider shape's layout and the
 * width coercion between them shares the value instead of copying it.
 *
 * This is the compiler paying for a divergence from the language: TypeScript
 * narrows structurally and for free (`syncSubtree({ ..., children })` shares
 * `children` with the caller), while a nominal record layout had to rebuild
 * the value — and for an array field whose element narrows, deep-copy the
 * subtree. That copy is 6.3% of the instructions in the twelve-workload
 * benchmark suite, plus an allocation storm (one record and one array per
 * node per frame) on top of it.
 *
 * The rule is deliberately narrow, and a miss costs a copy, never
 * correctness:
 *
 *   - the view is never constructed here (no recordLit, no recordClone, no
 *     dyn conversion, no call returning one), so its layout can be the
 *     source's without wasting a byte on any value the program builds;
 *   - exactly one candidate source (two would leave the layout ambiguous);
 *   - the source's fields are a superset by name, and shared fields match
 *     pairwise, recursively allowing this same relation on nested records
 *     and arrays (`ElementSpec[]` ≡ `Node[]` once the elements alias).
 *
 * What changes: the view's `fields` become the LAYOUT (the source's list, so
 * every GEP, entry point and walker follows it) while its declared list is
 * kept in `declaredFields` for the observable side — the dyn/JSON reflection
 * table, where a JS program sees only the declared keys. Conversion helpers
 * between alias-related shapes lose their call sites to `upcast`: the same
 * reference, ownership included, which is what the language semantics say it
 * always was.
 */
import type { IrFunction, IrModule, IrRecordShape, IrStmt, IrType } from "./ir.js";
import { typeKey } from "./ir.js";
import { everyStmtList, transformStmtList } from "./traverse.js";

/** The width conversion helpers this pass rewrites (`%rec.width.N` and
 * `%arr.width.N`); see `conversionPair`. */
function isConversionHelper(name: string): boolean {
  return name.startsWith("%rec.width.") || name.startsWith("%arr.width.");
}

/** Every width conversion helper, including the class→record and tuple→array
 * variants the elision does not rewrite but must still count as producers. */
function isWidthHelper(name: string): boolean {
  return isConversionHelper(name) || name.startsWith("%obj.width.") || name.startsWith("%tup.arr.");
}

/** Expression kinds that only ever READ an existing value. Anything else
 * can materialize a fresh record of its result type (a literal, a clone, a
 * dyn conversion, a lib result, a call, an awaited value, a resolvers
 * record...), which is all this pass needs to know to leave the shape
 * alone. The list is deliberately short: a kind that is wrongly treated as a
 * producer only costs the optimization. */
const READER_KINDS = new Set([
  "varRef",
  "recordGet",
  "fieldGet",
  "arrayGet",
  "recordKeyGet",
  "ternary",
  "logical",
  "nullish",
  "optChain",
  "seqExpr",
  "upcast",
  "downcast",
  "unionNarrow",
  "recordHas",
  "recordOvfHas",
]);

/** Shapes that materialize a fresh record of their own result type. */
function constructionSites(mod: IrModule): Set<string> {
  const constructed = new Set<string>();
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, u]));
  // A shape reached through a container or a SIGNATURE is built by whoever
  // materializes that container or calls that signature — a lib thunk that
  // hands a record to a callback, an array of them, a union arm.
  const builds = (t: IrType): void => {
    switch (t.kind) {
      case "record":
        constructed.add(t.shapeId);
        return;
      case "array":
        builds(t.elem);
        return;
      case "union":
        for (const arm of unions.get(t.unionId)?.arms ?? []) builds(arm);
        return;
      case "func":
        for (const param of t.params) builds(param);
        builds(t.ret);
        return;
      case "map":
        builds(t.key);
        builds(t.value);
        return;
      case "set":
        builds(t.elem);
        return;
      default:
        return;
    }
  };
  for (const fn of mod.functions ?? []) {
    // The width conversion helpers build their target on purpose — that
    // allocation is the copy this pass exists to delete, so it is not
    // evidence that the program constructs the shape.
    if (isConversionHelper(fn.name)) continue;
    everyStmtList(fn.body ?? [], {
      expr: (e) => {
        // Neither are the calls to those helpers.
        if (e.kind === "call" && isConversionHelper(e.callee)) return true;
        if (!READER_KINDS.has(e.kind)) builds(e.type);
        return true;
      },
      stmt: () => true,
    });
  }
  return constructed;
}

/** Accessor slots (`%get:x`), codec state and other reserved fields. */
function hasInternalFields(shape: IrRecordShape): boolean {
  return shape.fields.some((f) => f.name.startsWith("%"));
}

function fieldType(shape: IrRecordShape, name: string): IrType | null {
  return shape.fields.find((f) => f.name === name)?.type ?? null;
}

/**
 * `a` and `b` are the same representation, allowing the alias relation being
 * proved (`assume`) for nested record shapes. Arrays compare their elements;
 * everything else must be the identical type (same key), which keeps unions
 * and primitive wrappers out of the relation.
 */
function compatible(
  a: IrType,
  b: IrType,
  shapes: ReadonlyMap<string, IrRecordShape>,
  assume: ReadonlySet<string>,
  candidates: ReadonlyMap<string, string>,
): boolean {
  if (a.kind === "array" && b.kind === "array")
    return compatible(a.elem, b.elem, shapes, assume, candidates);
  if (a.kind === "record" && b.kind === "record") {
    if (a.shapeId === b.shapeId) return true;
    const pair = `${a.shapeId}\u0000${b.shapeId}`;
    if (assume.has(pair)) return true;
    if (candidates.get(a.shapeId) !== b.shapeId) return false;
    const view = shapes.get(a.shapeId),
      source = shapes.get(b.shapeId);
    if (!view || !source) return false;
    return narrowsTo(view, source, shapes, new Set([...assume, pair]), candidates);
  }
  return typeKey(a) === typeKey(b);
}

/** Every field of `view` exists in `source` with a compatible type. */
function narrowsTo(
  view: IrRecordShape,
  source: IrRecordShape,
  shapes: ReadonlyMap<string, IrRecordShape>,
  assume: Set<string>,
  candidates: ReadonlyMap<string, string>,
): boolean {
  for (const field of view.fields) {
    const other = fieldType(source, field.name);
    if (other === null) return false;
    if (!compatible(field.type, other, shapes, assume, candidates)) return false;
  }
  return true;
}

/**
 * Elide every view shape in `mod`, then share the conversions that became
 * identity. Mutates the module in place; safe to run once, after lowering
 * and before codegen.
 */
export function elideViewShapes(mod: IrModule): void {
  const records = mod.records;
  if (!records || records.length === 0) return;
  const shapes = new Map<string, IrRecordShape>(records.map((r) => [r.id, r]));
  const constructed = constructionSites(mod);

  // One candidate source per view. Tuples and index-signature shapes keep
  // their own layouts: their field lists mean something else entirely.
  // Every conversion helper that PRODUCES a shape, and from what. A shape
  // can only be re-represented when the one shape it narrows is the only
  // thing that ever produces it: a value converted from some other shape is
  // not a source value, so its slots are not the source's.
  const producers = new Map<string, Set<string>>();
  for (const fn of mod.functions ?? []) {
    if (!isWidthHelper(fn.name)) continue;
    const target = fn.returnType.kind === "record" ? fn.returnType.shapeId : null;
    if (target === null) continue;
    const param = fn.params[0]?.type;
    const source =
      param?.kind === "record" ? param.shapeId : param?.kind === "object" ? param.className : "";
    const set = producers.get(target) ?? new Set<string>();
    set.add(source);
    producers.set(target, set);
  }

  const unionArms = new Set<string>();
  for (const union of mod.unions ?? [])
    for (const arm of union.arms) if (arm.kind === "record") unionArms.add(arm.shapeId);

  const candidates = new Map<string, string>();
  for (const view of records) {
    if (constructed.has(view.id) || view.tuple === true || view.indexValue !== undefined) continue;
    // A union arm's representation is its identity: two arms of one union
    // must stay distinguishable (a discriminant field especially).
    if (unionArms.has(view.id)) continue;
    if (view.aliasedTo !== undefined) continue;
    // Internal '%'-slots (accessor closures, codec state) carry per-shape
    // semantics the layout cannot borrow; leave those shapes alone.
    if (hasInternalFields(view)) continue;
    let found: string | null = null;
    for (const source of records) {
      if (source.id === view.id) continue;
      if (source.tuple === true || source.indexValue !== undefined) continue;
      if (unionArms.has(source.id)) continue;
      if (hasInternalFields(source)) continue;
      if (source.fields.length <= view.fields.length) continue;
      if (!view.fields.every((f) => fieldType(source, f.name) !== null)) continue;
      if (found !== null) {
        found = null; // ambiguous
        break;
      }
      found = source.id;
    }
    if (found !== null) {
      const produced = producers.get(view.id);
      if (produced === undefined || [...produced].every((from) => from === found))
        candidates.set(view.id, found);
    }
  }

  for (const [viewId, sourceId] of [...candidates]) {
    const view = shapes.get(viewId)!,
      source = shapes.get(sourceId)!;
    if (!narrowsTo(view, source, shapes, new Set([`${viewId}\u0000${sourceId}`]), candidates)) {
      candidates.delete(viewId);
      continue;
    }
    // Full transparency: the view IS the source at runtime, so its layout,
    // its keys and their order are the source's. A JS program that reflects
    // on the value sees the source's shape — the narrowing never made a new
    // object — which is exactly what sharing says.
    view.aliasedTo = sourceId;
    view.declaredOrder = source.declaredOrder ?? source.fields.map((f) => f.name);
    // The slots are the source's; the TYPES at the shared slots stay the
    // view's own. The two are storage-identical by the proof above (same
    // kind, aliased records, identical scalars), so a physical source value
    // reads correctly through either spelling — and a read of the view's
    // field keeps answering the view's type, which is what the rest of the
    // IR was built against.
    const own = new Map(view.fields.map((f) => [f.name, f.type] as const));
    view.fields = source.fields.map((f) => ({ name: f.name, type: own.get(f.name) ?? f.type }));
  }
  if (candidates.size === 0) return;

  for (const fn of mod.functions ?? []) {
    fn.body = shareCalls(fn.body ?? [], candidates);
    // The conversion helper itself becomes the share: `return upcast(r)`,
    // the same reference under the target type. Its old body (rebuild the
    // value field by field) is exactly the copy this pass deletes.
    const pair = conversionPair(fn.name, fn.params[0]?.type, fn.returnType);
    if (pair !== null && candidates.get(pair[1]) === pair[0]) fn.body = shareBody(fn);
  }
}

/** Replace `call %rec.width.N(x)` / `call %arr.width.N(xs)` with `upcast`
 * of the same operand once the two shapes share a representation. The
 * operand keeps its ownership: `upcast` is the same reference. */
function shareCalls(body: IrStmt[], candidates: ReadonlyMap<string, string>): IrStmt[] {
  return transformStmtList(body, {
    expr: (e) => {
      if (e.kind !== "call") return e;
      const pair = conversionPair(e.callee, e.args[0]?.type, e.type);
      if (pair === null || candidates.get(pair[1]) !== pair[0]) return e;
      return { kind: "upcast", value: e.args[0]!, type: e.type, loc: e.loc };
    },
    stmt: (s) => s,
  });
}

/** The two shape ids a width conversion converts (call site or helper), or
 * null. */
function conversionPair(
  name: string,
  from: IrType | undefined,
  to: IrType,
): [string, string] | null {
  if (!isConversionHelper(name) || from === undefined) return null;
  const source = from.kind === "record" ? from.shapeId : elemShape(from);
  const target = to.kind === "record" ? to.shapeId : elemShape(to);
  return source !== null && target !== null ? [source, target] : null;
}

/** `return upcast(param)`: the conversion is the same reference, typed as
 * the target. */
function shareBody(fn: IrFunction): IrFunction["body"] {
  const param = fn.params[0]!;
  const loc = fn.loc;
  return [
    {
      kind: "return",
      value: {
        kind: "upcast",
        value: { kind: "varRef", localId: param.localId, type: param.type, loc },
        type: fn.returnType,
        loc,
      },
      loc,
    } as IrFunction["body"][number],
  ];
}

function elemShape(t: IrType): string | null {
  return t.kind === "array" && t.elem.kind === "record" ? t.elem.shapeId : null;
}

/** Map `fn` over every expression of a node, rebuilding the node around the
 * answers (shallow: `fn` sees each expression with its children already
 * rewritten when `mapExprChildren` is used bottom-up). */
