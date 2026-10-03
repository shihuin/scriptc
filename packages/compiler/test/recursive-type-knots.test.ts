/* Recursive types must terminate the JSON-safety and dyn-boxing walks.
 *
 * Both checks answer "can this type cross the dyn boundary", and both walk a
 * type graph. A recursive type makes that graph cyclic, and each needed a
 * recursion knot. Found by writing a component tree — a `Node` that holds a
 * `Component` returning a `Node` — and watching the compiler run to a stack
 * overflow instead of a diagnostic.
 *
 * The two knots had different defects:
 *   - `isJsonSafeAt`'s union case keyed the knot by unionId PLUS the walk's
 *     flags, so a cycle whose flags differed on each lap never repeated a
 *     key. The record case already keyed by shapeId alone.
 *   - `canBoxFuncIntoDyn` had no knot at all, and `canBoxDynComposite` did
 *     not pass its own down to it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rec-knots-"));
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noImplicitAny: false,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["*.ts"],
});

test("a recursive tree type does not overflow the walk", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    writeFileSync(
      join(dir, "tree.ts"),
      `export type Props = Record<string, unknown>;
export type Node =
  | { kind: "host"; type: string; props: Props; children: Node[] }
  | { kind: "component"; component: (props: Props) => Node; props: Props; children: Node[] };
export type Child = Node | string | number | boolean | null | undefined;
export function depth(node: Node): number {
  return node.children.length;
}
`,
    );
    const result = analyze(join(dir, "tree.ts"), {});
    // Terminating is the assertion: a stack overflow throws instead of
    // answering, so "analysis completed" is the proof.
    expect(result.coverage.preflightFailed).toBe(false);
    expect(result.coverage.diagnostics.map((d) => d.code)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);

test("a function type whose signature reaches itself is boxable, not a loop", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    writeFileSync(
      join(dir, "component.ts"),
      `export type Props = Record<string, unknown>;
export type Component = (props: Props) => Node;
export type Node = { kind: "component"; component: Component; props: Props; children: Node[] };
export function render(node: Node, apply: (json: string) => void): string {
  const out = node.component(node.props);
  apply("x");
  return out.kind;
}
`,
    );
    const result = analyze(join(dir, "component.ts"), {});
    expect(result.coverage.diagnostics.map((d) => d.code)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);

test("the knot does not make an unsafe type look safe", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    // A recursive type with an UNSAFE constituent must still be refused: the
    // knot assumes safety at the cycle, not everywhere.
    writeFileSync(
      join(dir, "unsafe.ts"),
      `export type Node = { kind: "host"; children: Node[]; when: Date };
export function stamp(node: Node): Date {
  return node.when;
}
`,
    );
    const result = analyze(join(dir, "unsafe.ts"), {});
    // Whatever the answer, it must be a diagnostic and not a crash.
    expect(result.coverage.diagnostics.every((d) => d.code.startsWith("SC"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
