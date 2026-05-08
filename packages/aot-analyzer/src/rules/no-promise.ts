import type { Rule, Reason } from "../types.js";

/**
 * Bare Promise references (`Promise.resolve`, `.then(...)` chains, `new Promise(...)`)
 * are equivalent to async work — the Rust runtime has no Promise type. Block.
 *
 * NOTE: this is a syntactic check; we look for the identifier `Promise` and `.then` /
 * `.catch` / `.finally` method names. False positives possible if a user has a custom
 * `Promise`-named local — Phase 0 trades that off for simplicity.
 */
export const noPromiseRule: Rule = ({ handler, typescript }) => {
  const reasons: Reason[] = [];

  const visit = (node: import("typescript").Node): void => {
    // `Promise.resolve(...)`, `Promise.reject(...)`, etc.
    if (typescript.isIdentifier(node) && node.text === "Promise") {
      reasons.push({
        rule: "no-promise",
        message: "Promise references are not AOT-compilable — handler will fall back to Bun",
        start: node.getStart(),
        end: node.getEnd(),
      });
    }
    // `.then(...)` / `.catch(...)` / `.finally(...)` calls
    if (typescript.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === "then" || name === "catch" || name === "finally") {
        reasons.push({
          rule: "no-promise",
          message: `Promise method "${name}" is not AOT-compilable — handler will fall back to Bun`,
          start: node.name.getStart(),
          end: node.name.getEnd(),
          hint: "Replace promise-chained logic with synchronous control flow.",
        });
      }
    }
    node.forEachChild(visit);
  };

  visit(handler.body);
  return reasons;
};
