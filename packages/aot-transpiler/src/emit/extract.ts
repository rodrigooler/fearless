import type ts from "typescript";
import type { BodyChunk, DynamicResponse, ResponseShape, StaticResponse } from "../types.js";

/**
 * Extract a ResponseShape from an arrow body or return-statement expression.
 * The expression must be a recognized `ctx.<builder>(...)` chain.
 *
 * Returns `null` if the expression isn't a recognized shape. The caller treats
 * that as an analyzer-vs-transpiler mismatch (the analyzer should have caught
 * it) and falls back to Bun for safety.
 */
export function extractResponseShape(
  expr: ts.Expression,
  typescript: typeof ts,
  ctxParamName: string
): ResponseShape | null {
  const chain = unwrapCtxChain(expr, typescript, ctxParamName);
  if (chain == null) {
    return null;
  }

  const { terminalMethod, terminalArgs, status, contentTypeOverride } = chain;

  switch (terminalMethod) {
    case "json":
      return buildJsonResponse(terminalArgs, status ?? 200, contentTypeOverride, typescript, ctxParamName);
    case "text":
      return buildTextResponse(terminalArgs, status ?? 200, contentTypeOverride, typescript, ctxParamName);
    case "html":
      return buildHtmlResponse(terminalArgs, status ?? 200, contentTypeOverride, typescript, ctxParamName);
    case "noContent":
      return staticBody(status ?? 204, "text/plain", new Uint8Array());
    case "notFound":
      return buildNotFoundResponse(terminalArgs, status ?? 404, typescript, ctxParamName);
    case "redirect":
      return buildRedirectResponse(terminalArgs, status ?? 302, typescript, ctxParamName);
    case "raw":
      // raw() can't be statically analyzed in Phase 0 — different shapes per call.
      return null;
    default:
      return null;
  }
}

/**
 * Unwrap a `ctx.[chain].[chain].terminal(args)` expression. Returns the terminal
 * method name + its args, plus any chained status/header values that came before.
 */
interface UnwrappedChain {
  readonly terminalMethod: string;
  readonly terminalArgs: ReadonlyArray<ts.Expression>;
  readonly status: number | null;
  readonly contentTypeOverride: string | null;
  readonly headerOverrides: ReadonlyMap<string, string>;
}

function unwrapCtxChain(
  expr: ts.Expression,
  typescript: typeof ts,
  ctxParamName: string
): UnwrappedChain | null {
  if (!typescript.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (!typescript.isPropertyAccessExpression(callee)) return null;

  const terminalMethod = callee.name.text;
  const terminalArgs = expr.arguments.slice() as readonly ts.Expression[];

  let status: number | null = null;
  let contentTypeOverride: string | null = null;
  const headerOverrides = new Map<string, string>();

  let cursor: ts.Node = callee.expression;
  while (typescript.isCallExpression(cursor)) {
    const inner = cursor.expression;
    if (!typescript.isPropertyAccessExpression(inner)) return null;

    const methodName = inner.name.text;
    if (methodName === "status") {
      const arg = cursor.arguments[0];
      if (arg != null && typescript.isNumericLiteral(arg)) {
        status = parseInt(arg.text, 10);
      } else {
        return null; // dynamic status not supported in Phase 0
      }
    } else if (methodName === "header") {
      const keyArg = cursor.arguments[0];
      const valueArg = cursor.arguments[1];
      if (keyArg != null && typescript.isStringLiteral(keyArg) && valueArg != null && typescript.isStringLiteral(valueArg)) {
        const key = keyArg.text.toLowerCase();
        if (key === "content-type") {
          contentTypeOverride = valueArg.text;
        } else {
          headerOverrides.set(key, valueArg.text);
        }
      } else {
        return null; // dynamic header values not supported in Phase 0
      }
    } else if (methodName === "setHeaders") {
      const arg = cursor.arguments[0];
      if (arg != null && typescript.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (
            typescript.isPropertyAssignment(prop) &&
            typescript.isStringLiteral(prop.initializer)
          ) {
            const key = (typescript.isStringLiteral(prop.name) ? prop.name.text : prop.name.getText()).toLowerCase();
            if (key === "content-type") {
              contentTypeOverride = prop.initializer.text;
            } else {
              headerOverrides.set(key, prop.initializer.text);
            }
          }
        }
      } else {
        return null;
      }
    } else {
      // Unknown chain method
      return null;
    }
    cursor = inner.expression;
  }

  if (!typescript.isIdentifier(cursor) || cursor.text !== ctxParamName) {
    return null;
  }

  return {
    terminalMethod,
    terminalArgs,
    status,
    contentTypeOverride,
    headerOverrides,
  };
}

