import ts from "typescript";
import { HANDLER_PARAM_NAME } from "@fearless/aot-analyzer";
import type { TranspileOptions, TranspileOutcome, TranspileResult, ResponseShape } from "./types.js";
import { extractResponseShape } from "./emit/extract.js";
import { emitResponseBody } from "./emit/rust.js";

export type {
  HttpMethod,
  TranspileOptions,
  TranspileOutcome,
  TranspileResult,
  TranspileError,
  ResponseShape,
  BodyChunk,
  ChunkFormat,
} from "./types.js";

/**
 * Transpile a Phase 0 handler to a Rust function source string.
 *
 * Preconditions:
 *   - `options.handler` has been validated by `analyzeHandler` and returned `compilable: true`.
 *   - `options.method` and `options.path` come from the registration call site.
 *   - `options.id` is a stable identifier used to name the generated Rust fn.
 *
 * Returns:
 *   - `{ success: true, result }` with `rustSource` containing the full `pub fn ...` definition.
 *   - `{ success: false, error }` if a structural mismatch with the analyzer is hit.
 *     The build pipeline should fall back to Bun for that route.
 */
export function transpileHandler(options: TranspileOptions): TranspileOutcome {
  const handler = options.handler;
  const fnName = `handler_${sanitizeId(options.id)}`;

  const blocks = extractReturnBlocks(handler);
  if (blocks.length === 0) {
    return {
      success: false,
      error: {
        kind: "expected-by-analyzer",
        message: "Handler has no recognizable return — analyzer should have caught this.",
      },
    };
  }

  const branches: BranchEmission[] = [];
  for (const block of blocks) {
    const shape = extractResponseShape(block.expression, ts, HANDLER_PARAM_NAME);
    if (shape == null) {
      return {
        success: false,
        error: {
          kind: "unsupported-construct",
          message: `Cannot extract response shape from expression: ${block.expression.getText()}`,
          node: block.expression,
        },
      };
    }
    branches.push({ guard: block.guard, response: shape });
  }

  const body = emitFunctionBody(branches);
  const rustSource = `pub fn ${fnName}(req: &aot_runtime::AotRequest, out: &mut Vec<u8>) {\n${body}\n}\n`;

  const result: TranspileResult = {
    rustSource,
    fnName,
    method: options.method,
    path: options.path,
  };
  return { success: true, result };
}

interface ReturnBlock {
  /** Guard expression that gates this return (null = always taken — concise body or top-level return). */
  readonly guard: GuardExpression | null;
  readonly expression: ts.Expression;
}

type GuardExpression = string; // for now, raw Rust source for the if-condition

interface BranchEmission {
  readonly guard: GuardExpression | null;
  readonly response: ResponseShape;
}

/**
 * Extract every return-statement-or-arrow-body from the handler, in source order.
 * Each comes with an optional guard expression (the if-condition path that leads to it).
 *
 * Phase 0 supports:
 *   - Concise arrow body: one branch, no guard.
 *   - Block body with `if (cond) return X;` chains: emit per-branch with cond as Rust source.
 *   - Block body with single trailing `return X;` and possibly preceded if-returns.
 */
function extractReturnBlocks(handler: ts.ArrowFunction | ts.FunctionExpression): ReturnBlock[] {
  // Concise arrow body
  if (ts.isArrowFunction(handler) && !ts.isBlock(handler.body)) {
    return [{ guard: null, expression: handler.body }];
  }

  if (!ts.isBlock(handler.body)) return [];

  const blocks: ReturnBlock[] = [];
  walkStatements(handler.body.statements, null, blocks);
  return blocks;
}

function walkStatements(
  statements: ReadonlyArray<ts.Statement>,
  guard: GuardExpression | null,
  blocks: ReturnBlock[]
): void {
  for (const stmt of statements) {
    if (ts.isReturnStatement(stmt)) {
      if (stmt.expression == null) continue; // analyzer rejects this; defensive
      blocks.push({ guard, expression: stmt.expression });
      return; // statements after a return are unreachable
    }
    if (ts.isIfStatement(stmt)) {
      const cond = renderConditionAsRust(stmt.expression);
      if (cond == null) continue;
      const combinedGuard = guard != null ? `(${guard}) && (${cond})` : cond;
      walkBranch(stmt.thenStatement, combinedGuard, blocks);
      if (stmt.elseStatement != null) {
        const negated = `!(${cond})`;
        const elseGuard = guard != null ? `(${guard}) && (${negated})` : negated;
        walkBranch(stmt.elseStatement, elseGuard, blocks);
      }
    }
    // Other statement kinds (variable declarations, expression statements) ignored —
    // analyzer should have rejected anything stateful.
  }
}

