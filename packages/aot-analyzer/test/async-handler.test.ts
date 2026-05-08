/**
 * Phase 1.2 tests: async handlers with awaits on registered framework handles.
 *
 * Policy decisions encoded here:
 *  - `async` without any `await` → ALLOWED (body is sync, no behavioral risk)
 *  - `await <handleVar>.<method>(...)` → ALLOWED when handleVar is a registered fearless handle
 *  - Any other `await` → REJECTED even if handler is otherwise valid
 *  - Mixed: one allowed + one disallowed await → REJECTED
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeHandler, formatReport } from "../src/index.js";

// ============================================================================
// Helper
// ============================================================================

/** Wrap a handler expression in a full source file with one SQL handle declared. */
function withSqlHandle(handlerSource: string): string {
  return `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    ${handlerSource}
  `;
}

/** Wrap with both a SQL handle and a KV handle. */
function withTwoHandles(handlerSource: string): string {
  return `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    const cache = fearless.kv("sessions");
    ${handlerSource}
  `;
}

// ============================================================================
// COMPILABLE
// ============================================================================

test("compilable: async handler with single await on registered SQL handle", () => {
  const result = analyzeHandler(withSqlHandle(
    `const handler = async (ctx: any) =>
      await db.queryOne(sql\`SELECT id FROM users WHERE id = \${ctx.params.id}\`);`
  ));
  if (!result.compilable) {
    throw new Error(`Expected compilable, got:\n${formatReport(result)}`);
  }
  assert.equal(result.compilable, true);
});

test("compilable: async modifier without any await (body is effectively sync)", () => {
  // Policy: async-without-await is harmless — permit it
  const result = analyzeHandler(withSqlHandle(
    `const handler = async (ctx: any) => ctx.json({ ok: true });`
  ));
  if (!result.compilable) {
    throw new Error(`Expected compilable, got:\n${formatReport(result)}`);
  }
  assert.equal(result.compilable, true);
});

test("compilable: multiple awaits all on registered handles", () => {
  const result = analyzeHandler(withTwoHandles(
    `const handler = async (ctx: any) => {
      const a = await db.queryOne(sql\`SELECT 1\`);
      const b = await cache.get(\`key\`);
      return ctx.json({ a, b });
    };`
  ));
  if (!result.compilable) {
    throw new Error(`Expected compilable, got:\n${formatReport(result)}`);
  }
  assert.equal(result.compilable, true);
});

test("compilable: async handler with block body and single handle await", () => {
  const result = analyzeHandler(withSqlHandle(
    `const handler = async (ctx: any) => {
      const row = await db.queryOne(sql\`SELECT id, name FROM users WHERE id = \${ctx.params.id}\`);
      return ctx.json(row);
    };`
  ));
  if (!result.compilable) {
    throw new Error(`Expected compilable, got:\n${formatReport(result)}`);
  }
  assert.equal(result.compilable, true);
});

// ============================================================================
// REJECTED
// ============================================================================

test("rejected: async with await on non-handle expression (fetch)", () => {
  const result = analyzeHandler(withSqlHandle(
    `const handler = async (ctx: any) => {
      const x = await fetch("http://example.com");
      return ctx.json({ x });
    };`
  ));
  assert.equal(result.compilable, false);
  if (!result.compilable) {
    const rules = new Set(result.reasons.map((r) => r.rule));
    assert.ok(
      rules.has("handler-shape") || rules.has("no-await"),
      `Expected handler-shape or no-await to fire, got: ${[...rules].join(", ")}`
    );
  }
});

test("rejected: mixed awaits — one on handle, one not", () => {
  const result = analyzeHandler(withSqlHandle(
    `const handler = async (ctx: any) => {
      const cached = await fetch("...");
      const row = await db.queryOne(sql\`SELECT 1\`);
      return ctx.json(row);
    };`
  ));
  assert.equal(result.compilable, false);
  if (!result.compilable) {
    const rules = new Set(result.reasons.map((r) => r.rule));
    assert.ok(
      rules.has("handler-shape") || rules.has("no-await"),
      `Expected handler-shape or no-await to fire, got: ${[...rules].join(", ")}`
    );
  }
});

test("rejected: await on plain function call (not a handle)", () => {
  const result = analyzeHandler(withSqlHandle(
    `const handler = async (ctx: any) => {
      const x = await someFunction();
      return ctx.json({ x });
    };`
  ));
  assert.equal(result.compilable, false);
});

test("rejected: await Promise.all even with handle args", () => {
  const result = analyzeHandler(withSqlHandle(
    `const handler = async (ctx: any) => {
      const [a] = await Promise.all([db.queryOne(sql\`SELECT 1\`)]);
      return ctx.json({ a });
    };`
  ));
  assert.equal(result.compilable, false);
});

// ============================================================================
// BACKWARD COMPAT: sync handlers unchanged
// ============================================================================

test("backward compat: sync handler still compilable", () => {
  const result = analyzeHandler(`(ctx) => ctx.json({ ok: true })`);
  assert.equal(result.compilable, true);
});

test("backward compat: async handler with non-handle await (no handles declared) still rejected", () => {
  // No fearless handle in scope — discoveredHandles=[], so the await is invalid
  const result = analyzeHandler(
    `async (ctx) => { const u = await db.find(ctx.params.id); return ctx.json(u); }`
  );
  assert.equal(result.compilable, false);
  if (!result.compilable) {
    const rules = new Set(result.reasons.map((r) => r.rule));
    assert.ok(
      rules.has("handler-shape") || rules.has("no-await"),
      `Expected handler-shape or no-await to fire, got: ${[...rules].join(", ")}`
    );
  }
});
