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

## Async handler emission (Phase 1.2)

When the analyzer marks a handler as async-compilable, the transpiler emits a
Rust `pub async fn` that calls into the build-generated `HandleRegistry`:

Input TypeScript:

```typescript
const db = fearless.sql("primary");

app.get("/db", async (ctx) =>
  await db.queryOne(sql`SELECT id, randomnumber FROM world WHERE id = ${Math.floor(Math.random() * 10000) + 1}`)
);
```

Generated Rust (truncated):

```rust
pub async fn handler_<id>(
    ctx: &crate::aot::runtime::AotRequest<'_>,
    handles: &crate::aot::handles::HandleRegistry,
) -> Vec<u8> {
    let p1: i32 = fastrand::i32(1..=10000);
    let row = match handles.sql.get("primary").expect(...).query_one("db_<hash>", &[&p1]).await {
        Ok(Some(r)) => r,
        Ok(None) => return crate::aot::runtime::not_found_response(),
        Err(_) => return crate::aot::runtime::error_response(503, b"database error"),
    };
    let mut body = Vec::with_capacity(128);
    // ... manual JSON build ...
    resp
}
```

The transpiler:
1. Parses the `sql\`...\`` template, extracting bind params and replacing
   substitutions with `$1, $2, ...` placeholders
2. Generates a stable statement key: `<handleVar>_<sha256[0..8]>` — same SQL
   text + handle produces the same key across builds
3. Emits param coercion (currently i32 only — `s.parse().ok()`)
4. Emits the async query call with the statement key
5. Emits manual byte-level JSON construction (no serde overhead)

The statement keys are aggregated by `@fearless/aot-build` into a single
`phf::phf_map` and prepared at startup.

## License

MIT
