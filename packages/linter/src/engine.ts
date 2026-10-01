/* The lint engine.
 *
 * A lint run drives the SAME compiler entry points a build drives, in the
 * same order, and reports every verdict they produce:
 *
 *   1. `analyze()` — the whole-program frontend pass: preflight (TypeScript
 *      errors, project-config gates), module-graph resolution, lowering of
 *      the entry path AND the unreached remainder. Its `diagnostics` are the
 *      blockers a build stops on; its `unreached` group never fails a build.
 *   2. `compile({ outputKind: "llvm" })` — the rest of the build pipeline:
 *      lowering without coverage, typed-IR validation, and LLVM emission.
 *      This is where a construct that only the backend refuses (SC3001)
 *      surfaces, and it is the reason a green lint is a build claim rather
 *      than an analysis claim.
 *
 * The LLVM emission is the deepest stage that needs no native toolchain:
 * scriptc's LLVM emitter is TypeScript, emitting textual IR. Object
 * emission, the C runtime, the linker, and the platform SDK are deliberately
 * outside the linter's claim — see `LintGuarantee.notChecked`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { analyze, compile } from "@scriptc/compiler";
import type { AnalyzeOptions, AnalyzeResult } from "@scriptc/compiler";
import type { ScrDiagnostic } from "@scriptc/compiler";
import { ruleFor, type Rule, type RuleFamily, type ScCode } from "./rules.js";

export type LintSeverity = "error" | "warning" | "note";

export interface LintOptions extends AnalyzeOptions {
  /** Report reachable `runtimeFence` statements (they build, and throw when
   * executed) and unreached-code blockers (their bodies never lower). On by
   * default: a lint that hides them overstates how native the program is. */
  reportRuntimeFences?: boolean;
  reportUnreached?: boolean;
  /** Promote warnings to errors. Use when "no warnings" is the bar for the
   * whole program, not just the parts a build reaches. Default: true — the
   * lint promise is only as strong as its strictness. */
  strict?: boolean;
  /** Run the backend verification pass (typed-IR validation + LLVM
   * emission) after the frontend analysis. Default: true. Turning it off
   * makes the lint roughly twice as fast and narrows the claim to the
   * frontend: the guarantee then says so explicitly. */
  verify?: boolean;
  /** Keep the emitted LLVM IR file. Default: false — the linter writes to a
   * temporary scratch directory and deletes it, so linting a program never
   * leaves artifacts. */
  keepLlvm?: boolean;
}

export interface LintLocation {
  file: string;
  /** Byte offset into the source text. */
  start: number;
  /** Always equal to `start`: a lint finding is a point, and the compiler's
   * diagnostic ranges are not uniform enough to promise a reliable end. */
  end: number;
}

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  family: RuleFamily;
  /** The compiler's own wording, verbatim. */
  message: string;
  loc: LintLocation;
  /** Present for compiler diagnostics; absent for the linter's own
   * runtime-fence and unreached-code findings. */
  code?: ScCode;
  hint?: string;
  note?: string;
  /** True when the construct compiles under `--dynamic` instead. */
  dynamicAlternative?: boolean;
  /** Attribution group: findings the entry path reaches, statements the
   * build never lowers, or code that lowers but defers to RUNTIME. */
  origin: "reached" | "unreached" | "runtime";
}

export interface LintStatementStats {
  /** Statements the linter's analysis pass lower-attempted, whole program:
   * the reached path plus the unreached remainder. */
  analyzed: number;
  /** Statements that lower to static native code. */
  static: number;
  /** Statements that lower for a `--dynamic` build (island sites). Always 0
   * unless `dynamic` is set. */
  island: number;
  /** Statements on the entry path the static tier refuses. */
  blocked: number;
  /** Statements in bodies nothing on the entry path reaches: the compiler
   * lowers them only for analysis, so their blockers cannot fail a build. */
  unreachedBlocked: number;
  /** Functions whose signature blocked analysis; their bodies were never
   * counted. */
  functionsSkipped: number;
  staticPercent: number;
}

export interface LintGuarantee {
  /** No error-level finding: the program passes the stages in `checked`
   * unchanged. With `verify` on (the default) that means a build from the
   * same source with the same options reaches native code generation. */
  supported: boolean;
  /** `supported` AND no warnings: nothing the linter reports at all, so the
   * compiler accepts every statement the program declares, including bodies
   * a build would never reach. */
  strictClean: boolean;
  /** The pipeline stages this verdict covers, in order. */
  checked: readonly string[];
  /** What a green verdict does NOT cover. Never omitted: the linter's whole
   * value is that its claim is exactly as wide as its evidence. */
  notChecked: readonly string[];
  /** One sentence a caller can print, stating the verdict and its scope. */
  summary: string;
}

