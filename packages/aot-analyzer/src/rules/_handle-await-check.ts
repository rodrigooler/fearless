/**
 * Shared helper: verify every AwaitExpression in a handler body is a call on a
 * registered framework handle variable (e.g. `await db.queryOne(sql\`...\`)`).
 *
 * Used by both `handler-shape` and `no-await` rules so the logic is DRY.
 */
import type ts from "typescript";
import type { DiscoveredHandle } from "../handles.js";

export interface AwaitCheckResult {
  /** true = all awaits are on registered handles (or there are no awaits at all) */
  readonly ok: boolean;
  /** Source text of the first offending awaited expression (only set when ok=false) */
  readonly offendingExpression?: string;
}

/**
 * Walk `handlerBody` and check every AwaitExpression.
 *
 * An await is allowed iff its expression is `<handleVar>.<method>(...)` where
 * `<handleVar>` is the `.variableName` of one of the `handles` entries.
 *
 * Does NOT recurse into the arguments of an allowed handle call — nested awaits
 * inside handle args are deferred to Phase 1.3+.
 */
export function checkAllAwaitsOnHandles(
  handlerBody: ts.Node,
  handles: readonly DiscoveredHandle[],
  tsApi: typeof ts,
): AwaitCheckResult {
  const handleNames = new Set(handles.map((h) => h.variableName));
  let result: AwaitCheckResult = { ok: true };

  const visit = (node: ts.Node): void => {
    if (!result.ok) return;

    if (tsApi.isAwaitExpression(node)) {
      const expr = node.expression;
      const isHandleCall =
        tsApi.isCallExpression(expr) &&
        tsApi.isPropertyAccessExpression(expr.expression) &&
        tsApi.isIdentifier(expr.expression.expression) &&
        handleNames.has(expr.expression.expression.text);

      if (!isHandleCall) {
        result = { ok: false, offendingExpression: expr.getText() };
      }
      // Don't recurse into an await's sub-expression — we've already classified it
      return;
    }

    tsApi.forEachChild(node, visit);
  };

  visit(handlerBody);
  return result;
}
