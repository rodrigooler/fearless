import type ts from "typescript";
import type { DiscoveredHandle, HandleMethodCall } from "@fearless/aot-analyzer";
import { makeStatementKey } from "./sql-statement.js";

export interface EmitAsyncHandlerInput {
  readonly handler: ts.ArrowFunction | ts.FunctionExpression;
  readonly source: ts.SourceFile;
  readonly discoveredHandles: readonly DiscoveredHandle[];
  readonly handlerId: string;
  readonly method: string;
  readonly path: string;
  readonly tsApi: typeof ts;
}

export interface EmitAsyncHandlerOutput {
  readonly success: boolean;
  readonly rustSource?: string;
  readonly functionName?: string;
  readonly statements?: ReadonlyMap<string, string>;
  /** The `registeredName` values (e.g. "primary") for all handles used in this handler.
   * Distinct from the statement key prefix (which uses `variableName`). The build pipeline
   * uses these to call `register_handles` with the correct registry key. */
  readonly registeredHandleNames?: ReadonlySet<string>;
  readonly error?: string;
}

/**
 * Emit a Rust async function implementing the handler.
 *
 * Generated function shape:
 *   pub async fn handler_<id>(
 *       ctx: &crate::aot::runtime::AotRequest<'_>,
 *       handles: &crate::aot::handles::HandleRegistry,
 *   ) -> Vec<u8> {
 *       // body
 *   }
 *
 * Phase 1.2 MVP supports EXACTLY this body shape:
 *   const <rowName> = await <handle>.<method>(sql`...`);
 *   if (<rowName> == null) return ctx.notFound();
 *   return ctx.json({ ...row fields });
 *
 * OR the equivalent concise arrow form: `async (ctx) => { ... }` with the same
 * single-await + return pattern.
 *
 * Returns success: false with an error message if the body doesn't match.
 */
export function emitAsyncHandler(input: EmitAsyncHandlerInput): EmitAsyncHandlerOutput {
  const { handler, discoveredHandles, handlerId, tsApi } = input;
  const fnName = `handler_${sanitizeId(handlerId)}`;

  const awaitInfo = findSingleAwait(handler, discoveredHandles, tsApi);
  if (awaitInfo == null) {
    return {
      success: false,
      error: "async handler must have exactly one await on a registered handle",
    };
  }

  const handle = discoveredHandles.find((h) => h.variableName === awaitInfo.handleName);
  if (handle == null) {
    return {
      success: false,
      error: `await target ${awaitInfo.handleName} is not a registered handle`,
    };
  }

  const stmtKey = makeStatementKey(awaitInfo.handleName, awaitInfo.methodCall.sqlTemplate.sqlText);
  const statements = new Map<string, string>([[stmtKey, awaitInfo.methodCall.sqlTemplate.sqlText]]);

  const bodyResult = translateBody(input, handle, awaitInfo, stmtKey);
  if (!bodyResult.success) {
    return { success: false, error: bodyResult.error ?? "async handler body emit failed" };
  }

  const rustSource = `pub async fn ${fnName}(
    ctx: &crate::aot::runtime::AotRequest<'_>,
    handles: &crate::aot::handles::HandleRegistry,
) -> Vec<u8> {
${bodyResult.code}
}
`;

  return {
    success: true,
    rustSource,
    functionName: fnName,
    statements,
    registeredHandleNames: new Set([handle.registeredName]),
  };
}

interface AwaitInfo {
  readonly handleName: string;
  readonly methodCall: HandleMethodCall;
  /** Variable that captures the await result. `null` if the await is the return value. */
  readonly resultBinding: string | null;
  /** True when the await sits inside `return await <call>` or `=> await <call>` — no statements after. */
  readonly isImplicitReturn: boolean;
}

