import type { Rule, Reason } from "../types.js";
import { checkAllAwaitsOnHandles } from "./_handle-await-check.js";

/**
 * `await` makes a handler asynchronous. The Rust runtime can't AOT-compile arbitrary
 * async work — it would need a Future executor and a way to map awaited values back
 * to typed Rust types. Phase 0 supports only synchronous handlers.
 *
 * Phase 1.2 exception: `await` on a registered framework handle variable
 * (e.g. `await db.queryOne(sql\`...\`)`) is allowed. The Rust transpiler maps these
 * to native async Rust calls. Any other await still rejects.
 */
export const noAwaitRule: Rule = ({ handler, typescript, discoveredHandles }) => {
  const reasons: Reason[] = [];

  const handleNames = new Set(discoveredHandles.map((h) => h.variableName));

  // Quick check first — if all awaits are on handles, no violation
  const check = checkAllAwaitsOnHandles(handler.body, discoveredHandles, typescript);
  if (check.ok) {
    return reasons;
  }

  // Walk to collect ALL offending awaits for full error reporting
  const visit = (node: import("typescript").Node): void => {
    if (typescript.isAwaitExpression(node)) {
      const expr = node.expression;
      const isHandleCall =
        typescript.isCallExpression(expr) &&
        typescript.isPropertyAccessExpression(expr.expression) &&
        typescript.isIdentifier(expr.expression.expression) &&
        handleNames.has(expr.expression.expression.text);

      if (!isHandleCall) {
        reasons.push({
          rule: "no-await",
          message: "`await` blocks AOT compilation — handler will fall back to Bun",
          start: node.getStart(),
          end: node.getEnd(),
          hint: "Use `await <handleVar>.<method>(...)` where `<handleVar>` is a registered fearless handle, or accept Bun-side execution.",
        });
      }
      return; // don't recurse into the await's sub-expression
    }
    node.forEachChild(visit);
  };

  visit(handler.body);
  return reasons;
};
