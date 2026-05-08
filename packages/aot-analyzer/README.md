# @fearless/aot-analyzer

Static-analyzer that decides whether a [Fearless](https://github.com/rodrigooler/fearless) handler can be AOT-compiled to Rust.

## Install

```bash
npm install @fearless/aot-analyzer
```

## Usage

```ts
import { analyzeHandler, formatReport } from "@fearless/aot-analyzer";

const result = analyzeHandler(`
  (ctx) => ctx.json({ id: ctx.params.id })
`);

if (result.compilable) {
  console.log("✅ this handler will run in Rust at multi-million req/s");
} else {
  console.log(formatReport(result));
  // ✗ Handler does NOT compile to Rust. Reasons:
  //   • [no-await] await blocks AOT compilation
  //   • [no-external-identifiers] Free identifier "db" is captured...
}
```

## Why

Fearless runs your TypeScript handlers on a hybrid Rust + Bun runtime. Handlers that fit a documented subset compile to native Rust at build time and serve at near-native speed (7-9M req/s). Handlers that don't fit that subset stay on Bun (which is still fast, ~400-800k req/s).

This package answers the question: **does my handler fit?**

## What's in the subset

The Phase 0 subset is intentionally tight:

- ✅ Handler is `(ctx) => ...` — single argument named `ctx`
- ✅ Returns `ctx.json/text/html/raw/redirect/notFound/noContent(...)` (optionally chained after `ctx.status(N).header(...)`)
- ✅ Reads `ctx.params.X`, `ctx.query.X`, `ctx.headers.X`, `ctx.method`, `ctx.path`, etc.
- ✅ `if/else` branching on `ctx.X` comparisons with literals
- ✅ Template literals with `ctx.X` substitutions

What **doesn't** fit (yet):

- ❌ `async` / `await` — except on registered framework handles (Phase 1+)
- ❌ External identifier capture (closures over `let db = ...`)
- ❌ Function calls outside `ctx.<builder>()` (no `parseInt`, no `JSON.stringify`, no npm packages)
- ❌ Loops (for/while/do-while)
- ❌ `throw` (return error responses directly instead)

Run `fearless analyze` over your project to see per-handler verdicts and refactor hints.

## Programmatic API

```ts
import { analyzeHandler, type AnalysisResult } from "@fearless/aot-analyzer";
import * as ts from "typescript";

// Pass a string source (analyzer parses it)
const r1: AnalysisResult = analyzeHandler(`(ctx) => ctx.json({})`);

// Or pass an existing AST node
const node = ts.createSourceFile(...).statements[0];
const r2 = analyzeHandler(node);

if (!r1.compilable) {
  for (const reason of r1.reasons) {
    console.log(`[${reason.rule}] ${reason.message}`);
    if (reason.hint) console.log(`  hint: ${reason.hint}`);
  }
}
```

The result format is stable JSON — safe for editor extensions, CI scripts, etc.

## Available rules

10 Phase 0 rules ship today:

| Rule | What it catches |
|---|---|
| `handler-shape` | Wrong parameter count, wrong name, async modifier |
| `no-await` | Any await blocks AOT |
| `no-promise` | Promise references / `.then()` chains |
| `no-external-identifiers` | Closures over outer scope |
| `no-dynamic-property` | `obj[var]` bracket access |
| `no-throw` | Throw statements |
| `no-loops` | for/while/do-while/for-in/for-of |
| `no-disallowed-calls` | Function calls outside ctx surface |
| `return-shape` | Returns must be `ctx.<builder>()` |
| `template-substitutions` | Template `${...}` must be `ctx.X` |

## License

MIT
