import type { IrModule, IrType } from "../ir/ir.js";
import { funcOf, mapOf, RUNTIME_EMITTER_CLASS, STRING, VOID } from "../ir/ir.js";

/** Cycle capability for native code generation.
 * Greatest fixpoint over shapes and unions: start optimistic (everything
 * cycle-capable), repeatedly drop shapes with no cycle-capable field and
 * unions with no cycle-capable arm until stable. Closures, checked values and promises
 * are always cycle-capable; strings never are; arrays/Sets inherit their
 * element type's capability and Maps inherit either key or value capability.
 * A HIERARCHY is one unit of capability
 * (a base-typed slot can hold any subclass and retain touches the cycle
 * header, so header presence must be uniform across an extends tree): a
 * unit is cycle-capable iff ANY member is — every backend uses the same grouping. */
export function computeTraced(mod: IrModule): { shapes: Set<string>; unions: Set<string> } {
  const classes = mod.classes ?? [];
  const shapeDefs = [
    ...classes.map((c) => ({
      key: `object:${c.name}`,
      fields: [
        ...c.fields,
        ...(c.name === RUNTIME_EMITTER_CLASS ? [{ name: "<listeners>", type: funcOf([], VOID) }] : []),
        ...(c.localCaptures !== undefined ? [{ name: "<class>", type: { kind: "classval" as const, className: c.name } }] : []),
      ],
    })),
    ...(mod.records ?? []).map((r) => ({
      key: `record:${r.id}`,
      fields: r.indexValue
        ? [...r.fields, { name: "<overflow>", type: mapOf(STRING, r.indexValue) }]
        : r.fields,
    })),
  ];
  // Hierarchy units: root lookup over the base links (classes with a base
  // or a subclass — and the runtime emitter class — form units under their
  // root; standalone classes and records stay singleton units).
  const baseOf = new Map(classes.map((c) => [c.name, c.base ?? null] as const));
  const roots = new Map<string, string>();
  const rootOf = (name: string): string => {
    let cur = name;
    const path: string[] = [];
    while (!roots.has(cur)) {
      path.push(cur);
      const base = baseOf.get(cur);
      if (base === null || base === undefined) break;
      cur = base;
    }
    cur = roots.get(cur) ?? cur;
    for (const member of path) roots.set(member, cur);
    return cur;
  };
  interface Capability {
    intrinsic: boolean;
    dependencies: Set<Capability>;
    dependents: Capability[];
    remaining: number;
  }
  const capability = (): Capability => ({ intrinsic: false, dependencies: new Set(), dependents: [], remaining: 0 });
  const units = new Map<string, Capability>();
  const shapes = new Map<string, Capability>();
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, capability()]));
  for (const s of shapeDefs) {
    const key = s.key.startsWith("object:") ? `object:${rootOf(s.key.slice("object:".length))}` : s.key;
    let unit = units.get(key);
    if (!unit) units.set(key, (unit = capability()));
    shapes.set(s.key, unit);
  }
  // Each field/arm is an OR of intrinsic capability and referenced units.
  // Flatten collections into these edges; repeated references count once.
  const addType = (unit: Capability, t: IrType): void => {
    if (unit.intrinsic) return;
    switch (t.kind) {
      case "func":
      case "dyn":
      case "classval":
      case "promise":
      case "caught":
        unit.intrinsic = true;
        unit.dependencies.clear();
        break;
      case "object":
      case "record":
      case "union": {
        const dependency = t.kind === "union" ? unions.get(t.unionId)
          : shapes.get(t.kind === "object" ? `object:${t.className}` : `record:${t.shapeId}`);
        if (dependency) unit.dependencies.add(dependency);
        break;
      }
      case "map":
        addType(unit, t.key);
        addType(unit, t.value);
        break;
      case "set":
      case "array":
        addType(unit, t.elem);
        break;
    }
  };
  for (const s of shapeDefs) for (const field of s.fields) addType(shapes.get(s.key)!, field.type);
  for (const u of mod.unions ?? []) for (const arm of u.arms) addType(unions.get(u.id)!, arm);
  const pending: Capability[] = [];
  for (const unit of [...units.values(), ...unions.values()]) {
    unit.remaining = unit.dependencies.size;
    for (const dependency of unit.dependencies) dependency.dependents.push(unit);
    if (!unit.intrinsic && unit.remaining === 0) pending.push(unit);
  }
  // Peel incapable leaves. Units in cycles retain a dependency, and units
  // containing intrinsic references never enter the removal queue.
  for (let i = 0; i < pending.length; i++) {
    for (const dependent of pending[i]!.dependents) {
      if (--dependent.remaining === 0 && !dependent.intrinsic) pending.push(dependent);
    }
  }
  const retained = (unit: Capability): boolean => unit.intrinsic || unit.remaining > 0;
  const tracedShapes = new Set([...shapes].filter(([, unit]) => retained(unit)).map(([key]) => key));
  const tracedUnions = new Set([...unions].filter(([, unit]) => retained(unit)).map(([id]) => id));
  return { shapes: tracedShapes, unions: tracedUnions };
}
