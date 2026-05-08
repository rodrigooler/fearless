import ts from "typescript";
import type { AnalysisResult, Reason, Rule, RuleContext } from "./types.js";
import { HANDLER_PARAM_NAME } from "./types.js";
import { handlerShapeRule } from "./rules/handler-shape.js";
import { noAwaitRule } from "./rules/no-await.js";
import { noPromiseRule } from "./rules/no-promise.js";
import { noExternalIdentifiersRule } from "./rules/no-external-identifiers.js";
import { noDynamicPropertyRule } from "./rules/no-dynamic-property.js";
import { noThrowRule } from "./rules/no-throw.js";
import { noLoopsRule } from "./rules/no-loops.js";
import { noDisallowedCallsRule } from "./rules/no-disallowed-calls.js";
import { returnShapeRule } from "./rules/return-shape.js";
import { templateSubstitutionsRule } from "./rules/template-substitutions.js";

export type { AnalysisResult, Reason, Rule, RuleId, RuleContext } from "./types.js";

/**
 * The full set of Phase 0 rules. Order matters only for output stability —
 * each rule operates independently, returning Reasons that the caller can
 * surface in editor / CLI.
 */
export const PHASE_0_RULES: ReadonlyArray<Rule> = [
  handlerShapeRule,
  noAwaitRule,
  noPromiseRule,
  noExternalIdentifiersRule,
  noDynamicPropertyRule,
  noThrowRule,
  noLoopsRule,
  noDisallowedCallsRule,
  returnShapeRule,
  templateSubstitutionsRule,
];

/**
 * Decide whether a handler can be AOT-compiled to Rust under the Phase 0 subset.
 *
 * Pass either:
 *   - a TypeScript source string containing one expression — the analyzer parses
 *     it and finds the first arrow function or function expression
 *   - a `ts.ArrowFunction` / `ts.FunctionExpression` node directly (from your own
 *     AST traversal — useful when you're walking a real source file)
 *
 * Returns:
 *   - `{ compilable: true }` if every Phase 0 rule passes
 *   - `{ compilable: false, reasons: [...] }` with one entry per violation
 *
 * The function is pure and synchronous. No file I/O, no network.
 */
export function analyzeHandler(
  input: string | ts.ArrowFunction | ts.FunctionExpression
): AnalysisResult {
  let handler: ts.ArrowFunction | ts.FunctionExpression;
  let sourceFile: ts.SourceFile;

  if (typeof input === "string") {
    sourceFile = ts.createSourceFile(
      "<aot-analysis>.ts",
      input,
      ts.ScriptTarget.ES2022,
      /* setParentNodes */ true,
      ts.ScriptKind.TS
    );
    const found = findFirstHandler(sourceFile, ts);
    if (found == null) {
      return {
        compilable: false,
        reasons: [
          {
            rule: "handler-shape",
            message:
              "No arrow function or function expression found in the source. Pass a handler like `(ctx) => ctx.json({})`.",
          },
        ],
      };
    }
    handler = found;
  } else {
    handler = input;
    const owner = handler.getSourceFile();
    sourceFile = owner;
  }

  const ruleContext: RuleContext = {
    handler,
    sourceFile,
    typescript: ts,
    ctxParamName: HANDLER_PARAM_NAME,
  };

  const reasons: Reason[] = [];
  for (const rule of PHASE_0_RULES) {
    const ruleReasons = rule(ruleContext);
    for (const reason of ruleReasons) {
      reasons.push(reason);
    }
  }

  if (reasons.length === 0) {
    return { compilable: true };
  }
  return { compilable: false, reasons };
}

/**
 * Walk a source file, return the first ArrowFunction or FunctionExpression encountered.
 * Handles common patterns:
 *   - `app.get("/x", (ctx) => ...)` — finds the arrow inside the call args
 *   - `const handler = (ctx) => ...` — finds the arrow on the right of the assignment
 *   - Bare expression: `(ctx) => ...`
 */
function findFirstHandler(
  source: ts.SourceFile,
  typescript: typeof ts
): ts.ArrowFunction | ts.FunctionExpression | null {
  let found: ts.ArrowFunction | ts.FunctionExpression | null = null;

  const visit = (node: ts.Node): void => {
    if (found != null) {
      return;
    }
    if (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node)) {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };

  visit(source);
  return found;
}

/**
 * Convenience: format an AnalysisResult as a human-readable report string.
 * Useful for CLI output. Compilable handlers report a single line; failures list
 * each reason with the rule id and (when available) source position.
 */
export function formatReport(result: AnalysisResult): string {
  if (result.compilable) {
    return "✓ Handler compiles to Rust under Phase 0 subset.";
  }
  const lines: string[] = ["✗ Handler does NOT compile to Rust. Reasons:"];
  for (const reason of result.reasons) {
    const position =
      reason.start != null ? ` (offset ${reason.start})` : "";
    lines.push(`  • [${reason.rule}]${position} ${reason.message}`);
    if (reason.hint != null) {
      lines.push(`      hint: ${reason.hint}`);
    }
  }
  return lines.join("\n");
}
