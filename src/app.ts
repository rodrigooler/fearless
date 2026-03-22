import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Request } from "./request.js";
import { Response } from "./response.js";
import type { AppOptions, Handler, HttpMethod, Middleware, RouteOptions } from "./types.js";
import { startRustCoreServer, type RustCoreServerHandle, type RustStaticRoute } from "./rust-core.js";

interface StaticRouteConfig {
  contentType: string;
  body: string;
  headers: Record<string, string>;
  status: number;
}

interface RouteMatch {
  route: RouteHandler;
  params: Record<string, string>;
  suppressBody: boolean;
}

interface CompiledPath {
  normalized: string;
  segments: RouteSegment[];
  paramNames: string[];
}

interface RouteHandler {
  kind: "dynamic" | "static";
  method: HttpMethod;
  path: string;
  handler?: Handler;
  middlewares: Middleware[];
  staticRoute?: StaticRouteConfig;
  compiledPath: CompiledPath;
}

type RouteSegment = { kind: "static"; value: string } | { kind: "param"; value: string };

type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: string };

function createValidator<T>(validator: (data: unknown) => T | null | undefined): (data: unknown) => ValidationResult<T> {
  return (data: unknown) => {
    const result = validator(data);
    if (result === null || result === undefined) {
      return { ok: false, errors: "Invalid payload" };
    }

    return { ok: true, data: result };
  };
}

function normalizePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  let normalized = path;
  const queryIndex = normalized.indexOf("?");
  if (queryIndex !== -1) {
    normalized = normalized.slice(0, queryIndex);
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/+$/, "");
  return normalized.length === 0 ? "/" : normalized;
}

function splitPath(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return [];
  }

  return normalized.slice(1).split("/");
}

function compilePath(path: string): CompiledPath {
  const normalized = normalizePath(path);
  const segments = splitPath(normalized).map<RouteSegment>((segment) => {
    if (segment.startsWith(":")) {
      return { kind: "param", value: segment.slice(1) };
    }

    return { kind: "static", value: segment };
  });

  return {
    normalized,
    segments,
    paramNames: segments.filter((segment) => segment.kind === "param").map((segment) => segment.value),
  };
}

function matchCompiledPath(route: CompiledPath, path: string): Record<string, string> | null {
  const actualSegments = splitPath(path);

  if (route.segments.length !== actualSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const expected = route.segments[index];
    const actual = actualSegments[index];

    if (expected.kind === "static") {
      if (expected.value !== actual) {
        return null;
      }
      continue;
    }

    try {
      params[expected.value] = decodeURIComponent(actual);
    } catch {
      params[expected.value] = actual;
    }
  }

  return params;
}

export class App {
  private routes: RouteHandler[] = [];
  private exactRoutes = new Map<string, RouteHandler>();
  private paramRoutes: RouteHandler[] = [];
  private middlewares: Middleware[] = [];
  private rustServer: RustCoreServerHandle | null = null;
  private rustStartup: Promise<void> | null = null;
  private nodeServer: HttpServer | null = null;
  private config: Required<AppOptions> = {
    keyFileName: "",
    certFileName: "",
    passphrase: "",
    port: 3000,
    host: "0.0.0.0",
    rustCoreBinary: "",
  };

  constructor(options?: AppOptions) {
    this.config = { ...this.config, ...options };
  }

  private routeKey(method: HttpMethod, path: string): string {
    return `${method}\0${path}`;
  }

  private addRoute(route: RouteHandler): this {
    this.routes.push(route);

    if (route.compiledPath.paramNames.length === 0) {
      this.exactRoutes.set(this.routeKey(route.method, route.compiledPath.normalized), route);
    } else {
      this.paramRoutes.push(route);
    }

    return this;
  }

  private registerRoute(method: HttpMethod, path: string, handler: Handler, options: RouteOptions = {}): this {
    return this.addRoute({
      kind: "dynamic",
      method,
      path,
      handler,
      middlewares: options.middlewares || [],
      compiledPath: compilePath(path),
    });
  }

