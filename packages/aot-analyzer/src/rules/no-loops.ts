import type { Rule, Reason } from "../types.js";

/**
 * Phase 0 doesn't model loops. Even bounded loops require generating Rust loop
 * constructs with provable termination, plus per-iteration variable lifetime.
 * Block all loop forms; defer to Phase 1+ if a clear iteration pattern (e.g.
 * "iterate ctx.headers entries") becomes a recurring need.
 */
export const noLoopsRule: Rule = ({ handler, typescript }) => {
  const reasons: Reason[] = [];

  const visit = (node: import("typescript").Node): void => {
    if (
      typescript.isForStatement(node) ||
      typescript.isForInStatement(node) ||
      typescript.isForOfStatement(node) ||
      typescript.isWhileStatement(node) ||
      typescript.isDoStatement(node)
    ) {
      reasons.push({
        rule: "no-loops",
        message: "Loops are not AOT-compilable in Phase 0 — handler will fall back to Bun",
        start: node.getStart(),
        end: node.getEnd(),
        hint: "Express the response shape as a literal or via a small number of branches.",
      });
    }
    node.forEachChild(visit);
  };

  visit(handler.body);
  return reasons;
};
