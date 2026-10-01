/* The linter's rule catalog.
 *
 * Every rule the linter can report comes from a REAL decision the compiler
 * already makes: a diagnostic code from `packages/compiler/src/diagnostics/
 * diagnostic.ts`, the single registry where message strings live. The linter
 * never invents a support claim — it re-labels compiler verdicts and anchors
 * them to source, so a green lint and a green build can never disagree.
 *
 * The `descriptions` table below is human-facing wording only. It is keyed by
 * diagnostic code and is checked against the registry by `rules.test.ts`, so a
 * new compiler code fails the linter's own test suite instead of silently
 * linting as an unexplained code.
 */

/** Diagnostic codes the compiler can raise, as string literals. */
export type ScCode = `SC${number}`;

/** What a diagnostic means for a developer, independent of the exact code.
 * The linter's verdicts and documentation are expressed in these families. */
export type RuleFamily =
  /** SC0xxx — the program never reached lowering: TypeScript errors, project
   * configuration the compiler cannot honor, malformed JSON modules, checker
   * panics. Nothing is claimed about support yet. */
  | "frontend"
  /** SC1xxx — the source is valid TypeScript but outside the statically
   * compiled subset. No build flag changes this. */
  | "unsupported"
  /** SC2xxx — scriptc type rules: the program may be valid JS/TS, but the
   * static tier cannot type it. SC2010–SC2013 are the constructs a
   * --dynamic build runs in the embedded engine instead. */
  | "type"
  /** SC3xxx — the program is fine; the selected backend or execution target
   * does not include it. */
  | "backend"
  /** SC4xxx — library-emission-mode refusals and traps. */
  | "library"
  /** SC5xxx — outbound native FFI manifest and signature refusals. */
  | "ffi"
  /** SC9xxx — internal compiler errors (a linter bug or a compiler bug). */
  | "internal";

export interface Rule {
  /** The diagnostic code, used as the rule id (`scriptc/SC1040`). */
  code: ScCode;
  family: RuleFamily;
  /** One-line statement of the decision. English, no trailing period. */
  description: string;
  /** True for SC2010–SC2013: constructive to compile with `--dynamic`
   * instead of removing the construct. */
  dynamicAlternative: boolean;
}

/** Human-facing wording per code. Codes absent here still have a rule: the
 * compiler's own diagnostic message is the fallback description, and
 * `rules.test.ts` fails when a registry code lacks both an entry and a
 * family classification. */
