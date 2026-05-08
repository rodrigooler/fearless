/**
 * AOT demo — showcases what compiles to Rust and what falls back to Bun.
 *
 * Run the analyzer to see the per-route verdict:
 *   node scripts/fearless-analyze.mjs examples/aot-demo/server.ts
 *
 * Run the build to emit Rust handler source:
 *   node scripts/fearless-build.mjs examples/aot-demo/server.ts --out-dir /tmp/aot-out
 */
import { App } from "../../src/index.js";

const app = new App({ port: 3000 });

// ============================================================================
// Template routes — execute in the Rust core directly (existing fast path).
// No analysis needed; the framework's manifest format already handles these.
// ============================================================================

app.text("/healthz", "ok");
app.json("/version", { version: "1.0.0", commit: "deadbeef" });

// ============================================================================
// AOT-compilable handlers — get lifted into Rust by `fearless build`.
// Each handler below is fully synchronous, captures only `ctx`, and returns a
// recognized `ctx.<builder>()` shape.
// ============================================================================

// Static body — pure literal response.
app.get("/echo-static", (ctx) => ctx.json({ ok: true, kind: "static" }));

// Param substitution — body has runtime data from path.
app.get("/users/:id/exists", (ctx) => ctx.json({ id: ctx.params.id, exists: true }));

// Conditional status with multiple return paths.
app.get("/admin/area", (ctx) => {
  if (ctx.headers.authorization === "letmein") {
    return ctx.json({ access: "granted" });
  }
  return ctx.status(401).json({ error: "denied" });
});

// Template literal in body — substitution allowed when source is `ctx.X`.
app.get("/greet/:name", (ctx) => ctx.text(`Hello, ${ctx.params.name}!`));

// Status chain + header chain.
app.get("/created", (ctx) =>
  ctx.status(201).header("location", "/created/42").json({ created: true })
);

// ============================================================================
// Bun-fallback handlers — analyzer rejects these; runtime forwards to Bun.
// Each is ANNOTATED with the rule that blocks AOT, for documentation.
// ============================================================================

// Blocked: `async` (handler-shape rule).
app.get("/async-trivial", async (ctx) => ctx.json({ async: true }));

// Blocked: `await` (no-await rule).
app.post("/upload", async (ctx) => {
  // ctx.body() returns Promise<unknown>; the await disqualifies the handler.
  const body = await ctx.body();
  return ctx.json({ received: body });
});

// Blocked: external identifier capture (no-external-identifiers rule).
const inMemoryUsers = new Map<string, { name: string }>();
app.get("/users-by-name", (ctx) => {
  const user = inMemoryUsers.get(ctx.params.name ?? "");
  return ctx.json({ user });
});

// Blocked: function call to non-ctx callee (no-disallowed-calls rule).
app.get("/parsed/:n", (ctx) => ctx.json({ n: parseInt(ctx.params.n, 10) }));

// ============================================================================
// Lifecycle (this part runs the same way regardless of AOT).
// ============================================================================

app.listen((started) => {
  if (started) {
    console.log("AOT demo on http://localhost:3000");
    console.log("Run `node scripts/fearless-analyze.mjs examples/aot-demo/server.ts`");
    console.log("to see which handlers compile to Rust and which fall back.");
  }
});
