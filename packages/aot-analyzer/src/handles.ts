/**
 * Typed framework handle recognition.
 *
 * The user's app declares handles at module scope:
 *   const db = fearless.sql("primary");
 *   const cache = fearless.kv("sessions");
 *   const users = fearless.http("user-service", { baseUrl: "..." });
 *
 * The analyzer recognizes:
 *   1. Handle declarations (so we don't flag them as "external identifiers"
 *      when handlers reference them).
 *   2. Allowed `await db.queryOne(sql\`...\`)` / `cache.get(...)` /
 *      `users.get(...)` patterns inside handlers — these get a green light
 *      under Phase 1, with the transpiler emitting native Rust pool calls.
 *
 * Phase 0 status: this module exports the **detection logic** but the
 * `noAwaitRule` and `noExternalIdentifiersRule` still REJECT these patterns
 * in the default rule set. Phase 1 work flips a feature flag that allows
 * `await <handle>.<method>()` calls. The detection here lays the groundwork
 * so the transpiler knows what to compile.
 */
import type ts from "typescript";

export type HandleKind = "sql" | "kv" | "http";

export interface DiscoveredHandle {
  /** Variable name the user bound the handle to (e.g. "db", "cache"). */
  readonly variableName: string;
  /** Type of handle. */
  readonly kind: HandleKind;
  /** First arg to fearless.<kind>(...) — the registered name (e.g. "primary"). */
  readonly registeredName: string;
  /** Source position of the declaration. */
  readonly start: number;
  readonly end: number;
}

/**
 * Walk a source file and return every fearless.{sql,kv,http}(...) declaration.
 *
 * Looks for the canonical pattern:
 *   const <name> = fearless.<kind>(<arg>, <opts>?);
 *
 * Variations supported:
 *   - `let` / `var` instead of `const`
 *   - Argument can be a string literal, number literal, or template literal
 *   - Second argument (options) is captured but not analyzed yet
 */
export function discoverHandles(
  sourceFile: ts.SourceFile,
  typescript: typeof ts
): DiscoveredHandle[] {
  const out: DiscoveredHandle[] = [];

  const visit = (node: ts.Node): void => {
    if (typescript.isVariableDeclaration(node) && node.initializer != null) {
      const handle = matchFearlessHandle(node, typescript);
      if (handle != null) {
        out.push(handle);
      }
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
  return out;
}

function matchFearlessHandle(
  node: ts.VariableDeclaration,
  typescript: typeof ts
): DiscoveredHandle | null {
  const init = node.initializer;
  if (init == null) return null;

  if (!typescript.isCallExpression(init)) return null;

  const callee = init.expression;
  if (!typescript.isPropertyAccessExpression(callee)) return null;

  if (!typescript.isIdentifier(callee.expression)) return null;
  if (callee.expression.text !== "fearless") return null;

  const methodName = callee.name.text;
  if (methodName !== "sql" && methodName !== "kv" && methodName !== "http") return null;

  if (!typescript.isIdentifier(node.name)) return null;

  const firstArg = init.arguments[0];
  if (firstArg == null) return null;

  let registeredName: string;
  if (typescript.isStringLiteral(firstArg) || typescript.isNoSubstitutionTemplateLiteral(firstArg)) {
    registeredName = firstArg.text;
  } else {
    return null; // Phase 1: literal-only registration names
  }

  return {
    variableName: node.name.text,
    kind: methodName,
    registeredName,
    start: node.getStart(),
    end: node.getEnd(),
  };
}