const descriptions: Record<string, [RuleFamily, string]> = {
  // ── SC0xxx: preflight gates ──────────────────────────────────────────
  SC0001: ["frontend", "TypeScript must typecheck before scriptc can analyze the program"],
  SC0002: ["frontend", "the project configuration is outside what scriptc can analyze"],
  SC0003: ["frontend", "an imported JSON module is malformed"],
  SC0004: ["frontend", "the TypeScript checker panicked while analyzing the program"],

  // ── SC1xxx: valid TypeScript outside the static subset ───────────────
  SC1010: ["unsupported", "this import form is not compiled statically"],
  SC1011: ["unsupported", "this export form is not compiled statically"],
  SC1012: ["unsupported", "default export/import form not compiled statically here"],
  SC1013: ["unsupported", "namespace import form not compiled statically here"],
  SC1014: ["unsupported", "re-export/export-list form not compiled statically here"],
  SC1015: ["unsupported", "dynamic import() is not compiled statically"],
  SC1016: ["unsupported", "this module syntax is not compiled statically"],
  SC1020: ["unsupported", "this declaration form is not compiled statically"],
  SC1021: ["unsupported", "this declaration form is not compiled statically"],
  SC1022: ["unsupported", "this declaration form is not compiled statically"],
  SC1023: ["unsupported", "this declaration form is not compiled statically"],
  SC1024: ["unsupported", "this declaration form is not compiled statically"],
  SC1030: ["unsupported", "this expression form is not compiled statically"],
  SC1031: ["unsupported", "this destructuring form is not compiled statically"],
  SC1032: ["unsupported", "this destructuring form is not compiled statically"],
  SC1033: ["unsupported", "this destructuring form is not compiled statically"],
  SC1040: ["unsupported", "this operator is not compiled statically"],
  SC1041: ["unsupported", "this operator is not compiled statically"],
  SC1042: ["unsupported", "this operator is not compiled statically"],
  SC1043: ["unsupported", "this operator is not compiled statically"],
  SC1045: ["unsupported", "this operator is not compiled statically"],
  SC1050: ["unsupported", "this statement form is not compiled statically"],
  SC1051: ["unsupported", "this statement form is not compiled statically"],
  SC1052: ["unsupported", "this statement form is not compiled statically"],
  SC1060: ["unsupported", "this class form is not compiled statically"],
  SC1061: ["unsupported", "this class form is not compiled statically"],
  SC1062: ["unsupported", "this class form is not compiled statically"],
  SC1063: ["unsupported", "this class form is not compiled statically"],
  SC1070: ["unsupported", "this function form is not compiled statically"],
  SC1071: ["unsupported", "this generator/async form is not compiled statically"],
  SC1080: ["unsupported", "this module-level construct is not compiled statically"],
  SC1090: ["unsupported", "this runtime construct is not compiled statically"],
  SC1100: ["unsupported", "this construct is not compiled statically"],
  SC1101: ["unsupported", "this construct is not compiled statically"],
  SC1110: ["unsupported", "this construct is not compiled statically"],
  SC1120: ["unsupported", "this construct is not compiled statically"],
  SC1121: ["unsupported", "this construct is not compiled statically"],

  // ── SC2xxx: scriptc type rules ───────────────────────────────────────
  SC2001: ["type", "this type is not compilable by the static tier"],
  SC2002: ["type", "this type is not compilable by the static tier"],
  SC2003: ["type", "this type is not compilable by the static tier"],
  SC2004: ["type", "this type is not compilable by the static tier"],
  SC2005: ["type", "this type is not compilable by the static tier"],
  SC2006: ["type", "this type is not compilable by the static tier"],
  SC2007: ["type", "this type is not compilable by the static tier"],
  SC2008: ["type", "this type is not compilable by the static tier"],
  SC2009: ["type", "this type is not compilable by the static tier"],
  SC2010: ["type", "this construct needs the embedded dynamic engine"],
  SC2011: ["type", "'any'-typed arithmetic needs the embedded dynamic engine"],
  SC2012: ["type", "this library member needs the embedded dynamic engine"],
  SC2013: ["type", "this construct needs the embedded dynamic engine"],
  SC2020: ["type", "this value's type is not compilable by the static tier"],
  SC2030: ["type", "the embedded npm code needs a Node builtin the island does not provide"],

  // ── SC3xxx: backend and target coverage ──────────────────────────────
  SC3001: ["backend", "the LLVM backend does not emit this construct yet"],
  SC3002: ["backend", "the selected execution target does not support this surface"],
  SC3003: ["backend", "the native helper for this host is missing or the wrong version"],
  SC3004: ["backend", "the native helper failed while generating code"],

  // ── SC4xxx: library emission mode ────────────────────────────────────
  SC4001: ["library", "the library profile is malformed"],
  SC4002: ["library", "a profile export does not resolve to a declaration"],
  SC4003: ["library", "an exported signature cannot be mapped to a library ABI class"],
  SC4004: ["library", "async or generator exports are not available in library mode"],
  SC4005: ["library", "the library graph must be async-free"],
  SC4006: ["library", "island/dynamic constructs are not available in library mode"],
  SC4007: ["library", "generic export signatures are not available in library mode"],
  SC4008: ["library", "a profile-fenced manifest surface was reached by the library graph"],
  SC4009: ["library", "the contract sidecar cannot project this export"],
  SC4010: ["library", "multiple type declarations feed a tabled library type"],
  SC4011: ["library", "a conditional or mapped type produced a tabled library type"],
  SC4012: ["library", "the inbound-bytes host contract trapped at runtime"],
  SC4013: ["library", "the library runtime detected a trap"],
  SC4014: ["library", "the library runtime detected a trap"],
  SC4015: ["library", "the library runtime detected a trap"],
  SC4016: ["library", "the library runtime detected a trap"],
  SC4017: ["library", "the library runtime detected a trap"],
  SC4018: ["library", "the library runtime detected a trap"],
  SC4019: ["library", "the library runtime detected a trap"],
  SC4020: ["library", "an npm package in the library graph fails the npm-static eligibility bar"],
  SC4021: ["library", "an integer literal does not round-trip f64 at a declared slot"],
  SC4022: ["library", "a value may be NaN or fractional at a declared integer slot"],
  SC4023: ["library", "a proven interval does not fit the declared integer slot"],
  SC4024: ["library", "an ambient function reference is not served by the profile's callbacks"],
  SC4025: ["library", "an unregistered host callback trapped at runtime"],
  SC4026: ["library", "the library re-entered a host callback boundary while one was active"],

  // ── SC5xxx: native FFI ───────────────────────────────────────────────
  SC5001: ["ffi", "the outbound FFI manifest is malformed or unreadable"],
  SC5002: ["ffi", "an FFI binding does not resolve to a signature-only ambient function"],
  SC5003: ["ffi", "an FFI binding's TypeScript signature and manifest ABI disagree"],
  SC5004: ["ffi", "the compiler could not build or link a valid FFI profile"],

  // ── SC9xxx: internal compiler errors ─────────────────────────────────
  SC9001: ["internal", "internal compiler error"],
  SC9002: ["internal", "internal compiler error"],
};

