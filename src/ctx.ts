import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import type { Ctx, Headers, HttpMethod, QueryParams, ResponseBody } from "./types.js";
import { HttpError, ValidationError } from "./errors.js";
import { normalizePath } from "./path.js";

type PendingResponseShape = {
  status: number | null;
  headers: Record<string, string>;
};

function emptyPendingShape(): PendingResponseShape {
  return { status: null, headers: {} };
}

function normalizeIp(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function parseQueryString(qs: string): QueryParams {
  if (!qs) return {};
  const result: QueryParams = {};
  const params = new URLSearchParams(qs);
  for (const [key, value] of params.entries()) {
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

function nodeHeadersToRecord(req: IncomingMessage): Headers {
  const out: Headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function webHeadersToRecord(req: globalThis.Request): Headers {
  const out: Headers = {};
  for (const [key, value] of req.headers.entries()) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function readNodeBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.once("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.once("aborted", () => reject(new HttpError(400, "Request aborted")));
    req.once("error", (error) => reject(new HttpError(400, "Request error", { cause: error })));
  });
}

export class RequestContext implements Ctx {
  readonly method: HttpMethod;
  readonly path: string;
  readonly url: string;
  readonly params: Record<string, string>;
  readonly headers: Headers;
  readonly ip: string;
  readonly nodeReq?: IncomingMessage;
  readonly nodeRes?: ServerResponse;
  readonly webReq?: globalThis.Request;
  state: Record<string, unknown> = {};

  private _query: QueryParams | null = null;
  private _bodyText: string | null = null;
  private _bodyTextPromise: Promise<string> | null = null;
  private pending: PendingResponseShape = emptyPendingShape();

  private constructor(args: {
    method: HttpMethod;
    url: string;
    path: string;
    headers: Headers;
    ip: string;
    params: Record<string, string>;
    nodeReq?: IncomingMessage;
    nodeRes?: ServerResponse;
    webReq?: globalThis.Request;
  }) {
    this.method = args.method;
    this.url = args.url;
    this.path = args.path;
    this.headers = args.headers;
    this.ip = args.ip;
    this.params = args.params;
    this.nodeReq = args.nodeReq;
    this.nodeRes = args.nodeRes;
    this.webReq = args.webReq;
  }

  static fromNode(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): RequestContext {
    const url = req.url || "/";
    return new RequestContext({
      method: (req.method || "GET").toUpperCase() as HttpMethod,
      url,
      path: normalizePath(url),
      headers: nodeHeadersToRecord(req),
      ip: normalizeIp(req.socket.remoteAddress),
      params,
      nodeReq: req,
      nodeRes: res,
    });
  }

  static fromWeb(request: globalThis.Request, params: Record<string, string>, ip = ""): RequestContext {
    const url = new URL(request.url);
    return new RequestContext({
      method: (request.method || "GET").toUpperCase() as HttpMethod,
      url: `${url.pathname}${url.search}`,
      path: normalizePath(url.pathname),
      headers: webHeadersToRecord(request),
      ip,
      params,
      webReq: request,
    });
  }

  // ---- inputs ----

  get query(): QueryParams {
    if (this._query === null) {
      const qs = this.url.includes("?") ? this.url.slice(this.url.indexOf("?") + 1) : "";
      this._query = parseQueryString(qs);
    }
    return this._query;
  }

  // ---- body parsing ----

  async text(): Promise<string> {
    if (this._bodyText !== null) return this._bodyText;
    if (this._bodyTextPromise !== null) return this._bodyTextPromise;

    if (this.webReq) {
      this._bodyTextPromise = this.webReq.text().catch((error) => {
        throw new HttpError(400, "Request body read failed", { cause: error });
      });
    } else if (this.nodeReq) {
      this._bodyTextPromise = readNodeBody(this.nodeReq);
    } else {
      this._bodyTextPromise = Promise.resolve("");
    }

    this._bodyText = await this._bodyTextPromise;
    return this._bodyText;
  }

  async body<T = unknown>(): Promise<T> {
    const raw = await this.text();
    if (raw.length === 0) return null as T;
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw new HttpError(400, "Invalid JSON body", { cause: error });
    }
  }

  async formData(): Promise<FormData> {
    if (this.webReq) {
      try {
        return await this.webReq.formData();
      } catch (error) {
        throw new HttpError(400, "Invalid form data", { cause: error });
      }
    }

    // Node fallback: build a Request from the buffered body and let undici parse it.
    const raw = await this.text();
    const contentType = this.headers["content-type"] ?? "";
    try {
      const synthetic = new globalThis.Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": contentType },
        body: raw,
      });
      return await synthetic.formData();
    } catch (error) {
      throw new HttpError(400, "Invalid form data", { cause: error });
    }
  }

  async validate<T>(validator: (data: unknown) => T | null | undefined): Promise<T> {
    const data = await this.body<unknown>();
    const result = validator(data);
    if (result === null || result === undefined) {
      throw new ValidationError("Validation failed");
    }
    return result;
  }

  // ---- chainable shapers ----

  status(code: number): Ctx {
    this.pending.status = code;
    return this;
  }

  header(key: string, value: string): Ctx {
    this.pending.headers[key] = value;
    return this;
  }

  setHeaders(headers: Record<string, string>): Ctx {
    for (const key of Object.keys(headers)) {
      this.pending.headers[key] = headers[key];
    }
    return this;
  }

  // ---- response builders ----

  json<T>(data: T, status?: number): Response {
    const body = JSON.stringify(data);
    return this.finalize(body, {
      status: status ?? this.pending.status ?? 200,
      headers: this.mergeHeaders({ "Content-Type": "application/json" }),
    });
  }

  html(body: string, status?: number): Response {
    return this.finalize(body, {
      status: status ?? this.pending.status ?? 200,
      headers: this.mergeHeaders({ "Content-Type": "text/html; charset=utf-8" }),
    });
  }

  raw(body: ResponseBody, init?: ResponseInit): Response {
    const status = init?.status ?? this.pending.status ?? 200;
    const headers = this.mergeHeaders(headersInitToRecord(init?.headers as HeadersInitLike | undefined));
    return this.finalize(body, { status, headers });
  }



  redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
    return this.finalize(null, {
      status,
      headers: this.mergeHeaders({ Location: url }),
    });
  }

  notFound(message = "Not Found"): Response {
    return this.finalize(message, {
      status: this.pending.status ?? 404,
      headers: this.mergeHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }

  noContent(): Response {
    return this.finalize(null, {
      status: this.pending.status ?? 204,
      headers: this.pending.headers,
    });
  }

  private mergeHeaders(extra: Record<string, string>): Record<string, string> {
    return { ...this.pending.headers, ...extra };
  }

  private finalize(body: ResponseBody, init: { status: number; headers: Record<string, string> }): Response {
    // Reset chainable shape after a response is produced — so the same Ctx
    // can be reused if a hook wants to build a different response.
    this.pending = emptyPendingShape();
    const isBodyless = init.status === 204 || init.status === 304;
    // Cast through unknown: ResponseBody is a hand-rolled union (no DOM lib);
    // the runtime Response constructor accepts every branch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Response(isBodyless ? null : (body as any), init);
  }
}

type HeadersInitLike =
  | globalThis.Headers
  | Record<string, string>
  | Array<[string, string]>;

function headersInitToRecord(init: HeadersInitLike | undefined): Record<string, string> {
  if (!init) return {};
  if (Array.isArray(init)) {
    const out: Record<string, string> = {};
    for (const [k, v] of init) out[k] = v;
    return out;
  }
  if (init instanceof globalThis.Headers) {
    const out: Record<string, string> = {};
    init.forEach((v, k) => { out[k] = v; });
    return out;
  }
  return { ...(init as Record<string, string>) };
}
