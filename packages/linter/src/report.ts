/* Report formatting: a human report for terminals and CI logs, a stable JSON
 * document for tooling, and the GitHub workflow-command format for inline
 * annotations. All three carry the same guarantee fields, so a pipeline can
 * gate on the verdict rather than on parsing prose.
 */

import { renderDiagnostics } from "@scriptc/compiler";
import type { ScrDiagnostic } from "@scriptc/compiler";
import type { LintFinding, LintResult, LintSeverity } from "./engine.js";
import { FAMILY_TITLES, ruleFor, type RuleFamily } from "./rules.js";

export type LintFormat = "text" | "json" | "github";

export interface ReportOptions {
  format?: LintFormat;
  color?: boolean;
  /** Include the source code frame under each finding's location line. */
  source?: Map<string, string>;
}

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const SEVERITY_LABEL: Record<LintSeverity, string> = {
  error: "error",
  warning: "warning",
  note: "note",
};

/** 1-based line/column for an offset, or 1:1 when the source text is unknown. */
function position(text: string | undefined, offset: number): { line: number; column: number } {
  if (text === undefined) return { line: 1, column: 1 };
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** The finding as a compiler diagnostic, so terminal frames use the exact
 * renderer `scriptc build` uses — locations read identically across the two
 * commands. */
function asDiagnostic(finding: LintFinding): ScrDiagnostic {
  return {
    code: (finding.code ?? "SC9001") as `SC${number}`,
    message: finding.message,
    loc: { file: finding.loc.file, start: finding.loc.start, end: finding.loc.end },
    ...(finding.hint === undefined ? {} : { hint: finding.hint }),
    ...(finding.note === undefined ? {} : { note: finding.note }),
  };
}

export interface LintJsonFinding {
  ruleId: string;
  severity: LintSeverity;
  family: RuleFamily;
  message: string;
  file: string;
  line: number;
  column: number;
  offset: number;
  origin: LintFinding["origin"];
  code?: string;
  description?: string;
  hint?: string;
  note?: string;
  dynamicAlternative?: boolean;
}

export interface LintJsonDocument {
  tool: "scriptc-lint";
  version: 1;
  results: {
    entry: string;
    supported: boolean;
    strictClean: boolean;
    compiled: boolean;
    stats: LintResult["stats"];
    checked: readonly string[];
    notChecked: readonly string[];
    summary: string;
    findings: LintJsonFinding[];
  }[];
  summary: {
    files: number;
    supported: number;
    failing: number;
    errors: number;
    warnings: number;
    supportedAll: boolean;
  };
}

function countSeverity(results: LintResult[]): { errors: number; warnings: number } {
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

function toJsonFinding(finding: LintFinding, source: Map<string, string> | undefined): LintJsonFinding {
  const { line, column } = position(source?.get(finding.loc.file), finding.loc.start);
  // The catalog description is keyed by diagnostic code. Linter-authored
  // findings (a runtime fence, say) have no code, so they carry no
  // description rather than borrowing an unrelated rule's wording.
  const description = finding.code === undefined ? undefined : ruleFor(finding.code, finding.message).description;
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    family: finding.family,
    message: finding.message,
    file: finding.loc.file,
    line,
    column,
    offset: finding.loc.start,
    origin: finding.origin,
    ...(finding.code === undefined ? {} : { code: finding.code }),
    ...(description === undefined ? {} : { description }),
    ...(finding.hint === undefined ? {} : { hint: finding.hint }),
    ...(finding.note === undefined ? {} : { note: finding.note }),
    ...(finding.dynamicAlternative === true ? { dynamicAlternative: true } : {}),
  };
}

/** The machine-readable document. Stable field names; additive changes only. */
export function reportJson(results: LintResult[], options: ReportOptions = {}): LintJsonDocument {
  const { errors, warnings } = countSeverity(results);
  const supported = results.filter((r) => r.guarantee.supported).length;
  return {
    tool: "scriptc-lint",
    version: 1,
    results: results.map((result) => ({
      entry: result.entry,
      supported: result.guarantee.supported,
      strictClean: result.guarantee.strictClean,
      compiled: result.compiled,
      stats: result.stats,
      checked: result.guarantee.checked,
      notChecked: result.guarantee.notChecked,
      summary: result.guarantee.summary,
      findings: result.findings.map((f) => toJsonFinding(f, options.source)),
    })),
    summary: {
      files: results.length,
      supported,
      failing: results.length - supported,
      errors,
      warnings,
      supportedAll: supported === results.length,
    },
  };
}

/** GitHub Actions workflow commands: one `::error`/`::warning` annotation per
 * finding, so a pull request shows the blockers inline. */
export function reportGithub(results: LintResult[], options: ReportOptions = {}): string {
  const lines: string[] = [];
  const escape = (value: string) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  // GitHub property escaping adds : and , on top of the message escaping,
  // applied after it so the percent signs it introduced are not re-escaped.
  const property = (value: string) => escape(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.severity === "note") continue;
      const level = finding.severity === "error" ? "error" : "warning";
      const { line, column } = position(options.source?.get(finding.loc.file), finding.loc.start);
      lines.push(
        `::${level} file=${property(finding.loc.file)},line=${line},col=${column},title=${property(finding.ruleId)}::${escape(finding.message)}`,
      );
    }
  }
  return lines.join("\n");
}

