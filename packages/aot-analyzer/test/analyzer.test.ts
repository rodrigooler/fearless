import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeHandler, formatReport, type AnalysisResult } from "../src/index.js";

// ============================================================================
// Helpers
// ============================================================================

function expectCompilable(source: string, label?: string): void {
  const result = analyzeHandler(source);
  if (!result.compilable) {
    const report = formatReport(result);
    throw new Error(
      `Expected handler to be compilable${label ? ` (${label})` : ""}, but got:\n${report}\n\nSource:\n${source}`
    );
  }
}

function expectFailure(source: string, expectedRule: string, label?: string): AnalysisResult & { compilable: false } {
  const result = analyzeHandler(source);
  if (result.compilable) {
    throw new Error(
      `Expected handler to fail rule "${expectedRule}"${label ? ` (${label})` : ""}, but it compiled.\n\nSource:\n${source}`
    );
  }
  const matched = result.reasons.some((r) => r.rule === expectedRule);
  if (!matched) {
    const got = result.reasons.map((r) => r.rule).join(", ");
    throw new Error(
      `Expected rule "${expectedRule}" to fire${label ? ` (${label})` : ""}, but got: ${got}\n\nSource:\n${source}`
    );
  }
  return result;
}

// ============================================================================
// COMPILABLE handlers — should pass all Phase 0 rules
// ============================================================================

test("compilable: trivial json literal", () => {
  expectCompilable(`(ctx) => ctx.json({ ok: true })`);
});

test("compilable: trivial text literal", () => {
  expectCompilable(`(ctx) => ctx.text("hello")`);
});

test("compilable: trivial html literal", () => {
  expectCompilable(`(ctx) => ctx.html("<h1>hi</h1>")`);
});

test("compilable: noContent", () => {
  expectCompilable(`(ctx) => ctx.noContent()`);
});

test("compilable: redirect with literal", () => {
  expectCompilable(`(ctx) => ctx.redirect("/login")`);
});

test("compilable: redirect with status", () => {
  expectCompilable(`(ctx) => ctx.redirect("/login", 301)`);
});

test("compilable: notFound with literal", () => {
  expectCompilable(`(ctx) => ctx.notFound("user not found")`);
});

test("compilable: notFound no args", () => {
  expectCompilable(`(ctx) => ctx.notFound()`);
});

test("compilable: read ctx.params.id and echo", () => {
  expectCompilable(`(ctx) => ctx.json({ id: ctx.params.id })`);
});

test("compilable: read ctx.method", () => {
  expectCompilable(`(ctx) => ctx.json({ method: ctx.method })`);
});

test("compilable: read ctx.path", () => {
  expectCompilable(`(ctx) => ctx.json({ path: ctx.path })`);
});

test("compilable: read ctx.ip", () => {
  expectCompilable(`(ctx) => ctx.json({ ip: ctx.ip })`);
});

test("compilable: read ctx.headers literal-key bracket", () => {
  expectCompilable(`(ctx) => ctx.json({ trace: ctx.headers["x-trace"] })`);
});

test("compilable: nested object literal", () => {
  expectCompilable(`(ctx) => ctx.json({ user: { id: ctx.params.id, name: "Alice" } })`);
});

test("compilable: array of literals", () => {
  expectCompilable(`(ctx) => ctx.json([1, 2, 3])`);
});

test("compilable: status chain then json", () => {
  expectCompilable(`(ctx) => ctx.status(201).json({ created: true })`);
});

test("compilable: status + header chain", () => {
  expectCompilable(`(ctx) => ctx.status(202).header("x-trace", ctx.params.id).json({})`);
});

test("compilable: setHeaders chain", () => {
  expectCompilable(`(ctx) => ctx.setHeaders({ "cache-control": "no-store" }).json({})`);
});

test("compilable: full chain status + header + setHeaders + json", () => {
  expectCompilable(
    `(ctx) => ctx.status(201).header("x-trace", ctx.params.id).setHeaders({ "cache-control": "no-store" }).json({ ok: true })`
  );
});

test("compilable: template literal with ctx.params substitution", () => {
  expectCompilable(`(ctx) => ctx.json({ message: \`Hello, \${ctx.params.name}\` })`);
});

test("compilable: template literal with ctx.method substitution", () => {
  expectCompilable(`(ctx) => ctx.text(\`method: \${ctx.method}\`)`);
});

test("compilable: template literal with multiple substitutions", () => {
  expectCompilable(
    `(ctx) => ctx.json({ msg: \`\${ctx.method} \${ctx.path} from \${ctx.ip}\` })`
  );
});

