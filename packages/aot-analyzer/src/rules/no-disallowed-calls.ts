import type { Rule, Reason } from "../types.js";
import { ALLOWED_CTX_BUILDERS, ALLOWED_CTX_CHAINS } from "../types.js";

/**
 * Phase 0 only knows how to compile calls of the form:
 *   - `ctx.<builder>(...)` where builder ∈ json/text/html/raw/redirect/notFound/noContent
 *   - `ctx.<chain>(...)` where chain ∈ status/header/setHeaders (used inline before a builder)
 *
 * Phase 1.2 exception: calls of the form `<handleVar>.<method>(...)` where `<handleVar>`
 * is a registered framework handle are allowed. These map to native Rust async operations.
 *
 * Any other call expression — `console.log()`, `parseInt()`, `JSON.stringify()`,
 * a user-defined function, etc. — falls back to Bun.
 *
 * String method calls (`"abc".toUpperCase()`) are also blocked because they require
 * a Rust runtime model of String methods. Phase 1+ may unblock specific ones.
 */
export const noDisallowedCallsRule: Rule = ({ handler, typescript, ctxParamName, discoveredHandles }) => {
  const reasons: Reason[] = [];

  const handleNames = new Set(discoveredHandles.map((h) => h.variableName));

  const visit = (node: import("typescript").Node): void => {
    if (typescript.isCallExpression(node)) {
      const callee = node.expression;
      // Allow ctx.<allowed>() — direct call on ctx
      if (
        typescript.isPropertyAccessExpression(callee) &&
        typescript.isIdentifier(callee.expression) &&
        callee.expression.text === ctxParamName
      ) {
        const methodName = callee.name.text;
        if (
          !ALLOWED_CTX_BUILDERS.has(methodName) &&
          !ALLOWED_CTX_CHAINS.has(methodName)
        ) {
          reasons.push({
            rule: "no-disallowed-calls",
            message: `\`ctx.${methodName}(...)\` is not in the AOT-allowed Ctx surface`,
            start: callee.getStart(),
            end: callee.getEnd(),
            hint: `Use one of: ${[...ALLOWED_CTX_BUILDERS, ...ALLOWED_CTX_CHAINS].sort().join(", ")}.`,
          });
        }
        // Recurse into arguments
        node.arguments.forEach((arg) => visit(arg));
        return;
      }

      // Allow chained calls: ctx.status(...).header(...).json(...)
      // We detect this by walking the callee chain back to a ctx root.
      if (typescript.isPropertyAccessExpression(callee)) {
        let cursor: import("typescript").Node = callee.expression;
        while (typescript.isCallExpression(cursor)) {
          const inner = cursor.expression;
          if (typescript.isPropertyAccessExpression(inner)) {
            const innerMethod = inner.name.text;
            if (
              !ALLOWED_CTX_BUILDERS.has(innerMethod) &&
              !ALLOWED_CTX_CHAINS.has(innerMethod)
            ) {
              break; // not a recognized ctx chain — fall through to error path below
            }
            cursor = inner.expression;
          } else {
            break;
          }
        }
        if (typescript.isIdentifier(cursor) && cursor.text === ctxParamName) {
          // Validate the terminal method too
          const methodName = callee.name.text;
          if (
            !ALLOWED_CTX_BUILDERS.has(methodName) &&
            !ALLOWED_CTX_CHAINS.has(methodName)
          ) {
            reasons.push({
              rule: "no-disallowed-calls",
              message: `\`ctx.${methodName}(...)\` is not in the AOT-allowed Ctx surface`,
              start: callee.getStart(),
              end: callee.getEnd(),
            });
          }
          node.arguments.forEach((arg) => visit(arg));
          return;
        }

        // Allow <handleVar>.<method>(...) — calls on registered framework handles
        if (
          typescript.isIdentifier(callee.expression) &&
          handleNames.has(callee.expression.text)
        ) {
          // Recurse into arguments (e.g. the sql`...` template arg)
          node.arguments.forEach((arg) => visit(arg));
          return;
        }
      }

      // Anything else: not a ctx call and not a handle call — block.
      const text = callee.getText(callee.getSourceFile());
      reasons.push({
        rule: "no-disallowed-calls",
        message: `Call to \`${text}(...)\` is not AOT-compilable — only \`ctx.<builder>()\` and \`ctx.<chain>()\` are allowed`,
        start: callee.getStart(),
        end: callee.getEnd(),
        hint: "Inline the value as a literal or move the work to Bun.",
      });
      node.arguments.forEach((arg) => visit(arg));
      return;
    }
    node.forEachChild(visit);
  };

  visit(handler.body);
  return reasons;
};
