import type { Rule, Reason } from "../types.js";

/**
 * `throw` statements imply error-path control flow that the Phase 0 AOT doesn't model.
 * Phase 1+ can lift `throw HttpError.X(...)` into Rust early-returns, but for now block.
 *
 * Future relaxation: allow `throw HttpError.X(...)` and lift to a Rust match arm.
 */
export const noThrowRule: Rule = ({ handler, typescript }) => {
  const reasons: Reason[] = [];

  const visit = (node: import("typescript").Node): void => {
    if (typescript.isThrowStatement(node)) {
      reasons.push({
        rule: "no-throw",
        message: "`throw` is not AOT-compilable in Phase 0 — handler will fall back to Bun",
        start: node.getStart(),
        end: node.getEnd(),
        hint: "Return an error response directly (e.g. `return ctx.status(404).json({ error: 'not found' })`).",
      });
    }
    node.forEachChild(visit);
  };

  visit(handler.body);
  return reasons;
};
