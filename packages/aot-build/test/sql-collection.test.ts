import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSql, emitRegistryInitRust } from "../src/sql-collection.js";
import type { DiscoveredRoute } from "../src/index.js";

// Helper: build a minimal aot DiscoveredRoute with async transpile result
function makeAsyncRoute(
  stmts: ReadonlyMap<string, string>,
  registeredHandleNames: ReadonlySet<string>,
): DiscoveredRoute & { kind: "aot" } {
  return {
    kind: "aot",
    method: "GET",
    path: "/test",
    transpile: {
      rustSource: "// stub",
      fnName: "handler_0",
      method: "GET",
      path: "/test",
      kind: "async",
      statements: stmts,
      registeredHandleNames,
    },
  };
}

function makeSyncRoute(): DiscoveredRoute & { kind: "aot" } {
  return {
    kind: "aot",
    method: "GET",
    path: "/sync",
    transpile: {
      rustSource: "// stub",
      fnName: "handler_sync",
      method: "GET",
      path: "/sync",
      kind: "sync",
      statements: new Map(),
      registeredHandleNames: new Set(),
    },
  };
}

// ============================================================================
// collectSql
// ============================================================================

test("collects statements from a single async handler", () => {
  const routes = [
    makeAsyncRoute(new Map([["db_abc12345", "SELECT 1"]]), new Set(["primary"])),
  ];
  const collected = collectSql(routes);
  assert.equal(collected.statements.size, 1);
  assert.equal(collected.statements.get("db_abc12345"), "SELECT 1");
  assert.deepEqual(collected.registeredHandleNames, ["primary"]);
});

test("collects statements from multiple async handlers", () => {
  const routes = [
    makeAsyncRoute(new Map([["db_abc12345", "SELECT 1"]]), new Set(["primary"])),
    makeAsyncRoute(new Map([["db_def67890", "SELECT 2"]]), new Set(["primary"])),
  ];
  const collected = collectSql(routes);
  assert.equal(collected.statements.size, 2);
  assert.deepEqual(collected.registeredHandleNames, ["primary"]);
});

test("dedups identical (key, sql) pairs across handlers", () => {
  const routes = [
    makeAsyncRoute(new Map([["db_abc", "SELECT 1"]]), new Set(["primary"])),
    makeAsyncRoute(new Map([["db_abc", "SELECT 1"]]), new Set(["primary"])),
  ];
  const collected = collectSql(routes);
  assert.equal(collected.statements.size, 1);
});

test("throws on key collision with different SQL", () => {
  const routes = [
    makeAsyncRoute(new Map([["db_abc", "SELECT 1"]]), new Set(["primary"])),
    makeAsyncRoute(new Map([["db_abc", "SELECT 2"]]), new Set(["primary"])),
  ];
  assert.throws(() => collectSql(routes), /collision/);
});

test("ignores sync handlers", () => {
  const routes = [
    makeSyncRoute(),
    makeAsyncRoute(new Map([["db_abc", "SELECT 1"]]), new Set(["primary"])),
  ];
  const collected = collectSql(routes);
  assert.equal(collected.statements.size, 1);
});

test("multiple distinct registeredHandleNames are collected and sorted", () => {
  const routes = [
    makeAsyncRoute(new Map([["primary_abc", "SELECT 1"]]), new Set(["primary"])),
    makeAsyncRoute(new Map([["replica_def", "SELECT 2"]]), new Set(["replica"])),
  ];
  const collected = collectSql(routes);
  assert.deepEqual(collected.registeredHandleNames, ["primary", "replica"]);
});

test("empty input returns empty result", () => {
  const collected = collectSql([]);
  assert.equal(collected.statements.size, 0);
  assert.deepEqual(collected.registeredHandleNames, []);
});

// ============================================================================
// emitRegistryInitRust
// ============================================================================

test("emits valid-looking phf map and register_handles fn", () => {
  const collected = {
    statements: new Map([["db_abc12345", "SELECT id FROM users WHERE id = $1"]]),
    registeredHandleNames: ["primary"],
  };
  const rust = emitRegistryInitRust(collected);
  assert.ok(rust.includes("phf::phf_map!"), "should include phf_map macro");
  assert.ok(rust.includes('"db_abc12345"'), "should include statement key");
  assert.ok(rust.includes("SELECT id FROM users WHERE id = $1"), "should include sql text");
  assert.ok(rust.includes("pub fn register_handles"), "should have register_handles fn");
  assert.ok(rust.includes("registry.register_sql"), "should call register_sql");
  assert.ok(rust.includes('"primary"'), "should reference registered name");
  assert.ok(rust.includes("AUTO-GENERATED"), "should have generation comment");
});

test("registers each distinct handle name once", () => {
  const collected = {
    statements: new Map([
      ["db_abc", "SELECT 1"],
      ["db_def", "SELECT 2"],
    ]),
    registeredHandleNames: ["primary"],
  };
  const rust = emitRegistryInitRust(collected);
  // Only one register_sql call (primary appears once, not twice)
  const matches = rust.match(/register_sql/g) ?? [];
  assert.equal(matches.length, 1);
});

test("emits multiple register_sql calls for multiple handles", () => {
  const collected = {
    statements: new Map([["p_abc", "SELECT 1"], ["r_def", "SELECT 2"]]),
    registeredHandleNames: ["primary", "replica"],
  };
  const rust = emitRegistryInitRust(collected);
  const matches = rust.match(/register_sql/g) ?? [];
  assert.equal(matches.length, 2);
  assert.ok(rust.includes('"primary"'));
  assert.ok(rust.includes('"replica"'));
});

test("returns empty string when no statements collected", () => {
  const rust = emitRegistryInitRust({ statements: new Map(), registeredHandleNames: [] });
  assert.equal(rust, "");
});

test("statement entries are sorted for deterministic output", () => {
  const collected = {
    statements: new Map([
      ["z_last", "SELECT z"],
      ["a_first", "SELECT a"],
    ]),
    registeredHandleNames: ["primary"],
  };
  const rust = emitRegistryInitRust(collected);
  const aIdx = rust.indexOf('"a_first"');
  const zIdx = rust.indexOf('"z_last"');
  assert.ok(aIdx < zIdx, "entries should be sorted alphabetically");
});