function findingBlock(finding: LintFinding, options: ReportOptions): string[] {
  const c = (code: string, s: string) => (options.color === true ? code + s + RESET : s);
  const text = options.source?.get(finding.loc.file);
  const { line, column } = position(text, finding.loc.start);
  const description = finding.code === undefined ? undefined : ruleFor(finding.code, finding.message).description;
  const severityColor = finding.severity === "error" ? RED : finding.severity === "warning" ? YELLOW : CYAN;
  const out: string[] = [];
  const framed = options.source !== undefined
    ? renderDiagnostics([asDiagnostic(finding)], options.source, { color: options.color === true })
    : `${finding.loc.file}:${line}:${column}`;
  out.push(`${c(BOLD, framed)}`);
  out.push(`  ${c(severityColor, `${SEVERITY_LABEL[finding.severity]} ${finding.ruleId}`)} ${c(DIM, `(${finding.family})`)}`);
  if (description !== undefined) out.push(`  ${c(DIM, description)}`);
  if (finding.origin === "unreached") {
    out.push(`  ${c(DIM, "this body is not on the entry path: the build never lowers it")}`);
  }
  if (finding.origin === "runtime") {
    out.push(`  ${c(DIM, "this builds; executing it throws where Node would not")}`);
  }
  if (finding.dynamicAlternative === true) {
    out.push(`  ${c(DIM, "fixed by --dynamic: the embedded engine runs this construct")}`);
  }
  return out;
}

/** The human report. Findings are grouped by rule family so a run answers
 * "what class of thing is blocking me" before listing sites. */
export function reportText(results: LintResult[], options: ReportOptions = {}): string {
  const c = (code: string, s: string) => (options.color === true ? code + s + RESET : s);
  const out: string[] = [];
  for (const result of results) {
    out.push(`${c(BOLD, "scriptc-lint")} ${result.entry}`);
    if (result.findings.length === 0) {
      out.push(`  ${c(GREEN, "supported")} — ${result.guarantee.summary}`);
      out.push("");
      continue;
    }
    const byFamily = new Map<RuleFamily, LintFinding[]>();
    for (const finding of result.findings) {
      const list = byFamily.get(finding.family);
      if (list === undefined) byFamily.set(finding.family, [finding]);
      else list.push(finding);
    }
    for (const [family, findings] of byFamily) {
      out.push("");
      out.push(`  ${c(BOLD, FAMILY_TITLES[family])} ${c(DIM, `(${findings.length})`)}`);
      out.push("");
      for (const finding of findings) out.push(...findingBlock(finding, options), "");
    }
    const s = result.stats;
    out.push(
      `  ${c(DIM, `statements: ${s.static}/${s.analyzed} static (${s.staticPercent}%)`)}${
        s.blocked > 0 ? c(DIM, `, ${s.blocked} blocked on the entry path`) : ""
      }${s.unreachedBlocked > 0 ? c(DIM, `, ${s.unreachedBlocked} blocked in unreached code`) : ""}`,
    );
    if (s.functionsSkipped > 0) out.push(`  ${c(DIM, `${s.functionsSkipped} function(s) not analyzed (blocked signature)`)}`);
    out.push("");
    out.push(`  ${c(RED, "not supported")} — ${result.guarantee.summary}`);
    out.push("");
  }

  const { errors, warnings } = countSeverity(results);
  const supported = results.filter((r) => r.guarantee.supported).length;
  if (results.length > 1) {
    out.push(
      `${supported}/${results.length} file${results.length === 1 ? "" : "s"} supported, ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`,
    );
  } else {
    out.push(`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`);
  }
  return out.join("\n");
}

export function report(results: LintResult[], options: ReportOptions = {}): string {
  switch (options.format ?? "text") {
    case "json":
      return JSON.stringify(reportJson(results, options), null, 2);
    case "github":
      return reportGithub(results, options);
    default:
      return reportText(results, options);
  }
}
