import ts from "typescript";
import { analyzeHandler, type AnalysisResult } from "@fearless/aot-analyzer";
import { transpileHandler, type HttpMethod, type TranspileResult } from "@fearless/aot-transpiler";
import { collectSql, emitRegistryInitRust } from "./sql-collection.js";

export { collectSql, emitRegistryInitRust } from "./sql-collection.js";
export type { CollectedSql } from "./sql-collection.js";

export interface CompileAppOptions {
  /** Source code of the user's app entry file. */
  readonly source: string;
  /** Optional file name (for diagnostic positions). */
  readonly fileName?: string;
}

/**
 * One discovered route in the user's app. Either:
 *   - `aot`: the handler passes the analyzer and is being transpiled to Rust.
 *   - `bun`: the handler does not qualify; the runtime forwards to Bun.
 *   - `template`: a declarative `app.text/json/html` registration; the rust-core
 *     manifest format already handles these (legacy template path).
 */
export type DiscoveredRoute =
  | {
      readonly kind: "aot";
      readonly method: HttpMethod;
      readonly path: string;
      readonly transpile: TranspileResult;
    }
  | {
      readonly kind: "bun";
      readonly method: HttpMethod;
      readonly path: string;
      readonly reason: AnalysisResult & { compilable: false };
      /** The handler text — useful for the Bun-side runtime to evaluate. */
      readonly handlerSource: string;
    }
  | {
      readonly kind: "template";
      readonly method: HttpMethod;
      readonly path: string;
      readonly responseSource: string;
    };

export interface CompileAppResult {
  readonly routes: ReadonlyArray<DiscoveredRoute>;
  /** Full Rust source for `aot_handlers.rs`. Empty string if no AOT routes. */
  readonly rustSource: string;
  /** Manifest fragment for the rust-core dispatcher. */
  readonly dispatchManifest: ReadonlyArray<DispatchEntry>;
  /** Diagnostic counts for the build script's summary output. */
  readonly summary: {
    readonly total: number;
    readonly aot: number;
    readonly bun: number;
    readonly template: number;
  };
  /**
   * Generated Rust source for `rust-core/src/aot/registry_init.rs`.
   * Contains a `STATEMENTS` phf map and a `register_handles(pool)` function.
   * Empty string when there are no async SQL handlers.
   */
  readonly registryRustSource: string;
}

export interface DispatchEntry {
  readonly method: HttpMethod;
  readonly path: string;
  readonly kind: "aot" | "bun" | "template";
  /** When kind === "aot", the generated Rust function name. */
  readonly fnName?: string;
}

const HTTP_METHOD_NAMES: ReadonlyMap<string, HttpMethod> = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["delete", "DELETE"],
  ["patch", "PATCH"],
  ["options", "OPTIONS"],
  ["head", "HEAD"],
]);

const TEMPLATE_METHOD_NAMES: ReadonlySet<string> = new Set(["text", "json", "html"]);

