import { ArkErrors, type } from "arktype";
import type { HttpRequest, HttpResponse, TemplatedApp, us_listen_socket } from "uWebSockets.js";
import { Request } from "./request.js";
import { Response } from "./response.js";
import type { HttpMethod, Handler, Middleware, RouteOptions, AppOptions } from "./types.js";
import { startRustCoreServer, type RustCoreServerHandle, type RustStaticRoute } from "./rust-core.js";

type ArktypeSchema = unknown;

interface StaticRouteConfig {
  contentType: string;
  body: string;
  headers: Record<string, string>;
  status: number;
}

interface RouteHandler {
  kind: "dynamic" | "static";
  method: HttpMethod;
  path: string;
  handler?: Handler;
  middlewares: Middleware[];
  paramNames: string[];
  staticRoute?: StaticRouteConfig;
}

type ArktypeValidator = (data: unknown) => { ok: true; data: unknown } | { ok: false; errors: ArkErrors };

function createValidator(schema: ArktypeSchema): ArktypeValidator {
  const validator = type(schema as never);
  return (data: unknown) => {
    const result = validator(data);
    if (result instanceof ArkErrors) {
      return { ok: false, errors: result };
    }

    return { ok: true, data: result };
  };
}

export class App {
  private routes: RouteHandler[] = [];
  private middlewares: Middleware[] = [];
  private rustServer: RustCoreServerHandle | null = null;
  private rustStartup: Promise<void> | null = null;
  private config: Required<AppOptions> = {
    keyFileName: "",
    certFileName: "",
    passphrase: "",
    port: 3000,
    host: "0.0.0.0",
    engine: "uws",
    rustCoreBinary: "",
  };

  constructor(options?: AppOptions) {
    this.config = { ...this.config, ...options };
  }

  private registerRoute(
    method: HttpMethod,
    path: string,
    handler: Handler,
    options: RouteOptions = {}
  ): this {
    this.routes.push({
      kind: "dynamic",
      method,
      path,
      handler,
      middlewares: options.middlewares || [],
      paramNames: this.parseParamNames(path),
    });
    return this;
  }

  private registerStaticRoute(
    method: HttpMethod,
    path: string,
    staticRoute: StaticRouteConfig,
    options: RouteOptions = {}
  ): this {
    if (options.middlewares && options.middlewares.length > 0) {
      throw new Error("Static Rust routes do not support middlewares");
    }

    this.routes.push({
      kind: "static",
      method,
      path,
      handler: undefined,
      middlewares: [],
      paramNames: [],
      staticRoute,
    });
    return this;
  }

  private parseParamNames(path: string): string[] {
    const names: string[] = [];
    const matcher = /:([A-Za-z0-9_]+)/g;
    let match: RegExpExecArray | null;

    while ((match = matcher.exec(path)) !== null) {
      names.push(match[1]);
    }

    return names;
  }

  private buildRouteHandlers(app: TemplatedApp): void {
    for (const route of this.routes) {
      const uwsMethod = route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch" | "options" | "head";

      const handler = (res: HttpResponse, req: HttpRequest) => {
        if (route.kind === "static") {
          const microRes = new Response(res);
          microRes.setHeader("Content-Type", route.staticRoute!.contentType);
          microRes.setHeaders(route.staticRoute!.headers);
          microRes.status(route.staticRoute!.status);
          microRes.end(route.staticRoute!.body);
          return;
        }

        const middlewareList =
          this.middlewares.length === 0
            ? route.middlewares
            : route.middlewares.length === 0
              ? this.middlewares
              : [...this.middlewares, ...route.middlewares];

        const microReq = new Request(req, res, route.paramNames);
        const microRes = new Response(res);

        if (middlewareList.length === 0) {
          void route.handler?.(microReq, microRes);
          return;
        }

        const runMiddlewares = async (index: number): Promise<void> => {
          if (index >= middlewareList.length) {
            await route.handler?.(microReq, microRes);
            return;
          }

          const middleware = middlewareList[index];
          const next = () => runMiddlewares(index + 1);
          await middleware(microReq, microRes, next);
        };

        void runMiddlewares(0);
      };

      switch (uwsMethod) {
        case "get":
          app.get(route.path, handler);
          break;
        case "post":
          app.post(route.path, handler);
          break;
        case "put":
          app.put(route.path, handler);
          break;
        case "delete":
          app.del(route.path, handler);
          break;
        case "patch":
          app.patch(route.path, handler);
          break;
        case "options":
          app.options(route.path, handler);
          break;
        case "head":
          app.head(route.path, handler);
          break;
      }
    }
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

  private async listenWithRust(callback?: (socket: us_listen_socket | false) => void): Promise<void> {
    if (this.middlewares.length > 0) {
      throw new Error("Rust engine does not support middlewares");
    }

    for (const route of this.routes) {
      if (route.kind !== "static") {
        throw new Error("Rust engine only supports static text/json/html routes");
      }
    }

    const manifest = this.createRustManifest();
    this.rustServer = await startRustCoreServer({
      port: this.config.port,
      manifest,
      binaryPath: this.config.rustCoreBinary || undefined,
    });

    if (callback) {
      callback(true as unknown as us_listen_socket);
    }
  }

  listen(callback?: (socket: us_listen_socket | false) => void): this {
    if (this.config.engine === "rust") {
      this.rustStartup = this.listenWithRust(callback).catch((error) => {
        console.error(error);
        if (callback) {
          callback(false);
        }
        process.exitCode = 1;
      });
      return this;
    }

    void import("uWebSockets.js").then((uWS) => {
      let app = uWS.SSLApp({
        key_file_name: this.config.keyFileName || undefined,
        cert_file_name: this.config.certFileName || undefined,
        passphrase: this.config.passphrase || undefined,
      });

      if (!this.config.keyFileName && !this.config.certFileName) {
        app = uWS.App();
      }

      this.buildRouteHandlers(app);

      app.listen(this.config.host, this.config.port, (socket) => {
        if (callback) callback(socket);
      });
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

    this.rustStartup = null;
  }
}

export { type, createValidator };
export type { ArktypeSchema, ArktypeValidator };
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
