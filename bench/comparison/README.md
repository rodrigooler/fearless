# bench/comparison — head-to-head framework apps

Four minimal apps that implement the same TFB-shaped routes (`/plaintext`,
`/json`, `/db`) so we can run the same `wrk` plan against each and compare
to fearless directly. **Not** intended as production demos — they are the
shortest framework-idiomatic version of each route.

| App           | Stack                  | File                       |
|---------------|------------------------|----------------------------|
| `ntex-rust`   | Rust + ntex 2 + tokio-postgres | `Cargo.toml`, `src/main.rs` |
| `bun-serve`   | Bun.serve native + `postgres` | `server.ts`                |
| `elysia-bun`  | Elysia 1.x on Bun + `postgres` | `server.ts`                |
| `hono-bun`    | Hono 4.x on Bun + `postgres`  | `server.ts`                |

All apps expose:

| Path         | Behaviour                                                        |
|--------------|------------------------------------------------------------------|
| `/plaintext` | `text/plain` `Hello, World!` (TFB plaintext spec)                |
| `/json`      | `application/json` `{"message":"Hello, World!"}`                 |
| `/db`        | `SELECT id,randomnumber FROM world WHERE id=$1` with id ∈ [1,10000], returns `{"id":N,"randomNumber":M}` |

## Env

All apps honour the same env vars:

- `BENCH_PORT` — listen port (default `8080`)
- `DATABASE_URL` — Postgres URL (default `postgres://fearless:fearless@localhost:5432/fearless_bench`)

The default DB URL points at port `5432`, **not** the bench compose's
`5433`. The deploy script wires Postgres at `5432` directly on the host
when running comparison apps; the bench compose at `5433` is for the
fearless harness which addresses Postgres via `host.docker.internal`.

## Run locally

Bring up Postgres first (any of these works):

```bash
# Either: the bench compose
./scripts/start-bench-postgres.sh
# … and override DATABASE_URL to use the 5433 port:
export DATABASE_URL=postgres://fearless:fearless@localhost:5433/fearless_bench

# Or: a one-shot postgres on 5432
docker run -d --name pg-bench -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
docker exec -i pg-bench psql -U postgres < bench/techempower/seed.sql
```

### ntex-rust

```bash
cd bench/comparison/ntex-rust
cargo run --release
# in another terminal:
curl localhost:8080/plaintext
curl localhost:8080/json
curl localhost:8080/db
```

### bun-serve

```bash
cd bench/comparison/bun-serve
bun install
BENCH_PORT=8080 bun run server.ts
```

### elysia-bun

```bash
cd bench/comparison/elysia-bun
bun install
BENCH_PORT=8080 bun run server.ts
```

### hono-bun

```bash
cd bench/comparison/hono-bun
bun install
BENCH_PORT=8080 bun run server.ts
```

## What's deliberately omitted

- No middleware, no logger, no request ID, no validation. We're measuring
  framework dispatch overhead + DB round-trip, not feature coverage.
- No connection-pool sizing tuning per framework. `postgres` defaults to
  `max: 16` here; ntex uses a single tokio-postgres client. These match
  what TFB submissions land on for these stacks.
- No graceful shutdown. The deploy script SIGKILLs each app between runs.
