import { ArkErrors } from "arktype";
import type { IncomingMessage } from "node:http";
import type { BodyValidator, Headers, HttpMethod, QueryParams, IncomingRequest } from "./types.js";

function normalizePath(url: string): string {
  const questionIndex = url.indexOf("?");
  const path = questionIndex === -1 ? url : url.slice(0, questionIndex);
  if (!path || path === "/") {
    return "/";
  }

  return path.startsWith("/") ? path.replace(/\/+$/, "") || "/" : `/${path.replace(/\/+$/, "")}`;
}

function normalizeIp(address: string | undefined): string {
  if (!address) {
    return "";
  }

  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export class Request implements IncomingRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly path: string;
  private _query: QueryParams | null = null;
  private _headers: Headers | null = null;
  readonly params: Record<string, string>;
  private _ip: string | null = null;
  private _body: unknown = null;
  private _bodyParsed = false;
  private _bodyPromise: Promise<string | null> | null = null;

  constructor(private req: IncomingMessage, params: Record<string, string> = {}) {
    this.method = (req.method || "GET").toUpperCase() as HttpMethod;
    this.url = req.url || "/";
    this.path = normalizePath(this.url);
    this.params = params;
  }

  private parseQuery(queryString: string): QueryParams {
    if (!queryString) {
      return {};
    }

    const params: QueryParams = {};
    const searchParams = new URLSearchParams(queryString);

    for (const [key, value] of searchParams.entries()) {
      const existing = params[key];
      if (existing === undefined) {
        params[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        params[key] = [existing, value];
      }
    }

    return params;
  }

  private parseHeaders(req: IncomingMessage): Headers {
    const result: Headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) {
        continue;
      }

      result[key] = Array.isArray(value) ? value.join(", ") : value;
    }

    return result;
  }

  get query(): QueryParams {
    if (this._query === null) {
      const queryIndex = this.url.indexOf("?");
      this._query = this.parseQuery(queryIndex === -1 ? "" : this.url.slice(queryIndex + 1));
    }

    return this._query;
  }

  get headers(): Headers {
    if (this._headers === null) {
      this._headers = this.parseHeaders(this.req);
    }

    return this._headers;
  }

  get ip(): string {
    if (this._ip === null) {
      this._ip = normalizeIp(this.req.socket.remoteAddress);
    }

    return this._ip;
  }

  get body(): unknown {
    return this._body;
  }

  setBody(body: unknown): void {
    this._body = body;
    this._bodyParsed = true;
  }

  get bodyParsed(): boolean {
    return this._bodyParsed;
  }

  private readBody(): Promise<string | null> {
    if (this._bodyPromise) {
      return this._bodyPromise;
    }

    this._bodyPromise = new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let finished = false;

      const cleanup = (): void => {
        this.req.off("data", onData);
        this.req.off("end", onEnd);
        this.req.off("aborted", onAborted);
        this.req.off("error", onError);
      };

      const settle = (value: string | null): void => {
        if (finished) {
          return;
        }

        finished = true;
        cleanup();
        resolve(value);
      };

      const onData = (chunk: Buffer | string): void => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      };

      const onEnd = (): void => {
        settle(Buffer.concat(chunks).toString("utf8"));
      };

      const onAborted = (): void => {
        settle(null);
      };

      const onError = (): void => {
        settle(null);
      };

      this.req.on("data", onData);
      this.req.once("end", onEnd);
      this.req.once("aborted", onAborted);
      this.req.once("error", onError);
    });

    return this._bodyPromise;
  }

  async parseBodyRaw<T = unknown>(schema: BodyValidator<T>): Promise<T | null> {
    if (this._bodyParsed) {
      return this._body as T | null;
    }

    const raw = await this.readBody();
    if (raw === null) {
      this.setBody(null);
      return null;
    }

    let body: unknown;
    try {
      body = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      this.setBody(null);
      return null;
    }

    const result = schema(body);
    if (result instanceof ArkErrors) {
      this.setBody(null);
      return null;
    }

    this.setBody(result);
    return result;
  }

  async parseBody<T = unknown>(schema: BodyValidator<T>): Promise<T | null> {
    return this.parseBodyRaw(schema);
  }

  async json<T = unknown>(schema: BodyValidator<T>): Promise<T | null> {
    return this.parseBodyRaw(schema);
  }
}