function staticBody(status: number, contentType: string, bodyBytes: Uint8Array): StaticResponse {
  return { kind: "static", status, contentType, bodyBytes };
}

function buildJsonResponse(
  args: ReadonlyArray<ts.Expression>,
  status: number,
  contentTypeOverride: string | null,
  typescript: typeof ts,
  ctxParamName: string
): ResponseShape | null {
  const ct = contentTypeOverride ?? "application/json";
  const arg = args[0];
  if (arg == null) {
    // ctx.json() with no body — encode as empty object
    return staticBody(status, ct, new TextEncoder().encode("{}"));
  }
  // Try to render as static JSON literal
  const staticText = renderJsonLiteral(arg, typescript, ctxParamName);
  if (staticText != null) {
    return staticBody(status, ct, new TextEncoder().encode(staticText));
  }
  // Fall back to dynamic chunks
  const chunks = renderJsonChunks(arg, typescript, ctxParamName);
  if (chunks == null) return null;
  return { kind: "dynamic", status, contentType: ct, bodyChunks: chunks };
}

function buildTextResponse(
  args: ReadonlyArray<ts.Expression>,
  status: number,
  contentTypeOverride: string | null,
  typescript: typeof ts,
  ctxParamName: string
): ResponseShape | null {
  const ct = contentTypeOverride ?? "text/plain; charset=utf-8";
  const arg = args[0];
  if (arg == null) return staticBody(status, ct, new Uint8Array());

  if (typescript.isStringLiteral(arg) || typescript.isNoSubstitutionTemplateLiteral(arg)) {
    return staticBody(status, ct, new TextEncoder().encode(arg.text));
  }
  if (typescript.isTemplateExpression(arg)) {
    const chunks = renderTemplateChunks(arg, typescript, ctxParamName, "raw");
    if (chunks == null) return null;
    return { kind: "dynamic", status, contentType: ct, bodyChunks: chunks };
  }
  return null;
}

function buildHtmlResponse(
  args: ReadonlyArray<ts.Expression>,
  status: number,
  contentTypeOverride: string | null,
  typescript: typeof ts,
  ctxParamName: string
): ResponseShape | null {
  const ct = contentTypeOverride ?? "text/html; charset=utf-8";
  return buildTextResponse(args, status, ct, typescript, ctxParamName);
}

function buildNotFoundResponse(
  args: ReadonlyArray<ts.Expression>,
  status: number,
  typescript: typeof ts,
  ctxParamName: string
): ResponseShape | null {
  const ct = "text/plain; charset=utf-8";
  const arg = args[0];
  if (arg == null) return staticBody(status, ct, new TextEncoder().encode("Not Found"));
  return buildTextResponse(args, status, ct, typescript, ctxParamName);
}

function buildRedirectResponse(
  args: ReadonlyArray<ts.Expression>,
  status: number,
  typescript: typeof ts,
  _ctxParamName: string
): ResponseShape | null {
  const arg = args[0];
  if (arg == null) return null;
  // The second argument to ctx.redirect() is the status code (301 | 302 | 303 | 307 | 308).
  // It overrides any status from a chained ctx.status(N) (which is unusual for redirects).
  const statusArg = args[1];
  let resolvedStatus = status;
  if (statusArg != null && typescript.isNumericLiteral(statusArg)) {
    resolvedStatus = parseInt(statusArg.text, 10);
  }
  if (typescript.isStringLiteral(arg) || typescript.isNoSubstitutionTemplateLiteral(arg)) {
    // Redirect renders as a status + Location header response with empty body.
    // We piggyback on the static-response path by encoding the location in
    // contentType — emitResponseBody recognizes the "redirect:" prefix.
    return staticBody(resolvedStatus, "redirect:" + arg.text, new Uint8Array());
  }
  return null;
}

