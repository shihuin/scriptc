# @scriptc/c-embed

Generate the C header, shim, and CMake fragment an embedder compiles against a **scriptc library-mode archive**.

scriptc's `build --lib` emits a static archive whose exported functions are C-ABI wrappers around a compiled TypeScript module's exports — and, until now, no declaration of that surface. Every embedder wrote the header by hand (`tests/library-mode/scalars/probe.c` is one). This package writes it down instead, from the same profile the archive was built with.

```console
$ scriptc build --lib --profile app.profile.json --out dist/libapp.a
$ scriptc-c-embed --profile app.profile.json --out dist
app: wrote app.h, app.c-embed.json, app.cmake into dist
```

Then:

```c
#include "app.h"

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr);

int main(void) {
  app_set_panic_sink(sink, NULL);
  app_init();
  double total = app_add(0.1, 0.2);
  app_collect();
  return total > 0 ? 0 : 1;
}
```

or, with CMake:

```cmake
set(SCRIPT_EMBED_ARCHIVE ${CMAKE_CURRENT_LIST_DIR}/libapp.a)
include(${CMAKE_CURRENT_LIST_DIR}/app.cmake)
target_link_libraries(my_app PRIVATE scriptc::app)
```

## Why the header can be trusted

A generated header is worse than useless if it disagrees with the archive: C will happily compile a call with the wrong pointee and corrupt memory at runtime. So the surface is checked from four directions, and all four are in this package's test suite:

| Check | What it catches |
| --- | --- |
| `test/c-abi.test.ts` | The class→C mapping itself: every marshalling class, every position |
| `test/ir-audit.test.ts` | **The archive's own LLVM IR**: every generated symbol exists there, with the right parameter shapes. Four real fixtures, including i64/u64 returns |
| `test/e2e-link.test.ts` | A C program that includes **only the generated header**, links the real archive, runs, and produces the expected transcript — plus the same through the generated CMake fragment |
| `test/header.test.ts`, `test/cli.test.ts` | Structure, the descriptor, reproducibility (no timestamps, no absolute paths), and the CLI's exit codes |

The IR audit is the load-bearing one: it is what makes this "derived from the compiler's own decisions" rather than "a plausible second opinion".

## The ABI, stated once

| TypeScript class | C |
| --- | --- |
| `f64` | `double` |
| `bool` | `uint8_t` (0/1) |
| `u8` / `u32` / `i32` / `i64` / `u64` | the matching `<stdint.h>` type |
| `string` | `const uint8_t *ptr, size_t len` — UTF-8, **not** NUL-terminated |
| `bytes` | `const uint8_t *ptr, size_t len` |
| `string`/`bytes` return | `void` with `const uint8_t **out, size_t *out_len` appended |

Plus the mode-provided entries from the profile: `init`, the panic-sink registration, `collect`, the declared result reset, the host-callback registrar, and the build-identity getters.

### The one that bites

`out` is a **pointer to pointer**. The library does not copy into a host buffer; it hands back a pointer into its own arena (`scr_library_str_out` in the runtime sets `*out = s->data`). So:

- a header declaring `uint8_t *out` describes an ABI that does not exist;
- the pointer is only valid until the next export call (unless the profile declares a result reset, in which case it stays valid until that reset);
- a host that stores it and reads later is reading freed memory.

The generated `-shim.c` exists for exactly this: `app_shim_shout(...)` calls the export, copies the arena bytes into a host-owned buffer, and returns that. `app_shim_free` is `free`.

## What it generates

| File | Purpose |
| --- | --- |
| `<stem>.h` | The C ABI: marshalling rules, memory and threading posture in prose, then the declarations |
| `<stem>.c-embed.json` | The same surface as JSON, for non-C embedders (Zig, Rust, Python ctypes) |
| `<stem>.cmake` | Imports the archive and exposes `scriptc::<stem>` as one interface target |
| `<stem>-shim.h` / `<stem>-shim.c` | Host-owned-buffer wrappers, emitted only when the profile moves buffers |

Output is deterministic: the same profile and stem produce byte-identical files, so a generated header is diffable and a `--check` in CI can fail a stale one.

## CLI

```console
$ scriptc-c-embed --profile app.profile.json      # write beside the profile
$ scriptc-c-embed --profile app.profile.json --list
$ scriptc-c-embed --profile app.profile.json --check   # exit 1 when stale
$ scriptc-c-embed --explain
```

Exit codes: `0` written (or up to date), `1` `--check` found a difference, `2` the tool could not run.

## Library API

```ts
import { loadLibraryProfile } from "@scriptc/compiler";
import { generateAll, signaturesOf } from "@scriptc/c-embed";

const loaded = loadLibraryProfile("app.profile.json");
if (!loaded.ok) throw new Error("bad profile");
for (const file of generateAll(loaded.profile, { stem: "app" })) {
  writeFileSync(join("dist", file.name), file.text);
}
```

`signaturesOf(profile)` returns the structured surface if you are generating a binding for another language.

## Limits, stated plainly

- **It does not build the library.** Run `scriptc build --lib` first; this reads the same profile and writes the declaration.
- **It does not promise link compatibility.** The archive's target triple must match the host's.
- **It does not make the ABI stable across compiles.** Use the identity getters (`<prefix>build_id`, `<prefix>abi_version`) to fence a stale archive before calling in.
- **Threading is the profile's**, not the header's: one instance per linked archive unless the profile sets `instance_per_thread`, and calls are not re-entrant across threads. The header says which.
