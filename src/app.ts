import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import { createSecureServer as createHttp2SecureServer, type Http2SecureServer } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import { Request } from "./request.js";
import { Response } from "./response.js";
import { normalizePath } from "./path.js";
import type {
  AppOptions,
  BuiltinFeature,
  HttpMethod,
  RouteOptions,
  RouteResponseSpec,
  TemplateValue,
} from "./types.js";
import {
  startRustCoreServer,
  type RustCoreManifest,
  type RustCoreServerHandle,
  type RustCorsManifest,
  type RustStaticRoute,
} from "./rust-core.js";

interface CompiledPath {
  normalized: string;
  segments: RouteSegment[];
  hasParams: boolean;
}

interface RouteDefinition {
  method: HttpMethod;
  compiledPath: CompiledPath;
  response: RouteResponseSpec;
}

interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
  suppressBody: boolean;
}

type RouteSegment = { kind: "static"; value: string } | { kind: "param"; value: string };
type RouteTable = {
  route: RouteDefinition | null;
  staticChildren: Map<string, RouteTable>;
  paramChild: RouteTable | null;
  paramKey: string | null;
};

type TemplateContext = {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  ip: string;
};

type BuiltinState = {
  headers: Record<string, string>;
  cors: RustCorsManifest | null;
};

type BunRuntimeRequest = globalThis.Request & {
  params?: Record<string, string>;
};

type BunRouteMethodHandler =
  | globalThis.Response
  | ((request: BunRuntimeRequest, server: BunServerLike) => globalThis.Response);

type BunRouteMap = Record<string, Partial<Record<HttpMethod, BunRouteMethodHandler>>>;

type BunServerLike = {
  stop(closeActiveConnections?: boolean): void;
  requestIP?(request: globalThis.Request): { address: string; port: number } | null;
};

type BunServeOptions = {
  port: number;
  hostname?: string;
  reusePort?: boolean;
  routes: BunRouteMap;
  fetch(request: BunRuntimeRequest, server: BunServerLike): globalThis.Response | Promise<globalThis.Response>;
};

type BunGlobalLike = {
  serve(options: BunServeOptions): BunServerLike;
};

function createValidator<T>(validator: (data: unknown) => T | null | undefined): (data: unknown) => { ok: true; data: T } | { ok: false; errors: string } {
  return (data: unknown) => {
    const result = validator(data);
    if (result === null || result === undefined) {
      return { ok: false, errors: "Invalid payload" };
    }

    return { ok: true, data: result };
  };
}

function splitNormalizedPath(normalized: string): string[] {
  if (normalized === "/") {
    return [];
  }

  return normalized.slice(1).split("/");
}

function compilePath(path: string): CompiledPath {
  const normalized = normalizePath(path);
  const rawSegments = splitNormalizedPath(normalized);
  const segments: RouteSegment[] = [];
  let hasParams = false;

  for (const segment of rawSegments) {
    if (segment.startsWith(":")) {
      hasParams = true;
      segments.push({ kind: "param", value: segment.slice(1) });
      continue;
    }

    segments.push({ kind: "static", value: segment });
  }

  return {
    normalized,
    segments,
    hasParams,
  };
}

function buildRouteResponse(kind: "text" | "html" | "json", body: TemplateValue, options: RouteOptions = {}): RouteResponseSpec {
  return {
    kind,
    body,
    status: options.status,
    headers: options.headers,
  };
}

function toHeaderRecord(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    output[key.toLowerCase()] = value;
  }

  return output;
}

function getBunGlobal(): BunGlobalLike | null {
  const candidate = (globalThis as typeof globalThis & { Bun?: BunGlobalLike }).Bun;
  if (!candidate || typeof candidate.serve !== "function") {
    return null;
  }

  return candidate;
}

// Pre-computed content-type lookup table for O(1) access
const CONTENT_TYPE_TABLE: Record<RouteResponseSpec["kind"], string> = {
  json: "application/json",
  html: "text/html",
  text: "text/plain",
};

function contentTypeForKind(kind: RouteResponseSpec["kind"]): string {
  return CONTENT_TYPE_TABLE[kind];
}

