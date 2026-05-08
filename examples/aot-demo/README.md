# AOT demo

A reference app that exercises every AOT analyzer rule — both compilable and not. Use it to learn what shapes lift to Rust and what falls back to Bun.

Covers Phase 0 (sync handlers + templates) AND Phase 1.2 (async handlers + typed SQL handles).

## Run the analyzer

```bash
node scripts/fearless-analyze.mjs examples/aot-demo/server.ts
```

Reports per-handler verdict (✅ AOT, 📄 template, ⚠️ Bun fallback) plus refactor hints for the rejected ones.

## Generate Rust source

```bash
node scripts/fearless-build.mjs examples/aot-demo/server.ts
```

Writes:
- `rust-core/src/aot/handlers.rs` — generated sync + async handler functions
- `rust-core/src/aot/registry_init.rs` — `STATEMENTS` phf map + `register_handles()` (only if any async handlers were lifted)
- `rust-core/src/aot/dispatch_manifest.json` — `(method, path) → kind` map

## Run the server (Bun-side, no AOT)

```bash
bun run examples/aot-demo/server.ts
```

Today this serves every route through Bun (the AOT-eligible handlers also work — they just don't get the Rust speedup until you build the docker image with the generated handlers).

## What each route demonstrates

### Phase 0 — sync handlers + templates

| Route | Runs on | Why |
|---|---|---|
| `GET /healthz` | Rust template | Pure declarative — no handler function |
| `GET /version` | Rust template | Same |
| `GET /echo-static` | **Rust (AOT sync)** | Pure literal body, no runtime values |
| `GET /users/:id/exists` | **Rust (AOT sync)** | Reads `ctx.params.id` — string substitution into JSON |
| `GET /admin/area` | **Rust (AOT sync)** | `if` branch on `ctx.headers.X`, two literal returns |
| `GET /greet/:name` | **Rust (AOT sync)** | Template literal with `ctx.params.X` substitution |
| `GET /created` | **Rust (AOT sync)** | `ctx.status().header().json()` chain |

### Phase 1.2 — async handlers with typed SQL handles

For an `async (ctx) => ...` handler to lift to Rust, every `await` must be on a registered framework handle. See `examples/real-bench/server.ts` for a working `/db` example using:

```ts
const db = fearless.sql("primary");

app.get("/db", async (ctx) => {
  const row = await db.queryOne(
    sql`SELECT id, randomnumber FROM world WHERE id = ${Math.floor(Math.random() * 10000) + 1}`
  );
  if (row == null) return ctx.notFound();
  return ctx.json({ id: row.id, randomNumber: row.randomnumber });
});
```

### Bun fallback (rejected by analyzer rules)

| Route | Why rejected |
|---|---|
| `GET /async-trivial` | `async` modifier with no handle await |
| `POST /upload` | `await ctx.body()` — not on a registered handle (`no-await` rule) |
| `GET /users-by-name` | Captures outer-scope `inMemoryUsers` (`no-external-identifiers` rule) |
| `GET /parsed/:n` | Calls `parseInt(...)` (`no-disallowed-calls` rule) |

## How to read the analyzer output

```
✅ → handler will run inside the Rust core at near-native speed (multi-million req/s for sync, ~40k+ req/s for async DB)
📄 → declarative template route, served by Rust core (templates only)
⚠️  → handler runs on Bun fallback (still fast, but ~10-100x slower than Rust path)
```

The bottom of the report shows the **top refactor candidates** — Bun-fallback handlers ranked by how few rules they break. Easiest wins first.

## Phase 1.2 async-handler subset (what's allowed)

- **Single `await`** in the body — must target a registered framework handle (`db.queryOne`, `db.queryMany`, `db.execute`)
- **Handle declared at module scope:** `const db = fearless.sql("primary")`
- **`sql\`...\`` template tag** for the SQL — bind params via `${...}` substitutions
- **Bind params** must be: `ctx.params.X`, `ctx.query.X`, or `Math.floor(Math.random() * NUM) + NUM`
- **Response shape:** `if (row == null) return ctx.notFound(); return ctx.json({ field: row.col, ... });`

Anything outside this subset → Bun fallback.

## Phase 1.3+ unlock (planned)

- `fearless.kv("name")` for KV/cache handles (Dragonfly, Redis)
- `fearless.http("name")` for typed HTTP clients
- Multiple awaits per handler (cache-then-DB pattern)
- Computed bind expressions (locals, arithmetic, string ops)
- Auto-derive `Row` types from `psql --describe` (typed columns)
