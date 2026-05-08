import type { Rule, Reason } from "../types.js";
import { ALLOWED_CTX_BUILDERS, ALLOWED_CTX_CHAINS } from "../types.js";

/**
 * Every return path must end in a `ctx.<builder>(...)` call (possibly preceded by
 * chainable `ctx.status()` / `ctx.header()` / `ctx.setHeaders()`). Bare returns,
 * `return undefined`, returning random expressions all block AOT.
 *
 * For arrow functions with concise body (`() => ctx.json(...)`), the body itself
 * is the return expression. For block bodies, every reachable `return` must qualify.
 */
export const returnShapeRule: Rule = ({ handler, typescript, ctxParamName }) => {
  const reasons: Reason[] = [];

  const isCtxBuilderCall = (expr: import("typescript").Expression): boolean => {
    if (!typescript.isCallExpression(expr)) {
      return false;
    }
    const callee = expr.expression;
    if (!typescript.isPropertyAccessExpression(callee)) {
      return false;
    }

    // Walk back: the callee is a property access. The chain may be:
    //   ctx.json(...)                       → callee.expression is Identifier "ctx"
    //   ctx.status(N).json(...)             → callee.expression is CallExpression on ctx.status
    //   ctx.status(N).header(K, V).json(...) → nested
    let cursor: import("typescript").Node = callee.expression;
    while (typescript.isCallExpression(cursor) || typescript.isPropertyAccessExpression(cursor)) {
      if (typescript.isCallExpression(cursor)) {
        const inner = cursor.expression;
        if (!typescript.isPropertyAccessExpression(inner)) {
          return false;
        }
        const innerMethod = inner.name.text;
        if (!ALLOWED_CTX_CHAINS.has(innerMethod)) {
          return false;
        }
        cursor = inner.expression;
      } else {
        // PropertyAccessExpression — walk down
        cursor = (cursor as import("typescript").PropertyAccessExpression).expression;
      }
    }
    if (!typescript.isIdentifier(cursor) || cursor.text !== ctxParamName) {
      return false;
    }

    // Terminal method must be a builder
    const methodName = callee.name.text;
    return ALLOWED_CTX_BUILDERS.has(methodName);
  };

  // Concise arrow body: `(ctx) => ctx.json({...})`
  if (
    typescript.isArrowFunction(handler) &&
    !typescript.isBlock(handler.body)
  ) {
    if (!isCtxBuilderCall(handler.body)) {
      reasons.push({
        rule: "return-shape",
        message:
          "Arrow function body must be a `ctx.<builder>(...)` call (json, text, html, raw, redirect, notFound, noContent)",
        start: handler.body.getStart(),
        end: handler.body.getEnd(),
        hint: "Wrap the value: `(ctx) => ctx.json(value)`.",
      });
    }
    return reasons;
  }

  // Block body: every return must end in a ctx builder. Implicit fall-off (no return) is allowed
  // ONLY if every code path explicitly returns — but the simpler rule is "every return statement
  // is a builder call". An implicit no-return = fall-back-to-undefined which doesn't compile.
  let returnCount = 0;
  const visitReturns = (node: import("typescript").Node): void => {
    if (typescript.isReturnStatement(node)) {
      returnCount += 1;
      if (node.expression == null) {
        reasons.push({
          rule: "return-shape",
          message: "`return` without an expression — must be `return ctx.<builder>(...)`",
          start: node.getStart(),
          end: node.getEnd(),
        });
      } else if (!isCtxBuilderCall(node.expression)) {
        reasons.push({
          rule: "return-shape",
          message:
            "Return value must be `ctx.<builder>(...)` (json/text/html/raw/redirect/notFound/noContent)",
          start: node.expression.getStart(),
          end: node.expression.getEnd(),
        });
      }
      // Don't recurse into the return expression — that's handled by other rules
      return;
    }
    // Don't descend into nested function bodies
    if (typescript.isFunctionLike(node) && node !== handler) {
      return;
    }
    node.forEachChild(visitReturns);
  };

  if (typescript.isBlock(handler.body)) {
    visitReturns(handler.body);
    if (returnCount === 0) {
      reasons.push({
        rule: "return-shape",
        message: "Handler body has no `return` statement — Phase 0 requires every path to return a ctx builder",
        start: handler.body.getStart(),
        end: handler.body.getEnd(),
      });
    }
  }

  return reasons;
};
