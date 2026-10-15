import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);

/** What the driver counted, in the report's own order. */
const REPORTED = "scriptc guard fallbacks: read=2 state=1 write=0 push=1";

/* The counters only exist in the RC-audit runtime, and the report only fires
 * with the variable set, so one lane is enough — but it has to be the
 * sanitized one, since that is the lane the compiler emits the note into. */
describe.skipIf(process.platform === "win32")("guard-fallback counters", () => {
  test("the exit report is opt-in, exact, and absent without the variable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-checks-"));
    try {
      const bin = join(dir, "checks");
      await exec("clang", [
        "-std=c11",
        "-O1",
        "-Wno-deprecated-declarations",
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        "-fsanitize=address,undefined",
        "-DSCR_RC_AUDIT",
        ...["scr_checks.test.c", ...EXECUTABLE_RUNTIME_SOURCES].map((source) =>
          join(import.meta.dirname, source),
        ),
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-o",
        bin,
      ]);

      // Unset: stdout is the program's, stderr must carry nothing at all.
      const quiet = await exec(bin, {
        timeout: 60000,
        env: { ...process.env, ASAN_OPTIONS: "halt_on_error=1" },
      });
      expect(quiet.stdout.trim()).toBe("counted");
      expect(quiet.stderr).toBe("");

      // Set: the same run, plus exactly one line reporting what was counted.
      const reported = await exec(bin, {
        timeout: 60000,
        env: {
          ...process.env,
          SCRIPTC_CHECK_STATS: "1",
          ASAN_OPTIONS: "halt_on_error=1",
        },
      });
      expect(reported.stdout.trim()).toBe("counted");
      const lines = reported.stderr.trim().split("\n");
      expect(lines).toContain(REPORTED);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
