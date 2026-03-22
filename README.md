# Fearless

Fearless is a small TypeScript-first framework with a Rust hot path underneath. It is designed to stay simple at the API surface while keeping the request path as close to the metal as possible.

The design goal is not to ship a giant ecosystem of batteries and wrappers. The goal is to give you a fast core, a small set of built-in helpers, and enough room to choose your own validation and application-level abstractions.

## Project Docs

- [License](./LICENSE)
- [Contributing](./CONTRIBUTING.md)
- [Contributors](./CONTRIBUTORS.md)
- [Pull Request Template](./.github/PULL_REQUEST_TEMPLATE.md)

## What It Is

Fearless combines three layers:

1. A TypeScript application layer for routes, middleware, request/response ergonomics, and user-facing APIs.
2. A Rust core for the static hot path used by benchmark-style endpoints such as `/plaintext` and `/json`.
3. A minimal helper layer for common concerns like CORS and security headers.

That split keeps the framework flexible without forcing every request through a large abstraction stack.

## Repository & Install

Main repository:

- [https://github.com/rodrigooler/fearless](https://github.com/rodrigooler/fearless)

If you want to install directly from Git in another project, use:

```json
{
  "dependencies": {
    "fearless": "git+https://github.com/rodrigooler/fearless.git#main"
  }
}
```

Or with npm:

```bash
npm install git+https://github.com/rodrigooler/fearless.git#main
```

### Do I need Rust installed?

- If you use the Rust hot path from source, yes, you need a Rust toolchain available because the framework compiles the Rust core when it starts.
- If you provide a prebuilt binary through `rustCoreBinary`, the framework will use that binary instead of building locally.
- If you only use the Node/TypeScript parts of the framework and never start the Rust-backed runtime, you may not need Rust on that machine.

## Why It Exists

Most frameworks optimize for breadth. Fearless optimizes for two things at the same time:

- low overhead on the critical path
- a small, understandable public API

The practical result is:

- fewer allocations on the hot path
- less middleware overhead when you do not need it
- a predictable runtime surface
- easy benchmarking against TechEmpower-style workloads
- a framework that stays pleasant to use even when you keep it lean

## Performance Model

Fearless is built around a few performance decisions:

- static routes can be served by Rust directly
- `plaintext` and `json` are precompiled into a manifest for the Rust core
- response payloads are cached per second so `Date` does not force per-request work
- route lookup is optimized for exact paths first
- request parsing avoids unnecessary work on the hot path
- the framework does not require a validation library in core

This means the framework can stay lightweight while still achieving serious throughput on a simple benchmark profile.

### Latest benchmark baseline

The current benchmark baseline in this repository is derived from the official TechEmpower clone and is tracked in [`benchmark.json`](./benchmark.json).

Recent measured peaks:

- `plaintext`: about `2.53M req/s`
- `json`: about `1.17M req/s`

Those numbers depend on the exact host, worker scheduling, and benchmark configuration, but they are a useful current reference point for the Rust hot path.

## Built-In Helpers

Fearless ships a few helpers that are intentionally small and dependency-light:

- `cors()` for cross-origin access control
- `securityHeaders()` for common security headers

These are provided so you do not need to install a large middleware package just to get a basic setup working.

## Validation Philosophy

Validation is intentionally not hard-wired to one specific library.

Fearless accepts validator functions, so you can plug in whatever you want:

- a tiny handwritten validator
- a schema library you already use
- a shared validation layer from your own app

This keeps the framework flexible and avoids forcing one validation ecosystem into the core package.

Example:

```ts
type User = {
  name: string;
  email: string;
  age: number;
};

function parseUser(data: unknown): User | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const candidate = data as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.email !== "string" ||
    typeof candidate.age !== "number"
  ) {
    return null;
  }

  return {
    name: candidate.name,
    email: candidate.email,
    age: candidate.age,
  };
}
```

You pass that function into `req.parseBodyRaw(...)`, `req.parseBody(...)`, `req.json(...)`, or into `createValidator(...)` if you want a standardized `{ ok, data, errors }` result.

## API Overview

### `App`

Create an app, register routes, add middleware, and start listening.

Supported route methods:

- `get`
- `post`
- `put`
- `patch`
- `delete`
- `options`
- `head`

Content helpers:

- `text`
- `json`
- `html`

Lifecycle:

- `listen()`
- `close()`

### `Request`

The request wrapper exposes:

- normalized `path`
- parsed `query`
- normalized `headers`
- path parameters in `params`
- client `ip`
- JSON body parsing helpers

### `Response`

The response wrapper exposes:

- `status()`
- `json()`
- `text()`
- `html()`
- `send()`
- `setHeader()`
- `setHeaders()`
- `getResponse()`
- `isEnded()`

### Middleware

Middleware is supported at both global and route level. Middleware can:

- inspect the request
- set headers
- short-circuit a request
- call `next()` to continue the chain

## Example

```ts
import { App, cors, securityHeaders } from "fearless";

const app = new App({ port: 3000 });

app.use(cors());
app.use(securityHeaders());

app.get("/plaintext", (_req, res) => {
  res.text("Hello, World!");
});

app.get("/json", (_req, res) => {
  res.json({ message: "Hello, World!" });
});

app.post("/users", async (req, res) => {
  const body = await req.parseBodyRaw((data) => {
    if (!data || typeof data !== "object") {
      return null;
    }

    const candidate = data as Record<string, unknown>;
    if (typeof candidate.name !== "string") {
      return null;
    }

    return { name: candidate.name };
  });

  if (!body) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  return res.json({ created: true, body });
});

app.listen((started) => {
  if (started) {
    console.log("Fearless is running on http://localhost:3000");
  }
});
```

## TechEmpower Benchmarking

Fearless has an official TechEmpower benchmark target in the sibling clone under `FrameworkBenchmarks`.

That target exists so we can measure the real framework implementation against the same benchmark harness used by the broader ecosystem, instead of relying on a separate local benchmark that drifts over time.

If you are working on performance:

- run the TechEmpower verify step first
- benchmark only the relevant tests
- compare the same host, same build, and same worker settings

The current repository also stores a compact summary of the latest baseline in [`benchmark.json`](./benchmark.json).

## Philosophy

Fearless tries to stay useful without becoming bloated:

- the runtime is internal, so implementation details can change without breaking the public API
- helper packages exist, but they stay small and optional
- validation is user-controlled instead of framework-controlled
- the Rust hot path is there for throughput, not for ceremony

That makes the framework a good fit when you want:

- a small framework with real performance ambition
- a baseline that is easy to understand and test
- a foundation you can extend without carrying unnecessary dependencies

## Development

Typical commands:

```bash
npm run build
npm test
npm run bench:tfb
```

## License

See the project repository for license information.
