# AGENTS.md

Project guidance for contributors and coding agents working on Fearless.

## Core Principles

- Keep the public API small and stable.
- Prefer Rust for the hot path when it is available.
- Keep TypeScript as the orchestration and ergonomics layer.
- Optimize for throughput without making the code opaque.
- Favor simple control flow over clever abstractions.

## Architecture

Fearless is split into three practical layers:

1. TypeScript application surface
   - route registration
   - middleware
   - request/response wrappers
   - developer-facing helpers

2. Rust hot path
   - static benchmark-style routes
   - low-overhead response generation
   - minimal per-request allocation

3. Small built-in helpers
   - `cors()`
   - `securityHeaders()`

Do not add heavy framework dependencies to core unless they clearly improve the product.

## Performance Rules

- Prefer `const` by default.
- Use `let` only when mutation is necessary.
- Use early return instead of deep nesting.
- Keep hot-path code free of avoidable intermediate arrays and object churn.
- Avoid `map`, `filter`, `reduce`, or similar combinators in request-critical paths when a plain loop is cheaper and clearer.
- Avoid `try/catch` in the normal fast path unless the error is genuinely exceptional.
- Avoid per-request allocation when a cached or precomputed value works.
- Do not introduce unnecessary abstraction layers in the request pipeline.
- Measure before and after any performance change.

## Hot Path Guidance

When editing request handling:

- keep route lookup direct and predictable
- keep not-found handling explicit
- keep middleware chaining readable but not over-engineered
- avoid duplicate normalization or parsing logic
- keep JSON serialization semantics intact
- do not trade correctness for micro-optimizations

If a change makes the code more functional but also creates extra allocations or hides control flow, it is usually the wrong tradeoff here.

## Runtime Rules

- The runtime selection is an internal implementation detail.
- Do not expose engine selection as a public API.
- If HTTPS is configured, do not route through the Rust static runtime unless the runtime explicitly supports it.
- The Rust runtime is intended for the static fast path.

## Validation Rules

Always run the relevant checks before finishing work:

- `npm run build`
- `npm test`
- Rust unit tests when Rust code changes

If you change benchmark-related code, also verify the TechEmpower target in the sibling clone when available.

## API Coverage Expectations

When adding or changing public APIs, make sure tests cover:

- `App` route registration
- `listen()` and `close()`
- request path normalization
- query parsing
- headers
- params
- request body parsing
- `Request`
- `Response`
- middleware order and short-circuiting
- HTTPS behavior
- Rust runtime compatibility for static routes

## Validation Philosophy

Validation is intentionally pluggable.

- Do not hard-wire one schema library into the framework core.
- Accept validator functions.
- Keep the API flexible so users can choose their own validation strategy.

## Built-in Helpers

Small helpers are welcome when they remove dependency overhead:

- `cors()`
- `securityHeaders()`

Prefer tiny built-ins over forcing users to install multiple packages for basic needs.

## Style Rules

- Write clear, direct code.
- Prefer small helpers when they reduce duplication.
- Remove dead code instead of leaving it around.
- Keep comments short and only where the logic is not obvious.
- Preserve existing formatting and conventions.

## Commit Messages

Use Conventional Commits for new work:

- `feat: ...`
- `fix: ...`
- `refactor: ...`
- `perf: ...`
- `test: ...`
- `chore: ...`
- `docs: ...`

Use a scope when it helps:

- `perf(rust-core): ...`
- `refactor(app): ...`
- `test(http): ...`

## Files To Watch Closely

- `src/app.ts`
- `src/request.ts`
- `src/response.ts`
- `src/path.ts`
- `src/rust-core.ts`
- `rust-core/src/main.rs`
- `test/http-engine.test.ts`
- `test/request-response.test.ts`

## If You Are Unsure

Choose the option that:

- preserves correctness
- keeps the API stable
- avoids extra runtime cost
- is easy to test
- is easy to explain to a future maintainer