function findSingleAwait(
  handler: ts.ArrowFunction | ts.FunctionExpression,
  handles: readonly DiscoveredHandle[],
  tsApi: typeof ts,
): AwaitInfo | null {
  const handleNames = new Set(handles.map((h) => h.variableName));
  let result: AwaitInfo | null = null;
  let count = 0;

  function visit(node: ts.Node, parent: ts.Node | null): void {
    if (count > 1) return;
    if (tsApi.isAwaitExpression(node)) {
      count += 1;
      const expr = node.expression;
      if (
        tsApi.isCallExpression(expr) &&
        tsApi.isPropertyAccessExpression(expr.expression) &&
        tsApi.isIdentifier(expr.expression.expression)
      ) {
        const handleName = expr.expression.expression.text;
        if (handleNames.has(handleName)) {
          const handle = handles.find((h) => h.variableName === handleName);
          const callStart = expr.getStart();
          const methodCall = handle?.methodCalls.find((mc) => mc.start === callStart);
          if (methodCall != null) {
            // Determine binding shape:
            //   const row = await ...;            → resultBinding = "row", isImplicitReturn = false
            //   return await ...;                 → resultBinding = null, isImplicitReturn = true
            //   async (ctx) => await ...;         → resultBinding = null, isImplicitReturn = true
            let resultBinding: string | null = null;
            let isImplicitReturn = false;
            if (parent != null) {
              if (tsApi.isVariableDeclaration(parent) && tsApi.isIdentifier(parent.name)) {
                resultBinding = parent.name.text;
              } else if (tsApi.isReturnStatement(parent)) {
                isImplicitReturn = true;
              } else if (
                tsApi.isArrowFunction(parent) ||
                tsApi.isFunctionExpression(parent) ||
                tsApi.isParenthesizedExpression(parent)
              ) {
                isImplicitReturn = true;
              }
            }
            result = { handleName, methodCall, resultBinding, isImplicitReturn };
          }
        }
      }
    }
    tsApi.forEachChild(node, (child) => visit(child, node));
  }

  if (handler.body) visit(handler.body, handler);

  if (count !== 1 || result == null) return null;
  return result;
}

interface BodyTranslation {
  readonly success: boolean;
  readonly code?: string;
  readonly error?: string;
}

