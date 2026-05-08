import type ts from "typescript";
import type { DiscoveredHandle } from "@fearless/aot-analyzer";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD";

/** Whether a generated handler is sync (returns into `out` directly) or async (returns Vec<u8>). */
export type EmittedHandlerKind = "sync" | "async";

/**
 * Inputs to the transpiler. The handler is the analyzed AST node; the route
 * metadata (method + path) comes from the registration call site.
 */
export interface TranspileOptions {
  readonly handler: ts.ArrowFunction | ts.FunctionExpression;
  readonly method: HttpMethod;
  readonly path: string;
  /** Stable id used to name the generated Rust function (e.g. handler_42). */
  readonly id: string;
  /**
   * Handles discovered in the source file (from `@fearless/aot-analyzer`'s
   * `discoverHandles`). Required for async handlers that reference a handle.
   * Defaults to `[]` for backward compat with sync-only callers.
   */
  readonly discoveredHandles?: readonly DiscoveredHandle[];
}

/**
 * Result of a successful transpile. The caller stitches `rustSource` into a
 * generated `aot_handlers.rs` file inside `rust-core`, then dispatches based
 * on `method` + `path` at runtime.
 */
export interface TranspileResult {
  /** Rust source code for the handler function. */
  readonly rustSource: string;
  /** Generated Rust function name (e.g. "handler_42"). */
  readonly fnName: string;
  /** Echoed from input — caller uses these for dispatch. */
  readonly method: HttpMethod;
  readonly path: string;
  /** Whether the generated function is sync or async. */
  readonly kind: EmittedHandlerKind;
  /**
   * Statement key → SQL text. Empty for sync handlers. The build pipeline
   * collects these across all async handlers and emits a single PHF map that
   * each async handler looks statements up in by key.
   */
  readonly statements: ReadonlyMap<string, string>;
  /**
   * The `registeredName` values (e.g. `"primary"`) for every SQL handle used
   * in this handler. Empty set for sync handlers. Note: statement keys use the
   * `variableName` prefix (e.g. `db_<hash>`), but registry lookups use
   * `registeredName` — the build pipeline needs both.
   */
  readonly registeredHandleNames: ReadonlySet<string>;
}

/**
 * Why a transpile attempt failed. The analyzer should have caught most of these
 * upstream — these errors mean the handler passed analyzeHandler() but the
 * transpiler hit a structural shape it doesn't know how to emit.
 *
 * Surfacing transpile errors back through the build pipeline triggers fallback
 * to Bun for that route.
 */
export interface TranspileError {
  readonly kind:
    | "unsupported-construct"
    | "internal-bug"
    | "expected-by-analyzer";
  readonly message: string;
  readonly node?: ts.Node;
}

export type TranspileOutcome =
  | { readonly success: true; readonly result: TranspileResult }
  | { readonly success: false; readonly error: TranspileError };

/**
 * Internal representation of a finalized response we know how to emit.
 * One of these is built per `return` statement / arrow body. The emitter
 * then turns it into Rust source.
 */
export type ResponseShape =
  | StaticResponse
  | DynamicResponse;

/**
 * Response whose exact bytes are known at compile time — emitted as a single
 * `&'static [u8]`.
 */
export interface StaticResponse {
  readonly kind: "static";
  readonly status: number;
  readonly contentType: string;
  readonly bodyBytes: Uint8Array;
}

/**
 * Response that needs runtime values (param substitutions, dynamic header
 * values). Body is emitted as a sequence of `BodyChunk`s; the framework writes
 * each in order.
 */
export interface DynamicResponse {
  readonly kind: "dynamic";
  readonly status: number;
  readonly contentType: string;
  readonly bodyChunks: ReadonlyArray<BodyChunk>;
}

export type BodyChunk =
  | { readonly kind: "literal"; readonly bytes: Uint8Array }
  | { readonly kind: "param"; readonly name: string; readonly format: ChunkFormat }
  | { readonly kind: "query"; readonly name: string; readonly format: ChunkFormat }
  | { readonly kind: "header"; readonly name: string; readonly format: ChunkFormat }
  | { readonly kind: "input"; readonly name: "method" | "path" | "url" | "ip"; readonly format: ChunkFormat };

/**
 * How to format a runtime value into the body.
 *
 * - `raw`: write the bytes directly (no escaping). Used inside text/html bodies.
 * - `json-string`: write a JSON-string-quoted version (escapes \\, \", control chars). Used inside JSON bodies.
 * - `url`: write a URL-encoded version. Used inside redirect locations.
 */
export type ChunkFormat = "raw" | "json-string" | "url";
