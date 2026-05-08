# Real Bench

The example app the bench harness (`scripts/run-bench.mjs`) targets. Mirrors the TechEmpower Frameworks Benchmark (TFB) scenario set so we can compare apples-to-apples against ntex, Bun.serve, Elysia, and Hono (in `bench/comparison/`).

This is **the** reference for what Fearless looks like in a realistic mixed-workload setting: AOT-eligible routes, typed SQL handles, and Bun-fallback routes all coexisting in the same app.

## Run

You need Postgres running on `localhost:5433` with the TFB World schema seeded. Start it via the bench fixture:

```bash
./scripts/start-bench-postgres.sh   # idempotent; brings up fearless-bench-pg with 10000 World rows
```

Then run via Bun (development mode — Bun fallback for everything except templates):

```bash
FEARLESS_PORT=8081 \
FEARLESS_SQL_PRIMARY=postgres://fearless:fearless@localhost:5433/fearless_bench \
bun run examples/real-bench/server.ts
```

For the full Rust-AOT path (where `/db` runs at native speed), build the bench docker image and run that:

```bash
docker build -f bench/techempower/fearless-rust-aot.dockerfile -t fearless-rust-aot:dev .
docker run --rm -d --name fearless-bench --privileged -p 8080:8080 \
  -e FEARLESS_SQL_PRIMARY="postgres://fearless:fearless@host.docker.internal:5433/fearless_bench" \
  fearless-rust-aot:dev
```

(Adapt `host.docker.internal` to `127.0.0.1` on Linux with `--network host`.)

## Routes

| Route | Path | What it shows | Where it runs |
|---|---|---|---|
| Plaintext | `GET /plaintext` | TFB-canonical text response | **Rust template** (~9.7M req/s pipelined) |
| JSON | `GET /json` | TFB-canonical JSON response | **Rust template** (~9.8M req/s pipelined) |
| Param echo | `GET /echo/:name` | Param substitution into JSON | **Rust AOT** |
| Static config | `GET /config` | Larger static JSON object | **Rust AOT** |
| Header-conditional | `GET /access` | Header-driven branch | **Rust AOT** |
| **DB single query** | `GET /db` | TFB-canonical SQL query — typed handle | **Rust async** (~42k req/s OrbStack, ~200k+ projected bare-metal) |
| Multi-query | `GET /queries?queries=N` | N parallel SQL queries | Bun fallback (uses `pg` directly — Phase 1.3 will lift) |
| Fibonacci | `GET /fib/:n` | CPU-bound recursive | Bun fallback |
| SHA256 chain | `GET /hash/:n` | CPU-bound hash chain | Bun fallback |

## The `/db` route — Phase 1.2 typed handles

This is the headline. The TypeScript source:

```ts
import { App, fearless, sql } from "../../src/index.js";

const db = fearless.sql("primary");

app.get("/db", async (ctx) => {
  const row = await db.queryOne(
    sql`SELECT id, randomnumber FROM world WHERE id = ${Math.floor(Math.random() * 10000) + 1}`
  );
  if (row == null) return ctx.notFound();
  return ctx.json({ id: row.id, randomNumber: row.randomnumber });
});
```

What happens at build time:

1. **Analyzer** (`@fearless/aot-analyzer`) sees the `await` is on a registered handle (`db.queryOne`) and the bind param matches the supported `Math.floor(Math.random() * NUM) + NUM` pattern — handler is AOT-eligible.
2. **Transpiler** (`@fearless/aot-transpiler`) emits Rust `pub async fn handler_db(ctx, handles) -> Vec<u8>` that calls `handles.sql.get("primary").query_one("STMT_KEY", &[&p1]).await` and constructs the JSON response by hand.
3. **Build** (`@fearless/aot-build`) collects the SQL into `STATEMENTS: phf::Map`, generates `register_handles(pool)` + `prepare_all()`.
4. **rust-core** routes `/db` via `AotRouteTable + HandlerKind::Async` through the io_uring + tokio bridge — connection parks during the await, eventfd CQE wakes the loop when the response is ready.

End result: same Rust assembly path as a hand-written `/db` would produce. Verified: 42.5k req/s c=256 vs 42.0k for the Phase 1.1 hardcoded baseline (within ±5% noise window).

## Why some routes are Bun fallback

`/queries`, `/fib`, `/hash` deliberately stay on Bun because:

- `/queries` does **multiple** awaits (Phase 1.3 will support — single await is the Phase 1.2 limit)
- `/fib` and `/hash` use `parseInt`, `createHash`, `Buffer` — all on the analyzer's `no-disallowed-calls` reject list (no plan to lift these — JS-side is fine for CPU work)

The bench harness reports both AOT and Bun numbers so you can see the gap in throughput between the two paths on the same workload shape.

## Bench against this app

```bash
node scripts/run-bench.mjs --quick --note "your-note-here"
```

Results land in `bench-history.json` with deltas vs the previous run printed inline.

## Next steps (Phase 1.3+ unlock)

Things that would let MORE of this app run on the AOT path:

- **Multi-await per handler** → `/queries` lifts to Rust
- **`fearless.kv("name")` handle** → cache-aside patterns become AOT-eligible
- **Computed bind params beyond `Math.random`** → arithmetic expressions, locals, `parseInt`
- **Schema describe** → row column types inferred (`row.id` is `i32` instead of always-`i32`)