  private registerStaticRoute(
    method: HttpMethod,
    path: string,
    staticRoute: StaticRouteConfig,
    options: RouteOptions = {}
  ): this {
    return this.addRoute({
      kind: "static",
      method,
      path,
      handler: undefined,
      middlewares: options.middlewares || [],
      staticRoute,
      compiledPath: compilePath(path),
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

    for (const route of this.paramRoutes) {
      if (route.method !== method) {
        continue;
      }

      const params = matchCompiledPath(route.compiledPath, normalizedPath);
      if (params) {
        return {
          route,
          params,
          suppressBody: method === "HEAD",
        };
      }
    }

    if (method !== "HEAD") {
      return null;
    }

    for (const route of this.paramRoutes) {
      if (route.method !== "GET") {
        continue;
      }

      const params = matchCompiledPath(route.compiledPath, normalizedPath);
      if (params) {
        return {
          route,
          params,
          suppressBody: true,
        };
      }
    }

    return null;
  }

  private mergeMiddlewares(routeMiddlewares: Middleware[]): Middleware[] {
    if (this.middlewares.length === 0) {
      return routeMiddlewares;
    }

    if (routeMiddlewares.length === 0) {
      return this.middlewares;
    }

    return [...this.middlewares, ...routeMiddlewares];
  }

  private canUseRustRuntime(): boolean {
    if (this.middlewares.length > 0) {
      return false;
    }

    return this.routes.every((route) => route.kind === "static" && route.middlewares.length === 0);
  }

  private async runMiddlewareStack(
    middlewareList: Middleware[],
    microReq: Request,
    microRes: Response,
    finalAction: () => void | Promise<void>
  ): Promise<void> {
    const dispatch = async (index: number): Promise<void> => {
      if (microRes.isEnded()) {
        return;
      }

      if (index >= middlewareList.length) {
        await finalAction();
        return;
      }

      const middleware = middlewareList[index];
      let nextCalled = false;
      let resolveNext: () => void = () => undefined;
      const nextCompleted = new Promise<void>((resolve) => {
        resolveNext = resolve;
      });

      const next = async (): Promise<void> => {
        if (nextCalled || microRes.isEnded()) {
          return;
        }

        nextCalled = true;
        try {
          await dispatch(index + 1);
        } finally {
          resolveNext?.();
        }
      };

      try {
        await middleware(microReq, microRes, next);
      } finally {
        if (!nextCalled) {
          resolveNext();
        }
      }

      if (nextCalled) {
        await nextCompleted;
      }
    };

    await dispatch(0);
  }

  private async handleNodeRequest(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
    const method = (nodeReq.method || "GET").toUpperCase() as HttpMethod;
    const routeMatch = this.findRoute(method, nodeReq.url || "/");

    if (!routeMatch) {
      const request = new Request(nodeReq);
      const response = new Response(nodeRes);

      try {
        if (this.middlewares.length > 0) {
          await this.runMiddlewareStack(this.middlewares, request, response, async () => {
            if (!response.isEnded()) {
              response.status(404).end();
            }
          });
        } else {
          response.status(404).end();
        }
      } catch (error) {
        if (!response.isEnded()) {
          response.status(500).end("Internal Server Error");
        }
        console.error(error);
      }

      return;
    }

    const request = new Request(nodeReq, routeMatch.params);
    const response = new Response(nodeRes, routeMatch.suppressBody);
    const middlewareList = this.mergeMiddlewares(routeMatch.route.middlewares);

    try {
      if (routeMatch.route.kind === "static") {
        await this.runMiddlewareStack(middlewareList, request, response, async () => {
          const staticRoute = routeMatch.route.staticRoute;
          if (!staticRoute) {
            return;
          }

          response.setHeader("Content-Type", staticRoute.contentType);
          response.setHeaders(staticRoute.headers);
          response.status(staticRoute.status);
          response.end(staticRoute.body);
        });
        return;
      }

      await this.runMiddlewareStack(middlewareList, request, response, async () => {
        await routeMatch.route.handler?.(request, response);
      });
    } catch (error) {
      if (!response.isEnded()) {
        response.status(500).end("Internal Server Error");
      }
      console.error(error);
    }
  }

  private ensureRustStaticRoutesOnly(): void {
    if (this.middlewares.length > 0) {
      throw new Error("Rust engine does not support middlewares");
    }

    for (const route of this.routes) {
      if (route.kind !== "static") {
        throw new Error("Rust engine only supports static text/json/html routes");
      }

      if (route.middlewares.length > 0) {
        throw new Error("Rust engine does not support route middlewares");
      }
    }
  }

  private createRustManifest(): { routes: RustStaticRoute[] } {
    const routes: RustStaticRoute[] = [];

    for (const route of this.routes) {
      if (route.kind !== "static" || !route.staticRoute) {
        throw new Error("Rust engine only supports static text/json/html routes");
      }

      routes.push({
        method: route.method,
        path: route.path,
        contentType: route.staticRoute.contentType,
        body: route.staticRoute.body,
        headers: route.staticRoute.headers,
        status: route.staticRoute.status,
      });
    }

    return { routes };
  }

  get(path: string, handler: Handler, options?: RouteOptions): this {
    return this.registerRoute("GET", path, handler, options);
  }

  post(path: string, handler: Handler, options?: RouteOptions): this {
    return this.registerRoute("POST", path, handler, options);
  }

  put(path: string, handler: Handler, options?: RouteOptions): this {
    return this.registerRoute("PUT", path, handler, options);
  }

  delete(path: string, handler: Handler, options?: RouteOptions): this {
    return this.registerRoute("DELETE", path, handler, options);
  }

  patch(path: string, handler: Handler, options?: RouteOptions): this {
    return this.registerRoute("PATCH", path, handler, options);
  }

  options(path: string, handler: Handler, options?: RouteOptions): this {
    return this.registerRoute("OPTIONS", path, handler, options);
  }

  head(path: string, handler: Handler, options?: RouteOptions): this {
    return this.registerRoute("HEAD", path, handler, options);
  }

  text(path: string, body: string, options?: RouteOptions): this {
    return this.registerStaticRoute(
      "GET",
      path,
      {
        contentType: "text/plain",
        body,
        headers: {},
        status: 200,
      },
      options
    );
  }

  json(path: string, body: unknown, options?: RouteOptions): this {
    return this.registerStaticRoute(
      "GET",
      path,
      {
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: {},
        status: 200,
      },
      options
    );
  }

  html(path: string, body: string, options?: RouteOptions): this {
    return this.registerStaticRoute(
      "GET",
      path,
      {
        contentType: "text/html",
        body,
        headers: {},
        status: 200,
      },
      options
    );
  }

  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  listen(callback?: (started: boolean) => void): this {
    if (this.canUseRustRuntime()) {
      this.rustStartup = (async () => {
        this.ensureRustStaticRoutesOnly();

        const manifest = this.createRustManifest();
        this.rustServer = await startRustCoreServer({
          port: this.config.port,
          manifest,
          binaryPath: this.config.rustCoreBinary || undefined,
        });
      })()
        .then(() => {
          callback?.(true);
        })
        .catch((error) => {
          console.error(error);
          callback?.(false);
          process.exitCode = 1;
        });

      return this;
    }

    const requestListener = (nodeReq: IncomingMessage, nodeRes: ServerResponse): void => {
      void this.handleNodeRequest(nodeReq, nodeRes);
    };

    const useHttps = Boolean(this.config.keyFileName || this.config.certFileName);
    if (useHttps) {
      if (!this.config.keyFileName || !this.config.certFileName) {
        throw new Error("Both keyFileName and certFileName are required for HTTPS");
      }

      const key = readFileSync(this.config.keyFileName);
      const cert = readFileSync(this.config.certFileName);
      this.nodeServer = createHttpsServer(
        {
          key,
          cert,
          passphrase: this.config.passphrase || undefined,
        },
        requestListener
      );
    } else {
      this.nodeServer = createHttpServer(requestListener);
    }

    this.nodeServer.once("error", (error) => {
      console.error(error);
      callback?.(false);
      process.exitCode = 1;
    });

    this.nodeServer.listen(this.config.port, this.config.host, () => {
      callback?.(true);
    });

    return this;
  }

  async close(): Promise<void> {
    if (this.rustStartup) {
      await this.rustStartup.catch(() => undefined);
    }

    if (this.rustServer) {
      await this.rustServer.stop();
      this.rustServer = null;
    }

    if (this.nodeServer) {
      const server = this.nodeServer;
      await new Promise<void>((resolve) => {
        if ("closeIdleConnections" in server && typeof server.closeIdleConnections === "function") {
          server.closeIdleConnections();
        }

        if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }

        server.close(() => resolve());
      });
      this.nodeServer = null;
    }

    this.rustStartup = null;
  }
}

export { createValidator };
export { Request } from "./request.js";
export { Response } from "./response.js";
export type {
  HttpMethod,
  QueryParams,
  Headers,
  IncomingRequest,
  OutgoingResponse,
  Handler,
  Middleware,
  RouteOptions,
  AppOptions,
} from "./types.js";
