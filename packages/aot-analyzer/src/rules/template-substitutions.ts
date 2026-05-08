import type { Rule, Reason } from "../types.js";
import { ALLOWED_CTX_INPUTS } from "../types.js";

/**
 * Template literals are allowed as response body content, but their `${...}` slots
 * must reference only `ctx.<input>.<key>` (string-shaped reads). Anything else
 * (`${someVar}`, `${ctx.params.id + 1}`, `${doStuff()}`) makes the substitution
 * non-trivial to lower into Rust.
 *
 * For Phase 0, allow:
 *   - `ctx.params.X` / `ctx.query.X` / `ctx.headers.X` (X = identifier or literal string)
 *   - `ctx.method`, `ctx.path`, `ctx.url`, `ctx.ip`
 */
export const templateSubstitutionsRule: Rule = ({ handler, typescript, ctxParamName }) => {
  const reasons: Reason[] = [];

  /**
   * Returns true for `Math.floor(Math.random() * <num>) + <num>` and
   * `Math.floor(Math.random() * <num>)` — Phase 1.2 fastrand bind-param pattern.
   */
  const isMathRandomPattern = (expr: import("typescript").Expression): boolean => {
    // Unwrap optional `+ <numeric literal>` wrapper
    let inner: import("typescript").Expression = expr;
    if (
      typescript.isBinaryExpression(expr) &&
      expr.operatorToken.kind === typescript.SyntaxKind.PlusToken &&
      typescript.isNumericLiteral(expr.right)
    ) {
      inner = expr.left;
    }
    // Must be Math.floor(<call>)
    if (!typescript.isCallExpression(inner)) return false;
    const floorCallee = inner.expression;
    if (
      !typescript.isPropertyAccessExpression(floorCallee) ||
      !typescript.isIdentifier(floorCallee.expression) ||
      floorCallee.expression.text !== "Math" ||
      floorCallee.name.text !== "floor"
    ) return false;
    if (inner.arguments.length !== 1) return false;
    const arg = inner.arguments[0]!;
    // Arg must be `Math.random() * <numeric literal>`
    if (!typescript.isBinaryExpression(arg)) return false;
    if (arg.operatorToken.kind !== typescript.SyntaxKind.AsteriskToken) return false;
    if (!typescript.isNumericLiteral(arg.right)) return false;
    const randCallee = arg.left;
    if (!typescript.isCallExpression(randCallee)) return false;
    const randExpr = randCallee.expression;
    return (
      typescript.isPropertyAccessExpression(randExpr) &&
      typescript.isIdentifier(randExpr.expression) &&
      randExpr.expression.text === "Math" &&
      randExpr.name.text === "random"
    );
  };

  const isAllowedSubstitution = (expr: import("typescript").Expression): boolean => {
    // Math.floor(Math.random() * N) + M — emits fastrand::i32(low..=high) in Rust
    if (isMathRandomPattern(expr)) return true;
    // ctx.X (single hop) — must be a leaf input on Ctx
    if (typescript.isPropertyAccessExpression(expr)) {
      const target = expr.expression;
      const prop = expr.name.text;
      if (typescript.isIdentifier(target) && target.text === ctxParamName) {
        // ctx.method, ctx.path, etc.
        return ALLOWED_CTX_INPUTS.has(prop);
      }
      // ctx.params.X / ctx.query.X / ctx.headers.X
      if (
        typescript.isPropertyAccessExpression(target) &&
        typescript.isIdentifier(target.expression) &&
        target.expression.text === ctxParamName
      ) {
        const collection = target.name.text;
        return collection === "params" || collection === "query" || collection === "headers";
      }
    }
    // ctx.headers["x-trace"] — element access with literal key
    if (typescript.isElementAccessExpression(expr)) {
      const arg = expr.argumentExpression;
      const target = expr.expression;
      const isLiteralKey =
        typescript.isStringLiteral(arg) ||
        typescript.isNoSubstitutionTemplateLiteral(arg);
      if (!isLiteralKey) {
        return false;
      }
      if (
        typescript.isPropertyAccessExpression(target) &&
        typescript.isIdentifier(target.expression) &&
        target.expression.text === ctxParamName
      ) {
        const collection = target.name.text;
        return collection === "params" || collection === "query" || collection === "headers";
      }
    }
    return false;
  };

  const visit = (node: import("typescript").Node): void => {
    if (typescript.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        if (!isAllowedSubstitution(span.expression)) {
          reasons.push({
            rule: "template-substitutions",
            message:
              "Template literal substitution must be `ctx.params.X`, `ctx.query.X`, `ctx.headers.X`, or a Ctx scalar input",
            start: span.expression.getStart(),
            end: span.expression.getEnd(),
            hint: "Either inline the value as a string literal or use one of the allowed Ctx accessors.",
          });
        }
      }
    }
    node.forEachChild(visit);
  };

  visit(handler.body);
  return reasons;
};
