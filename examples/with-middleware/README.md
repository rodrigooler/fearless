# With Middleware

Demonstrates the three hook phases: `onRequest`, `onResponse`, `onError`.

## Run

    npx tsx examples/with-middleware/server.ts

## Try

    # Public — no key needed
    curl http://localhost:3002/health

    # Authenticated — without key (401)
    curl http://localhost:3002/secret

    # Authenticated — with key (200)
    curl http://localhost:3002/secret -H 'x-api-key: secret-key-1'

    # Triggers the error hook (500)
    curl http://localhost:3002/boom -H 'x-api-key: secret-key-1'

## What it shows

- `app.onRequest((ctx) => ...)` — runs before the route handler. Return a `Response` to short-circuit (auth pattern).
- `app.onResponse((ctx, response) => ...)` — runs after the handler with the produced response. Use for logging, header injection.
- `app.onError((ctx, error) => ...)` — converts thrown errors into responses. `HttpError` carries its own status; everything else becomes 500.
- `ctx.state` — per-request mutable bag that survives across hooks (used here for `startTime` and `requestId`).
- Hook order: hooks fire in the order you registered them.
