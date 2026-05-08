# @fearless/aot-transpiler

Transpiles AOT-eligible [Fearless](https://github.com/rodrigooler/fearless) handlers from TypeScript to Rust source.

## Install

```bash
npm install @fearless/aot-transpiler
```

## Usage

You normally use this through `@fearless/aot-build` + the `fearless build` CLI, not directly. The package is exported in case you're building tooling that needs to invoke the transpiler standalone.

```ts
import { transpileHandler } from "@fearless/aot-transpiler";
import { analyzeHandler } from "@fearless/aot-analyzer";
import * as ts from "typescript";

const source = `(ctx) => ctx.json({ id: ctx.params.id })`;
const sourceFile = ts.createSourceFile("h.ts", source, ts.ScriptTarget.ES2022, true);
const handler = sourceFile.statements[0]; // ArrowFunction or FunctionExpression

const analysis = analyzeHandler(handler);
if (!analysis.compilable) throw new Error("not AOT-eligible");

const outcome = transpileHandler({
  handler,
  method: "GET",
  path: "/users/:id",
  id: "users_id",
});
if (outcome.success) {
  console.log(outcome.result.rustSource);
  // pub fn handler_users_id(req: &aot_runtime::AotRequest, out: &mut Vec<u8>) {
  //   ...
  // }
}
```

## Generated code shape

For literal-bodied handlers, the transpiler emits a single `&'static [u8]` write:

```ts
(ctx) => ctx.json({ ok: true })
```

becomes:

```rust
pub fn handler_ok(req: &aot_runtime::AotRequest, out: &mut Vec<u8>) {
    out.extend_from_slice(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: keep-alive\r\n\r\n{\"ok\":true}");
}
```

For handlers with runtime substitutions, body is built in a temp Vec and Content-Length is computed at runtime.

## Runtime contract

The generated Rust depends on a small runtime exposed at `crate::aot::runtime` in the `rust-core` crate. The contract is documented in [`src/runtime/mod.rs`](./src/runtime/mod.rs) — it's intentionally minimal: an `AotRequest` view + a few helpers (`write_json_string`, `write_decimal`, `write_url_encoded`).

If you embed this in a different Rust host, you can copy `src/runtime/mod.rs` and adapt the dispatcher. The runtime contract is stable across versions.

## License

MIT