function translateBody(
  input: EmitAsyncHandlerInput,
  handle: DiscoveredHandle,
  awaitInfo: AwaitInfo,
  stmtKey: string,
): BodyTranslation {
  const lines: string[] = [];

  // ==========================================================================
  // 1. Bind param coercions (one per ${...} substitution in the sql template).
  // ==========================================================================
  const paramExprs = awaitInfo.methodCall.sqlTemplate.params;
  for (let i = 0; i < paramExprs.length; i++) {
    const param = paramExprs[i]!;
    const rustVar = `p${i + 1}`;
    const coercion = translateParamExpression(param.expression, rustVar);
    if (!coercion.success) {
      return { success: false, error: coercion.error ?? "param coercion failed" };
    }
    lines.push("    " + coercion.code);
  }

  // ==========================================================================
  // 2. The handle method call. Resolve handle by registered name in the registry.
  // ==========================================================================
  if (handle.kind !== "sql") {
    return {
      success: false,
      error: `Phase 1.2 MVP supports only SQL handles; got ${handle.kind}`,
    };
  }

  const paramRefs = awaitInfo.methodCall.sqlTemplate.params
    .map((_, i) => `&p${i + 1}`)
    .join(", ");

  const methodMap: Record<string, string> = {
    queryOne: "query_one",
    queryMany: "query_many",
    execute: "execute",
  };
  const rustMethod = methodMap[awaitInfo.methodCall.methodName];
  if (rustMethod == null) {
    return {
      success: false,
      error: `unsupported handle method: ${awaitInfo.methodCall.methodName}`,
    };
  }

  const handleLookup = `handles.sql.get(${rustString(handle.registeredName)}).expect(${rustString(`sql handle ${handle.registeredName} not registered`)})`;

  // The result binding name: "row" for query_one/query_many (when implicit
  // return — no explicit binding), or whatever the user named it.
  const rowName = awaitInfo.resultBinding ?? "row";

  if (rustMethod === "query_one") {
    lines.push(`    let ${rowName} = match ${handleLookup}.query_one(${rustString(stmtKey)}, &[${paramRefs}]).await {`);
    lines.push("        Ok(Some(r)) => r,");
    lines.push("        Ok(None) => return crate::aot::runtime::not_found_response(),");
    lines.push("        Err(_) => return crate::aot::runtime::error_response(503, b\"database error\"),");
    lines.push("    };");
  } else if (rustMethod === "query_many") {
    lines.push(`    let ${rowName} = match ${handleLookup}.query_many(${rustString(stmtKey)}, &[${paramRefs}]).await {`);
    lines.push("        Ok(rows) => rows,");
    lines.push("        Err(_) => return crate::aot::runtime::error_response(503, b\"database error\"),");
    lines.push("    };");
  } else {
    lines.push(`    let ${rowName} = match ${handleLookup}.execute(${rustString(stmtKey)}, &[${paramRefs}]).await {`);
    lines.push("        Ok(n) => n,");
    lines.push("        Err(_) => return crate::aot::runtime::error_response(503, b\"database error\"),");
    lines.push("    };");
  }

  // ==========================================================================
  // 3. Response builder. Phase 1.2 MVP only supports `ctx.json({ k: row.col, ... })`.
  // ==========================================================================
  const responseInfo = findResponseCall(input, rowName);
  if (responseInfo == null) {
    return {
      success: false,
      error: "could not find ctx.json({...}) response builder. Phase 1.2 MVP requires explicit response shape.",
    };
  }

  const cols = parseSelectColumns(awaitInfo.methodCall.sqlTemplate.sqlText);
  if (cols == null) {
    return { success: false, error: "could not parse SELECT columns from SQL text" };
  }
  const colIndex: Record<string, number> = {};
  cols.forEach((c, i) => {
    colIndex[c] = i;
  });

  // Validate every row.<col> in the response object maps to a SELECT column.
  for (const field of responseInfo.fields) {
    if (!(field.colName.toLowerCase() in colIndex)) {
      return {
        success: false,
        error: `column ${field.colName} not found in SELECT (cols: ${cols.join(", ")})`,
      };
    }
  }

  // Emit Rust building the JSON manually, then wrap in HTTP response.
  lines.push("    let mut body = Vec::with_capacity(128);");
  lines.push("    body.push(b'{');");
  for (let i = 0; i < responseInfo.fields.length; i++) {
    const field = responseInfo.fields[i]!;
    const idx = colIndex[field.colName.toLowerCase()]!;
    if (i > 0) lines.push("    body.push(b',');");
    lines.push(`    body.extend_from_slice(${rustByteString(`"${field.jsonName}":`)});`);
    // Phase 1.2 MVP: assume i32 for every column (matches /db scenario).
    lines.push(`    let v${i}: i32 = ${rowName}.get(${idx});`);
    lines.push(`    crate::aot::runtime::write_i32(&mut body, v${i});`);
  }
  lines.push("    body.push(b'}');");
  lines.push("");
  lines.push("    let mut resp = Vec::with_capacity(body.len() + 100);");
  lines.push("    resp.extend_from_slice(b\"HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nServer: F\\r\\nContent-Length: \");");
  lines.push("    crate::aot::runtime::write_usize(&mut resp, body.len());");
  lines.push("    resp.extend_from_slice(b\"\\r\\n\\r\\n\");");
  lines.push("    resp.extend_from_slice(&body);");
  lines.push("    resp");

  return { success: true, code: lines.join("\n") };
}

interface ParamTranslation {
  readonly success: boolean;
  readonly code?: string;
  readonly error?: string;
}

/**
 * Translate a TS bind-param expression source string (e.g. "ctx.params.id")
 * into a Rust statement that binds it to `<rustVar>` as `i32`. Bails on
 * anything outside `ctx.params.X` / `ctx.query.X`.
 */
