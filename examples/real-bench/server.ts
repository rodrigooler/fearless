/**
 * Realistic benchmark suite — covers what 99% of HTTP services actually do:
 *   - Static JSON responses (AOT-eligible)
 *   - Param-driven JSON (AOT-eligible)
 *   - Postgres single query (Bun fallback — async IO)
 *   - Postgres multi-query (Bun fallback)
 *   - CPU-bound: recursive fibonacci (Bun fallback — function call rule)
 *   - CPU-bound: SHA256 N rounds (Bun fallback)
 *   - Large JSON object (AOT-eligible if static, Bun if dynamic)
 *
 * Run:
 *   1. Start Postgres:
 *      docker run -d --name pg-bench -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
 *      (then run scripts/seed-bench-db.sh to seed the world table)
 *
 *   2. Build AOT side:
 *      node scripts/fearless-build.mjs examples/real-bench/server.ts --no-cargo
 *
 *   3. Run rust-core (AOT routes only, port 8080):
 *      docker build -f bench/techempower/fearless-rust-aot.dockerfile -t fearless-rust:realbench .
 *      docker run -d --name fearless-aot --ulimit memlock=-1 --cap-add SYS_NICE \
 *        --security-opt seccomp=unconfined -p 8080:8080 fearless-rust:realbench
 *
 *   4. Run Bun-side (full server, port 8081):
 *      FEARLESS_PORT=8081 bun run examples/real-bench/server.ts
 *
 *   5. Bench both:
 *      wrk http://localhost:8080/json     # AOT — millions/sec
 *      wrk http://localhost:8081/db        # Bun — limited by Postgres
 */
import { App, HttpError } from "../../src/index.js";
import { createHash } from "node:crypto";

// ----------------------------------------------------------------------------
// Postgres setup — Bun has built-in `Bun.sql` from 1.2+; on Node we'd use pg.
// For the demo, we use a tiny pool helper that works on both.
// Set DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/postgres before running.
// ----------------------------------------------------------------------------

interface DbWorld {
  id: number;
  randomNumber: number;
}

// Lazy-init: avoid crashing on Bun startup if Postgres is down — handlers
// throw HttpError(503) instead.
let pgClient: { query: (sql: string, params?: unknown[]) => Promise<{ rows: DbWorld[] }> } | null = null;
let pgInitPromise: Promise<void> | null = null;

async function getPgClient() {
  if (pgClient != null) return pgClient;
  if (pgInitPromise == null) {
    pgInitPromise = (async () => {
      const url = process.env.DATABASE_URL ?? "postgres://postgres:pw@127.0.0.1:5432/postgres";
      try {
        // Bun has a built-in postgres driver via `Bun.sql` (1.2+).
        const bunGlobal = (globalThis as typeof globalThis & { Bun?: { sql?: unknown } }).Bun;
        if (bunGlobal?.sql != null) {
          const { SQL } = await import("bun");
          const sql = new (SQL as unknown as new (url: string) => {
            unsafe: (q: string, p?: unknown[]) => Promise<DbWorld[]>;
          })(url);
          pgClient = {
            query: async (sqlText: string, params: unknown[] = []) => {
              const rows = (await sql.unsafe(sqlText, params)) as DbWorld[];
              return { rows };
            },
          };
          return;
        }
        // Fallback: dynamic import of `pg` (Node-side). Will fail fast if not installed.
        const pg = await import("pg");
        const PoolCtor = (pg as { default?: { Pool: unknown }; Pool: unknown }).Pool ??
          (pg as { default: { Pool: unknown } }).default.Pool;
        const pool = new (PoolCtor as new (cfg: object) => {
          query: (sql: string, params?: unknown[]) => Promise<{ rows: DbWorld[] }>;
        })({ connectionString: url, max: 32 });
        pgClient = { query: (sql, params) => pool.query(sql, params) };
      } catch (error) {
        // No Postgres available — handlers will throw 503 rather than crash startup.
        console.warn("[bench] Postgres init failed; /db routes will return 503:", error);
      }
    })();
  }
  await pgInitPromise;
  if (pgClient == null) {
    throw HttpError.internal("Postgres unavailable");
  }
  return pgClient;
}

// ----------------------------------------------------------------------------
// App
// ----------------------------------------------------------------------------

const port = parseInt(process.env.FEARLESS_PORT ?? "8081", 10);
const app = new App({ port });

// === AOT-eligible routes (compile to Rust at build time) ===

// Plaintext template — same as TFB plaintext.
app.text("/plaintext", "Hello, World!");

// Static JSON — same as TFB json.
app.json("/json", { message: "Hello, World!" });

