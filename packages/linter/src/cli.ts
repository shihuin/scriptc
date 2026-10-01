/* `scriptc-lint`'s argument handling, as a pure function of (argv, cwd, io)
 * so the tests drive it without a subprocess.
 *
 * Exit codes:
 *   0  every linted program is supported (and within --max-warnings)
 *   1  at least one program is not supported, or the warning budget is spent
 *   2  the linter could not run (bad arguments, unreadable file)
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { lint, type LintResult } from "./engine.js";
import { report, type LintFormat } from "./report.js";
import { allRules, FAMILY_TITLES, RULE_FAMILIES } from "./rules.js";

export const USAGE = `scriptc-lint — lint TS/JS for the statically supported scriptc subset

A green lint is a build claim: the program passed the same frontend, typed-IR
validation, and LLVM emission a scriptc build runs. See --explain.

Usage:
  scriptc-lint [options] <file.ts|.js> [more files…]

Options:
      --dynamic              lint what a --dynamic build compiles (island sites
                             lower instead of fencing)
      --npm-static <pkg|auto>
                             lint with the named npm packages compiled as
                             program modules (repeatable, comma-splittable)
      --ffi <manifest.json>  lint with the manifest's native bindings bound
      --external-types <specifier=file.d.ts>
                             map an exact bare specifier to local declarations
      --strict               treat warnings as errors (default: on; the lint
                             promise is only as strong as its strictness)
      --no-strict            keep warnings non-blocking
      --no-verify            skip typed-IR validation and LLVM emission: about
                             twice as fast, and the verdict narrows to the
                             frontend (the report says so)
      --no-unreached         do not report blockers in bodies no entry path
                             reaches (a build never lowers them)
      --no-runtime-fences    do not report statements that build but trap when
                             executed
      --format <text|json|github>
                             output format (default: text). github emits
                             workflow-command annotations
      --color / --no-color   force/suppress ANSI color (default: TTY)
      --max-warnings <n>     fail when more than n warnings are reported
      --list-rules           print the rule catalog and exit
      --explain              print exactly what a green lint does and does not
                             prove, and exit
  -h, --help                 show this help
`;

export const EXPLAIN = `scriptc-lint --explain

What a green lint proves
  1. TypeScript preflight — the program typechecks under the project's
     tsconfig, and the project configuration is one scriptc honors.
  2. Module graph — every import form, package, and builtin module resolves
     the way the compiler resolves it.
  3. Whole-program lowering — every statement the entry path reaches lowers to
     typed IR. Bodies nothing reaches are lowered too and reported separately.
  4. Typed-IR validation — the IR passes the compiler's own validator.
  5. LLVM IR emission — the LLVM backend emits this program. This is the stage
     that catches backend-only gaps (scriptc/SC3001).

What a green lint does NOT prove
  • Native code generation, linking, the platform SDK, and the C runtime:
    those stages need a host toolchain the linter does not invoke.
  • Runtime behavior. Lint says the program builds, not what it prints.
  • That unreached code compiles, unless --strict (default) is on — with
    strict, blockers in unreached bodies are errors, and a green lint means
    every statement in the file is supported.
  • That the program runs identically under Node. Use the differential corpus
    ('scriptc run' vs 'node') for behavior.

Why it cannot disagree with a build
  The linter calls the compiler's own analyze() and compile() entry points —
  the same functions 'scriptc coverage' and 'scriptc build' call — so a
  reported rule is a diagnostic the compiler emitted, not a linter opinion.
`;

interface CliValues {
  dynamic: boolean;
  strict?: boolean;
  verify?: boolean;
  unreached?: boolean;
  "runtime-fences"?: boolean;
  format?: string;
  color?: boolean;
  "max-warnings"?: string;
  "npm-static"?: string[];
  ffi?: string;
  "external-types"?: string[];
  "list-rules": boolean;
  explain: boolean;
  help: boolean;
}

export interface CliIo {
  cwd?: string;
  isTty?: boolean;
}

export interface CliOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function printRules(): string {
  const out: string[] = ["scriptc-lint rules — every rule is a compiler diagnostic, re-labelled", ""];
  for (const family of RULE_FAMILIES) {
    const rules = allRules().filter((r) => r.family === family);
    if (rules.length === 0) continue;
    out.push(FAMILY_TITLES[family]);
    for (const rule of rules) {
      out.push(`  scriptc/${rule.code}  ${rule.description}${rule.dynamicAlternative ? "  [runs with --dynamic]" : ""}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function countFindings(results: LintResult[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.severity === "error") errors++;
      else if (finding.severity === "warning") warnings++;
    }
  }
  return { errors, warnings };
}

/** Run the CLI once. Never throws and never touches process state. */
export async function runLintCli(argv: string[], io: CliIo = {}): Promise<CliOutcome> {
  const cwd = io.cwd ?? process.cwd();
  let values: CliValues;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        dynamic: { type: "boolean", default: false },
        strict: { type: "boolean" },
        verify: { type: "boolean" },
        unreached: { type: "boolean" },
        "runtime-fences": { type: "boolean" },
        format: { type: "string" },
        color: { type: "boolean" },
        "max-warnings": { type: "string" },
        "npm-static": { type: "string", multiple: true },
        ffi: { type: "string" },
        "external-types": { type: "string", multiple: true },
        "list-rules": { type: "boolean", default: false },
        explain: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    values = parsed.values as CliValues;
    positionals = parsed.positionals;
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    return { stdout: "", stderr: `scriptc-lint: ${message}\n\n${USAGE}`, exitCode: 2 };
  }

  if (values.help) return { stdout: USAGE, stderr: "", exitCode: 0 };
  if (values["list-rules"]) return { stdout: printRules(), stderr: "", exitCode: 0 };
  if (values.explain) return { stdout: EXPLAIN, stderr: "", exitCode: 0 };
  if (positionals.length === 0) return { stdout: "", stderr: USAGE, exitCode: 2 };

  const format = (values.format ?? "text") as LintFormat;
  if (format !== "text" && format !== "json" && format !== "github") {
    return { stdout: "", stderr: `scriptc-lint: unknown --format "${values.format}" (supported: text, json, github)`, exitCode: 2 };
  }

  let warningBudget = Number.POSITIVE_INFINITY;
  if (values["max-warnings"] !== undefined) {
    warningBudget = Number(values["max-warnings"]);
    if (!Number.isInteger(warningBudget) || warningBudget < 0) {
      return {
        stdout: "",
        stderr: `scriptc-lint: --max-warnings takes a non-negative integer (got "${values["max-warnings"]}")`,
        exitCode: 2,
      };
    }
  }

  const npmStaticRaw = (values["npm-static"] ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
  let npmStatic: string[] | "auto" | undefined;
  if (npmStaticRaw.includes("auto")) {
    if (npmStaticRaw.length > 1) {
      return { stdout: "", stderr: "scriptc-lint: --npm-static auto cannot be combined with package names", exitCode: 2 };
    }
    npmStatic = "auto";
  } else if (npmStaticRaw.length > 0) {
    npmStatic = npmStaticRaw;
  }

  const externalTypes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const mapping of values["external-types"] ?? []) {
    const equals = mapping.indexOf("=");
    if (equals <= 0 || equals === mapping.length - 1) {
      return {
        stdout: "",
        stderr: `scriptc-lint: invalid --external-types mapping ${JSON.stringify(mapping)} (expected <specifier=file.d.ts>)`,
        exitCode: 2,
      };
    }
    externalTypes[mapping.slice(0, equals).trim()] = resolve(cwd, mapping.slice(equals + 1).trim());
  }

  const entries = positionals.map((p) => resolve(cwd, p));
  const color = values.color ?? io.isTty ?? false;
  const results: LintResult[] = [];
  const source = new Map<string, string>();
  for (const entry of entries) {
    let text: string;
    try {
      text = await readFile(entry, "utf8");
    } catch {
      return { stdout: "", stderr: `scriptc-lint: cannot read ${entry}`, exitCode: 2 };
    }
    source.set(entry, text);
    results.push(
      await lint(entry, {
        dynamic: values.dynamic,
        ...(values.strict === undefined ? {} : { strict: values.strict }),
        ...(values.verify === undefined ? {} : { verify: values.verify }),
        ...(values.unreached === undefined ? {} : { reportUnreached: values.unreached }),
        ...(values["runtime-fences"] === undefined ? {} : { reportRuntimeFences: values["runtime-fences"] }),
        ...(npmStatic === undefined ? {} : { npmStatic }),
        ...(values.ffi === undefined ? {} : { ffiProfilePath: resolve(cwd, values.ffi) }),
        ...(Object.keys(externalTypes).length === 0 ? {} : { externalTypes }),
      }),
    );
  }

  const rendered = report(results, { format, color, source });
  const { warnings } = countFindings(results);
  const unsupported = results.filter((r) => !r.guarantee.supported).length;
  const exitCode = unsupported > 0 || warnings > warningBudget ? 1 : 0;
  return { stdout: rendered.length > 0 ? rendered + "\n" : "", stderr: "", exitCode };
}