export interface LintResult {
  entry: string;
  /** Analysis options the run used, normalized. */
  options: LintOptions;
  findings: LintFinding[];
  stats: LintStatementStats;
  guarantee: LintGuarantee;
  /** The compiler's analysis result, for embedders that want the full
   * coverage input (per-file stats, npm-static status, dynamic builtins). */
  analysis: AnalyzeResult["coverage"];
  /** True when `compile()` was reached. False when analysis already failed,
   * or when `verify` was disabled. */
  compiled: boolean;
}

/** The stages the frontend-only pass covers: `analyze()` plus the lowering it
 * runs. Kept as its own list so a reordering of VERIFIED_STAGES can never silently
 * narrow (or widen) an unverified run's claim. */
export const FRONTEND_STAGES: readonly string[] = [
  "TypeScript preflight (the program must typecheck)",
  "project-configuration gates",
  "module-graph resolution and import forms",
  "whole-program lowering (entry path and unreached bodies)",
];

/** A verified run's stages: the frontend plus everything the verification
 * pass adds. */
export const VERIFIED_STAGES: readonly string[] = [
  ...FRONTEND_STAGES,
  "typed-IR validation",
  "LLVM IR emission",
];

const NOT_CHECKED: readonly string[] = [
  "native object/executable emission, linking, and the platform SDK",
  "the C runtime and precompiled runtime packs",
  "runtime behavior: a lint pass says the program BUILDS, not what it does",
  "runtimeFence statements — they build, and throw where Node would not",
];

function locOf(file: string, start: number): LintLocation {
  return { file, start, end: start };
}

/** Identity of a diagnostic for de-duplication. The analysis pass and the
 * verification pass share the same frontend decisions, so a blocker that
 * stops the frontend shows up in both lists: the lint reports it once. */
function diagKey(diag: ScrDiagnostic): string {
  return `${diag.code}\u0000${diag.loc.file}\u0000${diag.loc.start}`;
}

function finding(diag: ScrDiagnostic, severity: LintSeverity, origin: LintFinding["origin"]): LintFinding {
  const rule: Rule = ruleFor(diag.code as ScCode, diag.message);
  return {
    ruleId: `scriptc/${diag.code}`,
    severity,
    family: rule.family,
    message: diag.message,
    loc: locOf(diag.loc.file, diag.loc.start),
    code: diag.code as ScCode,
    ...(diag.hint === undefined ? {} : { hint: diag.hint }),
    ...(diag.note === undefined ? {} : { note: diag.note }),
    ...(rule.dynamicAlternative ? { dynamicAlternative: true } : {}),
    origin,
  };
}

/** Findings the linter emits itself, for compiler output that is not a
 * diagnostic: the reachable statements that defer to the runtime. */
function fenceFinding(diag: ScrDiagnostic): LintFinding {
  return {
    ruleId: "scriptc/runtime-fence",
    severity: "warning",
    family: "type",
    message: diag.message,
    loc: locOf(diag.loc.file, diag.loc.start),
    ...(diag.hint === undefined ? {} : { hint: diag.hint }),
    origin: "runtime",
  };
}

