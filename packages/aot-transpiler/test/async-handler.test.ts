/**
 * Phase 1.2 Task 4 tests: async handler emission.
 *
 * Covers the supported MVP shape (`const row = await db.queryOne(sql\`...\`);
 * if (row == null) return ctx.notFound(); return ctx.json({ ... });`) and key
 * rejection cases (multiple awaits, unsupported bind params).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { discoverHandles } from "@fearless/aot-analyzer";
import { transpileHandler } from "../src/index.js";

interface Setup {
  readonly source: ts.SourceFile;
  readonly handler: ts.ArrowFunction | ts.FunctionExpression;
  readonly handles: ReturnType<typeof discoverHandles>;
}

function setup(source: string): Setup {
  const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const handles = discoverHandles(sf, ts);
  let handler: ts.ArrowFunction | ts.FunctionExpression | undefined;
  function visit(node: ts.Node): void {
    if (handler != null) return;
    if (ts.isVariableStatement(node)) {
      const decl = node.declarationList.declarations[0];
      if (decl?.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
        handler = decl.initializer;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (handler == null) throw new Error("no handler arrow function found");
  return { source: sf, handler, handles };
}

// ============================================================================
// Success: classic /db handler shape
// ============================================================================

test("emits async fn for /db handler", () => {
  const source = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    const handler = async (ctx: any) => {
      const row = await db.queryOne(sql\`SELECT id, randomnumber FROM world WHERE id = \${ctx.params.id}\`);
      if (row == null) return ctx.notFound();
      return ctx.json({ id: row.id, randomNumber: row.randomnumber });
    };
  `;
  const { source: sf, handler, handles } = setup(source);
  const result = transpileHandler({
    handler,
    source: sf,
    discoveredHandles: handles,
    id: "db",
    method: "GET",
    path: "/db",
  });
  assert.equal(result.success, true, "expected transpile success");
  if (!result.success) return;
  assert.equal(result.result.kind, "async");
  assert.match(result.result.rustSource, /pub async fn handler_db/);
  assert.match(result.result.rustSource, /\.query_one\(/);
  assert.match(result.result.rustSource, /\.await/);
  assert.match(result.result.rustSource, /handles\.sql\.get\("primary"\)/);
  assert.equal(result.result.statements.size, 1);
  const [stmtKey, stmtSql] = [...result.result.statements.entries()][0];
  assert.match(stmtKey, /^db_[a-f0-9]{8}$/);
  assert.equal(stmtSql, "SELECT id, randomnumber FROM world WHERE id = $1");
  // Response builder emits both row column reads at the right indices.
  assert.match(result.result.rustSource, /row\.get\(0\)/);
  assert.match(result.result.rustSource, /row\.get\(1\)/);
  // JSON keys are emitted inside Rust byte-string literals — quotes are escaped.
  assert.match(result.result.rustSource, /\\"id\\":/);
  assert.match(result.result.rustSource, /\\"randomNumber\\":/);
});

// ============================================================================
// Rejection: multiple awaits — Phase 1.2 MVP supports exactly one
// ============================================================================

test("rejects handlers with multiple awaits (Phase 1.2 MVP limitation)", () => {
  const source = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    const handler = async (ctx: any) => {
      const a = await db.queryOne(sql\`SELECT 1\`);
      const b = await db.queryOne(sql\`SELECT 2\`);
      return ctx.json({ a, b });
    };
  `;
  const { source: sf, handler, handles } = setup(source);
  const result = transpileHandler({
    handler,
    source: sf,
    discoveredHandles: handles,
    id: "x",
    method: "GET",
    path: "/x",
  });
  assert.equal(result.success, false);
});

// ============================================================================
// Rejection: bind param expression outside ctx.params.X / ctx.query.X
// ============================================================================

test("rejects unsupported bind param expression", () => {
  const source = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    const someOtherVar = 42;
    const handler = async (ctx: any) => {
      const row = await db.queryOne(sql\`SELECT 1 WHERE x = \${someOtherVar}\`);
      return ctx.json({ x: row.x });
    };
  `;
  const { source: sf, handler, handles } = setup(source);
  const result = transpileHandler({
    handler,
    source: sf,
    discoveredHandles: handles,
    id: "x",
    method: "GET",
    path: "/x",
  });
  assert.equal(result.success, false);
});

// ============================================================================
// Stability: same SQL → same statement key, regardless of route id
// ============================================================================

test("statement key is stable across calls", () => {
  const source = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    const handler = async (ctx: any) => {
      const row = await db.queryOne(sql\`SELECT id FROM world WHERE id = \${ctx.params.id}\`);
      if (row == null) return ctx.notFound();
      return ctx.json({ id: row.id });
    };
  `;
  const { source: sf, handler, handles } = setup(source);
  const r1 = transpileHandler({
    handler,
    source: sf,
    discoveredHandles: handles,
    id: "a",
    method: "GET",
    path: "/a",
  });
  const r2 = transpileHandler({
    handler,
    source: sf,
    discoveredHandles: handles,
    id: "b",
    method: "GET",
    path: "/b",
  });
  assert.equal(r1.success && r2.success, true);
  if (r1.success && r2.success) {
    const k1 = [...r1.result.statements.keys()][0];
    const k2 = [...r2.result.statements.keys()][0];
    assert.equal(k1, k2);
  }
});

// ============================================================================
// Backward compat: sync handlers still produce kind: "sync" with empty statements
// ============================================================================

test("sync handler still works and reports kind: sync", () => {
  const source = `const handler = (ctx: any) => ctx.json({ ok: true });`;
  const { source: sf, handler } = setup(source);
  const result = transpileHandler({
    handler,
    source: sf,
    id: "sync",
    method: "GET",
    path: "/sync",
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.result.kind, "sync");
  assert.equal(result.result.statements.size, 0);
});