// Param echo — fastest path with runtime data.
app.get("/echo/:name", (ctx) => ctx.json({ hello: ctx.params.name }));

// Static larger JSON object — typical "config endpoint" shape.
app.get("/config", (ctx) => ctx.json({
  service: "fearless",
  version: "0.3.0",
  features: { aot: true, templates: true, hooks: true },
  limits: { maxBodyBytes: 10485760, maxConnections: 65535 },
  endpoints: {
    health: "/healthz",
    metrics: "/metrics",
    docs: "/docs",
  },
}));

// Conditional response — header-driven branching.
app.get("/access", (ctx) => {
  if (ctx.headers["x-key"] === "secret") {
    return ctx.json({ access: "granted" });
  }
  return ctx.status(401).json({ error: "denied" });
});

// === Bun-fallback routes (real-world async / CPU-bound work) ===

// TFB single query: pick one row from `world` by random id.
app.get("/db", async () => {
  const client = await getPgClient();
  const id = 1 + Math.floor(Math.random() * 10000);
  const result = await client.query("SELECT id, randomnumber FROM world WHERE id = $1", [id]);
  const row = result.rows[0];
  if (row == null) throw HttpError.notFound();
  return new Response(JSON.stringify({ id: row.id, randomNumber: row.randomNumber }), {
    headers: { "Content-Type": "application/json" },
  });
});

// TFB multi-query: N parallel queries, return array.
app.get("/queries", async (ctx) => {
  const n = clampQueriesCount(ctx.query.queries);
  const client = await getPgClient();
  const promises: Array<Promise<{ id: number; randomNumber: number }>> = [];
  for (let i = 0; i < n; i++) {
    const id = 1 + Math.floor(Math.random() * 10000);
    promises.push(
      client.query("SELECT id, randomnumber FROM world WHERE id = $1", [id]).then((r) => {
        const row = r.rows[0];
        if (row == null) throw HttpError.notFound();
        return { id: row.id, randomNumber: row.randomNumber };
      })
    );
  }
  const rows = await Promise.all(promises);
  return new Response(JSON.stringify(rows), {
    headers: { "Content-Type": "application/json" },
  });
});

// CPU-bound: recursive fibonacci. Naïve, exponential complexity.
// fib(30) ~10ms; fib(35) ~150ms. Demonstrates handler CPU saturation.
app.get("/fib/:n", (ctx) => {
  const n = clampFibN(ctx.params.n);
  const result = fib(n);
  return new Response(JSON.stringify({ n, result }), {
    headers: { "Content-Type": "application/json" },
  });
});

// CPU-bound: chained SHA256 hashes. Linear cost in `n`. Demonstrates measured CPU work.
app.get("/hash/:n", (ctx) => {
  const n = clampHashN(ctx.params.n);
  let buf = Buffer.from(ctx.params.id ?? "seed");
  for (let i = 0; i < n; i++) {
    buf = createHash("sha256").update(buf).digest();
  }
  return new Response(
    JSON.stringify({ n, hash: buf.toString("hex").slice(0, 16) }),
    { headers: { "Content-Type": "application/json" } }
  );
});

// === lifecycle ===

app.onError((ctx, error) => {
  if (error instanceof HttpError) return error.toResponse();
  console.error(error);
  return ctx.status(500).json({ error: "Internal Server Error" });
});

app.listen((started) => {
  if (started) {
    console.log(`real-bench server listening on http://localhost:${port}`);
    console.log("AOT routes (also served by rust-core if built):");
    console.log("  GET /plaintext");
    console.log("  GET /json");
    console.log("  GET /echo/:name");
    console.log("  GET /config");
    console.log("  GET /access");
    console.log("Bun-only routes:");
    console.log("  GET /db                — single Postgres query");
    console.log("  GET /queries?queries=N — N parallel Postgres queries (1-500)");
    console.log("  GET /fib/:n            — recursive fibonacci (CPU bound, n<=35)");
    console.log("  GET /hash/:n           — chained SHA256 (CPU bound, n<=10000)");
  }
});

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function clampQueriesCount(value: string | string[] | undefined): number {
  const v = Array.isArray(value) ? value[0] : value;
  const n = v != null ? parseInt(v, 10) : 1;
  if (Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(n, 500));
}

function clampFibN(value: string | undefined): number {
  if (value == null) return 20;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return 20;
  return Math.max(0, Math.min(n, 35));
}

function clampHashN(value: string | undefined): number {
  if (value == null) return 100;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return 100;
  return Math.max(1, Math.min(n, 10000));
}

function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