/** Deterministic order: file, then offset, then severity, then rule id. */
function sortFindings(findings: LintFinding[]): LintFinding[] {
  const rank: Record<LintSeverity, number> = { error: 0, warning: 1, note: 2 };
  return [...findings].sort(
    (a, b) =>
      a.loc.file.localeCompare(b.loc.file) ||
      a.loc.start - b.loc.start ||
      rank[a.severity] - rank[b.severity] ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

function promote(findings: LintFinding[], strict: boolean): LintFinding[] {
  if (!strict) return findings;
  return findings.map((f) => (f.severity === "warning" ? { ...f, severity: "error" as const } : f));
}

/** A summary that states the exact scope of the verdict. */
function summarize(entry: string, supported: boolean, findings: LintFinding[], strict: boolean, verified: boolean): string {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  const scope = verified ? "the frontend, typed IR, and LLVM emission" : "the frontend analysis";
  if (supported) {
    return strict
      ? `${entry} is fully supported: ${scope} accept every statement, and the linter reports nothing.`
      : `${entry} is fully supported: ${scope} all accept this program.`;
  }
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  return `${entry} is not supported as linted: ${plural(errors, "blocking error")} and ${plural(warnings, "warning")} stop the static build.`;
}

function statementsOf(coverage: AnalyzeResult["coverage"]): LintStatementStats {
  const reached = coverage.stats;
  const unreached = coverage.unreached;
  const unreachedBlocked = unreached?.stats.statementsFailed ?? 0;
  const analyzed = reached.statementsTotal + (unreached?.stats.statementsTotal ?? 0);
  const island = reached.statementsIsland + (unreached?.stats.statementsIsland ?? 0);
  const blocked = reached.statementsFailed;
  const staticCount = analyzed - blocked - island - unreachedBlocked;
  return {
    analyzed,
    static: staticCount,
    island,
    blocked,
    unreachedBlocked,
    functionsSkipped: reached.functionsSkipped + (unreached?.stats.functionsSkipped ?? 0),
    staticPercent: analyzed === 0 ? 100 : Math.floor((staticCount / analyzed) * 100),
  };
}

/** Verify the program builds: run lowering without coverage, typed-IR
 * validation, and LLVM emission. Returns the LLVM emitter's diagnostics (at
 * most one, SC3001) or null when emission succeeded. Throws only on internal
 * compiler errors, which are not the developer's to fix. */
async function verifyEmission(entry: string, options: LintOptions): Promise<ScrDiagnostic[] | null> {
  const scratch = await mkdtemp(join(tmpdir(), "scriptc-lint-"));
  try {
    const result = await compile(entry, {
      outputKind: "llvm",
      outDir: scratch,
      outPath: join(scratch, `${basename(entry)}.ll`),
      ...(options.dynamic === undefined ? {} : { dynamic: options.dynamic }),
      ...(options.npmStatic === undefined ? {} : { npmStatic: options.npmStatic }),
      ...(options.ffiProfilePath === undefined ? {} : { ffiProfilePath: options.ffiProfilePath }),
    });
    if (result.ok) return null;
    return result.diagnostics;
  } finally {
    if (options.keepLlvm !== true) await rm(scratch, { recursive: true, force: true });
  }
}

/** Lint one program. Synchronous work plus one async verification pass; see
 * the module comment for the exact pipeline. */
export async function lint(entryPath: string, options: LintOptions = {}): Promise<LintResult> {
  const strict = options.strict ?? true;
  const analysis = analyze(entryPath, options);
  const coverage = analysis.coverage;
  const findings: LintFinding[] = [];
  const seen = new Set<string>();
  const push = (diag: ScrDiagnostic, severity: LintSeverity, origin: LintFinding["origin"]): void => {
    const key = diagKey(diag);
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding(diag, severity, origin));
  };

  // Preflight failures carry no lowering verdict, and `diagnostics` already
  // holds every gate that fired. Report them and stop: there is nothing
  // trustworthy to verify, and running the backend over a program that did
  // not typecheck would produce noise, not evidence.
  for (const diag of coverage.diagnostics) push(diag, "error", "reached");

  const verify = options.verify !== false;
  let compiled = false;
  if (!coverage.preflightFailed) {
    for (const diag of coverage.runtimeFences ?? []) {
      if (options.reportRuntimeFences !== false) findings.push(fenceFinding(diag));
    }
    if (options.reportUnreached !== false) {
      for (const diag of coverage.unreached?.diagnostics ?? []) {
        if (seen.has(diagKey(diag))) continue;
        findings.push(finding(diag, "warning", "unreached"));
      }
    }
    // The backend pass is the difference between "the analyzer accepts it"
    // and "the build accepts it". Run it whenever the frontend got that far
    // and the caller did not opt out of the stronger claim.
    if (verify) {
      compiled = true;
      const emission = await verifyEmission(entryPath, options);
      for (const diag of emission ?? []) push(diag, "error", "reached");
    }
  }

  const reported = sortFindings(promote(findings, strict));
  const errors = reported.filter((f) => f.severity === "error");
  const warnings = reported.filter((f) => f.severity === "warning");
  const supported = errors.length === 0;
  const guarantee: LintGuarantee = {
    supported,
    strictClean: supported && warnings.length === 0,
    checked: compiled ? VERIFIED_STAGES : FRONTEND_STAGES,
    notChecked: NOT_CHECKED,
    summary: summarize(entryPath, supported, reported, strict, compiled),
  };

  return {
    entry: entryPath,
    options: { ...options, strict },
    findings: reported,
    stats: statementsOf(coverage),
    guarantee,
    analysis: coverage,
    compiled,
  };
}

/** The exit code a CLI should use: 0 when supported, 1 when not, 2 when the
 * linter itself could not run. */
export function lintExitCode(result: LintResult): 0 | 1 {
  return result.guarantee.supported ? 0 : 1;
}
