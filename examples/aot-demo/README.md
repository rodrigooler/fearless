# AOT demo

A reference app that exercises every Phase 0 AOT rule — both compilable and
not. Use it to learn what shapes lift to Rust and what falls back to Bun.

## Run the analyzer

```bash
node scripts/fearless-analyze.mjs examples/aot-demo/server.ts
```

Expected output: AOT score around 70-80% (5 AOT + 2 template + 4 Bun across
11 routes, depending on how you count).

## Generate Rust source

```bash
node scripts/fearless-build.mjs examples/aot-demo/server.ts --out-dir /tmp/aot-demo
cat /tmp/aot-demo/aot_handlers.rs
cat /tmp/aot-demo/dispatch_manifest.json
```

The `aot_handlers.rs` will be ready to paste into a `rust-core/src/aot/` module
once Week 3's runtime integration lands (see
[`docs/superpowers/plans/2026-05-08-aot-integration.md`](../../docs/superpowers/plans/2026-05-08-aot-integration.md)
for the design — wired during the next session).

## Run the server (Bun-side, no AOT)

```bash
npx tsx examples/aot-demo/server.ts
```

Today this serves every route through Node/Bun (the AOT-eligible handlers
also work — they just don't get the Rust speedup until the runtime
integration lands).

## What each route demonstrates

| Route | Runs on | Why |
|---|---|---|
| `GET /healthz` | Rust template | Pure declarative — no handler function. |
| `GET /version` | Rust template | Same. |
| `GET /echo-static` | **Rust (AOT)** | Pure literal body, no runtime values. |
| `GET /users/:id/exists` | **Rust (AOT)** | Reads `ctx.params.id` — string substitution into JSON. |
| `GET /admin/area` | **Rust (AOT)** | `if` branch on `ctx.headers.X`, two literal returns. |
| `GET /greet/:name` | **Rust (AOT)** | Template literal with `ctx.params.X` substitution. |
| `GET /created` | **Rust (AOT)** | `ctx.status().header().json()` chain. |
| `GET /async-trivial` | Bun (fallback) | `async` keyword (handler-shape rule). |
| `POST /upload` | Bun (fallback) | `await ctx.body()` (no-await rule). |
| `GET /users-by-name` | Bun (fallback) | Captures outer-scope `inMemoryUsers` (no-external-identifiers rule). |
| `GET /parsed/:n` | Bun (fallback) | Calls `parseInt(...)` (no-disallowed-calls rule). |

## How to read the analyzer output

```
✅ → handler will run inside the Rust core at near-native speed (millions of req/s)
📄 → declarative template route, served by Rust core
⚠️  → handler runs on Bun (fast, but ~10-100x slower than Rust path)
```

The bottom of the report shows the **top refactor candidates** — Bun-fallback
handlers ranked by how few rules they break. Easiest wins first.
