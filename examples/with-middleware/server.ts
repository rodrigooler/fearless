import { App, HttpError, type Ctx } from "../../src/index.js";

const app = new App({ port: 3002 });

const VALID_API_KEYS = new Set(["secret-key-1", "secret-key-2"]);

// 1. Logging — runs on every request.
app.onRequest((ctx) => {
  ctx.state.startTime = Date.now();
  ctx.state.requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
});

app.onResponse((ctx, response) => {
  const ms = Date.now() - (ctx.state.startTime as number);
  const id = ctx.state.requestId as string;
  console.log(`[${id}] ${ctx.method} ${ctx.path} -> ${response.status} (${ms}ms)`);
});

// 2. Auth — short-circuits with 401 if no/invalid API key.
//    Public routes are exempted by checking the path.
app.onRequest((ctx: Ctx): Response | undefined => {
  if (ctx.path === "/health" || ctx.path === "/") return undefined;
  const key = ctx.headers["x-api-key"];
  if (!key || !VALID_API_KEYS.has(key)) {
    return ctx.status(401).json({ error: "missing or invalid x-api-key header" });
  }
  return undefined;
});

// 3. Error handler — converts any unhandled throw into a structured response.
app.onError((ctx, error) => {
  const id = ctx.state.requestId as string;
  console.error(`[${id}] error:`, error);
  if (error instanceof HttpError) return error.toResponse();
  return ctx.status(500).json({ error: "Internal Server Error", requestId: id });
});

// Public.
app.get("/", (ctx) => ctx.json({ ok: true }));
app.get("/health", (ctx) => ctx.json({ status: "healthy" }));

// Authenticated.
app.get("/secret", (ctx) => ctx.json({ message: "you got in", requestId: ctx.state.requestId }));
app.get("/boom", () => { throw new Error("intentional crash"); });

app.listen((started) => {
  if (started) {
    console.log("Middleware demo on http://localhost:3002");
    console.log("  GET / -> public");
    console.log("  GET /health -> public");
    console.log("  GET /secret -> requires x-api-key");
    console.log("  GET /boom -> demonstrates error handling");
  }
});
