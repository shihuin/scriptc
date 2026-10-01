/* `scriptc-c-embed` — the command line over the generator.
 *
 * Exit codes:
 *   0  files written (or --check found them up to date)
 *   1  --check found a difference (the header is stale)
 *   2  the tool could not run: bad arguments, unreadable profile, I/O error
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadLibraryProfile, renderDiagnostics, type LibraryProfile } from "@scriptc/compiler";
import { generateAll, stemOf } from "@scriptc/compiler/embed";

export const USAGE = `scriptc-c-embed — generate the C header, shim, and descriptor for a scriptc library

The library-mode archive has a C ABI; this writes down what it is. The header
is derived from the same profile the archive was built with, and every
signature in it is checked against the archive's own LLVM IR by the test
suite, so it cannot drift from the artifact.

Usage:
  scriptc-c-embed --profile <profile.json> [--out <dir>] [options]

Options:
      --profile <path>  the library profile the archive was built with (required)
  -o, --out <dir>       directory to write into (default: beside the profile)
      --stem <name>     base file name (default: the profile's name, slugified)
      --bare            omit the marshalling/memory prose preamble
      --check           do not write: fail if the generated files are stale
      --list             print every symbol and signature to stdout, write nothing
  -h, --help            show this help
      --explain         what the generated surface promises, and what it does not
`;

export const EXPLAIN = `scriptc-c-embed --explain

What the generated header IS
  The C ABI of the archive scriptc's library mode emits for this profile: one
  declaration per exported wrapper, the mode-provided lifecycle entries
  (init, panic-sink registration, collect, result reset), the host-callback
  channel typedefs, and the profile's identity getters. Marshalling follows
  the profile's declared classes, spelled in <stdint.h> types.

Why it cannot drift
  Every signature is derived from the same LibraryProfile the compiler reads,
  and the test suite compiles a fixture to LLVM IR and asserts each generated
  signature appears there verbatim. A header that disagreed with the archive
  would fail CI, not an embedder's link step.

What it does NOT promise
  - Linkage. The archive must be linked, and the target triple must match.
  - Thread safety beyond what the profile declares: one instance per archive
    unless the profile says instance_per_thread, and calls are not re-entrant
    across threads.
  - Runtime behavior. The header says how to call; the contract sidecar says
    what the calls mean.
  - A stable ABI across compiles: identity getters exist so a host can fence a
    stale archive before calling into it.
`;

interface CliValues {
  profile?: string;
  out?: string;
  stem?: string;
  bare: boolean;
  check: boolean;
  list: boolean;
  help: boolean;
  explain: boolean;
}

export interface CliIo {
  cwd?: string;
}

export interface CliOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function formatSignatures(profile: LibraryProfile): string {
  const lines: string[] = [];
  for (const file of generateAll(profile, { bare: true })) {
    if (!file.name.endsWith(".h") || file.name.includes("-shim")) continue;
    lines.push(`/* ${file.name} */`);
    for (const line of file.text.split("\n")) {
      if (line.includes("(") && line.endsWith(";")) lines.push(line.trim());
    }
  }
  return lines.join("\n") + "\n";
}

/** Run the CLI once. Never throws and never touches process state. */
export async function runEmbedCli(argv: string[], io: CliIo = {}): Promise<CliOutcome> {
  const cwd = io.cwd ?? process.cwd();
  let values: CliValues;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        profile: { type: "string" },
        out: { type: "string", short: "o" },
        stem: { type: "string" },
        bare: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        list: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        explain: { type: "boolean", default: false },
      },
    });
    values = parsed.values as CliValues;
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    return { stdout: "", stderr: `scriptc-c-embed: ${message}\n\n${USAGE}`, exitCode: 2 };
  }

  if (values.help) return { stdout: USAGE, stderr: "", exitCode: 0 };
  if (values.explain) return { stdout: EXPLAIN, stderr: "", exitCode: 0 };
  if (values.profile === undefined) {
    return { stdout: "", stderr: `scriptc-c-embed: --profile is required\n\n${USAGE}`, exitCode: 2 };
  }

  const profilePath = resolve(cwd, values.profile);
  const loaded = loadLibraryProfile(profilePath);
  if (!loaded.ok) {
    const rendered = renderDiagnostics(loaded.diagnostics, new Map(), { color: false });
    return { stdout: "", stderr: `scriptc-c-embed: the profile is not usable:\n${rendered}\n`, exitCode: 2 };
  }
  const profile = loaded.profile;

  if (values.list) return { stdout: formatSignatures(profile), stderr: "", exitCode: 0 };

  const outDir = values.out === undefined ? dirname(profilePath) : resolve(cwd, values.out);
  const options = {
    ...(values.stem === undefined ? {} : { stem: values.stem }),
    bare: values.bare,
  };
  const files = generateAll(profile, options);
  const stem = stemOf(profile, values.stem);

  try {
    if (values.check) {
      const stale: string[] = [];
      for (const file of files) {
        const path = join(outDir, file.name);
        let existing: string | null = null;
        try {
          existing = await readFile(path, "utf8");
        } catch {
          existing = null;
        }
        if (existing !== file.text) stale.push(path);
      }
      if (stale.length > 0) {
        return {
          stdout: "",
          stderr: `scriptc-c-embed: stale (regenerate with --profile ${values.profile}):\n${stale.map((p) => `  ${p}`).join("\n")}\n`,
          exitCode: 1,
        };
      }
      return { stdout: `${stem}: up to date (${files.length} files)\n`, stderr: "", exitCode: 0 };
    }

    await mkdir(outDir, { recursive: true });
    for (const file of files) await writeFile(join(outDir, file.name), file.text, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: `scriptc-c-embed: ${message}\n`, exitCode: 2 };
  }

  const names = files.map((f) => f.name).join(", ");
  return { stdout: `${stem}: wrote ${names} into ${outDir}\n`, stderr: "", exitCode: 0 };
}
