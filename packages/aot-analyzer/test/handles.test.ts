import { test } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";
import { discoverHandles } from "../src/handles.js";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("t.ts", source, ts.ScriptTarget.ES2022, true);
}

test("finds queryOne with sql template + bind param", () => {
  const src = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    export const handler = async (ctx: any) =>
      await db.queryOne(sql\`SELECT id FROM users WHERE id = \${ctx.params.id}\`);
  `;
  const handles = discoverHandles(parse(src), ts);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].variableName, "db");
  assert.equal(handles[0].methodCalls.length, 1);
  const call = handles[0].methodCalls[0];
  assert.equal(call.methodName, "queryOne");
  assert.equal(call.sqlTemplate.sqlText, "SELECT id FROM users WHERE id = $1");
  assert.deepEqual(call.sqlTemplate.params, [
    { expression: "ctx.params.id", index: 0 },
  ]);
});

test("ignores method calls with non-sql template tags", () => {
  const src = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    export const handler = async (ctx: any) =>
      await db.queryOne(notSql\`SELECT 1\`);
  `;
  const handles = discoverHandles(parse(src), ts);
  assert.equal(handles[0].methodCalls.length, 0);
});

test("captures multiple bind params in order", () => {
  const src = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    export const handler = async (ctx: any) =>
      await db.queryMany(sql\`SELECT * FROM x WHERE a = \${ctx.params.a} AND b = \${ctx.query.b}\`);
  `;
  const handles = discoverHandles(parse(src), ts);
  const call = handles[0].methodCalls[0];
  assert.equal(call.sqlTemplate.sqlText, "SELECT * FROM x WHERE a = $1 AND b = $2");
  assert.deepEqual(call.sqlTemplate.params, [
    { expression: "ctx.params.a", index: 0 },
    { expression: "ctx.query.b", index: 1 },
  ]);
});

test("template with no substitutions has empty params", () => {
  const src = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    export const handler = async (ctx: any) =>
      await db.queryMany(sql\`SELECT id FROM fortune ORDER BY id\`);
  `;
  const handles = discoverHandles(parse(src), ts);
  assert.equal(handles[0].methodCalls[0].sqlTemplate.sqlText, "SELECT id FROM fortune ORDER BY id");
  assert.equal(handles[0].methodCalls[0].sqlTemplate.params.length, 0);
});

test("handle with no method calls returns empty methodCalls", () => {
  const src = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
  `;
  const handles = discoverHandles(parse(src), ts);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].methodCalls.length, 0);
});

test("multiple handles, multiple method calls each", () => {
  const src = `
    import { fearless } from "fearless";
    const db = fearless.sql("primary");
    const cache = fearless.kv("sessions");
    export const h1 = async (ctx: any) => await db.queryOne(sql\`SELECT 1\`);
    export const h2 = async (ctx: any) => {
      await db.queryMany(sql\`SELECT 2\`);
      await cache.get(\`key\`);
    };
  `;
  const handles = discoverHandles(parse(src), ts);
  assert.equal(handles.length, 2);
  const db = handles.find(h => h.variableName === "db")!;
  assert.equal(db.methodCalls.length, 2);
  const cache = handles.find(h => h.variableName === "cache")!;
  assert.equal(cache.methodCalls.length, 0);
});