/** Codes that a `--dynamic` build turns into working code instead of a
 * refusal: the construct lowers to an island call and the embedded engine
 * runs it. The coverage report draws the same line. */
const DYNAMIC_CAPABLE: ReadonlySet<string> = new Set(["SC2010", "SC2011", "SC2012", "SC2013"]);

/** Family from the code band. Kept beside the table so a registry code with
 * no bespoke wording still classifies correctly. */
function familyOfCode(code: string): RuleFamily {
  const band = code.slice(2, 3);
  switch (band) {
    case "0":
      return "frontend";
    case "1":
      return "unsupported";
    case "2":
      return "type";
    case "3":
      return "backend";
    case "4":
      return "library";
    case "5":
      return "ffi";
    case "9":
      return "internal";
    default:
      return "internal";
  }
}

/** The catalog entry for a compiler diagnostic code. `fallback` is the
 * compiler's own message, used as the description when the table has no
 * wording for a code that was added upstream. */
export function ruleFor(code: ScCode, fallback = ""): Rule {
  const entry = descriptions[code];
  return {
    code,
    family: entry?.[0] ?? familyOfCode(code),
    description: entry?.[1] ?? (fallback.length > 0 ? fallback : "this construct is not supported"),
    dynamicAlternative: DYNAMIC_CAPABLE.has(code),
  };
}

/** Every catalogued rule, sorted by code — the stable surface tooling reads. */
export function allRules(): Rule[] {
  return Object.keys(descriptions)
    .sort()
    .map((code) => ruleFor(code as ScCode));
}

export const RULE_FAMILIES: readonly RuleFamily[] = [
  "frontend",
  "unsupported",
  "type",
  "backend",
  "library",
  "ffi",
  "internal",
];

export const FAMILY_TITLES: Record<RuleFamily, string> = {
  frontend: "Frontend gates (nothing is claimed about support until these pass)",
  unsupported: "Valid TypeScript outside the statically compiled subset",
  type: "scriptc type rules (no build flag changes these; see --dynamic)",
  backend: "Backend and target coverage (the program is valid)",
  library: "Library emission mode (scriptc build --lib)",
  ffi: "Native FFI manifests and signatures",
  internal: "Internal compiler errors",
};

/** True for the codes a --dynamic build compiles to island calls. */
export function hasDynamicAlternative(code: ScCode): boolean {
  return DYNAMIC_CAPABLE.has(code);
}
