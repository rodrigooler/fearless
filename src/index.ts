export { App, createValidator } from "./app.js";
export { Request } from "./request.js";
export { Response } from "./response.js";
export { startRustCoreServer } from "./rust-core.js";
export { cors, securityHeaders } from "./dependencies/index.js";
export type {
  RuntimeMode,
  HttpVersion,
  BuiltinCorsConfig,
  BuiltinSecurityHeadersConfig,
  BuiltinFeature,
  HttpMethod,
  QueryParams,
  Headers,
  IncomingRequest,
  OutgoingResponse,
  RouteOptions,
  RouteResponseSpec,
  AppOptions,
  TemplateValue,
  JsonBody,
} from "./types.js";
export type {
  RustCoreManifest,
  RustCoreServerHandle,
  RustCorsManifest,
  RustStaticRoute,
  StartRustCoreServerOptions,
} from "./rust-core.js";
export type { CorsOptions } from "./dependencies/index.js";
export type { SecurityHeadersOptions } from "./dependencies/index.js";

// Functional handler API
export { RequestContext } from "./ctx.js";
export { HttpError, ValidationError } from "./errors.js";
export { HookChain } from "./middleware.js";
export type {
  Ctx,
  Handler,
  RequestHook,
  ResponseHook,
  ErrorHook,
  ResponseBody,
} from "./types.js";

// Phase 1.2: tagged template + handle namespace consumed by the AOT pipeline.
export { sql, fearless } from "./sql.js";
export type { SqlQuery, SqlHandle, SqlRow, FearlessNamespace } from "./sql.js";
