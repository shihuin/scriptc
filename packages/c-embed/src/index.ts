/* @scriptc/c-embed — C embedding for scriptc library-mode archives.
 *
 *   import { loadLibraryProfile } from "@scriptc/compiler";
 *   import { generateAll, signaturesOf } from "@scriptc/c-embed";
 *
 *   const loaded = loadLibraryProfile("app.profile.json");
 *   if (!loaded.ok) throw new Error("bad profile");
 *   for (const file of generateAll(loaded.profile)) writeFileSync(file.name, file.text);
 *
 * The generated header declares exactly the C ABI the library emitter
 * produces, so an embedder compiles against the archive without hand-writing
 * prototypes. `test/ir-audit.test.ts` checks that claim against the archive's
 * own LLVM IR.
 */

export {
  cTypeOf,
  callbackTypedef,
  exportSignature,
  includeGuard,
  isCIdentifier,
  outParamsFor,
  paramsFor,
  prefixOf,
  returnsFor,
  signaturesOf,
  splitsInC,
  type AbiClass,
  type CParam,
  type CSignature,
} from "./c-abi.js";

export {
  carriesBuffer,
  generateAll,
  generateDescriptor,
  generateHeader,
  generateShim,
  generateShimHeader,
  stemOf,
  type GeneratedFile,
  type HeaderOptions,
} from "./c-header.js";

export { runEmbedCli, EXPLAIN, USAGE, type CliIo, type CliOutcome } from "./cli.js";
