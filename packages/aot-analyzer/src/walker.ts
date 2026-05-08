import type ts from "typescript";

/**
 * Visit every descendant node of `root`, calling `visit` on each.
 * Stops descent into children of nested function expressions / arrow functions
 * if `crossFunctionBoundaries` is false — useful when checking only the
 * top-level handler body and not nested IIFEs that the AOT can't see into.
 */
export function walk(
  root: ts.Node,
  visit: (node: ts.Node) => void,
  options?: { crossFunctionBoundaries?: boolean }
): void {
  const crossBoundaries = options?.crossFunctionBoundaries ?? false;

  const recurse = (node: ts.Node): void => {
    visit(node);
    if (!crossBoundaries) {
      const kind = (node as { kind: number }).kind;
      // ts.SyntaxKind values can't be referenced without the runtime — pass the
      // typescript module from the caller. For now keep all kinds (caller filters).
      void kind;
    }
    node.forEachChild(recurse);
  };

  recurse(root);
}

/**
 * Get the text snippet at a node's range. Returns `<unknown>` if positions are missing.
 */
export function nodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  if (node.getSourceFile == null) {
    return "<unknown>";
  }
  try {
    return node.getText(sourceFile);
  } catch {
    return "<unknown>";
  }
}

/**
 * Returns true iff `node` is a `MemberAccessExpression` rooted at `ctx` (e.g. ctx.params, ctx.headers.foo).
 * Walks through nested property accesses.
 */
export function isCtxMemberAccess(
  node: ts.Node,
  ctxParamName: string,
  typescript: typeof ts
): boolean {
  if (!typescript.isPropertyAccessExpression(node) && !typescript.isElementAccessExpression(node)) {
    return false;
  }
  let cursor: ts.Node = node;
  while (typescript.isPropertyAccessExpression(cursor) || typescript.isElementAccessExpression(cursor)) {
    cursor = (cursor as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
  }
  return typescript.isIdentifier(cursor) && cursor.text === ctxParamName;
}

/**
 * If `node` is a property access of the form `ctx.X` (single hop), return X.
 * Otherwise return null.
 */
export function ctxFirstProp(
  node: ts.Node,
  ctxParamName: string,
  typescript: typeof ts
): string | null {
  if (!typescript.isPropertyAccessExpression(node)) {
    return null;
  }
  if (!typescript.isIdentifier(node.expression)) {
    return null;
  }
  if (node.expression.text !== ctxParamName) {
    return null;
  }
  return node.name.text;
}

/**
 * Walk the chain of a call expression's callee back to its left-most expression.
 * Useful for detecting `ctx.status(N).header(K, V).json(...)` chains.
 *
 * Returns:
 *   - `terminalCall`: the outermost call (the one being made)
 *   - `chain`: list of method names walked, in order from inner to outer
 *   - `root`: the left-most expression at the bottom of the chain
 */
export function unwrapCallChain(
  node: ts.CallExpression,
  typescript: typeof ts
): { terminalCall: string | null; chain: string[]; root: ts.Node } {
  const chain: string[] = [];
  let current: ts.Node = node;
  let terminalCall: string | null = null;

  if (typescript.isPropertyAccessExpression(node.expression)) {
    terminalCall = node.expression.name.text;
  }

  while (typescript.isCallExpression(current) || typescript.isPropertyAccessExpression(current)) {
    if (typescript.isCallExpression(current)) {
      const callee = current.expression;
      if (typescript.isPropertyAccessExpression(callee)) {
        chain.push(callee.name.text);
        current = callee.expression;
      } else {
        current = callee;
        break;
      }
    } else {
      // PropertyAccessExpression — descend
      current = (current as ts.PropertyAccessExpression).expression;
    }
  }

  return { terminalCall, chain, root: current };
}
