/* The C-embedding surface of the compiler.
 *
 * The generator lives here rather than in a separate package because it is
 * derived from the compiler's own library ABI: the marshalling classes, the
 * mode-provided symbol names, and the profile schema are all compiler
 * decisions, and a generator in another package would have to depend back on
 * this one to read them (a cycle the workspace rejects).
 *
 *   import { generateAll } from "@scriptc/compiler/embed";
 *
 * `@scriptc/c-embed` is the command-line face of this module.
 */

export {
  cTypeOf,
  callbackTypedef,
  declareParam,
  exportSignature,
  includeGuard,
  isCIdentifier,
  outParamsFor,
  paramsFor,
  prefixOf,
  returnsFor,
  signaturesOf,
  sinkTypedefName,
  splitsInC,
  type AbiClass,
  type CParam,
  type CSignature,
} from "./c-abi.js";

export {
  carriesBuffer,
  generateAll,
  generateCMake,
  generateDescriptor,
  generateHeader,
  generateShim,
  generateShimHeader,
  stemOf,
  type GeneratedFile,
  type HeaderOptions,
} from "./c-header.js";
