# Microservice patterns

Health checks, Prometheus metrics, graceful shutdown — the layout you'd run in
Kubernetes.

## Run

    npx tsx examples/microservice/server.ts

## Try

    # Liveness
    curl http://localhost:3003/healthz

    # Readiness (extend to check downstream deps)
    curl http://localhost:3003/readyz

    # Prometheus metrics
    curl http://localhost:3003/metrics

    # Reflect request
    curl 'http://localhost:3003/api/echo?foo=bar'

    # Graceful shutdown — server drains in-flight requests, then exits
    # (Ctrl-C in the server terminal)

## What it shows

- Standard endpoints for liveness/readiness probes (`/healthz`, `/readyz`).
- Counters maintained by `onRequest` + `onResponse` hooks, exposed via
  `/metrics` in Prometheus exposition format using `ctx.raw(body, init)`.
- `process.on("SIGINT" / "SIGTERM")` + `await app.close()` for graceful
  shutdown — important for Kubernetes rolling deploys.