// ----------------------------------------------------------------------------
// JSON literal rendering — when the expression is fully static, returns string.
// ----------------------------------------------------------------------------

function renderJsonLiteral(
  node: ts.Expression,
  typescript: typeof ts,
  ctxParamName: string
): string | null {
  if (typescript.isStringLiteral(node) || typescript.isNoSubstitutionTemplateLiteral(node)) {
    return JSON.stringify(node.text);
  }
  if (typescript.isNumericLiteral(node)) {
    return node.text;
  }
  if (node.kind === typescript.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === typescript.SyntaxKind.FalseKeyword) return "false";
  if (node.kind === typescript.SyntaxKind.NullKeyword) return "null";
  if (typescript.isPrefixUnaryExpression(node) && node.operator === typescript.SyntaxKind.MinusToken) {
    if (typescript.isNumericLiteral(node.operand)) {
      return "-" + node.operand.text;
    }
  }
  if (typescript.isObjectLiteralExpression(node)) {
    const entries: string[] = [];
    for (const prop of node.properties) {
      if (!typescript.isPropertyAssignment(prop)) return null;
      const key = propertyKeyText(prop.name, typescript);
      if (key == null) return null;
      const value = renderJsonLiteral(prop.initializer, typescript, ctxParamName);
      if (value == null) return null;
      entries.push(JSON.stringify(key) + ":" + value);
    }
    return "{" + entries.join(",") + "}";
  }
  if (typescript.isArrayLiteralExpression(node)) {
    const entries: string[] = [];
    for (const el of node.elements) {
      const value = renderJsonLiteral(el, typescript, ctxParamName);
      if (value == null) return null;
      entries.push(value);
    }
    return "[" + entries.join(",") + "]";
  }
  // Anything dynamic (ctx.params.X, template literals with substitutions) → fall through
  return null;
}

function propertyKeyText(name: ts.PropertyName, typescript: typeof ts): string | null {
  if (typescript.isIdentifier(name)) return name.text;
  if (typescript.isStringLiteral(name)) return name.text;
  if (typescript.isNumericLiteral(name)) return name.text;
  return null;
}

// ----------------------------------------------------------------------------
// Dynamic JSON chunk rendering — when the expression has runtime substitutions.
// ----------------------------------------------------------------------------

function renderJsonChunks(
  node: ts.Expression,
  typescript: typeof ts,
  ctxParamName: string
): BodyChunk[] | null {
  const chunks: BodyChunk[] = [];
  if (renderJsonValue(node, chunks, typescript, ctxParamName)) {
    return chunks;
  }
  return null;
}

