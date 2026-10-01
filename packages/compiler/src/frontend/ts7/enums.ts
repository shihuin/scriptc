/** Runtime enums generated from the pinned TypeScript 7 declarations.
 * Their nominal names and values match the SDK; TypeScript 5 remains a
 * separate world. No package loader runs on the compiler's native path. */
export * from "./enums.generated.js";

/** JsxEmit is an SDK enum whose name lookup the generator does not emit.
 * Values are TypeScript 7.0.2's, and the ACCEPTED tsconfig spelling is what
 * comes back out: the option parser is case-sensitive and wants
 * "react-jsx" rather than "ReactJSX". */
export function jsxName(value: number): string | undefined {
  switch (value) {
    case 0:
      return "none";
    case 1:
      return "preserve";
    case 2:
      return "react";
    case 3:
      return "react-native";
    case 4:
      return "react-jsx";
    case 5:
      return "react-jsxdev";
    default:
      return undefined;
  }
}