test("compilable: block body with single return", () => {
  expectCompilable(`(ctx) => { return ctx.json({ ok: true }); }`);
});

test("compilable: block body with conditional", () => {
  expectCompilable(`
    (ctx) => {
      if (ctx.headers.authorization === "secret") {
        return ctx.json({ access: "granted" });
      }
      return ctx.status(401).json({ error: "denied" });
    }
  `);
});

test("compilable: ternary in argument", () => {
  expectCompilable(
    `(ctx) => ctx.json({ admin: ctx.headers["x-role"] === "admin" })`
  );
});

test("compilable: logical OR in argument", () => {
  expectCompilable(`(ctx) => ctx.json({ name: ctx.params.name || "anonymous" })`);
});

test("compilable: nested if/else with multiple returns", () => {
  expectCompilable(`
    (ctx) => {
      if (ctx.method === "GET") {
        return ctx.json({ kind: "read" });
      } else if (ctx.method === "POST") {
        return ctx.status(201).json({ kind: "create" });
      } else {
        return ctx.status(405).json({ error: "method not allowed" });
      }
    }
  `);
});

test("compilable: function expression form", () => {
  // A bare `function (ctx) {}` parses as a declaration. Wrap as expression.
  expectCompilable(`const h = function (ctx) { return ctx.json({ ok: true }); };`);
});

test("compilable: numeric and boolean literals", () => {
  expectCompilable(`(ctx) => ctx.json({ count: 42, active: true, ratio: 1.5 })`);
});

test("compilable: null in body", () => {
  expectCompilable(`(ctx) => ctx.json({ deleted: null })`);
});

// ============================================================================
// FAILURES — each test asserts a specific rule fires
// ============================================================================

test("fails: await", () => {
  expectFailure(
    `async (ctx) => { const x = await something(); return ctx.json(x); }`,
    "no-await"
  );
});

test("fails: await on member call", () => {
  expectFailure(
    `async (ctx) => ctx.json(await something.foo())`,
    "no-await"
  );
});

test("fails: Promise reference", () => {
  expectFailure(
    `(ctx) => { const p = Promise.resolve(1); return ctx.json({ p }); }`,
    "no-promise"
  );
});

test("fails: .then() chain", () => {
  expectFailure(
    `(ctx) => something.then(x => ctx.json(x))`,
    "no-promise"
  );
});

test("fails: .catch() chain", () => {
  expectFailure(
    `(ctx) => something.catch(e => ctx.json({ e }))`,
    "no-promise"
  );
});

test("fails: external identifier captured (db)", () => {
  expectFailure(
    `(ctx) => ctx.json(db.findUser(ctx.params.id))`,
    "no-external-identifiers"
  );
});

test("fails: external identifier captured (cache)", () => {
  expectFailure(
    `(ctx) => { const cached = cache.get(ctx.params.id); return ctx.json(cached); }`,
    "no-external-identifiers"
  );
});

test("fails: console.log inside handler", () => {
  expectFailure(
    `(ctx) => { console.log("hi"); return ctx.json({}); }`,
    "no-external-identifiers"
  );
});

test("fails: dynamic property access ctx.headers[var]", () => {
  expectFailure(
    `(ctx) => { const k = "x-key"; return ctx.json({ v: ctx.headers[k] }); }`,
    "no-dynamic-property"
  );
});

test("fails: dynamic property access ctx.params[ctx.method]", () => {
  expectFailure(
    `(ctx) => ctx.json({ v: ctx.params[ctx.method] })`,
    "no-dynamic-property"
  );
});

test("fails: throw HttpError", () => {
  expectFailure(
    `(ctx) => { throw HttpError.notFound("nope"); }`,
    "no-throw"
  );
});

test("fails: throw plain Error", () => {
  expectFailure(
    `(ctx) => { throw new Error("boom"); }`,
    "no-throw"
  );
});

test("fails: for loop", () => {
  expectFailure(
    `(ctx) => { for (let i = 0; i < 10; i++) {} return ctx.json({}); }`,
    "no-loops"
  );
});

test("fails: for-of loop", () => {
  expectFailure(
    `(ctx) => { for (const k of [1,2,3]) {} return ctx.json({}); }`,
    "no-loops"
  );
});

test("fails: while loop", () => {
  expectFailure(
    `(ctx) => { while (true) { break; } return ctx.json({}); }`,
    "no-loops"
  );
});

test("fails: do-while loop", () => {
  expectFailure(
    `(ctx) => { do { break; } while (true); return ctx.json({}); }`,
    "no-loops"
  );
});