function renderJsonValue(
  node: ts.Expression,
  out: BodyChunk[],
  typescript: typeof ts,
  ctxParamName: string
): boolean {
  // Static fragment → emit as literal chunk
  const staticText = renderJsonLiteral(node, typescript, ctxParamName);
  if (staticText != null) {
    out.push({ kind: "literal", bytes: new TextEncoder().encode(staticText) });
    return true;
  }
  // ctx.params.X / ctx.query.X / ctx.headers.X — emit as JSON-string chunk
  const ctxRead = matchCtxRead(node, typescript, ctxParamName);
  if (ctxRead != null) {
    out.push({ kind: "literal", bytes: new TextEncoder().encode("\"") });
    out.push({ kind: ctxRead.kind, name: ctxRead.name, format: "json-string" } as BodyChunk);
    out.push({ kind: "literal", bytes: new TextEncoder().encode("\"") });
    return true;
  }
  // Template literal with substitutions
  if (typescript.isTemplateExpression(node)) {
    out.push({ kind: "literal", bytes: new TextEncoder().encode("\"") });
    const inner = renderTemplateChunks(node, typescript, ctxParamName, "json-string");
    if (inner == null) return false;
    for (const chunk of inner) out.push(chunk);
    out.push({ kind: "literal", bytes: new TextEncoder().encode("\"") });
    return true;
  }
  // Object literal with mixed static/dynamic values
  if (typescript.isObjectLiteralExpression(node)) {
    out.push({ kind: "literal", bytes: new TextEncoder().encode("{") });
    let first = true;
    for (const prop of node.properties) {
      if (!typescript.isPropertyAssignment(prop)) return false;
      const key = propertyKeyText(prop.name, typescript);
      if (key == null) return false;
      if (!first) out.push({ kind: "literal", bytes: new TextEncoder().encode(",") });
      out.push({ kind: "literal", bytes: new TextEncoder().encode(JSON.stringify(key) + ":") });
      if (!renderJsonValue(prop.initializer, out, typescript, ctxParamName)) return false;
      first = false;
    }
    out.push({ kind: "literal", bytes: new TextEncoder().encode("}") });
    return true;
  }
  // Array literal with mixed values
  if (typescript.isArrayLiteralExpression(node)) {
    out.push({ kind: "literal", bytes: new TextEncoder().encode("[") });
    let first = true;
    for (const el of node.elements) {
      if (!first) out.push({ kind: "literal", bytes: new TextEncoder().encode(",") });
      if (!renderJsonValue(el, out, typescript, ctxParamName)) return false;
      first = false;
    }
    out.push({ kind: "literal", bytes: new TextEncoder().encode("]") });
    return true;
  }
  return false;
}

interface CtxRead {
  readonly kind: "param" | "query" | "header" | "input";
  readonly name: string;
}

function matchCtxRead(
  node: ts.Expression,
  typescript: typeof ts,
  ctxParamName: string
): CtxRead | null {
  // ctx.method, ctx.path, ctx.url, ctx.ip — scalar inputs
  if (typescript.isPropertyAccessExpression(node)) {
    const target = node.expression;
    const name = node.name.text;
    if (typescript.isIdentifier(target) && target.text === ctxParamName) {
      if (name === "method" || name === "path" || name === "url" || name === "ip") {
        return { kind: "input", name };
      }
    }
    // ctx.params.X, ctx.query.X, ctx.headers.X
    if (
      typescript.isPropertyAccessExpression(target) &&
      typescript.isIdentifier(target.expression) &&
      target.expression.text === ctxParamName
    ) {
      const collection = target.name.text;
      if (collection === "params") return { kind: "param", name };
      if (collection === "query") return { kind: "query", name };
      if (collection === "headers") return { kind: "header", name: name.toLowerCase() };
    }
  }
  // ctx.headers["x-trace"] — element access with literal key
  if (typescript.isElementAccessExpression(node)) {
    const target = node.expression;
    const arg = node.argumentExpression;
    if (
      typescript.isPropertyAccessExpression(target) &&
      typescript.isIdentifier(target.expression) &&
      target.expression.text === ctxParamName &&
      (typescript.isStringLiteral(arg) || typescript.isNoSubstitutionTemplateLiteral(arg))
    ) {
      const collection = target.name.text;
      const key = arg.text;
      if (collection === "params") return { kind: "param", name: key };
      if (collection === "query") return { kind: "query", name: key };
      if (collection === "headers") return { kind: "header", name: key.toLowerCase() };
    }
  }
  return null;
}

function renderTemplateChunks(
  node: ts.TemplateExpression,
  typescript: typeof ts,
  ctxParamName: string,
  format: "raw" | "json-string"
): BodyChunk[] | null {
  const out: BodyChunk[] = [];
  if (node.head.text.length > 0) {
    out.push({ kind: "literal", bytes: encodeTemplateText(node.head.text, format) });
  }
  for (const span of node.templateSpans) {
    const ctxRead = matchCtxRead(span.expression, typescript, ctxParamName);
    if (ctxRead == null) return null;
    out.push({ kind: ctxRead.kind, name: ctxRead.name, format } as BodyChunk);
    if (span.literal.text.length > 0) {
      out.push({ kind: "literal", bytes: encodeTemplateText(span.literal.text, format) });
    }
  }
  return out;
}

function encodeTemplateText(text: string, _format: "raw" | "json-string"): Uint8Array {
  return new TextEncoder().encode(text);
}
