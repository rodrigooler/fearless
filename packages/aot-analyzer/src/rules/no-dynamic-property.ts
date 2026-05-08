import type { Rule, Reason } from "../types.js";

/**
 * `ctx.headers[someVar]` — bracket access with a non-literal key — can't be resolved
 * to a Rust struct field at compile time. We allow `ctx.headers["x-trace"]` (literal
 * string key, equivalent to dot access) but not `ctx.headers[var]`.
 *
 * Same applies to `ctx.params[var]`, `ctx.query[var]`.
 */
export const noDynamicPropertyRule: Rule = ({ handler, typescript }) => {
  const reasons: Reason[] = [];

  const visit = (node: import("typescript").Node): void => {
    if (typescript.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      const isLiteral =
        typescript.isStringLiteral(arg) ||
        typescript.isNumericLiteral(arg) ||
        typescript.isNoSubstitutionTemplateLiteral(arg);

      if (!isLiteral) {
        reasons.push({
          rule: "no-dynamic-property",
          message: "Dynamic property access (`obj[var]`) blocks AOT — the field name must be known at compile time",
          start: node.getStart(),
          end: node.getEnd(),
          hint: 'Use a literal string key (e.g. `ctx.headers["x-trace"]`) or branch on known property names.',
        });
      }
    }
    node.forEachChild(visit);
  };

  visit(handler.body);
  return reasons;
};
