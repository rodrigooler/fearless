import type ts from "typescript";

/**
 * Reason a handler does not compile to Rust under the Phase 0 subset.
 * Used to give actionable feedback to developers about what to refactor.
 */
export interface Reason {
  /** Stable rule identifier (e.g. "no-await"). Used to suppress / configure. */
  readonly rule: RuleId;
  /** Human-readable explanation, in plain English. */
  readonly message: string;
  /** Source range pointing at the offending construct. Optional — some rules report at handler scope. */
  readonly start?: number;
  readonly end?: number;
  /** Optional refactor hint — what the developer could change to make it compile. */
  readonly hint?: string;
}

export type RuleId =
  | "handler-shape"
  | "no-await"
  | "no-promise"
  | "no-external-identifiers"
  | "no-dynamic-property"
  | "no-throw"
  | "no-loops"
  | "no-disallowed-calls"
  | "return-shape"
  | "template-substitutions";

export type AnalysisResult =
  | { readonly compilable: true }
  | { readonly compilable: false; readonly reasons: ReadonlyArray<Reason> };

/**
 * What the handler accepts as a parameter — needed to validate "only ctx is captured".
 * For Phase 0 we hardcode the binding name to "ctx".
 */
export const HANDLER_PARAM_NAME = "ctx" as const;

/**
 * Allowed Ctx response builder methods. Calls outside this list make the handler ineligible.
 */
export const ALLOWED_CTX_BUILDERS = new Set([
  "json",
  "text",
  "html",
  "raw",
  "redirect",
  "notFound",
  "noContent",
]);

/**
 * Allowed Ctx chainable shapers. These can appear before a builder call (e.g. ctx.status(201).json(...)).
 */
export const ALLOWED_CTX_CHAINS = new Set([
  "status",
  "header",
  "setHeaders",
]);

/**
 * Allowed input properties on Ctx. Reads outside this list aren't supported in Phase 0.
 */
export const ALLOWED_CTX_INPUTS = new Set([
  "method",
  "path",
  "url",
  "params",
  "query",
  "headers",
  "ip",
  "state",
]);

/**
 * Internal context passed to each rule. Lets rules share AST traversal and source positions.
 */
export interface RuleContext {
  readonly handler: ts.ArrowFunction | ts.FunctionExpression;
  readonly sourceFile: ts.SourceFile;
  readonly typescript: typeof ts;
  /** Identifier name bound to Ctx in the handler signature. Currently always "ctx". */
  readonly ctxParamName: string;
}

/**
 * A rule is a pure function from RuleContext to a list of Reasons.
 * Empty list = rule satisfied. Non-empty = rule violated, each entry one violation.
 */
export type Rule = (context: RuleContext) => ReadonlyArray<Reason>;
