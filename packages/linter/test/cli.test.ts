/* CLI tests: the argument contract and the exit codes, driven through the
 * same `runLintCli` the published bin calls. */

import { expect, test } from "vitest";
import { runLintCli } from "../src/cli.js";

const repo = process.cwd(); // vitest runs from the repository root
const supported = "tests/corpus/400-fib.ts";
const unsupported = "tests/coverage-fixtures/mixed.ts";

test("--help prints usage and succeeds", async () => {
  const outcome = await runLintCli(["--help"], { cwd: repo });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stdout).toContain("scriptc-lint —");
  expect(outcome.stdout).toContain("--explain");
});

test("--explain states the checked and unchecked scopes", async () => {
  const outcome = await runLintCli(["--explain"], { cwd: repo });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stdout).toContain("What a green lint proves");
  expect(outcome.stdout).toContain("What a green lint does NOT prove");
});

test("--list-rules prints the catalog", async () => {
  const outcome = await runLintCli(["--list-rules"], { cwd: repo });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stdout).toContain("scriptc/SC1040");
  expect(outcome.stdout).toContain("scriptc/SC3001");
});

test("no arguments is a usage error", async () => {
  const outcome = await runLintCli([], { cwd: repo });
  expect(outcome.exitCode).toBe(2);
  expect(outcome.stderr).toContain("Usage:");
});

test("an unknown format is rejected", async () => {
  const outcome = await runLintCli(["--format=yaml", supported], { cwd: repo });
  expect(outcome.exitCode).toBe(2);
  expect(outcome.stderr).toContain("unknown --format");
});

test("an unreadable file is a linter error, not a lint verdict", async () => {
  const outcome = await runLintCli(["does-not-exist.ts"], { cwd: repo });
  expect(outcome.exitCode).toBe(2);
  expect(outcome.stderr).toContain("cannot read");
});

test("a supported program exits 0", async () => {
  const outcome = await runLintCli([supported], { cwd: repo, isTty: false });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stdout).toContain("supported");
});

test("an unsupported program exits 1", async () => {
  const outcome = await runLintCli([unsupported], { cwd: repo, isTty: false });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.stdout).toContain("scriptc/SC1031");
});

test("--format=json emits a machine document", async () => {
  const outcome = await runLintCli(["--format=json", unsupported], { cwd: repo });
  expect(outcome.exitCode).toBe(1);
  const document = JSON.parse(outcome.stdout) as { tool: string; summary: { errors: number } };
  expect(document.tool).toBe("scriptc-lint");
  expect(document.summary.errors).toBeGreaterThan(0);
});

test("--format=github emits workflow annotations", async () => {
  const outcome = await runLintCli(["--format=github", unsupported], { cwd: repo });
  expect(outcome.exitCode).toBe(1);
  expect(outcome.stdout).toContain("::error file=");
  expect(outcome.stdout).toContain("title=scriptc/SC1031");
});

test("--max-warnings can fail an otherwise supported program", async () => {
  const unreached = "tests/coverage-fixtures/unreached.ts";
  const lenient = await runLintCli(["--no-strict", unreached], { cwd: repo });
  expect(lenient.exitCode).toBe(0);
  const budgeted = await runLintCli(["--no-strict", "--max-warnings=0", unreached], { cwd: repo });
  expect(budgeted.exitCode).toBe(1);
});
