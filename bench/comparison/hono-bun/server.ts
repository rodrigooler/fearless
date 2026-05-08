// Hono (on Bun) bench app — TFB-shaped /plaintext, /json, /db.
//
// Idiomatic Hono: `new Hono().get(...)` + `c.text` / `c.json`. Bun adapter
// is just `export default { fetch }` — Bun.serve picks it up.
//
// Env:
//   BENCH_PORT   (default 8080)
//   DATABASE_URL (default postgres://fearless:fearless@localhost:5432/fearless_bench)

import { Hono } from "hono";
import postgres from "postgres";

const PORT = Number(process.env.BENCH_PORT ?? 8080);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fearless:fearless@localhost:5432/fearless_bench";

const sql = postgres(DATABASE_URL, {
  max: 16,
  prepare: true,
  fetch_types: false,
});

const app = new Hono();

app.get("/plaintext", (c) => c.text("Hello, World!"));
app.get("/json", (c) => c.json({ message: "Hello, World!" }));
app.get("/db", async (c) => {
  const id = ((Math.random() * 10000) | 0) + 1;
  const rows = await sql<{ id: number; randomnumber: number }[]>`
    SELECT id, randomnumber FROM world WHERE id = ${id}
  `;
  return c.json({ id: rows[0].id, randomNumber: rows[0].randomnumber });
});

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  reusePort: true,
  fetch: app.fetch,
});

console.error(`hono-bun listening on http://${server.hostname}:${server.port}`);
