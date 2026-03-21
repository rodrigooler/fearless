import type { Middleware } from "../types.js";

export interface CorsOptions {
  origin?: string | boolean;
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
  optionsSuccessStatus?: number;
}

function serializeOrigin(origin: CorsOptions["origin"]): string | null {
  if (origin === false) {
    return null;
  }

  if (origin === undefined || origin === true) {
    return "*";
  }

  return origin;
}

export function cors(options: CorsOptions = {}): Middleware {
  const origin = serializeOrigin(options.origin);
  const methods = options.methods?.join(", ") ?? "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS";
  const allowedHeaders = options.allowedHeaders?.join(", ");
  const exposedHeaders = options.exposedHeaders?.join(", ");
  const credentials = options.credentials === true;
  const maxAge = options.maxAge;
  const optionsSuccessStatus = options.optionsSuccessStatus ?? 204;

  return (req, res, next) => {
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }

    res.setHeader("Access-Control-Allow-Methods", methods);

    if (allowedHeaders) {
      res.setHeader("Access-Control-Allow-Headers", allowedHeaders);
    }

    if (exposedHeaders) {
      res.setHeader("Access-Control-Expose-Headers", exposedHeaders);
    }

    if (credentials) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    if (typeof maxAge === "number" && Number.isFinite(maxAge) && maxAge >= 0) {
      res.setHeader("Access-Control-Max-Age", String(Math.floor(maxAge)));
    }

    if (req.method === "OPTIONS") {
      res.status(optionsSuccessStatus).end();
      return;
    }

    return next();
  };
}