function walkBranch(stmt: ts.Statement, guard: GuardExpression, blocks: ReturnBlock[]): void {
  if (ts.isBlock(stmt)) {
    walkStatements(stmt.statements, guard, blocks);
    return;
  }
  if (ts.isReturnStatement(stmt)) {
    if (stmt.expression == null) return;
    blocks.push({ guard, expression: stmt.expression });
    return;
  }
  if (ts.isIfStatement(stmt)) {
    const cond = renderConditionAsRust(stmt.expression);
    if (cond == null) return;
    const combinedGuard = `(${guard}) && (${cond})`;
    walkBranch(stmt.thenStatement, combinedGuard, blocks);
    if (stmt.elseStatement != null) {
      const negated = `!(${cond})`;
      const elseGuard = `(${guard}) && (${negated})`;
      walkBranch(stmt.elseStatement, elseGuard, blocks);
    }
  }
}

/**
 * Render a TS conditional expression as Rust source. Phase 0 supports a small
 * subset: `ctx.X === "literal"`, `ctx.X !== "literal"`, equality between
 * ctx-reads and string literals, logical && / ||.
 *
 * Returns null when the condition is too complex — caller drops the branch
 * (transpile fails for the handler, falls back to Bun).
 */
function renderConditionAsRust(expr: ts.Expression): string | null {
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      const left = renderValueAsRust(expr.left);
      const right = renderValueAsRust(expr.right);
      if (left != null && right != null) return `${left} == ${right}`;
    }
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
      const left = renderValueAsRust(expr.left);
      const right = renderValueAsRust(expr.right);
      if (left != null && right != null) return `${left} != ${right}`;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = renderConditionAsRust(expr.left);
      const right = renderConditionAsRust(expr.right);
      if (left != null && right != null) return `(${left}) && (${right})`;
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const left = renderConditionAsRust(expr.left);
      const right = renderConditionAsRust(expr.right);
      if (left != null && right != null) return `(${left}) || (${right})`;
    }
  }
  return null;
}

function renderValueAsRust(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return `"${expr.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  if (ts.isNumericLiteral(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    // ctx.method, ctx.path, ctx.url, ctx.ip
    const target = expr.expression;
    const name = expr.name.text;
    if (ts.isIdentifier(target) && target.text === HANDLER_PARAM_NAME) {
      if (name === "method" || name === "path" || name === "url" || name === "ip") {
        return `req.${name}`;
      }
    }
    // ctx.params.X, ctx.query.X, ctx.headers.X
    if (
      ts.isPropertyAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      target.expression.text === HANDLER_PARAM_NAME
    ) {
      const collection = target.name.text;
      if (collection === "params") return `req.param("${escape(name)}")`;
      if (collection === "query") return `req.query_get("${escape(name)}")`;
      if (collection === "headers") return `req.header("${escape(name.toLowerCase())}")`;
    }
  }
  if (ts.isElementAccessExpression(expr)) {
    const target = expr.expression;
    const arg = expr.argumentExpression;
    if (
      ts.isPropertyAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      target.expression.text === HANDLER_PARAM_NAME &&
      (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
    ) {
      const collection = target.name.text;
      const key = arg.text;
      if (collection === "params") return `req.param("${escape(key)}")`;
      if (collection === "query") return `req.query_get("${escape(key)}")`;
      if (collection === "headers") return `req.header("${escape(key.toLowerCase())}")`;
    }
  }
  return null;
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function emitFunctionBody(branches: BranchEmission[]): string {
  const lines: string[] = [];
  for (const branch of branches) {
    if (branch.guard == null) {
      // Unguarded — emit the body and return
      lines.push(emitResponseBody(branch.response));
      return lines.join("\n");
    }
    lines.push(`    if ${branch.guard} {`);
    // Re-indent the inner body by 4 more spaces
    const inner = emitResponseBody(branch.response).replace(/^( {4})/gm, "        ");
    lines.push(inner);
    lines.push("        return;");
    lines.push("    }");
  }
  // No unguarded branch — emit a default 500 to keep the function total
  lines.push('    out.extend_from_slice(b"HTTP/1.1 500 Internal Server Error\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n");');
  return lines.join("\n");
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}
