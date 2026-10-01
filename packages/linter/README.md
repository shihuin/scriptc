# @scriptc/linter

`scriptc-lint` answers one question about a TypeScript or JavaScript program: **will scriptc compile it as-is?**

It is not a style linter. Every rule it can report is a diagnostic the compiler itself already emits, re-labelled and anchored to source, so a lint verdict and a build verdict cannot disagree.

## The promise

> A green `scriptc-lint` run means the frontend, typed-IR validation, and LLVM emission all accept the program. Nothing the static tier refuses is left in the file, including bodies no entry path reaches.

The linter drives the compiler's own public entry points — `analyze()` (the same whole-program pass `scriptc coverage` runs) and `compile({ outputKind: "llvm" })` (the same pipeline `scriptc build` runs, stopped at LLVM emission):

| Stage | Covered |
| --- | --- |
| TypeScript preflight (the program must typecheck) | yes |
| Project-configuration gates | yes |
| Module graph, import forms, builtin modules | yes |
| Whole-program lowering, entry path and unreached bodies | yes |
| Typed-IR validation | yes |
| LLVM IR emission (catches backend-only gaps, `SC3001`) | yes |
| Native object/executable emission, linking, platform SDK, C runtime | **no** |
| Runtime behavior (what the program prints) | **no** |

The unchecked stages need a host toolchain and are deliberately outside the linter's claim. Run `scriptc-lint --explain` for the same contract in the terminal, and read `result.guarantee.checked` / `result.guarantee.notChecked` in the API.

## Install and run

The package ships `scriptc-lint`:

```bash
scriptc-lint src/main.ts
scriptc-lint src/main.ts src/cli.ts src/worker.ts
scriptc-lint --format=json src/main.ts
```

Exit codes: `0` supported, `1` not supported (or the warning budget is spent), `2` the linter could not run.

Options that matter most:

```console
$ scriptc-lint --help
scriptc-lint — lint TS/JS for the statically supported scriptc subset
...
```

- `--dynamic` — lint what a `--dynamic` build compiles. Island-capable constructs (`SC2010`–`SC2013`) lower instead of fencing, so the report shows what is left once the embedded engine is allowed.
- `--no-verify` — skip typed-IR validation and LLVM emission. About twice as fast, and the verdict narrows to the frontend; the report says so.
- `--no-strict` — keep warnings non-blocking. Warnings are unreached-code blockers and reachable statements that build but trap at runtime.
- `--no-unreached` / `--no-runtime-fences` — drop those groups from the report.
- `--format=github` — GitHub Actions workflow-command annotations for inline pull-request comments.
- `--max-warnings <n>` — fail when the warning count exceeds the budget.
- `--list-rules` — print the rule catalog (every rule maps to a compiler diagnostic code).
- `--npm-static`, `--ffi`, `--external-types` — the same options `scriptc build` and `scriptc coverage` take, forwarded to the compiler.

## Library API

```ts
import { lint } from "@scriptc/linter";

const result = await lint("src/main.ts");
if (!result.guarantee.supported) process.exit(1);

console.log(result.guarantee.summary);   // exact scope of the verdict
console.log(result.stats.staticPercent); // statements that lower to static native code
for (const finding of result.findings) {
  console.log(finding.loc.file, finding.loc.start, finding.ruleId, finding.message);
}
```

`lint()` accepts `AnalyzeOptions` (`dynamic`, `npmStatic`, `ffiProfilePath`, `externalTypes`) plus the linter's own `strict`, `verify`, `reportUnreached`, `reportRuntimeFences`, and `keepLlvm`. `report*` helpers render the same result as text, JSON, or GitHub annotations.

## Rules

Rule ids are `scriptc/<code>`, one per compiler diagnostic code, grouped by family:

| Family | Codes | Meaning |
| --- | --- | --- |
| frontend | SC0xxx | Nothing is claimed about support yet: type errors, project-config gates |
| unsupported | SC1xxx | Valid TypeScript outside the statically compiled subset |
| type | SC2xxx | scriptc type rules; `SC2010`–`SC2013` are the `--dynamic` alternative |
| backend | SC3xxx | The program is valid; the backend or target does not include it |
| library | SC4xxx | Library emission mode (`scriptc build --lib`) |
| ffi | SC5xxx | Native FFI manifests and signatures |
| internal | SC9xxx | Internal compiler errors |

The catalog is checked against the compiler's diagnostic registry by `test/rules.test.ts`: a diagnostic code added upstream without wording here fails the linter's own test suite.

## How it stays honest

- The linter imports only the compiler's public entry point (`@scriptc/compiler`), so it can never report a verdict the installed compiler does not make.
- Deduplication keeps a frontend blocker from being reported twice when the verification pass surfaces the same decision again.
- The guarantee object always names what was *not* checked; there is no mode where a green lint silently overstates its scope.
- The test suite runs the real compiler against programs whose behavior the repository's corpus and coverage suites already pin.

## Development

```bash
pnpm --filter @scriptc/linter build
pnpm vitest run packages/linter/test
```
