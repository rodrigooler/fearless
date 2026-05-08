// Native Bun.serve bench app — TFB-shaped /plaintext, /json, /db.
//
// Uses Bun.serve with `routes` (Bun ≥ 1.1.30) and the `postgres` npm package
// (pure-JS, works on Bun without native compile). For /db we lean on
// `sql.unsafe(...).execute()` with an explicit prepared statement key.
//
// Env:
//   BENCH_PORT   (default 8080)
//   DATABASE_URL (default postgres://fearless:fearless@localhost:5432/fearless_bench)

import postgres from "postgres";

const PORT = Number(process.env.BENCH_PORT ?? 8080);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fearless:fearless@localhost:5432/fearless_bench";

const sql = postgres(DATABASE_URL, {
  max: 16,
  prepare: true,
  fetch_types: false,
});

const HELLO_PLAIN = "Hello, World!";
const HELLO_JSON_BUF = Buffer.from(JSON.stringify({ message: "Hello, World!" }));

// Pre-built static responses so the hot path is a constant pointer.
const PLAINTEXT_HEADERS = {
  "content-type": "text/plain",
  "content-length": String(Buffer.byteLength(HELLO_PLAIN)),
  server: "Bun",
} as const;

const JSON_HEADERS = {
  "content-type": "application/json",
  "content-length": String(HELLO_JSON_BUF.byteLength),
  server: "Bun",
} as const;

function plaintext(): Response {
  return new Response(HELLO_PLAIN, { headers: PLAINTEXT_HEADERS });
}

function json(): Response {
  return new Response(HELLO_JSON_BUF, { headers: JSON_HEADERS });
}

async function db(): Promise<Response> {
  const id = ((Math.random() * 10000) | 0) + 1;
  const rows = await sql<{ id: number; randomnumber: number }[]>`
    SELECT id, randomnumber FROM world WHERE id = ${id}
  `;
  const r = rows[0];
  const body = JSON.stringify({ id: r.id, randomNumber: r.randomnumber });
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      server: "Bun",
    },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  development: false,
  reusePort: true,
  routes: {
    "/plaintext": plaintext,
    "/json": json,
    "/db": db,
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

console.error(`bun-serve listening on http://${server.hostname}:${server.port}`);
