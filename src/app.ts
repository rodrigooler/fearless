import { ArkErrors, type } from "arktype";
import type { HttpRequest, HttpResponse, TemplatedApp, us_listen_socket } from "uWebSockets.js";
import { Request } from "./request.js";
import { Response } from "./response.js";
import type { HttpMethod, Handler, Middleware, RouteOptions, AppOptions } from "./types.js";

type ArktypeSchema = unknown;

interface RouteHandler {
  method: HttpMethod;
  path: string;
  handler: Handler;
  middlewares: Middleware[];
  paramNames: string[];
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
  private config: Required<AppOptions> = {
    keyFileName: "",
    certFileName: "",
    passphrase: "",
    port: 3000,
    host: "0.0.0.0",
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
      method,
      path,
      handler,
      middlewares: options.middlewares || [],
      paramNames: this.parseParamNames(path),
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
      const middlewareList =
        this.middlewares.length === 0
          ? route.middlewares
          : route.middlewares.length === 0
            ? this.middlewares
            : [...this.middlewares, ...route.middlewares];

      const handler = (res: HttpResponse, req: HttpRequest) => {
        const microReq = new Request(req, res, route.paramNames);
        const microRes = new Response(res);

        if (middlewareList.length === 0) {
          void route.handler(microReq, microRes);
          return;
        }

        const runMiddlewares = async (index: number): Promise<void> => {
          if (index >= middlewareList.length) {
            await route.handler(microReq, microRes);
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

  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  listen(callback?: (socket: us_listen_socket | false) => void): this {
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
