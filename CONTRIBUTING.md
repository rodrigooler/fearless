# Contributing to Fearless

Fearless is intentionally small. Contributions are welcome when they improve one of these areas:

- performance
- correctness
- test coverage
- developer ergonomics
- documentation

## Before You Open a PR

1. Read the README and the benchmark notes.
2. Keep the public API stable unless a change is clearly justified.
3. Prefer small, focused changes over broad refactors.
4. Add or update tests for any behavior change.
5. Run the full test suite before opening a pull request.

## Local Development

Typical commands:

```bash
npm run build
npm test
```

If your change affects the Rust hot path, also run the TechEmpower benchmark target in the sibling repository and capture the result in `benchmark.json` only when the benchmark data is relevant.

## Code Style

- Keep TypeScript code explicit and readable.
- Avoid unnecessary dependencies.
- Prefer narrow helpers over large abstractions.
- Keep hot-path code allocation-light.
- Document any non-obvious behavior in the code or README.

## Testing Rules

- Add tests for new public behavior.
- Update tests when behavior changes.
- Cover both success and failure cases for parsing, routing, and middleware behavior.
- For benchmark-driven changes, verify the result before and after the change when possible.

## Performance Changes

When changing the Rust hot path:

- measure before changing the code
- make one optimization at a time
- keep the benchmark harness stable
- avoid introducing extra allocations in the request path
- prefer data-oriented changes over framework-level complexity

## Pull Request Expectations

Each PR should include:

- a short summary of the change
- why the change is needed
- how it was validated
- any benchmark impact if relevant

If the change is user-facing, document it in the README or a dedicated doc file.

## Commit Messages

Use clear conventional-style commit subjects when possible:

- `feat: ...`
- `fix: ...`
- `perf: ...`
- `refactor: ...`
- `test: ...`
- `docs: ...`
- `chore: ...`

## What to Avoid

- large dependency additions for small features
- hidden breaking changes
- benchmark claims without a reproducible run
- merging untested changes
- optimizing code without measuring it
