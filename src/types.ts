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