function templateValueContainsToken(value: TemplateValue): boolean {
  if (value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.includes("{{");
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => templateValueContainsToken(entry));
  }

  for (const entry of Object.values(value)) {
    if (templateValueContainsToken(entry)) {
      return true;
    }
  }

  return false;
}

function headersContainTemplate(headers?: Record<string, string>): boolean {
  if (!headers) {
    return false;
  }

  for (const value of Object.values(headers)) {
    if (value.includes("{{")) {
      return true;
    }
  }

  return false;
}

function routeCanUseStaticBunResponse(route: RouteDefinition): boolean {
  // Static routes without params and without template tokens can be cached
  if (route.compiledPath.hasParams) {
    return false;
  }
  if (templateValueContainsToken(route.response.body)) {
    return false;
  }
  if (headersContainTemplate(route.response.headers)) {
    return false;
  }
  return true;
}

// Fast path lookup for simple tokens
const SIMPLE_TOKEN_LOOKUP: Record<string, keyof TemplateContext> = {
  method: "method",
  path: "path",
  ip: "ip",
  params: "params",
  query: "query",
  headers: "headers",
};

function resolveTemplateToken(token: string, context: TemplateContext): unknown {
  // Fast path: simple tokens
  const simpleValue = SIMPLE_TOKEN_LOOKUP[token];
  if (simpleValue !== undefined) {
    return context[simpleValue];
  }

  // Param access: params.name
  if (token.startsWith("params.")) {
    return context.params[token.slice(7)] ?? "";
  }

  // Query access: query.name
  if (token.startsWith("query.")) {
    const value = context.query[token.slice(6)];
    return Array.isArray(value) ? value.join(", ") : value ?? "";
  }

  // Header access: headers.name
  if (token.startsWith("headers.")) {
    return context.headers[token.slice(8).toLowerCase()] ?? "";
  }

  return "";
}

// Template pattern compiled once
const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

function renderTemplateString(input: string, context: TemplateContext): string {
  // Fast path: no template tokens
  const templateIndex = input.indexOf("{{");
  if (templateIndex === -1) {
    return input;
  }

  // Reset regex state for each call
  TEMPLATE_PATTERN.lastIndex = 0;
  
  return input.replace(TEMPLATE_PATTERN, (_, rawToken: string) => {
    const token = rawToken.trim();
    const value = resolveTemplateToken(token, context);
    if (value === null || value === undefined) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    return JSON.stringify(value);
  });
}

function renderTemplateValue(value: TemplateValue, context: TemplateContext): TemplateValue {
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return renderTemplateString(value, context);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplateValue(entry, context));
  }

  const output: Record<string, TemplateValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = renderTemplateValue(entry, context);
  }

  return output;
}

function renderRouteBody(response: RouteResponseSpec, context: TemplateContext): string {
  const rendered = renderTemplateValue(response.body, context);

  // JSON always needs stringify, but for text/html the body might already be a string
  if (response.kind === "json") {
    return JSON.stringify(rendered);
  }

  if (typeof rendered === "string") {
    return rendered;
  }

  // For arrays/objects in text/html, serialize
  return JSON.stringify(rendered);
}

function joinQueryParams(queryString: string): Record<string, string | string[]> {
  if (!queryString || queryString.length < 2) {
    return {};
  }

  const result: Record<string, string | string[]> = {};
  const searchParams = new URLSearchParams(queryString);

  for (const [key, value] of searchParams.entries()) {
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }

  return result;
}

