import type { Rule, Reason } from "../types.js";

/**
 * `await` makes a handler asynchronous. The Rust runtime can't AOT-compile arbitrary
 * async work — it would need a Future executor and a way to map awaited values back
 * to typed Rust types. Phase 0 supports only synchronous handlers.
 */
export const noAwaitRule: Rule = ({ handler, typescript }) => {
  const reasons: Reason[] = [];

  const visit = (node: import("typescript").Node): void => {
    if (typescript.isAwaitExpression(node)) {
      reasons.push({
        rule: "no-await",
        message: "`await` blocks AOT compilation — handler will fall back to Bun",
        start: node.getStart(),
        end: node.getEnd(),
        hint: "Move the awaited work behind a `fearless.kv()` / `fearless.sql()` handle (Phase 2 typed IO) or accept the Bun-side execution.",
      });
    }
    node.forEachChild(visit);
  };

  visit(handler.body);
  return reasons;
};
