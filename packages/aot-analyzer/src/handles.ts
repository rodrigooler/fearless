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
import { parseSqlTemplate } from "./sql-template.js";

export type HandleKind = "sql" | "kv" | "http";

/** A `${...}` substitution inside a sql`...` template literal. */
export interface SqlBindParam {
  /** Source code of the substitution expression (e.g. "ctx.params.id"). */
  readonly expression: string;
  /** Position in the template (0-indexed across all substitutions). */
  readonly index: number;
}

/** A parsed sql`...` template literal. */
export interface SqlTemplate {
  /** SQL text with `${...}` substitutions replaced by `$1, $2, ...` placeholders. */
  readonly sqlText: string;
  /** Bind params in order, matching the `$1, $2, ...` placeholders. */
  readonly params: readonly SqlBindParam[];
  /** Source position of the template literal. */
  readonly start: number;
  readonly end: number;
}

/** A single `await db.queryOne(sql\`...\`)` (or similar) call. */
export interface HandleMethodCall {
  /** Method name on the handle, e.g. "queryOne", "queryMany", "execute". */
  readonly methodName: string;
  /** The sql`...` template passed as the FIRST argument. */
  readonly sqlTemplate: SqlTemplate;
  /** Source position of the entire CallExpression. */
  readonly start: number;
  readonly end: number;
}

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
  /** All method calls on this handle within the analyzed source. */
  readonly methodCalls: readonly HandleMethodCall[];
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
  // Phase 1: collect handle declarations
  const handlesByVar = new Map<string, {
    variableName: string;
    kind: HandleKind;
    registeredName: string;
    start: number;
    end: number;
    methodCalls: HandleMethodCall[];
  }>();

  const visitDeclarations = (node: ts.Node): void => {
    if (typescript.isVariableDeclaration(node) && node.initializer != null) {
      const handle = matchFearlessHandle(node, typescript);
      if (handle != null) {
        handlesByVar.set(handle.variableName, { ...handle, methodCalls: [] });
      }
    }
    node.forEachChild(visitDeclarations);
  };

  visitDeclarations(sourceFile);

  // Phase 2: walk the file finding handle method calls
  const visitCalls = (node: ts.Node): void => {
    if (
      typescript.isCallExpression(node) &&
      typescript.isPropertyAccessExpression(node.expression)
    ) {
      const propAccess = node.expression;
      if (typescript.isIdentifier(propAccess.expression)) {
        const objName = propAccess.expression.text;
        const handle = handlesByVar.get(objName);
        if (handle != null) {
          const firstArg = node.arguments[0];
          if (firstArg != null && typescript.isTaggedTemplateExpression(firstArg)) {
            const template = parseSqlTemplate(firstArg, sourceFile, typescript);
            if (template != null) {
              handle.methodCalls.push({
                methodName: propAccess.name.text,
                sqlTemplate: template,
                start: node.getStart(sourceFile),
                end: node.getEnd(),
              });
            }
          }
        }
      }
    }
    typescript.forEachChild(node, visitCalls);
  };

  visitCalls(sourceFile);

  return [...handlesByVar.values()];
}

function matchFearlessHandle(
  node: ts.VariableDeclaration,
  typescript: typeof ts
): Omit<DiscoveredHandle, "methodCalls"> | null {
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
