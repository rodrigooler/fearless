import type { ArkErrors } from "arktype";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD";

export type BodyValidator<T = unknown> = (data: unknown) => T | ArkErrors;

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

export type Handler = (
  req: IncomingRequest,
  res: OutgoingResponse
) => void | OutgoingResponse | Promise<void | OutgoingResponse | undefined>;

export type Middleware = (
  req: IncomingRequest,
  res: OutgoingResponse,
  next: () => void | Promise<void>
) => void | OutgoingResponse | Promise<void | OutgoingResponse | undefined>;

export interface RouteOptions {
  middlewares?: Middleware[];
}

export interface AppOptions {
  keyFileName?: string;
  certFileName?: string;
  passphrase?: string;
  port?: number;
  host?: string;
  rustCoreBinary?: string;
}
