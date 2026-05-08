import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { transpileHandler } from "../src/index.js";
import type { TranspileResult } from "../src/index.js";

// ============================================================================
// Helpers
// ============================================================================

function parseHandler(source: string): ts.ArrowFunction | ts.FunctionExpression {
  const sourceFile = ts.createSourceFile(
    "<test>.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  let found: ts.ArrowFunction | ts.FunctionExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (found != null) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  if (found == null) throw new Error(`No handler found in: ${source}`);
  return found;
}

function transpile(source: string, opts?: { method?: "GET" | "POST"; path?: string; id?: string }): TranspileResult {
  const handler = parseHandler(source);
  const outcome = transpileHandler({
    handler,
    method: opts?.method ?? "GET",
    path: opts?.path ?? "/test",
    id: opts?.id ?? "test",
  });
  if (!outcome.success) {
    throw new Error(`Expected success, got error: ${outcome.error.kind} — ${outcome.error.message}`);
  }
  return outcome.result;
}

function transpileFails(source: string): void {
  const handler = parseHandler(source);
  const outcome = transpileHandler({ handler, method: "GET", path: "/test", id: "test" });
  if (outcome.success) {
    throw new Error(`Expected failure, but got success:\n${outcome.result.rustSource}`);
  }
}

// ============================================================================
// Static responses
// ============================================================================

test("json literal — emits static byte string", () => {
  const result = transpile(`(ctx) => ctx.json({ ok: true })`);
  assert.match(result.rustSource, /pub fn handler_test\(req: &aot_runtime::AotRequest, out: &mut Vec<u8>\)/);
  assert.match(result.rustSource, /HTTP\/1\.1 200 OK/);
  assert.match(result.rustSource, /Content-Type: application\/json/);
  assert.match(result.rustSource, /Content-Length: 11/);
  assert.match(result.rustSource, /\{\\"ok\\":true\}/);
  assert.equal(result.fnName, "handler_test");
});

test("text literal — text/plain content-type", () => {
  const result = transpile(`(ctx) => ctx.text("Hello, World!")`);
  assert.match(result.rustSource, /HTTP\/1\.1 200 OK/);
  assert.match(result.rustSource, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(result.rustSource, /Content-Length: 13/);
  assert.match(result.rustSource, /Hello, World!/);
});

test("html literal — text/html content-type", () => {
  const result = transpile(`(ctx) => ctx.html("<h1>hi</h1>")`);
  assert.match(result.rustSource, /Content-Type: text\/html; charset=utf-8/);
  assert.match(result.rustSource, /<h1>hi<\/h1>/);
});

test("noContent — 204 with empty body", () => {
  const result = transpile(`(ctx) => ctx.noContent()`);
  assert.match(result.rustSource, /HTTP\/1\.1 204 No Content/);
  assert.match(result.rustSource, /Content-Length: 0/);
});

test("notFound — 404 with body", () => {
  const result = transpile(`(ctx) => ctx.notFound("user not found")`);
  assert.match(result.rustSource, /HTTP\/1\.1 404 Not Found/);
  assert.match(result.rustSource, /user not found/);
});

test("notFound no args — defaults to 'Not Found'", () => {
  const result = transpile(`(ctx) => ctx.notFound()`);
  assert.match(result.rustSource, /HTTP\/1\.1 404 Not Found/);
  assert.match(result.rustSource, /Not Found/);
});

test("redirect — Location header set", () => {
  const result = transpile(`(ctx) => ctx.redirect("/login")`);
  assert.match(result.rustSource, /HTTP\/1\.1 302 Found/);
  assert.match(result.rustSource, /Location: \/login/);
});

test("redirect with explicit status — uses given code", () => {
  const result = transpile(`(ctx) => ctx.redirect("/elsewhere", 301)`);
  assert.match(result.rustSource, /HTTP\/1\.1 301 Moved Permanently/);
});

// ============================================================================
// Status & header chains
// ============================================================================

test("status chain — uses given code", () => {
  const result = transpile(`(ctx) => ctx.status(201).json({ created: true })`);
  assert.match(result.rustSource, /HTTP\/1\.1 201 Created/);
});

test("status 422", () => {
  const result = transpile(`(ctx) => ctx.status(422).json({ error: "bad" })`);
  assert.match(result.rustSource, /HTTP\/1\.1 422 Unprocessable Entity/);
});

test("status 500", () => {
  const result = transpile(`(ctx) => ctx.status(500).json({ error: "boom" })`);
  assert.match(result.rustSource, /HTTP\/1\.1 500 Internal Server Error/);
});

// ============================================================================
// Param / query / header substitution
// ============================================================================

test("ctx.params.id substitution in JSON", () => {
  const result = transpile(`(ctx) => ctx.json({ id: ctx.params.id })`);
  assert.match(result.rustSource, /req\.param\("id"\)/);
  assert.match(result.rustSource, /aot_runtime::write_json_string/);
  assert.match(result.rustSource, /aot_runtime::write_decimal/);
  // dynamic — content length not statically known
  assert.doesNotMatch(result.rustSource, /Content-Length: \d+\\r/);
});

test("ctx.query.q substitution", () => {
  const result = transpile(`(ctx) => ctx.json({ q: ctx.query.q })`);
  assert.match(result.rustSource, /req\.query_get\("q"\)/);
});

test("ctx.headers.x-trace substitution", () => {
  const result = transpile(`(ctx) => ctx.json({ trace: ctx.headers["x-trace"] })`);
  assert.match(result.rustSource, /req\.header\("x-trace"\)/);
});

test("ctx.method substitution", () => {
  const result = transpile(`(ctx) => ctx.json({ m: ctx.method })`);
  assert.match(result.rustSource, /req\.method/);
});

test("nested object with mixed static + dynamic", () => {
  const result = transpile(`(ctx) => ctx.json({ user: { id: ctx.params.id, kind: "human" } })`);
  assert.match(result.rustSource, /req\.param\("id"\)/);
  assert.match(result.rustSource, /human/);
});

test("array literal with one dynamic element", () => {
  const result = transpile(`(ctx) => ctx.json([1, ctx.params.id, 3])`);
  assert.match(result.rustSource, /req\.param\("id"\)/);
});

// ============================================================================
// Template literals
// ============================================================================

test("template literal in text body", () => {
  const result = transpile(`(ctx) => ctx.text(\`Hello, \${ctx.params.name}\`)`);
  assert.match(result.rustSource, /Hello, /);
  assert.match(result.rustSource, /req\.param\("name"\)\.as_bytes\(\)/);
});

test("template literal in JSON body — quoted", () => {
  const result = transpile(`(ctx) => ctx.json({ msg: \`Hello, \${ctx.params.name}\` })`);
  assert.match(result.rustSource, /aot_runtime::write_json_string/);
});

test("template literal with multiple substitutions", () => {
  const result = transpile(
    `(ctx) => ctx.text(\`\${ctx.method} \${ctx.path} from \${ctx.ip}\`)`
  );
  assert.match(result.rustSource, /req\.method\.as_bytes\(\)/);
  assert.match(result.rustSource, /req\.path\.as_bytes\(\)/);
  assert.match(result.rustSource, /req\.ip\.as_bytes\(\)/);
});

// ============================================================================
// Conditional branches
// ============================================================================

test("if/else branches — both compile to guarded blocks", () => {
  const result = transpile(`
    (ctx) => {
      if (ctx.method === "GET") {
        return ctx.json({ k: "read" });
      }
      return ctx.status(405).json({ k: "no" });
    }
  `);
  assert.match(result.rustSource, /if req\.method == "GET"/);
  assert.match(result.rustSource, /HTTP\/1\.1 200 OK/);
  assert.match(result.rustSource, /HTTP\/1\.1 405 Method Not Allowed/);
});

test("if-elseif-else chain", () => {
  const result = transpile(`
    (ctx) => {
      if (ctx.method === "GET") return ctx.json({ k: "r" });
      if (ctx.method === "POST") return ctx.status(201).json({ k: "c" });
      return ctx.status(405).json({});
    }
  `);
  assert.match(result.rustSource, /if req\.method == "GET"/);
  assert.match(result.rustSource, /if req\.method == "POST"/);
  assert.match(result.rustSource, /HTTP\/1\.1 201 Created/);
  assert.match(result.rustSource, /HTTP\/1\.1 405 Method Not Allowed/);
});

test("equality with header read", () => {
  const result = transpile(`
    (ctx) => {
      if (ctx.headers.authorization === "secret") {
        return ctx.json({ access: true });
      }
      return ctx.status(401).json({ access: false });
    }
  `);
  assert.match(result.rustSource, /req\.header\("authorization"\) == "secret"/);
});

test("inequality operator", () => {
  const result = transpile(`
    (ctx) => {
      if (ctx.method !== "GET") return ctx.status(405).json({});
      return ctx.json({ ok: true });
    }
  `);
  assert.match(result.rustSource, /req\.method != "GET"/);
});

// ============================================================================
// Status codes outside the named map — fallback reason text
// ============================================================================

test("status 299 — falls back to 'OK' reason", () => {
  const result = transpile(`(ctx) => ctx.status(299).json({})`);
  assert.match(result.rustSource, /HTTP\/1\.1 299 OK/);
});

test("status 599 — falls back to 'Server Error'", () => {
  const result = transpile(`(ctx) => ctx.status(599).json({})`);
  assert.match(result.rustSource, /HTTP\/1\.1 599 Server Error/);
});

// ============================================================================
// Failure modes
// ============================================================================

test("fails: ctx.raw call", () => {
  // ctx.raw is intentionally unsupported in Phase 0 — too many shapes.
  transpileFails(`(ctx) => ctx.raw("anything")`);
});

test("fails: dynamic status (variable)", () => {
  // The analyzer normally rejects this, but if a transpile is attempted directly
  // on a non-literal status, it should fail rather than emit broken Rust.
  const handler = parseHandler(`(ctx) => { const code = 200; return ctx.status(code).json({}); }`);
  const outcome = transpileHandler({ handler, method: "GET", path: "/", id: "x" });
  assert.equal(outcome.success, false);
});

// ============================================================================
// Output structural sanity
// ============================================================================

test("function name is sanitized — special chars stripped", () => {
  const result = transpile(`(ctx) => ctx.json({})`, { id: "users-by-id" });
  assert.equal(result.fnName, "handler_users_by_id");
});

test("method and path echo through unchanged", () => {
  const result = transpile(`(ctx) => ctx.json({})`, { method: "POST", path: "/users/:id" });
  assert.equal(result.method, "POST");
  assert.equal(result.path, "/users/:id");
});

test("rustSource ends with closing brace + newline", () => {
  const result = transpile(`(ctx) => ctx.json({})`);
  assert.match(result.rustSource, /\n\}\n$/);
});

test("rustSource starts with pub fn", () => {
  const result = transpile(`(ctx) => ctx.json({})`);
  assert.match(result.rustSource, /^pub fn handler_/);
});
