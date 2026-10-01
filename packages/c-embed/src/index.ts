/* @scriptc/c-embed — the command line and public re-export for scriptc's C
 * embedding generator.
 *
 * The generator itself lives in the compiler (`@scriptc/compiler/embed`),
 * because it is derived from the compiler's own library ABI. This package is
 * the packaged face of it: the `scriptc-c-embed` command, plus a stable import
 * path for tooling that should not reach into the compiler.
 *
 *   import { generateAll } from "@scriptc/c-embed";
 */

export {
  carriesBuffer,
  cTypeOf,
  callbackTypedef,
  declareParam,
  exportSignature,
  generateAll,
  generateCMake,
  generateDescriptor,
  generateHeader,
  generateShim,
  generateShimHeader,
  includeGuard,
  isCIdentifier,
  outParamsFor,
  paramsFor,
  prefixOf,
  returnsFor,
  signaturesOf,
  sinkTypedefName,
  splitsInC,
  stemOf,
  type AbiClass,
  type CParam,
  type CSignature,
  type GeneratedFile,
  type HeaderOptions,
} from "@scriptc/compiler/embed";

export { runEmbedCli, EXPLAIN, USAGE, type CliIo, type CliOutcome } from "./cli.js";
