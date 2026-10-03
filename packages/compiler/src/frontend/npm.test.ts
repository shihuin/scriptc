import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { moduleSpecifiersOf } from "./npm-node.js";
import { NpmGraphBuilder } from "./npm-node.js";

const fixturesRoot = fileURLToPath(new URL("../../../../tests/fixtures/npm/", import.meta.url));
const fixture = (...parts: string[]): string => join(fixturesRoot, ...parts);
const portable = (path: string): string => path.replaceAll("\\", "/");

test("TypeScript runtime entries embed emitted JS and only its runtime dependencies", () => {
  const entry = fixture("typescript", "main.ts");
  const builder = new NpmGraphBuilder();
  builder.addImport(entry, "tsruntime");
  builder.addImport(entry, "tsruntime/common");
  const graph = builder.finish();
  expect(graph.errors).toEqual([]);
  const modules = graph.modules.map((module) => ({ ...module, key: portable(module.key) }));
  expect(modules.map((module) => module.key.split("/").at(-1)).sort()).toEqual([
    "common.cts", "export-side.ts", "index.ts", "side.ts", "unused.ts", "value.mts",
  ]);
  const root = modules.find((module) => module.key.endsWith("/tsruntime/index.ts"));
  expect(root).toBeDefined();
  if (root === undefined) return;
  expect(root.format).toBe("esm");
  expect(root.source).not.toContain("import type");
  expect(root.source).not.toContain("export type");
  expect(root.source).not.toContain(": number");
  expect(root.source).not.toContain("./types.ts");
  const edges = graph.edges.filter((edge) => portable(edge.from) === root.key);
  expect(edges.map((edge) => edge.specifier).sort()).toEqual(["./export-side.ts", "./side.ts", "./unused.ts", "./value.mts"]);
  expect(edges.every((edge) => portable(edge.to).endsWith(edge.specifier.slice(2)))).toBe(true);
  expect(modules.find((module) => module.key.endsWith("/value.mts"))?.format).toBe("esm");
  const common = modules.find((module) => module.key.endsWith("/common.cts"));
  expect(common).toBeDefined();
  if (common === undefined) return;
  expect(common.format).toBe("cjs");
  expect(common.source).not.toContain(": number");
  expect(common.esm).toContain("value");
});

test.for([
  ["index.ts", "export function broken(: number) {}", "TS"],
  ["index.d.ts", "export declare const value: number;", "declaration files"],
  ["index.d.mts", "export declare const value: number;", "declaration files"],
  ["index.d.cts", "export declare const value: number;", "declaration files"],
  ["index.tsx", "export const value = <div />;", "TSX runtime modules"],
] as const)("invalid runtime source %s produces an attributed graph error", ([name, source, message]) => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-typescript-"));
  try {
    const pkg = join(dir, "node_modules", "invalid-typescript");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "invalid-typescript", type: "module", main: name }));
    writeFileSync(join(pkg, name), source);
    const builder = new NpmGraphBuilder();
    builder.addImport(join(dir, "main.ts"), "invalid-typescript");
    const graph = builder.finish();
    expect(graph.modules).toEqual([]);
    expect(graph.errors).toHaveLength(1);
    const diagnostic = graph.errors[0]?.message;
    expect(diagnostic).toContain(name);
    expect(diagnostic).toContain(message);
    expect(diagnostic).toContain("dependency chain: invalid-typescript");
    expect(diagnostic).not.toContain("scriptc-typescript-");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("collects import.meta.resolve literals as resolution-only edges", () => {
  const result = moduleSpecifiersOf(
    'export const relative = import.meta.resolve("./asset.js");\n' +
      'export const packageUrl = import.meta.resolve("example-package");\n',
    "/project/index.mjs",
  );
  expect(result.uses).toEqual([
    {
      specifier: "./asset.js",
      static: false,
      require: false,
      requireLocal: false,
      requireViaHelper: false,
      dynamicImport: false,
      importMetaResolve: true,
    },
    {
      specifier: "example-package",
      static: false,
      require: false,
      requireLocal: false,
      requireViaHelper: false,
      dynamicImport: false,
      importMetaResolve: true,
    },
  ]);
});

