# @fearless/bun-runtime

Bun-side companion runtime for [Fearless](https://github.com/rodrigooler/fearless). Imports a user's Fearless app and serves the routes that didn't AOT-compile, on a configurable port.

## Install

```bash
npm install @fearless/bun-runtime
```

## CLI usage

```bash
fearless-bun my-app.ts --port 8081
```

This is just a thin wrapper that:
1. Sets `FEARLESS_PORT=8081` in env
2. Dynamically imports `my-app.ts` (Bun handles TS natively)
3. Lets the user's `app.listen()` bind to the configured port

For the dual-port architecture, you'd typically run this alongside the rust-core binary (which serves AOT routes) on a separate port. Your reverse proxy / load balancer fronts both.

## Programmatic usage

```ts
import { runFallbackServer } from "@fearless/bun-runtime";

await runFallbackServer({
  appPath: "./my-app.ts",
  port: 8081,
});
```

## Status

This package is the v1 of the dual-port architecture. Single-port transparent forwarding (rust-core proxying non-AOT requests to Bun via unix socket) is roadmapped — see the `aot-integration.md` design doc in the main repo.

For most production deployments, the dual-port approach is preferable anyway: it gives you independent scaling of the AOT side and the Bun side, plus your existing reverse proxy already knows how to do path-based routing.

## License

MIT
