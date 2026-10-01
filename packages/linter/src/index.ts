/* @scriptc/linter — the public surface.
 *
 *   import { lint } from "@scriptc/linter";
 *   const result = await lint("src/main.ts");
 *   if (!result.guarantee.supported) process.exit(1);
 *
 * The lint is a build claim, not a style opinion: it drives the compiler's own
 * `analyze()` and `compile()` entry points and re-labels their diagnostics.
 */

export {
  lint,
  lintExitCode,
  FRONTEND_STAGES,
  VERIFIED_STAGES,
  type LintFinding,
  type LintGuarantee,
  type LintLocation,
  type LintOptions,
  type LintResult,
  type LintSeverity,
  type LintStatementStats,
} from "./engine.js";
export {
  report,
  reportGithub,
  reportJson,
  reportText,
  type LintFormat,
  type LintJsonDocument,
  type LintJsonFinding,
  type ReportOptions,
} from "./report.js";
export {
  allRules,
  hasDynamicAlternative,
  ruleFor,
  FAMILY_TITLES,
  RULE_FAMILIES,
  type Rule,
  type RuleFamily,
  type ScCode,
} from "./rules.js";
export { runLintCli, EXPLAIN, USAGE, type CliIo, type CliOutcome } from "./cli.js";
