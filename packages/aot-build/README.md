# @fearless/aot-build

Orchestration package: scans a [Fearless](https://github.com/rodrigooler/fearless) app's TypeScript source, runs the AOT analyzer + transpiler over each registered handler, emits Rust source for the `rust-core` to compile in.

## Install

```bash
npm install @fearless/aot-build
```

## Usage

```ts
import { compileApp, formatBuildReport } from "@fearless/aot-build";

const source = await fs.readFile("my-app.ts", "utf8");
const result = compileApp({ source });

console.log(formatBuildReport(result));
// Discovered 7 routes: 5 AOT, 2 Bun-fallback, 0 template.
//   ✅ GET /healthz             → Rust (handler_0...)
//   ✅ GET /users/:id           → Rust (handler_1...)
//   ⚠️  POST /users              → Bun (blocked by: no-await)
//   ...

// Persist generated Rust + manifest:
await fs.writeFile("rust-core/src/aot/handlers.rs", result.rustSource);
await fs.writeFile("rust-core/src/aot/dispatch_manifest.json",
  JSON.stringify(result.dispatchManifest, null, 2));
```

The CLI wrapper at the repo root (`scripts/fearless-build.mjs`) does the file writes + cargo build for you.

## What it does

1. Parses your app source with the TypeScript compiler.
2. Walks `app.get/post/put/...` and `app.text/json/html` calls.
3. For each route:
   - Inline arrow handlers → analyzer + transpiler (compile to Rust if eligible)
   - Template-style routes (`app.text/json/html`) with literal bodies → synthesized as `(ctx) => ctx.<method>(literal)` and lifted into the AOT pipeline (so they serve at AOT speed too)
   - Non-inline / async / external-capture handlers → marked as Bun fallback
4. Emits a single `aot_handlers.rs` containing all generated functions + a `register(table)` function the runtime calls at startup.
5. Returns a manifest mapping (method, path) → kind (`aot` | `bun` | `template`) for the dispatcher.

## License

MIT
