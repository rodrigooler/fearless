import type { Rule, Reason } from "../types.js";

const ALLOWED_GLOBALS = new Set([
  // The handler's bound parameter — name comes from RuleContext but Phase 0 is "ctx".
  "ctx",
  // TypeScript builtins that don't escape to runtime: type-level only.
  "undefined",
  "null",
  "true",
  "false",
  "Infinity",
  "NaN",
]);

/**
 * Phase 0 handlers can only see `ctx`. Any other free identifier (closure capture
 * over module-scope `const db = ...`, references to imported functions, etc.) means
 * the AOT compiler would need to model that identifier's runtime — which it can't.
 *
 * What's allowed inside the handler:
 *   - Locally declared identifiers (within the handler body)
 *   - The `ctx` parameter
 *   - JS literals (`undefined`, `null`, `true`, `false`)
 *
 * What's blocked:
 *   - Captures over enclosing `const` / `let` / `var`
 *   - References to imports, globals like `console`, `parseInt`, `Date`, etc.
 *   - Any identifier not declared inside the handler body
 */
export const noExternalIdentifiersRule: Rule = ({ handler, typescript, ctxParamName }) => {
  const reasons: Reason[] = [];

  // Collect all identifiers declared inside the handler body (let, const, var, function, parameter).
  const localScope = new Set<string>([ctxParamName]);

  const collectLocals = (node: import("typescript").Node): void => {
    if (typescript.isVariableDeclaration(node) && typescript.isIdentifier(node.name)) {
      localScope.add(node.name.text);
    }
    if (typescript.isParameter(node) && typescript.isIdentifier(node.name)) {
      localScope.add(node.name.text);
    }
    if (typescript.isFunctionDeclaration(node) && node.name != null) {
      localScope.add(node.name.text);
    }
    node.forEachChild(collectLocals);
  };
  collectLocals(handler.body);

  // Walk all identifier USES — flag those that aren't declarations and aren't in scope.
  const visit = (node: import("typescript").Node, parent: import("typescript").Node | null): void => {
    if (typescript.isIdentifier(node)) {
      // Skip identifiers that are NAMES in declarations (let foo = ..., function foo(...) {})
      if (parent != null) {
        if (typescript.isVariableDeclaration(parent) && parent.name === node) {
          // declaration name, not a use
        } else if (typescript.isParameter(parent) && parent.name === node) {
          // parameter name
        } else if (typescript.isPropertyAccessExpression(parent) && parent.name === node) {
          // The `bar` in `foo.bar` — not a free identifier
        } else if (
          typescript.isPropertyAssignment(parent) &&
          parent.name === node
        ) {
          // The key in `{ foo: 1 }` — not a free identifier (well, depending on shorthand)
        } else if (typescript.isFunctionDeclaration(parent) && parent.name === node) {
          // function name in declaration
        } else {
          // It's a USE — check scope
          if (!localScope.has(node.text) && !ALLOWED_GLOBALS.has(node.text)) {
            reasons.push({
              rule: "no-external-identifiers",
              message: `Free identifier "${node.text}" is captured from outside the handler — blocks AOT`,
              start: node.getStart(),
              end: node.getEnd(),
              hint: `Either declare "${node.text}" inside the handler, or use a registered framework handle (\`fearless.kv()\` etc) when Phase 2 lands.`,
            });
          }
        }
      }
    }
    node.forEachChild((child) => visit(child, node));
  };
  visit(handler.body, null);

  // Deduplicate by name + position (multiple references to the same external var → one report)
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = `${reason.message}@${reason.start}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};
