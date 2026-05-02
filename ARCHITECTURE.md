# Fearless Architecture

Fearless is being shaped as a Rust-first microframework with a very small TypeScript surface.

## Goals

- Keep the public API small.
- Keep the request path as close to the metal as possible.
- Prefer Rust for the hot path whenever the app shape allows it.
- Use TypeScript for ergonomics, configuration, and developer-facing APIs.

## Runtime Split

### Rust

Rust is the primary runtime for:

- static routes
- response generation
- header application
- CORS preflight handling for compatible apps
- low-overhead request serving

### TypeScript

TypeScript is responsible for:

- declarative route registration
- request/response wrappers for compatibility mode
- manifest generation for the Rust core
- validation helpers
- compatibility mode when Rust cannot run

## What Stays in TypeScript

- route manifest construction
- request body parsing in compatibility mode
- response convenience APIs in compatibility mode
- framework ergonomics

## What Moves to Rust

- static route serving
- response template rendering
- global security headers
- global CORS config when it is compilable
- benchmark-style endpoints such as `/plaintext` and `/json`

## Built-In Helper Compilation

Small built-in helpers may be compiled into the Rust manifest when they are compatible with the hot path:

- `securityHeaders()` compiles into global response headers
- `cors()` compiles into global CORS metadata and OPTIONS handling

## Compatibility Rule

The framework should prefer Rust first, but still allow an explicit Node compatibility mode.

- `runtime: "rust"` means Rust is required.
- `runtime: "auto"` means Rust is preferred.
- `runtime: "node"` means Node only.

## Future Direction

The next migration steps are:

1. move more request metadata into the Rust manifest
2. compile more built-in helpers into Rust
3. reduce the number of apps that need Node compatibility mode
4. eventually move more dynamic template rendering into Rust as the next phase
