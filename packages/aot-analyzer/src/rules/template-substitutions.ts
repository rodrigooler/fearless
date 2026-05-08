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

  const isAllowedSubstitution = (expr: import("typescript").Expression): boolean => {
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
