import { App } from "../../src/index.js";

const app = new App({ port: 3003 });

const startTime = Date.now();
const counters = {
  requestsTotal: 0,
  requestsByStatus: new Map<number, number>(),
};

app.onRequest(() => {
  counters.requestsTotal += 1;
});

app.onResponse((_, response) => {
  counters.requestsByStatus.set(
    response.status,
    (counters.requestsByStatus.get(response.status) ?? 0) + 1
  );
});

app.get("/healthz", (ctx) => {
  return ctx.json({
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
  });
});

app.get("/readyz", (ctx) => {
  // Real services check downstream deps here (DB, cache, queue).
  return ctx.json({ status: "ready" });
});

app.get("/metrics", (ctx) => {
  // Prometheus exposition format.
  const lines: string[] = [
    "# HELP fearless_requests_total Total requests served",
    "# TYPE fearless_requests_total counter",
    `fearless_requests_total ${counters.requestsTotal}`,
    "# HELP fearless_requests_by_status Requests by HTTP status",
    "# TYPE fearless_requests_by_status counter",
  ];
  for (const [status, count] of counters.requestsByStatus.entries()) {
    lines.push(`fearless_requests_by_status{status="${status}"} ${count}`);
  }
  return ctx.raw(lines.join("\n") + "\n", {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  });
});

app.get("/api/echo", (ctx) => {
  return ctx.json({
    method: ctx.method,
    path: ctx.path,
    query: ctx.query,
    headers: ctx.headers,
    ip: ctx.ip,
  });
});

// Graceful shutdown on SIGINT / SIGTERM.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — closing server gracefully`);
  await app.close();
  console.log("server closed");
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

app.listen((started) => {
  if (started) {
    console.log("Microservice on http://localhost:3003");
    console.log("  GET /healthz   liveness");
    console.log("  GET /readyz    readiness");
    console.log("  GET /metrics   Prometheus exposition");
    console.log("  GET /api/echo  reflect request shape");
    console.log("Send SIGINT (Ctrl-C) for graceful shutdown.");
  }
});
