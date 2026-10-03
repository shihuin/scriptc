import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FrontendServices } from "../../../packages/compiler/src/frontend/services.js";
import type { FetchAnalysisModule } from "../../../packages/compiler/src/frontend/npm-fetch-analysis.js";
import { parseNpmStaticDeclarationOverloads, parseNpmStaticDeclarationProperties } from "../../../packages/compiler/src/frontend/npm-static-declaration-syntax.js";
import { isVariableStatement, isIdentifier } from "../../../packages/compiler/src/frontend/ts7/syntax.js";
import { NpmGraphBuilder } from "../../../packages/compiler/src/frontend/npm.js";

function check(value: boolean, reason: string): void { if (!value) throw new Error(reason); }

export function runFrontendServices(services: FrontendServices, input: string, output: string): void {
  const request = JSON.parse(readFileSync(input, "utf8")) as {
    modules: FetchAnalysisModule[];
    directory: string;
    declarations: string;
    source: string;
    bundled: string;
  };
  const fetch = [...services.globalFetchModules(request.modules)];
  check(services.globalFetchModules([]).size === 0, "empty graph");
  check(services.globalFetchModules([{ key: "edited", source: "fetch();", format: "cjs" }]).has("edited"), "initial graph");
  check(services.globalFetchModules([{ key: "edited", source: "const fetch = () => 1; fetch();", format: "cjs" }]).size === 0, "updated graph");
  check(services.globalFetchModules([{ key: "edited", source: "globalThis.fetch;", format: "cjs" }]).has("edited"), "restored graph");
  let collision = false;
  try { services.globalFetchModules([
    { key: "same", source: "fetch();", format: "cjs" },
    { key: "same.js", source: "const fetch = 1;", format: "cjs" },
  ]); } catch { collision = true; }
  check(collision, "loader key collision");

  const declarationFile = services.parse("package.d.ts", request.declarations, "ts");
  const methods = parseNpmStaticDeclarationOverloads(declarationFile);
  const properties = parseNpmStaticDeclarationProperties(declarationFile);
  const nullable = services.nullableClassFields("package.js", request.source);
  const widened = services.findReturnWidening("package.js", nullable?.text ?? request.source);
  const namepaths = services.jsDocNamepaths("package.js", "/** @returns {Array<Box~Item>} */ function items() { return []; }");
  check(namepaths !== null && namepaths.includes("Array<*"), "checked JSDoc namepaths");
  const fields = services.declarationProperties("package.js", widened?.text ?? nullable?.text ?? request.source, properties);
  const overloads = services.declarationOverloads("package.js", fields?.text ?? widened?.text ?? nullable?.text ?? request.source, methods);
  const rewritten = services.rewriteCjs(request.bundled, join(request.directory, "bundle.js"));
  check(typeof rewritten === "string", "bundled rewrite");
  const original = services.parse("edited.ts", "export const original = 1;", "ts");
  const changed = services.parse("edited.ts", "export const changed = 2;", "ts");
  check(original.text.includes("original") && changed.text.includes("changed"), "detached syntax versions");

  const builder = new NpmGraphBuilder(services);
  const entry = join(request.directory, "main.ts");
  const graphKey = builder.addImport(entry, "service-fetch");
  check(graphKey !== null, "package entry resolution");
  builder.addImport(entry, "service-typescript");
  const graph = builder.finish();
  check(graph.errors.length === 0, "package graph diagnostics");
  const typed = graph.modules.filter((module) => /\.(?:ts|mts)$/.test(module.key));
  check(typed.length === 2, "TypeScript runtime graph");
  check(typed.every((module) => !module.source.includes(": number") && !module.source.includes("missing-types")), "TypeScript runtime emission");

  const host = services.createProgramHost({ cwd: request.directory });
  const sourcePath = join(request.directory, "virtual.ts");
  try {
    host.addVirtualFile(sourcePath, "export const version = 1;");
    const before = host.createProgram([sourcePath], { noLib: true, types: [] });
    try {
      const source = before.getSourceFile(sourcePath)!;
      const statement = source.statements[0]!;
      check(isVariableStatement(statement), "native statement view");
      if (isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations[0]!;
        const name = declaration.name;
        check(isIdentifier(name), "native binding view");
        if (isIdentifier(name)) {
          check(before.getTypeChecker().typeToString(before.getTypeChecker().getTypeAtLocation(name)) === "1", "native checker literal");
        }
        before.analysis.createRequireReasons.set(declaration, "owned by old program");
      }
      before.analysis.nodeEsmFiles.set(source, true);
      host.addVirtualFile(sourcePath, "export const version = 2;");
      const after = host.createProgram([sourcePath], { noLib: true, types: [] });
      try {
        check(after.analysis.nodeEsmFiles.size === 0, "new snapshot has no old format decisions");
        check(after.analysis.createRequireReasons.size === 0, "new snapshot has no old binding decisions");
        check(after.getSourceFile(sourcePath)!.text.includes("2"), "updated program source");
        check(before.getSourceFile(sourcePath) === source && source.text.includes("1"), "old program source remains live");
      } finally { after.dispose(); }
    } finally { before.dispose(); }
    check(before.analysis.nodeEsmFiles.size === 0 && before.analysis.createRequireReasons.size === 0, "disposed analysis state");
    // Closing syntax/fetch services does not close a host explicitly owned by this caller.
    services.close();
    check(original.text === "export const original = 1;", "detached AST survives service close");
    const independent = host.createProgram([sourcePath], { noLib: true, types: [] });
    try { check(independent.getSourceFile(sourcePath)!.text.includes("2"), "host survives service close"); }
    finally { independent.dispose(); }
  } finally { host.close(); }
  let closed = false;
  try { services.parse("closed.ts", "", "ts"); } catch { closed = true; }
  check(closed, "closed syntax refusal");
  services.close();
  writeFileSync(output, JSON.stringify({
    fetch, collision, nullable, widened, fields, overloads, rewritten,
    graph: {
      modules: graph.modules.map((module) => ({ key: module.key.split("\\").join("/"), format: module.format, usesFetch: module.usesFetch ?? false, facade: module.esm ?? "" })),
      builtins: graph.builtins,
      lazyTraps: graph.lazyTraps,
    },
    versions: [original.text, changed.text], closed,
  }));
}
