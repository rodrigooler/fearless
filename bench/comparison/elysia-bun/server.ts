// Elysia (on Bun) bench app — TFB-shaped /plaintext, /json, /db.
//
// Idiomatic Elysia: chained .get(...) on the app builder, returning
// objects/strings — Elysia handles the response construction.
//
// Env:
//   BENCH_PORT   (default 8080)
//   DATABASE_URL (default postgres://fearless:fearless@localhost:5432/fearless_bench)

import { Elysia } from "elysia";
import postgres from "postgres";

const PORT = Number(process.env.BENCH_PORT ?? 8080);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fearless:fearless@localhost:5432/fearless_bench";

const sql = postgres(DATABASE_URL, {
  max: 16,
  prepare: true,
  fetch_types: false,
});

const app = new Elysia()
  .get("/plaintext", () => "Hello, World!")
  .get("/json", () => ({ message: "Hello, World!" }))
  .get("/db", async () => {
    const id = ((Math.random() * 10000) | 0) + 1;
    const rows = await sql<{ id: number; randomnumber: number }[]>`
      SELECT id, randomnumber FROM world WHERE id = ${id}
    `;
    return { id: rows[0].id, randomNumber: rows[0].randomnumber };
  })
  .listen({ hostname: "0.0.0.0", port: PORT, reusePort: true });

console.error(`elysia-bun listening on http://${app.server!.hostname}:${app.server!.port}`);
