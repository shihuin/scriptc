/* JSX compiler options are ADOPTED from the project tsconfig.
 *
 * They are a project-level decision (which runtime elements lower to, and
 * which package owns the factory), so they belong to the same adopted subset
 * as strictness and import interop. Before this, every .tsx file was refused
 * at preflight with TS17004 ("Cannot use JSX unless the '--jsx' flag is
 * provided") no matter what the project said — the checker never saw the
 * code. Found by trying to lint a real @gpuix/react example.
 *
 * The second case pins the enum spelling: TS7's option parser is
 * case-sensitive and wants "react-jsx" rather than "ReactJSX", and an
 * unserialized enum value reached it as a number (an internal compiler
 * error, not a diagnostic).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "jsx-config-"));
}

test("a project's jsx + jsxImportSource reach the checker", () => {
  const dir = scratch();
  try {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2020",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          jsxImportSource: ".",
          strict: true,
          noEmit: true,
        },
        include: ["*.tsx"],
      }),
    );
    // A minimal jsx-runtime the fixture can resolve to — including the JSX
    // namespace TS reads for intrinsic typing — so the test proves the OPTION
    // is adopted rather than that a package is present.
    writeFileSync(
      join(dir, "jsx-runtime.ts"),
      `export function jsx(type: string, props: unknown): unknown { return { type, props }; }
export function jsxs(type: string, props: unknown): unknown { return { type, props }; }
export const Fragment: string = "fragment";
// The JSX namespace is what TS reads for intrinsic typing under "react-jsx".
export namespace JSX {
  export type Element = unknown;
  export type ElementType = string;
  export interface ElementChildrenAttribute { children: unknown }
  export interface IntrinsicElements {
    div: { children?: unknown };
  }
}
`,
    );
    writeFileSync(
      join(dir, "component.tsx"),
      `export function Greeting(): unknown {
  return <div>hello</div>;
}
`,
    );
    const result = analyze(join(dir, "component.tsx"), {});
    const codes = result.coverage.diagnostics.map((d) => d.code);
    expect(codes, "the JSX option was adopted: no TS17004-style preflight failure").not.toContain("SC0001");
    expect(result.coverage.preflightFailed).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);

test("an unknown jsx spelling is refused as a diagnostic, not a crash", () => {
  const dir = scratch();
  try {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "preserve", jsxImportSource: ".", noEmit: true },
        include: ["*.tsx"],
      }),
    );
    writeFileSync(
      join(dir, "jsx-runtime.ts"),
      `export function jsx(type: string, props: unknown): unknown { return { type, props }; }
export function jsxs(type: string, props: unknown): unknown { return { type, props }; }
export const Fragment: string = "fragment";
// The JSX namespace is what TS reads for intrinsic typing under "react-jsx".
export namespace JSX {
  export type Element = unknown;
  export type ElementType = string;
  export interface ElementChildrenAttribute { children: unknown }
  export interface IntrinsicElements {
    div: { children?: unknown };
  }
}
`,
    );
    writeFileSync(join(dir, "component.tsx"), `export function Greeting(): unknown {
  return <div>hello</div>;
}
`);
    // jsx: preserve serializes to "preserve" — the enum reaches the parser as
    // a NAME rather than a number. What it REPORTS afterwards is the
    // preserve-mode typing (no JSX namespace under that mode is a plain
    // diagnostic); what matters here is that nothing throws an internal
    // compiler error on the way.
    const result = analyze(join(dir, "component.tsx"), {});
    expect(result.coverage.diagnostics.map((d) => d.code)).not.toContain("SC9001");
    expect(result.coverage.diagnostics.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
