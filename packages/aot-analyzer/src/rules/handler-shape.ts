import type { Rule, Reason } from "../types.js";
import { HANDLER_PARAM_NAME } from "../types.js";
import { checkAllAwaitsOnHandles } from "./_handle-await-check.js";

/**
 * The handler must be a single arrow function or function expression that takes
 * exactly one parameter named `ctx`. Anything else (multiple params, bare function
 * declarations, references to a function defined elsewhere) cannot be analyzed
 * as a self-contained unit and falls back to Bun.
 *
 * Phase 1.2: `async` handlers are allowed provided every `await` in the body is on
 * a registered framework handle variable (e.g. `await db.queryOne(sql\`...\`)`).
 * Any other await (e.g. `await fetch(...)`) still rejects the handler.
 * `async` without any `await` is permitted — the body is effectively sync.
 */
export const handlerShapeRule: Rule = ({ handler, typescript, discoveredHandles }) => {
  const reasons: Reason[] = [];

  const modifiers = typescript.canHaveModifiers(handler) ? typescript.getModifiers(handler) : undefined;
  const isAsync = modifiers != null && modifiers.some((m) => m.kind === typescript.SyntaxKind.AsyncKeyword);

  if (isAsync && handler.body != null) {
    const check = checkAllAwaitsOnHandles(handler.body, discoveredHandles, typescript);
    if (!check.ok) {
      reasons.push({
        rule: "handler-shape",
        message: `async handler may only \`await\` registered framework handles. Found: \`await ${check.offendingExpression}\``,
        start: handler.getStart(),
        end: handler.getEnd(),
        hint: "Replace with `await <handleVar>.<method>(...)` where `<handleVar>` is `const db = fearless.sql(...)` or similar.",
      });
    }
    // All awaits are on handles (or there are none) — allow async, fall through
  }

  if (handler.parameters.length !== 1) {
    reasons.push({
      rule: "handler-shape",
      message: `Handler must take exactly one parameter (got ${handler.parameters.length})`,
      start: handler.getStart(),
      end: handler.getEnd(),
      hint: `Use the single-argument signature: (ctx) => ...`,
    });
    return reasons;
  }

  const param = handler.parameters[0];
  if (param == null) {
    return reasons; // unreachable due to length check, satisfies noUncheckedIndexedAccess
  }

  if (!typescript.isIdentifier(param.name)) {
    reasons.push({
      rule: "handler-shape",
      message: "Handler parameter must be a plain identifier (no destructuring or rest)",
      start: param.getStart(),
      end: param.getEnd(),
      hint: `Use \`(ctx)\` and access fields via \`ctx.params\`, \`ctx.headers\`, etc.`,
    });
    return reasons;
  }

  if (param.name.text !== HANDLER_PARAM_NAME) {
    reasons.push({
      rule: "handler-shape",
      message: `Handler parameter must be named "${HANDLER_PARAM_NAME}" (got "${param.name.text}")`,
      start: param.getStart(),
      end: param.getEnd(),
      hint: `Rename the parameter to "${HANDLER_PARAM_NAME}".`,
    });
  }

  return reasons;
};