function normalizeIp(address: string | undefined): string {
  if (!address) {
    return "";
  }

  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

// Null character as route key delimiter
const ROUTE_KEY_DELIMITER = "\0";

// Pre-allocated empty context for static routes (avoids allocation per request)
const EMPTY_TEMPLATE_CONTEXT: TemplateContext = {
  method: "GET",
  path: "/",
  params: {},
  query: {},
  headers: {},
  ip: "",
};

// Pre-allocated empty query result
const EMPTY_QUERY_RESULT: Record<string, string | string[]> = {};

export class App {
  private routes: RouteDefinition[] = [];
  private exactRoutes = new Map<string, RouteDefinition>();
  private paramRoutesByMethod: Partial<Record<HttpMethod, RouteTable>> = {};
  private builtin: BuiltinState = {
    headers: {},
    cors: null,
  };
  private rustServer: RustCoreServerHandle | null = null;
  private bunServer: BunServerLike | null = null;
  private nodeServer: HttpServer | Http2SecureServer | null = null;
  private config: Required<AppOptions> = {
    keyFileName: "",
    certFileName: "",
    passphrase: "",
    port: 3000,
    host: "0.0.0.0",
    runtime: "auto",
    httpVersion: "auto",
    rustCoreBinary: "",
  };

  constructor(options?: AppOptions) {
    this.config = { ...this.config, ...options };
  }

  private routeKey(method: HttpMethod, path: string): string {
    return method + ROUTE_KEY_DELIMITER + path;
  }

  private createRouteTable(): RouteTable {
    return {
      route: null,
      staticChildren: new Map<string, RouteTable>(),
      paramChild: null,
      paramKey: null,
    };
  }

  private insertParamRoute(method: HttpMethod, route: RouteDefinition): void {
    const existingRoot = this.paramRoutesByMethod[method];
    let node: RouteTable;

    if (existingRoot) {
      node = existingRoot;
    } else {
      node = this.createRouteTable();
      this.paramRoutesByMethod[method] = node;
    }

    for (const segment of route.compiledPath.segments) {
      if (segment.kind === "static") {
        const existing = node.staticChildren.get(segment.value);
        if (existing) {
          node = existing;
          continue;
        }

        const next = this.createRouteTable();
        node.staticChildren.set(segment.value, next);
        node = next;
        continue;
      }

      if (!node.paramChild) {
        node.paramChild = this.createRouteTable();
        node.paramChild.paramKey = segment.value;
      } else if (node.paramChild.paramKey === null) {
        node.paramChild.paramKey = segment.value;
      }

      node = node.paramChild;
    }

    if (node.route === null) {
      node.route = route;
    }
  }

  private addRoute(route: RouteDefinition): this {
    this.routes.push(route);

    if (!route.compiledPath.hasParams) {
      this.exactRoutes.set(this.routeKey(route.method, route.compiledPath.normalized), route);
    } else {
      this.insertParamRoute(route.method, route);
    }

    return this;
  }

  private registerRoute(method: HttpMethod, path: string, response: RouteResponseSpec, options: RouteOptions = {}): this {
    const compiledPath = compilePath(path);
    const routeResponse: RouteResponseSpec = {
      kind: response.kind,
      body: response.body,
      status: response.status ?? options.status,
      headers: { ...(options.headers ?? {}), ...(response.headers ?? {}) },
    };

    return this.addRoute({
      method,
      compiledPath,
      response: routeResponse,
    });
  }

  private findRoute(method: HttpMethod, path: string): RouteMatch | null {
    const normalizedPath = normalizePath(path);

    const exactRoute = this.exactRoutes.get(this.routeKey(method, normalizedPath));
    if (exactRoute) {
      return {
        route: exactRoute,
        params: {},
        suppressBody: method === "HEAD",
      };
    }

    if (method === "HEAD") {
      const exactGetRoute = this.exactRoutes.get(this.routeKey("GET", normalizedPath));
      if (exactGetRoute) {
        return {
          route: exactGetRoute,
          params: {},
          suppressBody: true,
        };
      }
    }

    const routeMatch = this.findParamRoute(method, normalizedPath, method === "HEAD");
    if (routeMatch) {
      return routeMatch;
    }

    if (method !== "HEAD") {
      return null;
    }

    return this.findParamRoute("GET", normalizedPath, true);
  }

  private findParamRoute(method: HttpMethod, path: string, suppressBody: boolean): RouteMatch | null {
    const table = this.paramRoutesByMethod[method];
    if (!table) {
      return null;
    }

    const params: Record<string, string> = {};
    const route = this.matchRouteTable(table, splitNormalizedPath(path), 0, params);
    if (!route) {
      return null;
    }

    return {
      route,
      params,
      suppressBody,
    };
  }

  private matchRouteTable(
    table: RouteTable,
    segments: string[],
    index: number,
    params: Record<string, string>
  ): RouteDefinition | null {
    if (index === segments.length) {
      return table.route;
    }

    const segment = segments[index];
    const staticChild = table.staticChildren.get(segment);
    if (staticChild) {
      const matched = this.matchRouteTable(staticChild, segments, index + 1, params);
      if (matched) {
        return matched;
      }
    }

    if (!table.paramChild) {
      return null;
    }

    const paramSegment = table.paramChild.paramKey;
    if (paramSegment === null) {
      return null;
    }

    try {
      params[paramSegment] = decodeURIComponent(segment);
    } catch {
      params[paramSegment] = segment;
    }

    const matched = this.matchRouteTable(table.paramChild, segments, index + 1, params);
    if (matched) {
      return matched;
    }

    delete params[paramSegment];
    return null;
  }

  private canUseRustRuntime(useHttps: boolean): boolean {
    if (this.config.runtime === "node" || useHttps) {
      return false;
    }

    return true;
  }

  private canUseBunRuntime(useHttps: boolean): boolean {
    if (this.config.runtime !== "auto" || useHttps) {
      return false;
    }

    return getBunGlobal() !== null;
  }

  private shouldUseHttp2(useHttps: boolean): boolean {
    if (!useHttps) {
      return false;
    }

    return this.config.httpVersion === "2" || this.config.httpVersion === "auto";
  }

  private buildRequestListener(): (nodeReq: IncomingMessage, nodeRes: ServerResponse) => void {
    return (nodeReq: IncomingMessage, nodeRes: ServerResponse): void => {
      void this.handleNodeRequest(nodeReq, nodeRes);
    };
  }

  private buildBuiltinHeaders(): Record<string, string> {
    // Avoid spread operator - build headers directly
    const builtinHeaders = this.builtin.headers;
    const hasBuiltinHeaders = Object.keys(builtinHeaders).length > 0;
    const hasCors = this.builtin.cors !== null;

    // Fast path: no headers needed
    if (!hasBuiltinHeaders && !hasCors) {
      return {};
    }

    // Calculate required size
    let size = Object.keys(builtinHeaders).length;
    const cors = this.builtin.cors;
    if (cors) {
      size += 1; // methods
      if (cors.origin) size++;
      if (cors.allowedHeaders) size++;
      if (cors.exposedHeaders) size++;
      if (cors.credentials) size++;
      if (cors.maxAge !== null) size++;
    }

    const headers: Record<string, string> = {};

    // Copy builtin headers
    for (const key of Object.keys(builtinHeaders)) {
      headers[key] = builtinHeaders[key];
    }

    // Add CORS headers
    if (cors) {
      if (cors.origin) {
        headers["Access-Control-Allow-Origin"] = cors.origin;
      }
      headers["Access-Control-Allow-Methods"] = cors.methods;
      if (cors.allowedHeaders) {
        headers["Access-Control-Allow-Headers"] = cors.allowedHeaders;
      }
      if (cors.exposedHeaders) {
        headers["Access-Control-Expose-Headers"] = cors.exposedHeaders;
      }
      if (cors.credentials) {
        headers["Access-Control-Allow-Credentials"] = "true";
      }
      if (cors.maxAge !== null) {
        headers["Access-Control-Max-Age"] = String(cors.maxAge);
      }
    }

    return headers;
  }

  private buildRouteHeaders(route: RouteDefinition): Record<string, string> {
    const baseHeaders = this.buildBuiltinHeaders();
    const routeHeaders = route.response.headers;
    const hasRouteHeaders = routeHeaders && Object.keys(routeHeaders).length > 0;

    if (!hasRouteHeaders) {
      baseHeaders["Content-Type"] = CONTENT_TYPE_TABLE[route.response.kind];
      return baseHeaders;
    }

    // Merge with route-specific headers
    for (const key of Object.keys(routeHeaders)) {
      baseHeaders[key] = routeHeaders[key];
    }

    baseHeaders["Content-Type"] = CONTENT_TYPE_TABLE[route.response.kind];
    return baseHeaders;
  }

  private createStaticBunResponse(route: RouteDefinition): globalThis.Response {
    const headers = this.buildRouteHeaders(route);
    const status = route.response.status ?? 200;
    const body = renderRouteBody(route.response, EMPTY_TEMPLATE_CONTEXT);

    return new globalThis.Response(status === 204 || status === 304 ? null : body, {
      status,
      headers,
    });
  }

  private createBunResponse(
    route: RouteDefinition,
    method: HttpMethod,
    path: string,
    params: Record<string, string>,
    query: Record<string, string | string[]>,
    headers: Record<string, string>,
    ip: string
  ): globalThis.Response {
    const body = renderRouteBody(route.response, {
      method,
      path,
      params,
      query,
      headers,
      ip,
    });
    const status = route.response.status ?? 200;

    return new globalThis.Response(status === 204 || status === 304 ? null : body, {
      status,
      headers: this.buildRouteHeaders(route),
    });
  }

  private createBunRouteHandler(route: RouteDefinition): BunRouteMethodHandler {
    if (routeCanUseStaticBunResponse(route)) {
      return this.createStaticBunResponse(route);
    }

    return (request: BunRuntimeRequest, server: BunServerLike): globalThis.Response => {
      const url = new URL(request.url);
      const ip = normalizeIp(server.requestIP?.(request)?.address);
      const search = url.search;

      return this.createBunResponse(
        route,
        (request.method || route.method).toUpperCase() as HttpMethod,
        normalizePath(url.pathname),
        request.params ?? {},
        search.length > 1 ? joinQueryParams(search.slice(1)) : EMPTY_QUERY_RESULT,
        toHeaderRecord(request.headers),
        ip
      );
    };
  }

  private buildBunRoutes(): BunRouteMap {
    const routes: BunRouteMap = {};

    for (const route of this.routes) {
      if (this.builtin.cors && route.method === "OPTIONS") {
        continue;
      }

      const path = route.compiledPath.normalized;
      const methodHandlers = routes[path] ?? {};
      methodHandlers[route.method] = this.createBunRouteHandler(route);
      routes[path] = methodHandlers;
    }

    return routes;
  }

  private createBunNotFoundResponse(): globalThis.Response {
    return new globalThis.Response("Not Found", {
      status: 404,
      headers: this.buildBuiltinHeaders(),
    });
  }

  private createBunOptionsResponse(): globalThis.Response {
    return new globalThis.Response("", {
      status: this.builtin.cors?.optionsSuccessStatus ?? 204,
      headers: this.buildBuiltinHeaders(),
    });
  }

  private handleBunFallback(request: BunRuntimeRequest, server: BunServerLike): globalThis.Response {
    const method = (request.method || "GET").toUpperCase() as HttpMethod;

    if (this.builtin.cors && method === "OPTIONS") {
      return this.createBunOptionsResponse();
    }

    const url = new URL(request.url);
    const routeMatch = this.findRoute(method, `${url.pathname}${url.search}`);
    if (!routeMatch) {
      return this.createBunNotFoundResponse();
    }

    return this.createBunResponse(
      routeMatch.route,
      method,
      normalizePath(url.pathname),
      routeMatch.params,
      joinQueryParams(url.search.length > 1 ? url.search.slice(1) : ""),
      toHeaderRecord(request.headers),
      normalizeIp(server.requestIP?.(request)?.address)
    );
  }

  private startBunServer(callback?: (started: boolean) => void): void {
    const bun = getBunGlobal();
    if (!bun) {
      throw new Error("Bun runtime is not available");
    }

    try {
      this.bunServer = bun.serve({
        port: this.config.port,
        hostname: this.config.host,
        reusePort: process.env.FEARLESS_BUN_REUSE_PORT === "1",
        routes: this.buildBunRoutes(),
        fetch: (request, server) => this.handleBunFallback(request, server),
      });
      callback?.(true);
    } catch (error) {
      console.error(error);
      callback?.(false);
      process.exitCode = 1;
    }
  }

  private startNodeServer(callback?: (started: boolean) => void): void {
    const requestListener = this.buildRequestListener();
    const useHttps = Boolean(this.config.keyFileName || this.config.certFileName);

    if (useHttps) {
      if (!this.config.keyFileName || !this.config.certFileName) {
        throw new Error("Both keyFileName and certFileName are required for HTTPS");
      }

      const key = readFileSync(this.config.keyFileName);
      const cert = readFileSync(this.config.certFileName);
      if (this.shouldUseHttp2(useHttps)) {
        this.nodeServer = createHttp2SecureServer(
          {
            key,
            cert,
            passphrase: this.config.passphrase || undefined,
            allowHTTP1: true,
          },
          requestListener as never
        );
      } else {
        this.nodeServer = createHttpsServer(
          {
            key,
            cert,
            passphrase: this.config.passphrase || undefined,
          },
          requestListener as never
        );
      }
    } else {
      if (this.config.httpVersion === "2") {
        throw new Error("HTTP/2 requires HTTPS");
      }

      this.nodeServer = createHttpServer(requestListener as never);
    }

    this.nodeServer.once("error", (error) => {
      console.error(error);
      callback?.(false);
      process.exitCode = 1;
    });

    this.nodeServer.listen(this.config.port, this.config.host, () => {
      callback?.(true);
    });
  }

  private async handleNodeRequest(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
    const method = (nodeReq.method || "GET").toUpperCase() as HttpMethod;

    if (this.builtin.cors && method === "OPTIONS") {
      const response = new Response(nodeRes);
      this.applyBuiltins(response, this.builtin);
      response.status(this.builtin.cors.optionsSuccessStatus).end();
      return;
    }

    const routeMatch = this.findRoute(method, nodeReq.url || "/");
    const request = new Request(nodeReq, routeMatch?.params ?? {});
    const response = new Response(nodeRes, routeMatch?.suppressBody ?? false);

    if (routeMatch) {
      this.applyBuiltins(response, this.builtin);
      this.writeRouteResponse(request, response, routeMatch);
      return;
    }

    this.applyBuiltins(response, this.builtin);
    response.status(404).end("Not Found");
  }

  private applyBuiltins(response: Response, builtins: BuiltinState): void {
    for (const [key, value] of Object.entries(builtins.headers)) {
      response.setHeader(key, value);
    }

    if (!builtins.cors) {
      return;
    }

    const cors = builtins.cors;
    if (cors.origin) {
      response.setHeader("Access-Control-Allow-Origin", cors.origin);
    }

    response.setHeader("Access-Control-Allow-Methods", cors.methods);
    if (cors.allowedHeaders) {
      response.setHeader("Access-Control-Allow-Headers", cors.allowedHeaders);
    }
    if (cors.exposedHeaders) {
      response.setHeader("Access-Control-Expose-Headers", cors.exposedHeaders);
    }
    if (cors.credentials) {
      response.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (cors.maxAge !== null) {
      response.setHeader("Access-Control-Max-Age", String(cors.maxAge));
    }
  }

  private writeRouteResponse(request: Request, response: Response, routeMatch: RouteMatch): void {
    const templateContext: TemplateContext = {
      method: request.method,
      path: request.path,
      params: routeMatch.params,
      query: request.query,
      headers: request.headers,
      ip: request.ip,
    };

    const body = renderRouteBody(routeMatch.route.response, templateContext);
    const status = routeMatch.route.response.status ?? 200;
    const headers = routeMatch.route.response.headers ?? {};

    response.status(status);
    response.setHeaders(headers);

    if (routeMatch.suppressBody) {
      response.end();
      return;
    }

    if (routeMatch.route.response.kind === "json") {
      response.setHeader("Content-Type", "application/json");
      response.end(body);
      return;
    }

    response.setHeader("Content-Type", routeMatch.route.response.kind === "html" ? "text/html" : "text/plain");
    response.end(body);
  }

  private createRustManifest(): RustCoreManifest {
    const routes: RustStaticRoute[] = [];

    for (const route of this.routes) {
      routes.push({
        method: route.method,
        path: route.compiledPath.normalized,
        response: {
          kind: route.response.kind,
          body: route.response.body,
          status: route.response.status,
          headers: route.response.headers,
        },
        headers: route.response.headers ?? {},
      });
    }

    return {
      routes,
      headers: this.builtin.headers,
      cors: this.builtin.cors,
    };
  }

  get(path: string, response: RouteResponseSpec, options?: RouteOptions): this {
    return this.registerRoute("GET", path, response, options);
  }

  post(path: string, response: RouteResponseSpec, options?: RouteOptions): this {
    return this.registerRoute("POST", path, response, options);
  }

  put(path: string, response: RouteResponseSpec, options?: RouteOptions): this {
    return this.registerRoute("PUT", path, response, options);
  }

  delete(path: string, response: RouteResponseSpec, options?: RouteOptions): this {
    return this.registerRoute("DELETE", path, response, options);
  }

  patch(path: string, response: RouteResponseSpec, options?: RouteOptions): this {
    return this.registerRoute("PATCH", path, response, options);
  }

  options(path: string, response: RouteResponseSpec, options?: RouteOptions): this {
    return this.registerRoute("OPTIONS", path, response, options);
  }

  head(path: string, response: RouteResponseSpec, options?: RouteOptions): this {
    return this.registerRoute("HEAD", path, response, options);
  }

  text(path: string, body: TemplateValue, options?: RouteOptions): this {
    return this.registerRoute("GET", path, buildRouteResponse("text", body, options), options);
  }

  json(path: string, body: TemplateValue, options?: RouteOptions): this {
    return this.registerRoute("GET", path, buildRouteResponse("json", body, options), options);
  }

  html(path: string, body: TemplateValue, options?: RouteOptions): this {
    return this.registerRoute("GET", path, buildRouteResponse("html", body, options), options);
  }

  use(feature: BuiltinFeature): this {
    switch (feature.kind) {
      case "cors":
        this.builtin.cors = feature.config;
        break;
      case "securityHeaders":
        if (feature.config.noSniff) {
          this.builtin.headers["X-Content-Type-Options"] = "nosniff";
        }
        if (feature.config.frameOptions) {
          this.builtin.headers["X-Frame-Options"] = feature.config.frameOptions;
        }
        if (feature.config.referrerPolicy) {
          this.builtin.headers["Referrer-Policy"] = feature.config.referrerPolicy;
        }
        if (feature.config.crossOriginOpenerPolicy) {
          this.builtin.headers["Cross-Origin-Opener-Policy"] = feature.config.crossOriginOpenerPolicy;
        }
        if (feature.config.crossOriginResourcePolicy) {
          this.builtin.headers["Cross-Origin-Resource-Policy"] = feature.config.crossOriginResourcePolicy;
        }
        if (feature.config.contentSecurityPolicy) {
          this.builtin.headers["Content-Security-Policy"] = feature.config.contentSecurityPolicy;
        }
        break;
      default:
        throw new Error("Unsupported builtin feature");
    }

    return this;
  }

  listen(callback?: (started: boolean) => void): this {
    const useHttps = Boolean(this.config.keyFileName || this.config.certFileName);

    if (this.config.runtime === "node") {
      this.startNodeServer(callback);
      return this;
    }

    if (this.canUseBunRuntime(useHttps)) {
      this.startBunServer(callback);
      return this;
    }

    if (!this.canUseRustRuntime(useHttps)) {
      throw new Error("Rust runtime required by this API. Use runtime: \"node\" only for compatibility mode.");
    }

    const start = async (): Promise<void> => {
      const manifest = this.createRustManifest();
      this.rustServer = await startRustCoreServer({
        port: this.config.port,
        manifest,
        binaryPath: this.config.rustCoreBinary || undefined,
        startupTimeoutMs: 5000,
      });
      callback?.(true);
    };

    start().catch((error) => {
      console.error(error);
      callback?.(false);
      process.exitCode = 1;
    });

    return this;
  }

  async close(): Promise<void> {
    if (this.bunServer) {
      this.bunServer.stop(true);
      this.bunServer = null;
    }

    if (this.rustServer) {
      await this.rustServer.stop();
      this.rustServer = null;
    }

    if (this.nodeServer) {
      const server = this.nodeServer;
      await new Promise<void>((resolve) => {
        const nodeServer = server as HttpServer & {
          closeIdleConnections?: () => void;
          closeAllConnections?: () => void;
        };

        if (typeof nodeServer.closeIdleConnections === "function") {
          nodeServer.closeIdleConnections();
        }

        if (typeof nodeServer.closeAllConnections === "function") {
          nodeServer.closeAllConnections();
        }

        server.close(() => resolve());
      });
      this.nodeServer = null;
    }
  }
}

export { createValidator };
