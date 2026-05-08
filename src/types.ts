export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD";
export type RuntimeMode = "auto" | "node" | "rust";
export type HttpVersion = "auto" | "1.1" | "2";

export type TemplatePrimitive = string | number | boolean | null;
export type TemplateValue = TemplatePrimitive | TemplateValue[] | { [key: string]: TemplateValue };

export interface RouteResponseSpec {
  kind: "text" | "html" | "json";
  body: TemplateValue;
  status?: number;
  headers?: Record<string, string>;
}

export interface BuiltinCorsConfig {
  origin: string | null;
  methods: string;
  allowedHeaders: string | null;
  exposedHeaders: string | null;
  credentials: boolean;
  maxAge: number | null;
  optionsSuccessStatus: number;
}

export interface BuiltinSecurityHeadersConfig {
  contentSecurityPolicy: string | null;
  crossOriginOpenerPolicy: string | null;
  crossOriginResourcePolicy: string | null;
  referrerPolicy: string | null;
  frameOptions: string | null;
  noSniff: boolean;
}

export type BuiltinMiddlewareMetadata =
  | { kind: "cors"; config: BuiltinCorsConfig }
  | { kind: "securityHeaders"; config: BuiltinSecurityHeadersConfig };

export type BodyValidator<T = unknown> = (data: unknown) => T | null | undefined;

export type JsonBody = {
  body: unknown | null;
  bodyParsed: boolean;
  parseBodyRaw: <T = unknown>(schema: BodyValidator<T>) => Promise<T | null>;
  parseBody: <T = unknown>(schema: BodyValidator<T>) => Promise<T | null>;
  json: <T = unknown>(schema: BodyValidator<T>) => Promise<T | null>;
};

export type QueryParams = Record<string, string | string[]>;

export type Headers = Record<string, string>;

export type IncomingRequest = JsonBody & {
  method: HttpMethod;
  url: string;
  path: string;
  query: QueryParams;
  headers: Headers;
  params: Record<string, string>;
  ip: string;
};

export interface OutgoingResponse {
  status(code: number): this;
  json(data: unknown): this;
  text(data: string): this;
  html(data: string): this;
  setHeader(key: string, value: string): this;
  setHeaders(headers: Record<string, string>): this;
  end(data?: string | unknown): this;
}

export interface RouteOptions {
  status?: number;
  headers?: Record<string, string>;
}

export type BuiltinFeature = BuiltinMiddlewareMetadata;

export interface AppOptions {
  keyFileName?: string;
  certFileName?: string;
  passphrase?: string;
  port?: number;
  host?: string;
  runtime?: RuntimeMode;
  httpVersion?: HttpVersion;
  rustCoreBinary?: string;
}

// ============================================================================
// Functional handler API (Hono/Elysia-style)
//
// New types layered on top of the existing template-based RouteResponseSpec.
// Routes registered with a Handler force the Node/Bun runtime (Rust hot path
// requires templates, not function calls).
// ============================================================================

/**
 * Body types accepted by Ctx.raw — the union of what `new Response(body, ...)`
 * accepts in Node 22+ and Bun. Hand-rolled to avoid a DOM lib dependency.
 */
export type ResponseBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | Blob
  | FormData
  | URLSearchParams
  | ReadableStream
  | null;

/**
 * Request context passed to functional handlers and hooks.
 * Provides ergonomic access to the incoming request and a builder API for
 * the outgoing response. Returns standard web `Response` objects.
 */
export interface Ctx {
  // -- inputs (read-only) --
  readonly method: HttpMethod;
  readonly path: string;
  readonly url: string;
  readonly params: Record<string, string>;
  readonly query: QueryParams;
  readonly headers: Headers;
  readonly ip: string;

  /**
   * Per-request mutable bag — survive hooks → handler → hooks.
   * Use for auth subject, timing, request id, etc.
   */
  state: Record<string, unknown>;

  // -- body parsing (lazy) --
  /** Parse body as JSON. Throws HttpError(400) on invalid JSON. */
  body<T = unknown>(): Promise<T>;
  /** Read body as raw text. Empty string if no body. */
  text(): Promise<string>;
  /** Parse body as multipart/form-data. Throws HttpError(400) on parse failure. */
  formData(): Promise<FormData>;
  /** Parse + validate in one step. Throws ValidationError on failure. */
  validate<T>(validator: (data: unknown) => T | null | undefined): Promise<T>;

  // -- response builders (return standard web Response) --
  json<T>(data: T, status?: number): Response;
  raw(body: ResponseBody, init?: ResponseInit): Response;
  html(body: string, status?: number): Response;
  redirect(url: string, status?: 301 | 302 | 303 | 307 | 308): Response;
  notFound(message?: string): Response;
  noContent(): Response;

  // -- chainable response shaping (applied to next builder call) --
  status(code: number): Ctx;
  header(key: string, value: string): Ctx;
  setHeaders(headers: Record<string, string>): Ctx;

  // -- escape hatches --
  /** Raw Node IncomingMessage when running on Node. Undefined on Bun. */
  readonly nodeReq?: import("node:http").IncomingMessage;
  /** Raw Node ServerResponse when running on Node. Undefined on Bun. */
  readonly nodeRes?: import("node:http").ServerResponse;
  /** Raw web Request when running on Bun. Undefined on Node. */
  readonly webReq?: globalThis.Request;
}

/** Returns a Response (sync or async). */
export type Handler = (ctx: Ctx) => Response | Promise<Response>;

/**
 * Runs before the route handler. Return `Response` to short-circuit (the
 * handler is skipped). Return `void` (or undefined) to continue to the next
 * hook / the handler.
 */
export type RequestHook = (ctx: Ctx) => void | Response | Promise<void | Response>;

/**
 * Runs after the route handler with the produced response. Return a new
 * `Response` to replace it, or `void` to keep the original.
 */
export type ResponseHook = (ctx: Ctx, response: Response) => void | Response | Promise<void | Response>;

/**
 * Runs when the handler or any hook throws. Return a `Response` to recover.
 * Return `void` to fall through to the next error hook (or the default 500).
 */
export type ErrorHook = (ctx: Ctx, error: unknown) => void | Response | Promise<void | Response>;