test("emits an import-condition edge for an embedded bare import.meta.resolve", () => {
  const entry = fixture("cases", "dual-entry", "main.ts");
  const builder = new NpmGraphBuilder();
  builder.addImport(entry, "dual");
  const graph = builder.finish();
  const dual = graph.modules.find((module) => portable(module.key).endsWith("/dual/index.mjs"));
  expect(dual).toBeDefined();
  if (dual === undefined) return;
  const edges = graph.edges.map((edge) => ({ ...edge, from: portable(edge.from), to: portable(edge.to) }));
  expect(edges).toContainEqual({
    from: portable(dual.key),
    specifier: "cjszoo",
    to: expect.stringMatching(/\/cjszoo\/index\.js$/),
    kind: "import",
  });
});

test("embeds dependencies reached only through CommonJS module.require", () => {
  const entry = fixture("cases", "node24-commonjs-metadata", "main.ts");
  const builder = new NpmGraphBuilder();
  builder.addImport(entry, "node24-commonjs-fixture");
  const graph = builder.finish();
  expect(graph.errors).toEqual([]);
  expect(graph.modules.some((module) => portable(module.key).endsWith("/node24-commonjs-fixture/method-only.cjs"))).toBe(true);
  expect(graph.edges.map((edge) => ({ ...edge, from: portable(edge.from), to: portable(edge.to) }))).toContainEqual({
    from: expect.stringMatching(/\/node24-commonjs-fixture\/index\.cjs$/),
    specifier: "./method-only.cjs",
    to: expect.stringMatching(/\/node24-commonjs-fixture\/method-only\.cjs$/),
    kind: "any",
  });
});

test("runtime introspection keeps import and require export conditions separate", () => {
  const entry = fixture("cases", "dual-entry", "main.ts");
  const builder = new NpmGraphBuilder();
  const imported = builder.resolveForIntrospection(entry, "dual", "import");
  const required = builder.resolveForIntrospection(entry, "dual", "require");
  expect(imported).not.toBeNull();
  expect(required).not.toBeNull();
  if (imported === null || required === null) return;
  expect(portable(imported)).toMatch(/\/dual\/index\.mjs$/);
  expect(portable(required)).toMatch(/\/dual\/index\.cjs$/);
});

test("embedded package imports resolve with edge-specific conditions", () => {
  const entry = fixture("cases", "package-imports", "main.ts");
  const builder = new NpmGraphBuilder();
  builder.addImport(entry, "importmapped");
  const graph = builder.finish();
  const packageEntry = graph.modules.find((module) => portable(module.key).endsWith("/importmapped/index.js"));
  const edges = graph.edges.map((edge) => ({ ...edge, from: portable(edge.from), to: portable(edge.to) }));
  expect(graph.errors).toEqual([]);
  expect(packageEntry).toBeDefined();
  if (packageEntry === undefined) return;
  expect(edges).toContainEqual({
    from: portable(packageEntry.key),
    specifier: "#exact",
    to: expect.stringMatching(/\/importmapped\/internal\/exact\.js$/),
    kind: "import",
  });
  expect(edges).toContainEqual({
    from: portable(packageEntry.key),
    specifier: "#pattern/value",
    to: expect.stringMatching(/\/importmapped\/internal\/value\.js$/),
    kind: "import",
  });
  expect(edges).toContainEqual({
    from: portable(packageEntry.key),
    specifier: "#external",
    to: expect.stringMatching(/\/dual\/index\.mjs$/),
    kind: "import",
  });
  expect(edges).toContainEqual({
    from: portable(packageEntry.key),
    specifier: "#mode",
    to: expect.stringMatching(/\/importmapped\/internal\/require-mode\.cjs$/),
    kind: "require",
  });
  expect(edges).toContainEqual({
    from: portable(packageEntry.key),
    specifier: "#mode",
    to: expect.stringMatching(/\/importmapped\/internal\/import-mode\.js$/),
    kind: "import",
  });
});

test("an unmapped embedded package import reports its package scope", () => {
  const entry = fixture("cases", "package-imports", "main.ts");
  const builder = new NpmGraphBuilder();
  builder.addFileImport(entry, "../../node_modules/importmapped/missing.js");
  const graph = builder.finish();
  expect(graph.errors).toHaveLength(1);
  const error = graph.errors[0];
  expect(error).toBeDefined();
  if (error === undefined) return;
  expect(error.message).toContain(
    `package import '#missing' is not defined by "imports" in ${fixture("node_modules", "importmapped", "package.json")}`,
  );
  expect(error.message).not.toContain("cannot find package");
});
