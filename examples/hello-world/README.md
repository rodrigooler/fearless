# Hello World

The smallest possible Fearless app: one template route, one handler route.

## Run

    npx tsx examples/hello-world/server.ts

## Try

    curl http://localhost:3000/
    curl http://localhost:3000/greet/Alice

## What it shows

- Template routes (`app.text`, `app.json`) for static responses — eligible for the Rust hot path on Linux.
- Handler routes (`app.get(path, ctx => ...)`) for dynamic logic — always runs on Node or Bun.
