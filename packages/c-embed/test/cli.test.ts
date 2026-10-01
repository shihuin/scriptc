/* CLI contract: the flags, the exit codes, and the --check staleness gate an
 * embedder wires into CI. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runEmbedCli } from "../src/cli.js";

const repo = process.cwd();
const PROFILE = join(repo, "tests/library-mode/scalars/profile.json");

test("--help and --explain succeed and describe the contract", async () => {
  const help = await runEmbedCli(["--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("scriptc-c-embed");

  const explain = await runEmbedCli(["--explain"]);
  expect(explain.exitCode).toBe(0);
  expect(explain.stdout).toContain("What the generated header IS");
  expect(explain.stdout).toContain("What it does NOT promise");
});

test("a missing --profile is a usage error", async () => {
  const outcome = await runEmbedCli([]);
  expect(outcome.exitCode).toBe(2);
  expect(outcome.stderr).toContain("--profile is required");
});

test("an unknown option is rejected, not ignored", async () => {
  const outcome = await runEmbedCli(["--profile", PROFILE, "--nope"]);
  expect(outcome.exitCode).toBe(2);
  expect(outcome.stderr).toContain("scriptc-c-embed:");
});

test("a bad profile path fails with the tool's own error", async () => {
  const outcome = await runEmbedCli(["--profile", join(repo, "does-not-exist.json")]);
  expect(outcome.exitCode).toBe(2);
  expect(outcome.stderr).toContain("not usable");
});

test("--list prints symbols without writing anything", async () => {
  const outcome = await runEmbedCli(["--profile", PROFILE, "--list"]);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stdout).toContain("kt_add");
  expect(outcome.stdout).toContain("kt_init");
  expect(outcome.stdout).not.toContain("wrote");
});

test("generation writes the header and the descriptor, and --check passes after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "c-embed-cli-"));
  try {
    const write = await runEmbedCli(["--profile", PROFILE, "--out", dir], { cwd: repo });
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toContain("conformance_scalars.h");
    const header = readFileSync(join(dir, "conformance_scalars.h"), "utf8");
    expect(header).toContain("void kt_init(void);");

    const check = await runEmbedCli(["--profile", PROFILE, "--out", dir], { cwd: repo });
    expect(check.exitCode).toBe(0);

    const checkMode = await runEmbedCli(["--profile", PROFILE, "--out", dir, "--check"], { cwd: repo });
    expect(checkMode.exitCode).toBe(0);
    expect(checkMode.stdout).toContain("up to date");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check fails when a generated file is stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "c-embed-stale-"));
  try {
    await runEmbedCli(["--profile", PROFILE, "--out", dir], { cwd: repo });
    writeFileSync(join(dir, "conformance_scalars.h"), "/* hand-edited */\n");
    const outcome = await runEmbedCli(["--profile", PROFILE, "--out", dir, "--check"], { cwd: repo });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--stem renames the files without renaming the symbols", async () => {
  const dir = mkdtempSync(join(tmpdir(), "c-embed-stem-"));
  try {
    const outcome = await runEmbedCli(["--profile", PROFILE, "--out", dir, "--stem", "my_lib"], { cwd: repo });
    expect(outcome.exitCode).toBe(0);
    const header = readFileSync(join(dir, "my_lib.h"), "utf8");
    expect(header).toContain("void kt_init(void);");
    expect(header).toContain("SCRIPT_EMBED_KT_MY_LIB_H");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
