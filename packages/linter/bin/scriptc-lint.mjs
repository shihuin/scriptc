#!/usr/bin/env node
/* The published `scriptc-lint` command. Kept deliberately thin: every
 * argument, lint, and report decision lives in the compiled library so the
 * tests exercise exactly what users run. */
import { runLintCli } from "../dist/cli.js";

const outcome = await runLintCli(process.argv.slice(2), {
  cwd: process.cwd(),
  isTty: process.stdout.isTTY ?? false,
});
if (outcome.stdout.length > 0) process.stdout.write(outcome.stdout);
if (outcome.stderr.length > 0) process.stderr.write(outcome.stderr);
process.exitCode = outcome.exitCode;