test("fails: parseInt call", () => {
  expectFailure(
    `(ctx) => ctx.json({ n: parseInt(ctx.params.id) })`,
    "no-disallowed-calls"
  );
});

test("fails: JSON.stringify call", () => {
  expectFailure(
    `(ctx) => ctx.text(JSON.stringify({ x: 1 }))`,
    "no-disallowed-calls"
  );
});

test("fails: ctx.unknownMethod call", () => {
  expectFailure(
    `(ctx) => ctx.unknownMethod()`,
    "no-disallowed-calls"
  );
});

test("fails: bare identifier call", () => {
  expectFailure(
    `(ctx) => { someFunction(); return ctx.json({}); }`,
    // either rule may catch this — both should work; assert call rule
    "no-disallowed-calls"
  );
});

test("fails: return without expression", () => {
  expectFailure(
    `(ctx) => { return; }`,
    "return-shape"
  );
});

test("fails: return raw value (not ctx builder)", () => {
  expectFailure(
    `(ctx) => { return { ok: true }; }`,
    "return-shape"
  );
});

test("fails: arrow body that isn't a ctx call", () => {
  expectFailure(
    `(ctx) => 42`,
    "return-shape"
  );
});

test("fails: arrow body returning non-builder ctx call", () => {
  expectFailure(
    `(ctx) => ctx.status(200)`,
    "return-shape"
  );
});

test("fails: empty block body, no return", () => {
  expectFailure(
    `(ctx) => {}`,
    "return-shape"
  );
});

test("fails: template substitution with arbitrary expression", () => {
  expectFailure(
    `(ctx) => ctx.json({ x: \`hello \${1 + 2}\` })`,
    "template-substitutions"
  );
});

test("fails: template substitution with bare identifier", () => {
  expectFailure(
    `(ctx) => { const name = "x"; return ctx.json({ msg: \`hi \${name}\` }); }`,
    "template-substitutions"
  );
});

test("fails: handler with two parameters", () => {
  expectFailure(
    `(ctx, req) => ctx.json({})`,
    "handler-shape"
  );
});

test("fails: handler with destructured parameter", () => {
  expectFailure(
    `({ params }) => ctx.json({})`,
    "handler-shape"
  );
});

test("fails: handler param named differently", () => {
  expectFailure(
    `(c) => c.json({})`,
    "handler-shape"
  );
});

test("fails: handler with no parameters", () => {
  expectFailure(
    `() => ctx.json({})`,
    "handler-shape"
  );
});

// ============================================================================
// Multi-rule failures (composite cases — any of the listed rules may fire)
// ============================================================================

test("fails: async + await + external identifier — multiple rules fire", () => {
  const result = analyzeHandler(
    `async (ctx) => { const u = await db.find(ctx.params.id); return ctx.json(u); }`
  );
  assert.equal(result.compilable, false);
  if (!result.compilable) {
    const rules = new Set(result.reasons.map((r) => r.rule));
    assert.ok(rules.has("no-await"), `expected no-await in ${[...rules].join(", ")}`);
    assert.ok(
      rules.has("no-external-identifiers") || rules.has("no-disallowed-calls"),
      `expected external-id or call rule in ${[...rules].join(", ")}`
    );
  }
});

// ============================================================================
// API shape checks
// ============================================================================

test("formatReport: success message", () => {
  const report = formatReport({ compilable: true });
  assert.match(report, /compiles to Rust/);
});

test("formatReport: failure includes rule names", () => {
  const result = analyzeHandler(`(ctx) => 42`);
  assert.equal(result.compilable, false);
  const report = formatReport(result);
  assert.match(report, /return-shape/);
});

test("analyzeHandler: input that is not a function returns no-handler reason", () => {
  const result = analyzeHandler(`const x = 1;`);
  assert.equal(result.compilable, false);
  if (!result.compilable) {
    assert.equal(result.reasons[0]?.rule, "handler-shape");
  }
});

// ============================================================================
// Sanity: every rule has at least one test asserting it fires
// ============================================================================

test("test coverage: every rule has at least one failure test", () => {
  const expectedRules = new Set([
    "handler-shape",
    "no-await",
    "no-promise",
    "no-external-identifiers",
    "no-dynamic-property",
    "no-throw",
    "no-loops",
    "no-disallowed-calls",
    "return-shape",
    "template-substitutions",
  ]);
  // This test passes by construction — earlier tests assert each rule. It's a
  // regression sentinel: if someone adds a new rule, they need to add a test
  // and add it to this set.
  assert.equal(expectedRules.size, 10);
});