function translateParamExpression(expr: string, rustVar: string): ParamTranslation {
  const paramMatch = expr.match(/^ctx\.params\.(\w+)$/);
  if (paramMatch != null) {
    const name = paramMatch[1]!;
    return {
      success: true,
      code: `let ${rustVar}: i32 = match ctx.params.get(${rustString(name)}).and_then(|s| s.parse().ok()) { Some(v) => v, None => return crate::aot::runtime::error_response(400, b"invalid param"), };`,
    };
  }
  const queryMatch = expr.match(/^ctx\.query\.(\w+)$/);
  if (queryMatch != null) {
    const name = queryMatch[1]!;
    return {
      success: true,
      code: `let ${rustVar}: i32 = match ctx.query.get(${rustString(name)}).and_then(|s| s.parse().ok()) { Some(v) => v, None => return crate::aot::runtime::error_response(400, b"invalid query param"), };`,
    };
  }
  return {
    success: false,
    error: `unsupported bind param expression: ${expr}. Only ctx.params.X and ctx.query.X are supported in Phase 1.2.`,
  };
}

interface ResponseInfo {
  /** Builder method (only "json" supported in Phase 1.2 MVP). */
  readonly builder: string;
  /** Fields in the response object: `{ jsonName: <rowBinding>.colName }`. */
  readonly fields: readonly { jsonName: string; colName: string }[];
}

/**
 * Find the `ctx.json({...})` call in the handler body. The object literal must
 * map identifier keys → `<rowBinding>.<col>` property accesses; anything else
 * (spread, computed key, expression value) bails out.
 */
function findResponseCall(input: EmitAsyncHandlerInput, rowBinding: string): ResponseInfo | null {
  const { tsApi, handler } = input;
  let result: ResponseInfo | null = null;

  function visit(node: ts.Node): void {
    if (result != null) return;
    if (
      tsApi.isCallExpression(node) &&
      tsApi.isPropertyAccessExpression(node.expression) &&
      tsApi.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ctx" &&
      node.expression.name.text === "json"
    ) {
      const arg = node.arguments[0];
      if (arg != null && tsApi.isObjectLiteralExpression(arg)) {
        const fields: { jsonName: string; colName: string }[] = [];
        let valid = true;
        for (const prop of arg.properties) {
          if (
            tsApi.isPropertyAssignment(prop) &&
            tsApi.isIdentifier(prop.name) &&
            tsApi.isPropertyAccessExpression(prop.initializer) &&
            tsApi.isIdentifier(prop.initializer.expression) &&
            prop.initializer.expression.text === rowBinding &&
            tsApi.isIdentifier(prop.initializer.name)
          ) {
            fields.push({
              jsonName: prop.name.text,
              colName: prop.initializer.name.text,
            });
          } else {
            valid = false;
            break;
          }
        }
        if (valid) {
          result = { builder: "json", fields };
          return;
        }
      }
    }
    tsApi.forEachChild(node, visit);
  }

  if (handler.body) visit(handler.body);
  return result;
}

/**
 * Parse SELECT columns from a SQL string. Returns lowercase column names in
 * the order they appear in the SELECT list. Returns null on parse failure.
 *
 * Phase 1.2: regex-based, handles only the common case
 *   `SELECT a, b, c FROM ...`
 * No subqueries, no aliases (col AS alias), no wildcards.
 */
function parseSelectColumns(sql: string): string[] | null {
  const m = sql.match(/SELECT\s+(.+?)\s+FROM/i);
  if (m == null || m[1] == null) return null;
  return m[1].split(",").map((c) => c.trim().toLowerCase());
}

/**
 * Render a JS string as a Rust string literal: `"foo"` (no escape edge cases
 * for SQL keys / reg names — they're [a-zA-Z0-9_] only).
 */
function rustString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render a JS string as a Rust byte-string literal: `b"foo"`. Escapes `\` and `"`.
 */
function rustByteString(s: string): string {
  return `b"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}