export function compileApp(options: CompileAppOptions): CompileAppResult {
  const sourceFile = ts.createSourceFile(
    options.fileName ?? "<app>.ts",
    options.source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const routes: DiscoveredRoute[] = [];
  let aotIdCounter = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const methodName = callee.name.text;

        // Handler routes (app.get, app.post, etc.) — handler is the second arg
        const httpMethod = HTTP_METHOD_NAMES.get(methodName);
        if (httpMethod != null && node.arguments.length >= 2) {
          const pathArg = node.arguments[0];
          const handlerArg = node.arguments[1];
          if (
            pathArg != null &&
            (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg)) &&
            handlerArg != null
          ) {
            const path = pathArg.text;
            const route = discoverHandlerRoute(httpMethod, path, handlerArg, aotIdCounter);
            routes.push(route);
            if (route.kind === "aot") aotIdCounter += 1;
            // Also distinguishes: handlerArg might be a RouteResponseSpec object literal
            // for the legacy template API (app.get(path, { kind: "json", body: {...} })).
            // That's not handled here — analyzer would reject it. Future: detect and route
            // through the existing manifest-based template path.
          }
        }

        // Template routes (app.text, app.json, app.html) — body is the second arg.
        // We synthesize an equivalent inline handler `(ctx) => ctx.<method>(body)` and
        // run it through the AOT pipeline. The transpiler's static-literal path turns
        // it into a `&'static [u8]` response — identical performance to a template
        // served by a hand-written Rust route.
        if (TEMPLATE_METHOD_NAMES.has(methodName) && node.arguments.length >= 2) {
          const pathArg = node.arguments[0];
          const bodyArg = node.arguments[1];
          if (
            pathArg != null &&
            (ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg)) &&
            bodyArg != null
          ) {
            const path = pathArg.text;
            const bodySource = bodyArg.getText(sourceFile);
            const synthetic = `(ctx) => ctx.${methodName}(${bodySource})`;
            const aotRoute = synthesizeTemplateAsAot(synthetic, path, aotIdCounter);
            if (aotRoute != null) {
              routes.push(aotRoute);
              aotIdCounter += 1;
            } else {
              // Fall back to kind: template (won't be served until a future runtime
              // wires templates separately — for now logs as un-served).
              routes.push({
                kind: "template",
                method: "GET",
                path,
                responseSource: bodySource,
              });
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  const rustChunks: string[] = [];
  const aotRoutes = routes.filter((r) => r.kind === "aot");
  if (aotRoutes.length > 0) {
    rustChunks.push(
      "// Auto-generated by @fearless/aot-build. Do not edit — regenerated on every `fearless build`.",
      "// The Rust runtime contract lives in `crate::aot::runtime` (alias `aot_runtime` for short).",
      "use crate::aot::runtime as aot_runtime;",
      "use crate::aot::AotRouteTable;",
      ""
    );
    for (const route of aotRoutes) {
      if (route.kind === "aot") {
        rustChunks.push(route.transpile.rustSource);
      }
    }
    // Append the register() function that wires every handler into a table.
    // The runtime calls this once at startup before spawning workers.
    rustChunks.push("/// Register every AOT-compiled handler into the given route table.");
    rustChunks.push("/// Called once at server startup; `table` is then shared (read-only) across all workers.");
    rustChunks.push("pub fn register(table: &mut AotRouteTable) {");
    for (const route of aotRoutes) {
      if (route.kind === "aot") {
        const method = JSON.stringify(route.method);
        const path = JSON.stringify(route.path);
        rustChunks.push(`    table.add(${method}, ${path}, ${route.transpile.fnName});`);
      }
    }
    rustChunks.push("}");
  }

  const dispatchManifest: DispatchEntry[] = routes.map((route) => {
    if (route.kind === "aot") {
      return {
        method: route.method,
        path: route.path,
        kind: "aot",
        fnName: route.transpile.fnName,
      };
    }
    return {
      method: route.method,
      path: route.path,
      kind: route.kind,
    };
  });

  const summary = {
    total: routes.length,
    aot: routes.filter((r) => r.kind === "aot").length,
    bun: routes.filter((r) => r.kind === "bun").length,
    template: routes.filter((r) => r.kind === "template").length,
  };

  // Collect SQL statements from all AOT async handlers and emit the Rust registry init.
  const aotAsyncRoutes = routes
    .filter((r): r is DiscoveredRoute & { kind: "aot" } => r.kind === "aot")
    .filter((r) => r.transpile.kind === "async");
  const collected = collectSql(aotAsyncRoutes);
  const registryRustSource = emitRegistryInitRust(collected);

  return {
    routes,
    rustSource: rustChunks.join("\n"),
    dispatchManifest,
    summary,
    registryRustSource,
  };
}

/**
 * Synthesize an inline handler from an `app.text/json/html(path, body)` call
 * and run it through the AOT pipeline. Returns the discovered route, or null
 * if the body isn't AOT-compatible (e.g. the user passed a complex expression
 * that doesn't reduce to a static literal).
 */
function synthesizeTemplateAsAot(
  syntheticSource: string,
  path: string,
  idCounter: number
): DiscoveredRoute | null {
  const wrapper = ts.createSourceFile(
    "<template-synth>.ts",
    `const __h = ${syntheticSource};`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  let arrow: ts.ArrowFunction | null = null;
  const visit = (node: ts.Node): void => {
    if (arrow != null) return;
    if (ts.isArrowFunction(node)) {
      arrow = node;
      return;
    }
    node.forEachChild(visit);
  };
  visit(wrapper);
  if (arrow == null) return null;

  const analysis = analyzeHandler(arrow);
  if (!analysis.compilable) return null;

  const id = `${idCounter}_template_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const outcome = transpileHandler({ handler: arrow, method: "GET", path, id });
  if (!outcome.success) return null;

  return { kind: "aot", method: "GET", path, transpile: outcome.result };
}

function discoverHandlerRoute(
  method: HttpMethod,
  path: string,
  handlerArg: ts.Expression,
  idCounter: number
): DiscoveredRoute {
  // Only inline arrow functions / function expressions can be transpiled.
  // References to a named function are out of scope (would need cross-file
  // analysis). They fall back to Bun.
  if (!ts.isArrowFunction(handlerArg) && !ts.isFunctionExpression(handlerArg)) {
    return {
      kind: "bun",
      method,
      path,
      reason: {
        compilable: false,
        reasons: [
          {
            rule: "handler-shape",
            message: "Handler is not an inline function — cross-file reference not supported in Phase 0.",
          },
        ],
      },
      handlerSource: handlerArg.getText(),
    };
  }

  const analysis = analyzeHandler(handlerArg);
  if (!analysis.compilable) {
    return {
      kind: "bun",
      method,
      path,
      reason: analysis,
      handlerSource: handlerArg.getText(),
    };
  }

  const id = `${idCounter}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const outcome = transpileHandler({
    handler: handlerArg,
    method,
    path,
    id,
  });
  if (!outcome.success) {
    return {
      kind: "bun",
      method,
      path,
      reason: {
        compilable: false,
        reasons: [
          {
            rule: "handler-shape",
            message: `Transpiler failed: ${outcome.error.kind} — ${outcome.error.message}`,
          },
        ],
      },
      handlerSource: handlerArg.getText(),
    };
  }

  return { kind: "aot", method, path, transpile: outcome.result };
}

/**
 * Format a CompileAppResult as a human-readable build report — one line per route.
 * Used by the `fearless build` CLI for at-a-glance feedback.
 */
export function formatBuildReport(result: CompileAppResult): string {
  const lines: string[] = [];
  lines.push(
    `Discovered ${result.summary.total} routes: ${result.summary.aot} AOT, ${result.summary.bun} Bun-fallback, ${result.summary.template} template.`
  );
  for (const route of result.routes) {
    const method = route.method.padEnd(6);
    const path = route.path.padEnd(28);
    if (route.kind === "aot") {
      lines.push(`  ✅ ${method} ${path} → Rust (${route.transpile.fnName})`);
    } else if (route.kind === "template") {
      lines.push(`  📄 ${method} ${path} → template (Rust hot path)`);
    } else {
      const ruleNames = route.reason.reasons.map((r) => r.rule).join(", ");
      lines.push(`  ⚠️  ${method} ${path} → Bun (blocked by: ${ruleNames})`);
    }
  }
  return lines.join("\n");
}
