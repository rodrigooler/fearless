import { ArkErrors } from "arktype";
import type { HttpRequest as UWSRequest, HttpResponse as UWSResponse } from "uWebSockets.js";
import type { BodyValidator, HttpMethod, QueryParams, Headers, IncomingRequest } from "./types.js";

const textDecoder = new TextDecoder();

function decodeRemoteAddress(remoteAddress: ArrayBuffer): string {
  const bytes = new Uint8Array(remoteAddress);
  if (bytes.length === 4) {
    let result = "";
    for (let i = 0; i < bytes.length; i += 1) {
      if (i > 0) {
        result += ".";
      }
      result += bytes[i];
    }
    return result;
  }

  return textDecoder.decode(bytes).replace(/\0+$/, "");
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
  private _bodyPromise: Promise<unknown | null> | null = null;

  constructor(private req: UWSRequest, private res: UWSResponse, paramNames: readonly string[] = []) {
    this.method = req.getMethod().toUpperCase() as HttpMethod;
    this.url = req.getUrl();
    this.path = this.parsePath(req.getUrl());
    this.params = this.parseParams(req, paramNames);
  }

  private parsePath(url: string): string {
    const questionIndex = url.indexOf("?");
    return questionIndex === -1 ? url : url.substring(0, questionIndex);
  }

  private parseQuery(queryString: string): QueryParams {
    if (!queryString) return {};
    const params: QueryParams = {};
    for (const pair of queryString.split("&")) {
      const [key, ...valueParts] = pair.split("=");
      if (!key) continue;
      const value = decodeURIComponent(valueParts.join("="));
      if (params[key]) {
        if (Array.isArray(params[key])) {
          (params[key] as string[]).push(value);
        } else {
          params[key] = [params[key] as string, value];
        }
      } else {
        params[key] = value;
      }
    }
    return params;
  }

  private parseHeaders(req: UWSRequest): Headers {
    const result: Headers = {};
    req.forEach((key, value) => {
      result[key] = value;
    });
    return result;
  }

  private parseParams(req: UWSRequest, paramNames: readonly string[]): Record<string, string> {
    if (paramNames.length === 0) {
      return {};
    }

    const params: Record<string, string> = {};
    for (let i = 0; i < paramNames.length; i += 1) {
      params[paramNames[i]] = req.getParameter(paramNames[i]) ?? "";
    }

    return params;
  }

  get query(): QueryParams {
    if (this._query === null) {
      this._query = this.parseQuery(this.req.getQuery());
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
      this._ip = decodeRemoteAddress(this.res.getRemoteAddressAsText());
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

  private readBody(): Promise<unknown | null> {
    if (this._bodyPromise) {
      return this._bodyPromise;
    }

    this._bodyPromise = new Promise((resolve) => {
      const chunks: Buffer[] = [];

      this.res.onData((ab, isLast) => {
        chunks.push(Buffer.from(ab));

        if (!isLast) {
          return;
        }

        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const parsed = raw.length > 0 ? JSON.parse(raw) : null;
          resolve(parsed);
        } catch {
          this.res.close();
          resolve(null);
        }
      });

      this.res.onAborted(() => {
        resolve(null);
      });
    });

    return this._bodyPromise;
  }

  async parseBodyRaw<T = unknown>(schema: BodyValidator<T>): Promise<T | null> {
    if (this._bodyParsed) {
      return this._body as T | null;
    }

    const body = await this.readBody();
    if (body === null) {
      return null;
    }

    const result = schema(body);
    if (result instanceof ArkErrors) {
      this.res.close();
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
