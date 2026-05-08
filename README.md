# Fearless

A TypeScript microframework with a hybrid Rust+Bun runtime. You write idiomatic TS; declarative routes execute on a Rust core at multi-million req/s, function handlers execute on Bun, and `await db.queryOne(sql\`...\`)` compiles to native Rust async via the io_uring + tokio bridge. Everything ships in the same deployable unit.

> **About the benchmarks:** plaintext / JSON routes hit ~9.7M req/s pipelined on a Mac OrbStack VM (Rust core). Typed SQL handlers hit ~42k req/s end-to-end against local Postgres — same throughput as hand-written Rust (Docker NAT is the ceiling; bare-metal projection 200k+). Bun-fallback handlers hit Bun-class throughput (~400-800k req/s). Be honest with yourself about which path your endpoints actually take — see [Performance](#performance) for the breakdown.

## Quick start

### Install

Fearless is currently distributed from git (the npm package name is `microu`, but it is not yet published to the registry).

```bash
npm install git+https://github.com/rodrigooler/fearless.git#main
```

### Hello, World

Create `server.ts`:

```ts
import { App } from "fearless";

const app = new App({ port: 3000 });

app.get("/", (ctx) => ctx.json({ ok: true }));

app.get("/users/:id", (ctx) => {
  return ctx.json({ id: ctx.params.id, name: "Alice" });
});

app.post("/users", async (ctx) => {
  const body = await ctx.body<{ name: string }>();
  return ctx.status(201).json({ id: "new", name: body.name });
});

app.listen((started) => {
  if (started) console.log("Listening on http://localhost:3000");
});
```

### Run

```bash
npx tsx server.ts
```

That's it. No config files, no decorators, no plugins to wire up.

## Why Fearless

- **Hybrid runtime.** Declarative routes run on a Rust core; function handlers run on Bun. Both in the same process group — no operational split.
- **Typed SQL at native speed.** `await db.queryOne(sql\`...\`)` compiles to native Rust async (Postgres prepared statements + io_uring/tokio bridge). Same throughput as hand-written Rust. See [Typed SQL handles](#typed-sql-handles).
- **Functional handler API.** `(ctx) => Response` — return a `Response`, no `(req, res, next)` mess.
- **Hooks for everything else.** `onRequest` for auth, `onResponse` for logging, `onError` for recovery.
- **Small surface.** ~10 public types. No DI container, no decorator soup, no required validation library.
- **Optional strict linting.** Ship-included [oxlint config](#linting-optional) catches sloppy patterns early — opt in if you want it, ignore if you don't.

## Routing

```ts
app.get("/health", (ctx) => ctx.json({ ok: true }));
app.post("/users", (ctx) => ctx.status(201).json({ id: "new" }));
app.put("/users/:id", (ctx) => ctx.json({ id: ctx.params.id }));
app.patch("/users/:id", (ctx) => ctx.json({ id: ctx.params.id }));
app.delete("/users/:id", (ctx) => ctx.noContent());
app.options("/users", (ctx) => ctx.noContent());
app.head("/users/:id", (ctx) => ctx.noContent());
```

Path params are exposed on `ctx.params`. Query strings are pre-parsed on `ctx.query` (values are `string | string[]`).

```ts
app.get("/search", (ctx) => {
  const q = ctx.query.q;       // "hello"
  const tags = ctx.query.tags; // ["a", "b"] when repeated
  return ctx.json({ q, tags });
});
```

`HEAD` requests automatically fall back to the matching `GET` handler if no explicit `HEAD` route is registered.

## Handler context (Ctx)

`Ctx` is the single object every handler and hook receives. It bundles request inputs, lazy body parsers, response builders, and a per-request `state` bag.

### Inputs

```ts
app.get("/inspect/:id", (ctx) => {
  ctx.method;   // "GET"
  ctx.path;     // "/inspect/42"
  ctx.params;   // { id: "42" }
  ctx.query;    // parsed query string
  ctx.headers;  // normalized lowercase header map
  ctx.ip;       // client IP
  ctx.state;    // mutable bag shared across hooks + handler
  return ctx.json({ ok: true });
});
```

### Body parsing

All body parsers are lazy. They consume the stream on first call.

```ts
await ctx.body<MyShape>();   // JSON, throws HttpError(400) on invalid
await ctx.text();            // raw text
await ctx.formData();        // multipart/form-data
await ctx.validate(parser);  // parse + validate; throws ValidationError (422)
```

### Response builders

Every builder returns a standard web `Response`.

```ts
ctx.json({ ok: true });               // 200 application/json
ctx.json(data, 201);                  // status as second arg
ctx.html("<h1>hi</h1>");              // 200 text/html
ctx.raw("raw body", { status: 200 }); // anything `new Response()` accepts
ctx.redirect("/login", 302);          // 301 | 302 | 303 | 307 | 308
ctx.notFound("user not found");       // 404
ctx.noContent();                      // 204
```

### Chainable status / headers

Apply once, consumed by the next builder call.

```ts
return ctx
  .status(202)
  .header("x-trace", id)
  .setHeaders({ "cache-control": "no-store" })
  .json({ accepted: true });
```

## Validation

`ctx.validate` runs your validator and throws a `ValidationError` (422) on null/undefined.

```ts
type User = { name: string; email: string };

function parseUser(data: unknown): User | null {
  if (!data || typeof data !== "object") return null;
  const c = data as Record<string, unknown>;
  if (typeof c.name !== "string" || typeof c.email !== "string") return null;
  return { name: c.name, email: c.email };
}

app.post("/users", async (ctx) => {
  const user = await ctx.validate(parseUser);
  return ctx.status(201).json(user);
});
```

Use any validator that returns `T | null`. Hand-written guards work; so does Zod's `.safeParse` (just adapt `success ? data : null`). The framework does not bind to a schema library.

## Errors

Throw `HttpError` from any handler or hook and it becomes a structured response.

```ts
import { HttpError } from "fearless";

app.get("/users/:id", (ctx) => {
  const user = users.get(ctx.params.id);
  if (!user) throw HttpError.notFound(`user ${ctx.params.id} not found`);
  return ctx.json(user);
});
```

Factories:

| Factory | Status |
|---|---|
| `HttpError.badRequest(msg, details?)` | 400 |
| `HttpError.unauthorized(msg?)` | 401 |
| `HttpError.forbidden(msg?)` | 403 |
| `HttpError.notFound(msg?)` | 404 |
| `HttpError.conflict(msg, details?)` | 409 |
| `HttpError.internal(msg?, cause?)` | 500 |
| `ValidationError` (extends `HttpError`) | 422 |

4xx responses include the message you pass. 5xx responses hide the message and surface a generic body — your `cause` stays in the log, not on the wire.

## Middleware (hooks)

Three lifecycle points. Hooks run in registration order.

### `onRequest` — runs before the handler

Return a `Response` to short-circuit (auth, rate limits). Return `void` to continue.

```ts
app.onRequest((ctx) => {
  ctx.state.startTime = Date.now();
});

app.onRequest((ctx) => {
  if (!ctx.headers.authorization) {
    return ctx.status(401).json({ error: "unauthorized" });
  }
});
```

### `onResponse` — runs after the handler

Inspect or replace the response. Return `void` to keep it as-is.

```ts
app.onResponse((ctx, response) => {
  const ms = Date.now() - (ctx.state.startTime as number);
  console.log(`${ctx.method} ${ctx.path} ${response.status} (${ms}ms)`);
});
```

### `onError` — runs when anything throws

Return a `Response` to recover. Return `void` to fall through to the next error hook (or the default 500).

```ts
app.onError((ctx, error) => {
  if (error instanceof HttpError) return error.toResponse();
  console.error(error);
  return ctx.status(500).json({ error: "Internal" });
});
```

`ctx.state` is shared across all hooks and the handler within a single request. Use it for request id, auth subject, timing, etc.

## Built-in helpers

```ts
import { App, cors, securityHeaders } from "fearless";

const app = new App({ port: 3000 });

app.use(cors());
app.use(securityHeaders());
```

Both are intentionally minimal. They configure CORS preflight and a default set of security headers and — when the app shape allows it — get compiled into the Rust manifest so they cost nothing on the hot path.

## Templates and the Rust hot path

Declarative template routes have no handler function — the response shape is known at registration time:

```ts
app.text("/plaintext", "Hello, World!");
app.json("/json", { message: "Hello, World!" });
app.html("/welcome", "<h1>Welcome</h1>");
```

These routes are served by the Rust core at 8M+ RPS pipelined because there is no JS function to call per request. Mix templates and handlers freely — handler routes automatically run on the Bun side; template routes stay in Rust.

Template tokens interpolate request data:

```ts
app.json("/users/:id", { id: "{{ params.id }}" });
```

Use templates for: health checks, version endpoints, well-known paths, static API responses. Use handlers for: anything with branching, validation, IO, or business logic.

## Typed SQL handles

Async handlers that talk to Postgres can compile to native Rust — same code path as the hot Rust core, no Bun round-trip. The pattern:

```ts
import { App, fearless, sql } from "fearless";

const db = fearless.sql("primary");

const app = new App({ port: 3000 });

app.get("/db", async (ctx) =>
  await db.queryOne(
    sql`SELECT id, randomnumber FROM world WHERE id = ${Math.floor(Math.random() * 10000) + 1}`
  ).then(row =>
    row == null ? ctx.notFound() : ctx.json({ id: row.id, randomNumber: row.randomnumber })
  )
);
```

What happens at build time:

1. The analyzer accepts the handler if every `await` targets a registered handle (`db.queryOne`, `db.queryMany`, `db.execute`)
2. The transpiler emits `pub async fn handler_X(ctx, handles) -> Vec<u8>` calling `handles.sql.get("primary").query_one(STMT_KEY, &[&p1]).await` with manual JSON construction (no serde overhead)
3. The build collects every `sql\`...\`` literal into a `phf::phf_map` STATEMENTS table and prepares them at startup against the connection pool
4. The dispatcher routes via `AotRouteTable + HandlerKind::Async` through the io_uring + tokio bridge — connection parks during the await, eventfd CQE wakes the loop when the response is ready

Set `FEARLESS_SQL_PRIMARY=postgres://user:pw@host:5432/db` at startup. Pool size defaults to 128 (override with `FEARLESS_SQL_PRIMARY_POOL_SIZE`).

### What's supported (Phase 1.2)

- `fearless.sql("name")` → SQL handle
- Methods: `queryOne(sql\`...\`)`, `queryMany(sql\`...\`)`, `execute(sql\`...\`)`
- Bind params: `${ctx.params.X}`, `${ctx.query.X}`, `${Math.floor(Math.random() * NUM) + NUM}`
- Single `await` per handler body
- Response: `ctx.json({ field: row.col, ... })`

### What's not yet supported (Phase 1.3+)

- `fearless.kv("name")` (Redis/Dragonfly) and `fearless.http("name")` handles
- Multiple awaits per handler (cache-then-DB pattern)
- Computed bind expressions beyond `Math.random` (locals, `parseInt`, etc.)
- Schema validation (auto-derive Row types from `psql --describe`)
- Transactions (`BEGIN`/`COMMIT`)

If your handler doesn't fit the supported subset, the analyzer rejects it with a clear reason and the route falls back to Bun (still 30-80k req/s with a Postgres pool — the comparison just isn't to the Rust ceiling anymore).

## Examples

| Example | Shows |
|---|---|
| [hello-world](./examples/hello-world/) | Smallest possible app. |
| [rest-crud](./examples/rest-crud/) | In-memory CRUD with validation, status codes, and `HttpError`. |
| [with-middleware](./examples/with-middleware/) | Auth, logging, and error handling via hooks. |
| [microservice](./examples/microservice/) | Health probes, Prometheus metrics, graceful shutdown. |

Run any example:

```bash
npx tsx examples/<name>/server.ts
```

## Runtime selection

```ts
new App({ runtime: "auto" }); // prefer Rust > Bun > Node (default)
new App({ runtime: "node" }); // force Node
new App({ runtime: "rust" }); // force Rust (template-only apps)
```

For HTTPS, pass `keyFileName` and `certFileName`. For HTTP/2, set `httpVersion: "2"` (requires HTTPS).

```ts
new App({
  port: 443,
  keyFileName: "./key.pem",
  certFileName: "./cert.pem",
  httpVersion: "2",
});
```

## Performance

Be honest with yourself about which path your endpoints take. The Rust core is fast; the Bun fallback is also fast (top of the JS-runtime tier); but they are not the same speed. The number that matters for your app is the one for the path your handlers actually run on.

### Template routes (Rust core)

`app.text` / `app.json` / `app.html`. Local rig: Mac M-series + OrbStack VM (10 vCPU), `wrk` over Docker host network.

| Workload | Throughput |
|---|---|
| `/plaintext` non-pipelined c=64  | 441k req/s |
| `/plaintext` pipeline-32 c=256   | 9.79M req/s |
| `/json` non-pipelined c=64       | 448k req/s |
| `/json` pipeline-32 c=256        | 9.82M req/s |

For context, the older TFB Citrine baseline this repo tracked was ~2.78M req/s plaintext and ~1.36M req/s JSON on bare metal. Fearless meets and exceeds that on weaker hardware via OrbStack.

### Typed SQL handlers (Rust async via io_uring + tokio bridge)

`async (ctx) => await db.queryOne(sql\`...\`)`. Same rig + Postgres 16 in Docker.

| Workload | Throughput |
|---|---|
| `/db` (single SELECT WHERE id=$1) c=64  | 39k req/s |
| `/db` c=256                              | 42.5k req/s |

The OrbStack rig caps at ~42k for /db (Docker NAT + macOS networking, not the framework). pgbench reaches ~14k TPS on the same rig — we exceed that via tokio's task-level concurrency over the pool. **Bare-metal projection: 200k-400k req/s** (eliminates Docker NAT, pinned cores, real NIC queues).

### Handler routes (Bun fallback)

Function handlers that DON'T fit the AOT subset run on Bun's native HTTP server:

| Handler shape | Approximate throughput |
|---|---|
| Trivial (no IO, return literal) | 400k - 800k req/s |
| With validation + business logic | 100k - 300k req/s |
| With single DB query (Postgres pool) | 30k - 80k req/s |

These are limited by Bun + your IO, not by Fearless.

See [`bench-history.json`](./bench-history.json) for raw run data, [`docs/deployment-tuning.md`](./docs/deployment-tuning.md) for the host-side knobs that unlock 2-5x extra throughput on bare-metal Linux (IRQ affinity, RPS/RFS, sysctl, container caps), and [`docs/deploy-citrine.md`](./docs/deploy-citrine.md) for the bare-metal validation playbook.

## Linting (optional)

Fearless ships an [`oxlint`](https://oxc-project.github.io/) config (`.oxlintrc.json`) tuned for type safety and predictable patterns:

```bash
npm run lint        # report
npm run lint:fix    # autofix what's safe
```

oxlint is Rust-based and runs in single-digit milliseconds across the codebase. The config is intentionally conservative (most rules are warnings, not errors) so it slots into existing projects without breaking the build. Ratchet to errors as your codebase matures.

## Development

```bash
npm install
npm run build
npm test
npm run lint
npm run bench:tfb
```

## License & Contributing

- [LICENSE](./LICENSE)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [CONTRIBUTORS.md](./CONTRIBUTORS.md)
